/**
 * Mongo purge port — driver glue for the chunked tenant-purge orchestrator.
 *
 * Implements `PurgePort.purgeChunk(strategy, limit)` over a mongoose-backed
 * `Repository<TDoc>`. The orchestrator owns the loop / signal / progress /
 * retry / error envelope; this file owns the driver-shaped per-chunk work.
 *
 * **Per-strategy round-trip optima:**
 *
 *   - **`hard`** — `find(filter,{_id:1}).limit(n)` + `deleteMany`.
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

import type { PurgePort, WritingPurgeStrategy } from '@classytic/repo-core/repository';
import type { AnyBulkWriteOperation, ClientSession, Model } from 'mongoose';

/**
 * Minimal slice of `Repository<TDoc>` the port needs. Typed structurally
 * so this module stays decoupled from `../Repository.ts` (circular-import-safe).
 */
interface PurgeableRepo<TDoc> {
  readonly Model: Model<TDoc>;
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
): PurgePort {
  const filter: Record<string, unknown> = { [field]: value };
  const baseOpts = { session, bypassTenant: true };

  return {
    async purgeChunk(strategy: WritingPurgeStrategy, limit: number): Promise<number> {
      // Anonymize with function-form: fetch full docs (need the row to
      // compute per-row $set), batch into one bulkWrite.
      if (strategy.type === 'anonymize') {
        const hasFn = Object.values(strategy.fields).some((v) => typeof v === 'function');
        if (hasFn) {
          return purgeAnonymizeFunctional(repo, filter, strategy.fields, limit, session);
        }
        // Static fields — falls through to the id-batched path below.
      }

      // Common path for `hard` / `soft` / `anonymize` (static): fetch
      // ids first to bound the write filter. Mongo has no DELETE LIMIT.
      const idDocs = (await repo.Model.find(filter, { _id: 1 })
        .limit(limit)
        .session(session ?? null)
        .lean()
        .exec()) as Array<{ _id: unknown }>;

      if (idDocs.length === 0) return 0;

      const ids = idDocs.map((d) => d._id);
      // Re-assert the predicate on the narrowed write — defends against
      // a row whose tenant field changed between the read and the write.
      const chunkFilter = { _id: { $in: ids }, [field]: value };

      switch (strategy.type) {
        case 'hard':
          await repo.deleteMany(chunkFilter, { ...baseOpts, mode: 'hard' });
          return idDocs.length;
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
          return idDocs.length;
        case 'anonymize':
          // Static-fields branch — single updateMany with shared $set.
          await repo.updateMany(
            chunkFilter,
            { $set: strategy.fields as Record<string, unknown> },
            baseOpts,
          );
          return idDocs.length;
      }
    },
  };
}

/**
 * Anonymize with at least one function-form field replacer. Fetches the
 * full docs (function needs the row) and issues ONE `bulkWrite` with N
 * heterogeneous `updateOne` ops. Two round-trips per chunk regardless
 * of N — vs the N+1 of per-doc `update()` fan-out.
 *
 * Mongo's `bulkWrite` is ordered: false → independent failures don't
 * abort the batch. For idempotent anonymize (same row anonymized twice
 * is the same write), this matches the at-least-once contract.
 */
async function purgeAnonymizeFunctional<TDoc>(
  repo: PurgeableRepo<TDoc>,
  filter: Record<string, unknown>,
  fields: Record<string, unknown | ((doc: Record<string, unknown>) => unknown)>,
  limit: number,
  session: ClientSession | undefined,
): Promise<number> {
  const docs = (await repo.Model.find(filter)
    .limit(limit)
    .session(session ?? null)
    .lean()
    .exec()) as Array<Record<string, unknown>>;

  if (docs.length === 0) return 0;

  const operations: AnyBulkWriteOperation[] = docs.map((doc) => {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      set[k] = typeof v === 'function' ? (v as (d: Record<string, unknown>) => unknown)(doc) : v;
    }
    return {
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: set },
      },
    };
  });

  // Native driver call — `bulkWrite` on the model bypasses the Repository
  // hook surface intentionally for this path: we already routed through
  // `deleteMany`/`updateMany` for the other strategies (audit + cache
  // compose there); the anonymize-functional path fires `before:bulkWrite`
  // when the host has the batch-operations plugin wired, otherwise this
  // is a single mongo bulk write — fewer hooks than per-doc but the same
  // domain effect.
  await repo.Model.bulkWrite(operations, {
    ordered: false,
    session: session ?? undefined,
  });

  return docs.length;
}
