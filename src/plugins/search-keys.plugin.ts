/**
 * Search-keys plugin: keeps the `searchMode: 'prefix'` keys field in step with
 * its source fields on EVERY write path, inside the same write.
 *
 *   create / createMany / bulkWrite insertOne / replaceOne → keys of the document
 *   getOrCreate                                            → keys of filter equalities + insert data
 *   update / findOneAndUpdate / claim / claimVersion /
 *   bulkWrite updateOne / bulkUpsert                       → keys of the new values; a write that
 *                                                            sets only SOME search fields reads the
 *                                                            others from the matched document first
 *   updateMany / bulkWrite updateMany                      → keys of the new values; setting only
 *                                                            some search fields is refused (400),
 *                                                            the rest differ per document
 *
 * Caller-supplied values for the keys field are always dropped: the keys are
 * derived, never client-settable. Runs after every default-priority hook, so it
 * sees the payload other plugins (validation, defaults, tenant) produced.
 *
 * `Repository` installs this automatically for `searchMode: 'prefix'`; install
 * it by hand only to keep keys on a repository that searches some other way.
 *
 * Writes that bypass the repository (raw `Model.updateOne`, another driver such
 * as Better Auth's adapter) must write the keys themselves with
 * `buildSearchKeys`, or be repaired with `rebuildSearchKeys`.
 */

import { HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import {
  analyzeUpdate,
  fieldValuesOf,
  insertValues,
  keysFromValues,
  SEARCH_KEYS_ERROR_CODES,
  SearchKeysWriteError,
  unresolvedForUpdate,
  writeKeys,
} from '../search/derive.js';
import { buildSearchKeys, DEFAULT_SEARCH_KEYS_FIELD } from '../search/prefix.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';

export interface SearchKeysPluginOptions {
  /** Source fields (dotted paths allowed; string, number, or arrays of them). */
  fields: readonly string[];
  /** Field that stores the keys. Default `'_searchKeys'`. */
  keysField?: string;
}

type Doc = Record<string, unknown>;
type Loader = () => Promise<Doc | null | undefined>;

const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);

/** After every default-priority (user) hook: derive from the final payload. */
const PRIORITY = HOOK_PRIORITY.DEFAULT + 100;

