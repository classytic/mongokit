/**
 * Backfill / repair for `searchMode: 'prefix'` keys: recompute the keys of
 * existing documents from their source fields and write the ones that differ.
 *
 * Use it once when turning prefix search on for a collection that already has
 * rows, after changing `searchFields`, after a normaliser upgrade, or after
 * writes that bypassed the repository. Idempotent (a second run writes
 * nothing) and resumable (walks `_id` ascending in bounded batches, so it never
 * holds a long cursor).
 */

import type { ClientSession, Model } from 'mongoose';
import { buildSearchKeys, DEFAULT_SEARCH_KEYS_FIELD } from './prefix.js';

/** A prefix-mode `Repository` satisfies this: `rebuildSearchKeys(repo)`. */
export interface SearchKeysSource {
  Model: Model<any, any, any, any>;
  searchFields?: readonly string[] | undefined;
  searchKeysField?: string;
}

export interface RebuildSearchKeysOptions {
  /** Source fields. Default: the repository's `searchFields`. */
  fields?: readonly string[];
  /** Keys field. Default: the repository's `searchKeysField`, else `'_searchKeys'`. */
  keysField?: string;
  /** Only documents matching this filter. Default: all. */
  filter?: Record<string, unknown>;
  /** Only documents with no keys field yet (cheapest boot-time backfill). Default `false`. */
  onlyMissing?: boolean;
  /** Documents read and written per round-trip. Default 500. */
  batchSize?: number;
  session?: unknown;
}

export interface RebuildSearchKeysResult {
  /** Documents read. */
  scanned: number;
  /** Documents whose keys were missing or stale and were rewritten (server-reported). */
  updated: number;
}

const sameKeys = (a: unknown, b: readonly string[]): boolean =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

export async function rebuildSearchKeys(
  source: SearchKeysSource | Model<any, any, any, any>,
  options: RebuildSearchKeysOptions = {},
): Promise<RebuildSearchKeysResult> {
  // A mongoose model is a function; a repository (or any SearchKeysSource) is an object.
  const repo = typeof source === 'function' ? undefined : (source as SearchKeysSource);
  const Model = (repo ? repo.Model : source) as Model<any, any, any, any>;
  const fields = options.fields ?? repo?.searchFields ?? [];
  const keysField = options.keysField ?? repo?.searchKeysField ?? DEFAULT_SEARCH_KEYS_FIELD;
  if (fields.length === 0) {
    throw new TypeError(
      '[mongokit] rebuildSearchKeys: no source fields (pass `fields` or a prefix-mode repository)',
    );
  }
  const batchSize = Math.max(1, options.batchSize ?? 500);
  const session = (options.session as ClientSession | undefined) ?? null;
  const base: Record<string, unknown> = {
    ...(options.filter ?? {}),
    ...(options.onlyMissing ? { [keysField]: { $exists: false } } : {}),
  };
  const projection = Object.fromEntries([...fields, keysField].map((f) => [f, 1]));

  let scanned = 0;
  let updated = 0;
  let after: unknown;
  for (;;) {
    const page = (await Model.find(
      after === undefined ? base : { $and: [base, { _id: { $gt: after } }] },
      projection,
    )
      .sort({ _id: 1 })
      .limit(batchSize)
      .session(session)
      .lean()) as Array<Record<string, unknown>>;
    if (page.length === 0) break;
    scanned += page.length;
    after = page[page.length - 1]?._id;
    const writes = page.flatMap((doc) => {
      const keys = buildSearchKeys(doc, fields);
      if (sameKeys(doc[keysField], keys)) return [];
      return [{ updateOne: { filter: { _id: doc._id }, update: { $set: { [keysField]: keys } } } }];
    });
    if (writes.length > 0) {
      const res = await Model.bulkWrite(writes as never, {
        ordered: false,
        session: session ?? undefined,
      });
      // What the server changed, not what was sent: a filter the model casts to a different
      // `_id` type (string ids under an ObjectId schema) matches nothing and must not count.
      updated += res.modifiedCount;
    }
    if (page.length < batchSize) break;
  }
  return { scanned, updated };
}
