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
 *     purge port. It deletes `{ ...filter, _id: { $in: chunk } }` with each row
 *     pinned to its exported `updatedAt` (+ version), so a row that left the
 *     filter or was edited after the read stays hot for the next run.
 *   - **retentionPurge** — when the run carries one, every chunk delete
 *     sends it with an attestation minted from the ids the SINK acknowledged
 *     ({@link createMongoArchiveRun} wraps the sink to record them), which an
 *     `allowArchive` fence accepts and nothing else can produce.
 *
 * 2 round-trips per chunk (Mongo has no DELETE … LIMIT).
 */

import type { ArchivePort, ArchiveSink } from '@classytic/repo-core/repository';
import type { ClientSession, Model } from 'mongoose';
import { attestArchivedChunk, type RetentionPurgeRequest } from '../plugins/retention-purge.js';
import { createError } from '../utils/error.js';
import { keysetFilter, narrowToIds, selectKeysetChunk } from '../utils/id-chunks.js';

/**
 * Minimal slice of `Repository<TDoc>` the port needs. Typed structurally
 * so this module stays decoupled from `../Repository.ts`.
 */
interface ArchivableRepo<TDoc> {
  readonly Model: Model<TDoc>;
  readonly versionField: string;
  deleteMany(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ deletedCount: number }>;
}

const idOf = (doc: unknown): unknown => (doc as { _id: unknown })._id;

const valueAt = (doc: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], doc);

/**
 * The fields that prove a row is unchanged since export: the `updatedAt` mongoose
 * timestamps maintain on every write path, plus the repository's `versionField` when
 * the schema has it. Empty only for a collection declared `immutable`. A collection with
 * no maintained `updatedAt` is refused before the run reads anything.
 */
function archiveChangeTokens(
  model: { modelName: string; timestamps: unknown; hasVersionPath: boolean },
  versionField: string,
  immutable: boolean,
): string[] {
  if (immutable) return [];
  const ts = model.timestamps as boolean | { updatedAt?: boolean | string } | undefined;
  const updatedAt =
    ts === true
      ? 'updatedAt'
      : ts && typeof ts === 'object' && ts.updatedAt !== false
        ? typeof ts.updatedAt === 'string'
          ? ts.updatedAt
          : 'updatedAt'
        : undefined;
  if (!updatedAt) {
    throw createError(
      400,
      `archiveByFilter on '${model.modelName}': the schema maintains no updatedAt (timestamps), so a row ` +
        'edited between export and delete could not be told apart and would be deleted with its edit. ' +
        'Enable timestamps, or pass immutable: true for a collection whose rows never change.',
      { code: 'ARCHIVE_NO_CHANGE_TOKEN', meta: { model: model.modelName } },
    );
  }
  return model.hasVersionPath ? [updatedAt, versionField] : [updatedAt];
}

/** Each exported row pinned to its change tokens: an edited row no longer matches. */
function unchangedSince(
  docs: readonly unknown[],
  tokens: readonly string[],
): Record<string, unknown> {
  return {
    $or: docs.map((doc) => {
      const pin: Record<string, unknown> = { _id: idOf(doc) };
      for (const token of tokens) {
        const value = valueAt(doc, token);
        pin[token] = value === undefined ? { $exists: false } : value;
      }
      return pin;
    }),
  };
}

/**
 * Build the sink + port pair for ONE `archiveByFilter` call. The returned sink
 * forwards to the caller's and records what it acknowledged; the port's delete
 * removes only acknowledged rows still unchanged since export, and throws on any other.
 * Progression is a keyset over `_id`, so a row left live is not revisited by this run.
 */
export function createMongoArchiveRun<TDoc>(
  repo: ArchivableRepo<TDoc>,
  filter: Record<string, unknown>,
  sink: ArchiveSink<TDoc>,
  session: ClientSession | undefined,
  retentionPurge: RetentionPurgeRequest | undefined,
  immutable: boolean,
): { sink: ArchiveSink<TDoc>; port: ArchivePort<TDoc> } {
  const tokens = archiveChangeTokens(
    {
      modelName: repo.Model.modelName,
      timestamps: repo.Model.schema.get('timestamps'),
      hasVersionPath: Boolean(repo.Model.schema.path(repo.versionField)),
    },
    repo.versionField,
    immutable,
  );
  let acknowledged = new Set<string>();
  let cursor: unknown = null;

  const recordingSink: ArchiveSink<TDoc> = {
    async write(docs) {
      await sink.write(docs);
      acknowledged = new Set(docs.map((doc) => String(idOf(doc))));
    },
    ...(sink.flush ? { flush: () => sink.flush?.() ?? Promise.resolve() } : {}),
  };

  const port: ArchivePort<TDoc> = {
    async readChunk(limit: number): Promise<readonly TDoc[]> {
      return selectKeysetChunk(repo.Model, keysetFilter(filter, cursor), limit, { session });
    },

    async deleteChunk(docs: readonly TDoc[]): Promise<number> {
      const ids = docs.map(idOf);
      const unacknowledged = ids.filter((id) => !acknowledged.has(String(id)));
      if (unacknowledged.length > 0) {
        throw new Error(
          `archiveByFilter: refusing to delete ${unacknowledged.length} row(s) the sink did not acknowledge`,
        );
      }
      const narrowed = narrowToIds(filter, ids);
      const result = await repo.deleteMany(
        tokens.length > 0 ? { $and: [narrowed, unchangedSince(docs, tokens)] } : narrowed,
        {
          session,
          bypassTenant: true,
          mode: 'hard',
          ...(retentionPurge
            ? { retentionPurge, archiveAttestation: attestArchivedChunk(ids) }
            : {}),
        },
      );
      // Advance only after the delete: a retried chunk re-reads the same rows.
      if (ids.length > 0) cursor = ids[ids.length - 1];
      return result.deletedCount;
    },
  };

  return { sink: recordingSink, port };
}