export function searchKeysPlugin(options: SearchKeysPluginOptions): Plugin {
  const fields = [...options.fields];
  const keysField = options.keysField ?? DEFAULT_SEARCH_KEYS_FIELD;
  if (fields.length === 0) {
    throw new TypeError(
      '[mongokit] searchKeysPlugin: `fields` must name at least one source field',
    );
  }
  const projection = Object.fromEntries(fields.map((f) => [f, 1]));

  const stampDoc = (doc: unknown): void => {
    if (isDoc(doc)) doc[keysField] = buildSearchKeys(doc, fields);
  };

  /** Derive the keys for ONE update in place. `load` reads the matched document's current values. */
  const deriveOne = async (
    update: unknown,
    filter: unknown,
    upsert: boolean,
    load: Loader | undefined,
  ): Promise<void> => {
    if (!isDoc(update) && !Array.isArray(update)) return;
    const effect = analyzeUpdate(update, filter, fields, keysField);
    if (!isDoc(update)) return; // pipeline: analysed (refused if it touches a field), nothing to add
    const updatedAny = Object.keys(effect.updated).length > 0;
    if (!updatedAny) {
      if (upsert && Object.keys(effect.onInsert).length > 0) {
        writeKeys(update, keysField, keysFromValues(insertValues(effect), fields), '$setOnInsert');
      }
      return;
    }
    const missing = unresolvedForUpdate(effect, fields);
    if (missing.length === 0) {
      writeKeys(update, keysField, keysFromValues({ ...effect.pinned, ...effect.updated }, fields));
      return;
    }
    if (!load) {
      throw new SearchKeysWriteError(
        `[mongokit] search keys: a multi-document update sets ${Object.keys(effect.updated).join(', ')} ` +
          `but not ${missing.join(', ')}; the keys would differ per document. Set every search field ` +
          `(${fields.join(', ')}) in this update, or update per document, or call rebuildSearchKeys afterwards`,
        SEARCH_KEYS_ERROR_CODES.PARTIAL_MULTI_UPDATE,
      );
    }
    const current = await load();
    let values: Record<string, unknown>;
    if (current)
      values = { ...fieldValuesOf(current, fields), ...effect.pinned, ...effect.updated };
    else if (upsert) values = insertValues(effect);
    else return; // nothing matches: nothing is written
    writeKeys(update, keysField, keysFromValues(values, fields));
  };

  return {
    name: 'search-keys',

    apply(repo: RepositoryInstance): void {
      const Model = repo.Model;
      const findOne =
        (filter: unknown, ctx: RepositoryContext, sort?: unknown): Loader =>
        async () => {
          let q = Model.findOne(filter as Doc, projection, { session: ctx.session as never });
          if (sort) q = q.sort(sort as never);
          return (await q.lean()) as Doc | null;
        };
      const byTarget = (ctx: RepositoryContext): Loader | undefined =>
        typeof ctx.loadTarget === 'function'
          ? () => (ctx.loadTarget as (this: RepositoryContext) => Promise<Doc | null>).call(ctx)
          : undefined;

      repo.on('before:create', (ctx: RepositoryContext) => stampDoc(ctx.data), {
        priority: PRIORITY,
      });
      repo.on(
        'before:createMany',
        (ctx: RepositoryContext) => {
          for (const doc of ctx.dataArray ?? []) stampDoc(doc);
        },
        { priority: PRIORITY },
      );
      repo.on(
        'before:getOrCreate',
        async (ctx: RepositoryContext) => {
          // getOrCreate inserts `{ ...filter equalities, ...data }` via $setOnInsert.
          if (!isDoc(ctx.data)) return;
          const effect = analyzeUpdate({ $setOnInsert: ctx.data }, ctx.query, fields, keysField);
          ctx.data[keysField] = keysFromValues(insertValues(effect), fields);
        },
        { priority: PRIORITY },
      );

      // Id-addressed single-document updates: the shared, scope-aware target read.
      for (const op of ['update', 'claim', 'claimVersion'] as const) {
        repo.on(
          `before:${op}`,
          (ctx: RepositoryContext) =>
            deriveOne(ctx.data, ctx.query, ctx.upsert === true, byTarget(ctx)),
          { priority: PRIORITY },
        );
      }
      repo.on(
        'before:findOneAndUpdate',
        (ctx: RepositoryContext) =>
          deriveOne(ctx.data, ctx.query, ctx.upsert === true, findOne(ctx.query, ctx, ctx.sort)),
        { priority: PRIORITY },
      );
      repo.on(
        'before:updateMany',
        (ctx: RepositoryContext) => deriveOne(ctx.data, ctx.query, ctx.upsert === true, undefined),
        { priority: PRIORITY },
      );

      const deriveBulk = async (ctx: RepositoryContext): Promise<void> => {
        for (const subOp of (ctx.operations as Doc[] | undefined) ?? []) {
          if (!isDoc(subOp)) continue;
          const insert = subOp.insertOne as Doc | undefined;
          if (insert) stampDoc(insert.document);
          const replace = subOp.replaceOne as Doc | undefined;
          if (replace) stampDoc(replace.replacement);
          const one = subOp.updateOne as Doc | undefined;
          if (one) {
            await deriveOne(one.update, one.filter, one.upsert === true, findOne(one.filter, ctx));
          }
          const many = subOp.updateMany as Doc | undefined;
          if (many) await deriveOne(many.update, many.filter, many.upsert === true, undefined);
        }
      };
      repo.on('before:bulkWrite', deriveBulk, { priority: PRIORITY });
      repo.on('before:bulkUpsert', deriveBulk, { priority: PRIORITY });
    },
  };
}
