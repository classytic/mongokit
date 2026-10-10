/**
 * `@classytic/mongokit/read-model` — maintain and verify a derived (read) collection.
 *
 * - {@link applyIncrements}: grains summed per key, then ONE `bulkUpsert` (`$inc` + `$setOnInsert`)
 *   inside the caller's unit of work. With a `ledger`, each grain's `dedupeKey` is recorded in the
 *   SAME transaction and a key already recorded is skipped, so a replayed event counts once.
 * - {@link rebuildInto}: the source pipeline (scoped by the source repository) ends in a `$merge`
 *   on a unique `on`; grains of the scope the source no longer produces are then removed.
 *   `$merge` cannot run in a transaction, so a session inside one is refused.
 * - {@link reconcile}: recompute from the source and compare with the read model; returns drift.
 */

import { randomUUID } from 'node:crypto';
import type { BulkUpsertResult } from '@classytic/repo-core/repository';
import type { Repository } from '../Repository.js';
import { scopeForCollection, tenantFieldsOf } from '../repository/join-scope.js';
import type { RepositoryContext } from '../types/repository.js';
import { createError } from '../utils/error.js';

export const READ_MODEL_ERROR_CODES = {
  MERGE_IN_TRANSACTION: 'mongokit.read_model.merge_in_transaction',
  ON_NOT_UNIQUE: 'mongokit.read_model.on_not_unique',
  ON_MISSING_SCOPE: 'mongokit.read_model.on_missing_scope',
  DEDUPE_NEEDS_TRANSACTION: 'mongokit.read_model.dedupe_needs_transaction',
  DEDUPE_KEY_MISSING: 'mongokit.read_model.dedupe_key_missing',
  INCREMENT_FAILED: 'mongokit.read_model.increment_failed',
  TOO_LARGE: 'mongokit.read_model.too_large',
} as const;

/** Caller scope forwarded to every repository call (tenant, bypass, attribution). */
export type ReadModelScope = Record<string, unknown>;

