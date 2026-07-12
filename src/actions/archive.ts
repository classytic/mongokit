/**
 * Mongo archive port — driver glue for the chunked cold-storage
 * orchestrator (`runChunkedArchive` in `@classytic/repo-core`).
 *
 * The orchestrator owns the loop / write-before-delete ordering / signal /
 * progress / retry envelope; this file owns the driver-shaped per-chunk
 * work:
 *
 *   - **readChunk** — `find(filter).sort({_id: 1}).limit(n).lean()`.
 *     Lean on purpose: sinks receive plain JSON-ready objects, not
 *     hydrated mongoose documents. `_id` ordering keeps chunk progression
 *     deterministic. Raw Model access (plugin-bypass invariant): the
 *     caller's filter is the authoritative predicate — tenant re-scoping
 *     would narrow the archive to the wrong slice.
 *   - **deleteChunk** — routed through the repo's `deleteMany`
 *     (`bypassTenant: true`, `mode: 'hard'`) so audit / cache /
 *     observability plugins fire on the destructive half, mirroring the
 *     purge port.
 *
 * 2 round-trips per chunk (Mongo has no DELETE … LIMIT). For very large
 * archives prefer running against a secondary read preference for the
 * read half — pass a pre-scoped repo or use the session option upstream.
 */

import type { ArchivePort } from '@classytic/repo-core/repository';
import type { ClientSession, Model } from 'mongoose';

/**
 * Minimal slice of `Repository<TDoc>` the port needs. Typed structurally
 * so this module stays decoupled from `../Repository.ts`.
 */
interface ArchivableRepo<TDoc> {
  readonly Model: Model<TDoc>;
  deleteMany(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ deletedCount: number }>;
}

/**
 * Build an `ArchivePort` bound to a repository + a pre-compiled Mongo
 * filter (the repository compiles Filter IR before calling this).
 */
export function createMongoArchivePort<TDoc>(
  repo: ArchivableRepo<TDoc>,
  filter: Record<string, unknown>,
  session: ClientSession | undefined,
): ArchivePort<TDoc> {
  return {
    async readChunk(limit: number): Promise<readonly TDoc[]> {
      return (await repo.Model.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .session(session ?? null)
        .lean()
        .exec()) as TDoc[];
    },

    async deleteChunk(docs: readonly TDoc[]): Promise<number> {
      const ids = docs.map((doc) => (doc as { _id: unknown })._id);
      // Re-assert the predicate on the narrowed write — defends against
      // a row that left the matching set between read and delete.
      const result = await repo.deleteMany(
        { ...filter, _id: { $in: ids } },
        { session, bypassTenant: true, mode: 'hard' },
      );
      return result.deletedCount;
    },
  };
}
