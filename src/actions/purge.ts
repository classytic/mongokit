/**
 * Mongo purge port — driver glue for the chunked tenant-purge orchestrator.
 *
 * Implements `PurgePort.purgeChunk(strategy, limit)` over a mongoose-backed
 * `Repository<TDoc>`. The orchestrator owns the loop / signal / progress /
 * retry / error envelope; this file owns the driver-shaped per-chunk work.
 *
 * **Keyset progression (the PurgePort contract).** Every chunk selects
 * `_id`-ascending with an internal `_id > lastSeen` cursor, so successive
 * calls ADVANCE for every strategy. This is load-bearing for `soft` and
 * `anonymize`: those writes mutate rows that usually still satisfy the base
 * predicate, so a bare `find(filter).limit(n)` re-selects the same first
 * chunk forever and the orchestrator never terminates. `hard` also rides
 * the keyset (harmless — deleted rows can't reappear behind the cursor).
 * The cursor advances only AFTER the chunk's write succeeds: a retried
 * chunk re-selects the same rows (idempotent by outcome). A port instance
 * is single-run state — `Repository` builds a fresh port per call.
 *
 * **Per-strategy round-trip optima:**
 *
 *   - **`hard`** — `find(filter,{_id:1}).sort(_id).limit(n)` + `deleteMany`.
 *     2 round-trips per chunk. Mongo has no `DELETE … LIMIT`; the
 *     SELECT bounds the lock scope.
 *   - **`soft`** — same shape: find ids, `updateMany` with `$set`. 2 RTs.
 *   - **`anonymize` (static fields)** — find ids, `updateMany` with
 *     `$set: fields`. 2 RTs. All N rows get the same patch.
 *   - **`anonymize` (function-form replacers)** — find docs, `bulkWrite`
 *     N heterogeneous `updateOne` ops in a single round-trip. 2 RTs
 *     total per chunk (vs N+1 with per-doc fan-out).
 *
 * **Plugin composition.** The strategy write routes through the kit's
 * `deleteMany` / `updateMany` / `bulkWrite` methods so audit + cache +
 * observability plugins fire. Tenant scoping is bypassed at the inner
 * call (`bypassTenant: true`) because `field = value` IS the authoritative
 * scope — re-scoping would narrow to the wrong tenant.
 */

import type {
  PurgePort,
  TenantPurgeOptions,
  TenantPurgeStrategy,
  WritingPurgeStrategy,
} from '@classytic/repo-core/repository';
import type { ClientSession, Model } from 'mongoose';
import {
  assertRetentionPurgeShape,
  RETENTION_PURGE_ERROR_CODES,
  type RetentionPurgeRequest,
} from '../plugins/retention-purge.js';
import { createError } from '../utils/error.js';
import { keysetFilter, narrowToIds, selectKeysetChunk } from '../utils/id-chunks.js';

/**
 * Per-run options the port forwards to its writes. `retentionPurge` rides
 * every `hard` chunk's `deleteMany` (with `mode: 'hard'`), so
 * `appendOnlyPlugin` / `immutableStatesPlugin` built with `allowPurge` let
 * the chunk through and audit it. Never forwarded to soft / anonymize
 * writes: a purge request never unlocks an edit.
 */
export interface PurgePortOptions {
  retentionPurge?: RetentionPurgeRequest | undefined;
}

/**
 * `purgeByFilter` / `purgeByField` options: repo-core's `TenantPurgeOptions`
 * plus the audited `retentionPurge` (see `SessionOptions.retentionPurge`).
 */
export type RetentionTenantPurgeOptions = TenantPurgeOptions & {
  retentionPurge?: RetentionPurgeRequest | undefined;
};

/**
 * Validates the run's `retentionPurge` up front (before any chunk is
 * selected) and returns the port options. A purge request is a physical
 * delete only: with a `soft` / `anonymize` strategy it is refused.
 */
export function purgePortOptions(
  op: string,
  strategy: TenantPurgeStrategy,
  options: RetentionTenantPurgeOptions,
): PurgePortOptions {
  const raw = options.retentionPurge as unknown;
  if (raw === undefined || raw === null || raw === false) return {};
  const retentionPurge = assertRetentionPurgeShape(raw, op);
  if (strategy.type !== 'hard') {
    throw createError(
      400,
      `'${op}' with retentionPurge must use the 'hard' strategy (got '${strategy.type}').`,
      { code: RETENTION_PURGE_ERROR_CODES.HARD_ONLY, meta: { operation: op } },
    );
  }
  return { retentionPurge };
}