export interface IncrementGrain {
  /** The read-model key (without the policy scope, which the repository adds). */
  key: Record<string, unknown>;
  inc: Record<string, number>;
  setOnInsert?: Record<string, unknown>;
  /** Identity of the event this grain comes from; required when a ledger is given. */
  dedupeKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inTransaction(session: unknown): boolean {
  const s = session as { inTransaction?: () => boolean } | null | undefined;
  return typeof s?.inTransaction === 'function' && s.inTransaction();
}

/** Sum grains per key, apply them in one upsert; with a ledger, count each dedupeKey once. */
export async function applyIncrements<TDoc>(
  target: Repository<TDoc>,
  grains: readonly IncrementGrain[],
  options: ReadModelScope & {
    session?: unknown;
    /** Repository over a collection unique on (scope, `dedupeKey`). */
    ledger?: Repository<unknown>;
  } = {},
): Promise<BulkUpsertResult> {
  const { ledger, ...scope } = options;
  let live = grains;
  if (ledger) {
    if (!inTransaction(scope.session)) {
      throw createError(
        500,
        '[mongokit] applyIncrements: a dedupe ledger is only correct inside a transaction',
        {
          code: READ_MODEL_ERROR_CODES.DEDUPE_NEEDS_TRANSACTION,
        },
      );
    }
    if (grains.some((g) => !g.dedupeKey)) {
      throw createError(
        400,
        '[mongokit] applyIncrements: every grain needs a dedupeKey when a ledger is given',
        {
          code: READ_MODEL_ERROR_CODES.DEDUPE_KEY_MISSING,
        },
      );
    }
    const keys = [...new Set(grains.flatMap((g) => (g.dedupeKey ? [g.dedupeKey] : [])))];
    const seen = new Set(
      (
        await ledger.findAll(
          { dedupeKey: { $in: keys } },
          { ...scope, select: 'dedupeKey', lean: true },
        )
      )
        .map((d): unknown => d)
        .filter(isRecord)
        .map((d) => String(d.dedupeKey)),
    );
    const fresh = keys.filter((k) => !seen.has(k));
    if (fresh.length > 0)
      await ledger.createMany(
        fresh.map((dedupeKey) => ({ dedupeKey })),
        scope,
      );
    const freshSet = new Set(fresh);
    // A dedupeKey repeated inside this batch also counts once.
    const taken = new Set<string>();
    live = grains.filter((g) => {
      const k = g.dedupeKey;
      if (!k || !freshSet.has(k) || taken.has(k)) return false;
      taken.add(k);
      return true;
    });
  }
  if (live.length === 0) return { results: [], inserted: 0, updated: 0, unchanged: 0, failed: 0 };

  const summed = new Map<
    string,
    {
      key: Record<string, unknown>;
      inc: Record<string, number>;
      setOnInsert: Record<string, unknown>;
    }
  >();
  for (const g of live) {
    const id = JSON.stringify(
      Object.keys(g.key)
        .sort()
        .map((k) => [k, g.key[k]]),
    );
    const slot = summed.get(id) ?? { key: g.key, inc: {}, setOnInsert: { ...g.setOnInsert } };
    for (const [field, n] of Object.entries(g.inc)) slot.inc[field] = (slot.inc[field] ?? 0) + n;
    summed.set(id, slot);
  }
  const rows = [...summed.values()].map((s) => ({ ...s.key, ...s.inc, ...s.setOnInsert }));
  const first = [...summed.values()][0];
  const result = await target.bulkUpsert(rows, {
    ...scope,
    key: Object.keys(first?.key ?? {}),
    inc: [...new Set([...summed.values()].flatMap((s) => Object.keys(s.inc)))],
    setOnInsert: [...new Set([...summed.values()].flatMap((s) => Object.keys(s.setOnInsert)))],
  });
  if (result.failed > 0) {
    throw createError(
      500,
      `[mongokit] applyIncrements: ${result.failed} grain(s) failed; the unit of work must abort`,
      {
        code: READ_MODEL_ERROR_CODES.INCREMENT_FAILED,
        meta: { failures: result.results.filter((r) => r.outcome === 'failed') },
      },
    );
  }
  return result;
}

function contextOf(scope: ReadModelScope): RepositoryContext {
  return { operation: 'aggregatePipeline', model: 'read-model', ...scope };
}

/** The target's policy predicate for this scope (tenant + live docs), as equality fields. */
function targetScope<TDoc>(
  target: Repository<TDoc>,
  scope: ReadModelScope,
): Record<string, unknown> {
  const predicate = scopeForCollection(target.Model.collection.collectionName, {
    connection: target.Model.db,
    context: contextOf(scope),
    operation: 'aggregatePipeline',
  });
  if (!predicate) return {};
  const parts = Array.isArray(predicate.$and) ? predicate.$and.filter(isRecord) : [predicate];
  return Object.assign({}, ...parts);
}

export interface RebuildOptions {
  /** Source stages producing one row per read-model grain (with every `on` field except scope fields). */
  pipeline: readonly unknown[];
  /** Fields identifying a grain; must equal a unique index of the target and include its tenant field. */
  on: readonly string[];
  whenMatched?: 'replace' | 'merge';
  /** Caller scope (tenant etc.), applied to the source read and stamped on the target rows. */
  scope?: ReadModelScope;
  session?: unknown;
}

/** Rebuild the scope's slice of `target` from `source` with one `$merge`, then drop stale grains. */
export async function rebuildInto<TSrc, TDoc>(
  source: Repository<TSrc>,
  target: Repository<TDoc>,
  options: RebuildOptions,
): Promise<{ rebuildId: string; removed: number }> {
  const scope = options.scope ?? {};
  if (inTransaction(options.session)) {
    throw createError(500, '[mongokit] rebuildInto: $merge cannot run inside a transaction', {
      code: READ_MODEL_ERROR_CODES.MERGE_IN_TRANSACTION,
    });
  }
  const on = [...options.on];
  const tenantFields = tenantFieldsOf(target.Model);
  const missing = tenantFields.filter((f) => !on.includes(f));
  if (missing.length > 0) {
    throw createError(
      400,
      `[mongokit] rebuildInto: 'on' must include the target's tenant field(s) ${missing.join(', ')}`,
      {
        code: READ_MODEL_ERROR_CODES.ON_MISSING_SCOPE,
      },
    );
  }
  const unique = target.Model.schema
    .indexes()
    .some(([fields, opts]) => opts.unique === true && sameSet(Object.keys(fields), on));
  if (!unique) {
    throw createError(
      400,
      `[mongokit] rebuildInto: $merge needs a unique index on exactly (${on.join(', ')})`,
      {
        code: READ_MODEL_ERROR_CODES.ON_NOT_UNIQUE,
      },
    );
  }
  const rebuildId = randomUUID();
  const stamp = { ...targetScope(target, scope), _rebuildId: rebuildId };
  const stages: unknown[] = [
    ...options.pipeline,
    { $set: stamp },
    {
      $merge: {
        into: target.Model.collection.collectionName,
        on,
        whenMatched: options.whenMatched ?? 'replace',
        whenNotMatched: 'insert',
      },
    },
  ];
  await source.aggregatePipeline(stages, {
    ...scope,
    ...(options.session ? { session: options.session } : {}),
  });
  const stale = await target.deleteMany(
    { _rebuildId: { $ne: rebuildId } },
    { ...scope, ...(options.session ? { session: options.session } : {}) },
  );
  return { rebuildId, removed: stale.deletedCount };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export interface ReconcileOptions {
  pipeline: readonly unknown[];
  on: readonly string[];
  /** Fields compared between the recomputed and the stored row. */
  measures: readonly string[];
  scope?: ReadModelScope;
  /** Refuse past this many rows on either side (both are held in memory). Default 100,000. */
  maxRows?: number;
}

export interface DriftRow {
  key: Record<string, unknown>;
  /** Recomputed measures, `null` when the source produces no such grain. */
  expected: Record<string, unknown> | null;
  /** Stored measures, `null` when the read model lacks the grain. */
  actual: Record<string, unknown> | null;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (isRecord(value) && value._bsontype === 'Decimal128') {
    return String(Number(String(value)));
  }
  return JSON.stringify(value);
}

/** Recompute the scope's grains from `source` and report every one that differs in `target`. */
export async function reconcile<TSrc, TDoc>(
  source: Repository<TSrc>,
  target: Repository<TDoc>,
  options: ReconcileOptions,
): Promise<{ drift: DriftRow[]; compared: number }> {
  const scope = options.scope ?? {};
  const maxRows = options.maxRows ?? 100_000;
  const stamp = targetScope(target, scope);
  const keyFields = options.on.filter((f) => !(f in stamp));
  const pick = (row: Record<string, unknown>, fields: readonly string[]) =>
    Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));
  const id = (row: Record<string, unknown>) => keyFields.map((f) => canonical(row[f])).join('|');

  const expectedRows = await source.aggregatePipeline<Record<string, unknown>>(
    [...options.pipeline, { $limit: maxRows + 1 }],
    scope,
  );
  const actualRows = (
    await target.findAll(
      {},
      {
        ...scope,
        select: [...keyFields, ...options.measures].join(' '),
        limit: maxRows + 1,
        lean: true,
      },
    )
  )
    .map((d): unknown => d)
    .filter(isRecord);
  if (expectedRows.length > maxRows || actualRows.length > maxRows) {
    throw createError(
      500,
      `[mongokit] reconcile: more than ${maxRows} grains in scope; reconcile a narrower scope`,
      {
        code: READ_MODEL_ERROR_CODES.TOO_LARGE,
      },
    );
  }
  const actual = new Map(actualRows.map((r) => [id(r), r]));
  const drift: DriftRow[] = [];
  const seen = new Set<string>();
  for (const e of expectedRows) {
    const k = id(e);
    seen.add(k);
    const a = actual.get(k);
    const differs = !a || options.measures.some((m) => canonical(e[m]) !== canonical(a[m]));
    if (differs) {
      drift.push({
        key: pick(e, keyFields),
        expected: pick(e, options.measures),
        actual: a ? pick(a, options.measures) : null,
      });
    }
  }
  for (const [k, a] of actual) {
    if (!seen.has(k))
      drift.push({ key: pick(a, keyFields), expected: null, actual: pick(a, options.measures) });
  }
  return { drift, compared: expectedRows.length };
}