/**
 * Minimal slice of `Repository<TDoc>` the port needs. Typed structurally
 * so this module stays decoupled from `../Repository.ts` (circular-import-safe).
 */
interface PurgeableRepo<TDoc> {
  readonly Model: Model<TDoc>;
  /** Announces what a native bulk write changed, so plugins that track writes (the change log) see it. */
  emitAsync(event: string, data: unknown): Promise<void>;
  deleteMany(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  updateMany(
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Build a `PurgePort` bound to a repository + the `field = value`
 * predicate the purge targets.
 */
export function createMongoPurgePort<TDoc>(
  repo: PurgeableRepo<TDoc>,
  field: string,
  value: unknown,
  session: ClientSession | undefined,
  portOptions: PurgePortOptions = {},
): PurgePort {
  return createKeysetPurgePort(repo, { [field]: value }, session, portOptions);
}

/**
 * Build a `PurgePort` bound to a repository + a pre-compiled Mongo filter
 * (the repository compiles Filter IR via `compileFilterToMongo` before
 * calling this) — the range/filter-scoped sibling of
 * {@link createMongoPurgePort}.
 *
 * The per-strategy chunk logic is IDENTICAL to the equality-bound port; the
 * only difference is the base predicate — an arbitrary compiled filter (a
 * `civilDate` window, a retention cutoff, a compound cohort) instead of
 * `{ [field]: value }`. The narrowed write is re-asserted on
 * `{ _id: { $in: ids }, ...filter }`, the same defense the equality port
 * uses, so a row that leaves the matching set between the id select and the
 * write is never touched.
 *
 * Mirrors `createMongoArchivePort`, which likewise binds a pre-compiled
 * filter rather than a `field/value` pair.
 */
export function createMongoPurgePortFromFilter<TDoc>(
  repo: PurgeableRepo<TDoc>,
  filter: Record<string, unknown>,
  session: ClientSession | undefined,
  portOptions: PurgePortOptions = {},
): PurgePort {
  return createKeysetPurgePort(repo, filter, session, portOptions);
}

/**
 * Shared keyset-progressed port both public factories delegate to. The
 * closure's `cursor` is the port's single-run progression state.
 */
function createKeysetPurgePort<TDoc>(
  repo: PurgeableRepo<TDoc>,
  baseFilter: Record<string, unknown>,
  session: ClientSession | undefined,
  portOptions: PurgePortOptions,
): PurgePort {
  const baseOpts = { session, bypassTenant: true };
  const hardOpts = {
    ...baseOpts,
    mode: 'hard',
    ...(portOptions.retentionPurge ? { retentionPurge: portOptions.retentionPurge } : {}),
  };
  // Keyset cursor: the highest `_id` whose chunk COMMITTED. Selection is
  // `_id`-ascending, so `$gt: cursor` never revisits a processed row and
  // never skips an unprocessed one (ids are immutable; new rows inserted
  // behind the cursor are a concurrent-write race the run's snapshot
  // semantics already exclude).
  let cursor: unknown = null;

  const selectFilter = (): Record<string, unknown> => keysetFilter(baseFilter, cursor);

  return {
    async purgeChunk(strategy: WritingPurgeStrategy, limit: number): Promise<number> {
      // Anonymize with function-form: fetch full docs (need the row to
      // compute per-row $set), batch into one bulkWrite.
      if (strategy.type === 'anonymize') {
        const hasFn = Object.values(strategy.fields).some((v) => typeof v === 'function');
        if (hasFn) {
          const { processed, lastId } = await purgeAnonymizeFunctional(
            repo,
            selectFilter(),
            baseFilter,
            strategy.fields,
            limit,
            session,
            baseOpts,
          );
          if (lastId != null) cursor = lastId;
          return processed;
        }
        // Static fields — falls through to the id-batched path below.
      }

      // Common path for `hard` / `soft` / `anonymize` (static): fetch
      // ids first to bound the write filter. Mongo has no DELETE LIMIT.
      const idDocs = (await selectKeysetChunk(repo.Model, selectFilter(), limit, {
        session,
        projection: { _id: 1 },
      })) as Array<{ _id: unknown }>;

      if (idDocs.length === 0) return 0;

      const ids = idDocs.map((d) => d._id);
      const chunkFilter = narrowToIds(baseFilter, ids);

      switch (strategy.type) {
        case 'hard':
          await repo.deleteMany(chunkFilter, hardOpts);
          break;
        case 'soft':
          await repo.updateMany(
            chunkFilter,
            {
              $set: {
                [strategy.deletedField ?? 'deleted']: true,
                [strategy.deletedAtField ?? 'deletedAt']: new Date(),
              },
            },
            baseOpts,
          );
          break;
        case 'anonymize':
          // Static-fields branch — single updateMany with shared $set.
          await repo.updateMany(
            chunkFilter,
            { $set: strategy.fields as Record<string, unknown> },
            baseOpts,
          );
          break;
      }

      // Commit the keyset ONLY after the write succeeded — a thrown write
      // leaves the cursor put, so the orchestrator's retry re-selects the
      // same chunk (at-least-once, idempotent by outcome).
      cursor = ids[ids.length - 1];
      return idDocs.length;
    },
  };
}

/**
 * Anonymize with at least one function-form field replacer. Fetches the
 * full docs (function needs the row), computes each row's values, and
 * writes the chunk with ONE `repo.updateMany` whose pipeline picks each
 * row's value by its `_id`. Two round-trips per chunk regardless of N.
 *
 * Through the repository, never a raw `Model.bulkWrite`: the write meets
 * the same `before:updateMany` fences as the static form —
 * `immutableStatesPlugin` refuses a chunk holding a frozen row,
 * `appendOnlyPlugin` refuses the edit, tenant / soft-delete scope apply —
 * and `after:updateMany` reaches the change log, cache and audit plugins.
 *
 * Selection is `_id`-ascending against the caller's keyset-narrowed
 * filter; returns the chunk's last `_id` so the port can advance its
 * cursor after the write commits. Values are cast by the field's schema
 * type where it is a scalar (a pipeline update is not cast by mongoose);
 * `undefined` is written as `null`. Idempotent per row, so the
 * at-least-once contract holds.
 */
async function purgeAnonymizeFunctional<TDoc>(
  repo: PurgeableRepo<TDoc>,
  selectFilter: Record<string, unknown>,
  baseFilter: Record<string, unknown>,
  fields: Record<string, unknown | ((doc: Record<string, unknown>) => unknown)>,
  limit: number,
  session: ClientSession | undefined,
  writeOpts: Record<string, unknown>,
): Promise<{ processed: number; lastId: unknown }> {
  const docs = (await selectKeysetChunk(repo.Model, selectFilter, limit, {
    session,
  })) as Array<Record<string, unknown>>;

  if (docs.length === 0) return { processed: 0, lastId: null };

  const ids = docs.map((doc) => doc._id);
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const values = docs.map((doc) =>
      castScalar(
        repo.Model,
        k,
        typeof v === 'function' ? (v as (d: Record<string, unknown>) => unknown)(doc) : v,
      ),
    );
    // This row's value: its position in the chunk's id list picks it from the value list.
    set[k] = {
      $let: {
        vars: { i: { $indexOfArray: [{ $literal: ids }, '$_id'] } },
        in: { $arrayElemAt: [{ $literal: values }, '$$i'] },
      },
    };
  }

  await repo.updateMany(narrowToIds(baseFilter, ids), [{ $set: set }] as never, {
    ...writeOpts,
    updatePipeline: true,
  });

  return { processed: docs.length, lastId: docs[docs.length - 1]?._id ?? null };
}

/** Scalar schema types a pipeline write must be cast to by hand (mongoose casts `$set`, not pipelines). */
const SCALAR_INSTANCES = new Set([
  'String',
  'Number',
  'Date',
  'Boolean',
  'ObjectId',
  'ObjectID',
  'Decimal128',
  'UUID',
  'BigInt',
  'Double',
  'Int32',
]);

function castScalar<TDoc>(model: Model<TDoc>, path: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const type = model.schema.path(path) as
    | { instance?: string; cast?: (v: unknown) => unknown }
    | undefined;
  if (!type?.instance || !SCALAR_INSTANCES.has(type.instance) || !type.cast) return value;
  return type.cast(value);
}
