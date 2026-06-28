/**
 * cascadePurgeReferences — imperative, multi-relation "purge by reference".
 *
 * Given a value (typically an id) and a set of relations (each a target +
 * the field that references the value), purge every matching row. The
 * imperative sibling of `cascadePlugin` (which is Repository-delete-EVENT
 * driven): use this when the delete happens OUTSIDE a mongokit Repository —
 * e.g. a Better Auth `user.delete` hook, where BA deletes its own `user` row
 * and the app must clean up its FK-referencing collections (Mongo has no
 * foreign-key cascades; SQL kits get this for free via `onDelete: 'cascade'`).
 *
 * Composition, not duplication:
 *   - **repo-routed** relations reuse repo-core's `runChunkedPurge` +
 *     `createMongoPurgePort` → chunking, soft/anonymize strategies, plugin
 *     hooks (audit / cache), and tenant-bypass all come from the existing
 *     layers. No purge logic is re-implemented here.
 *   - **collection-routed** relations hit a raw `Collection` (for BA-owned
 *     tables that have no Repository) with a direct deleteMany / updateMany.
 *   - id matching uses `idVariants` so a value stored as either a hex string
 *     or an ObjectId is caught.
 *
 * Never throws for in-strategy failures (mirrors `runChunkedPurge`): each
 * relation returns a `{ ok, error }` line so a partial failure doesn't abort
 * siblings and the caller can log/inspect the full report.
 */

import { runChunkedPurge, type WritingPurgeStrategy } from '@classytic/repo-core/repository';
import type { ClientSession } from 'mongoose';
import { idVariants } from '../utils/id-resolution.js';
import { createMongoPurgePort } from './purge.js';

export type PurgeMode = 'hard' | 'soft' | 'anonymize';

/** Raw collection surface — a native MongoDB `Collection` or a Mongoose `Model`. */
export interface CollectionRWLike {
  readonly collectionName?: string;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount?: number }>;
}

/** Repository surface for the policy-preserving path (matches `createMongoPurgePort`). */
export interface PurgeableRepoLike {
  readonly Model: { readonly modelName?: string };
  deleteMany(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  updateMany(
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ReferenceRelation {
  /** Policy-preserving target — a mongokit Repository (chunked via repo-core). */
  repo?: PurgeableRepoLike;
  /** Raw target — a collection with no Repository (e.g. a Better Auth table). */
  collection?: CollectionRWLike;
  /** Field on the target holding the reference id. */
  field: string;
  /** Override the call-level `mode` for this relation. */
  mode?: PurgeMode;
  /** `$set` patch applied when the resolved mode is `'anonymize'`. */
  anonymizeFields?: Record<string, unknown>;
  /** Soft-delete field names (default `'deleted'` / `'deletedAt'`). */
  softDeletedField?: string;
  softDeletedAtField?: string;
}

export interface CascadePurgeReferencesOptions {
  /** The value every relation's `field` is matched against (usually an id). */
  value: unknown;
  /** Targets to purge. */
  relations: ReferenceRelation[];
  /** Default mode for relations without an override. Default `'hard'`. */
  mode?: PurgeMode;
  /** Also match the ObjectId/hex variant of `value`. Default `true`. */
  matchIdVariants?: boolean;
  /** Run relations concurrently. Default `true`. */
  parallel?: boolean;
  /** Chunk size for repo-routed relations. Default `1000`. */
  batchSize?: number;
  session?: ClientSession;
}

export interface ReferencePurgeResult {
  /** Model or collection name. */
  target: string;
  field: string;
  mode: PurgeMode;
  /** Rows deleted (hard) or modified (soft / anonymize). */
  affected: number;
  ok: boolean;
  error?: string;
}

function toStrategy(mode: PurgeMode, rel: ReferenceRelation): WritingPurgeStrategy {
  if (mode === 'soft') {
    return {
      type: 'soft',
      deletedField: rel.softDeletedField,
      deletedAtField: rel.softDeletedAtField,
    };
  }
  if (mode === 'anonymize') {
    return { type: 'anonymize', fields: rel.anonymizeFields ?? {} };
  }
  return { type: 'hard' };
}

async function purgeRelation(
  rel: ReferenceRelation,
  match: unknown,
  defaultMode: PurgeMode,
  ctx: { session?: ClientSession; batchSize?: number },
): Promise<ReferencePurgeResult> {
  const mode = rel.mode ?? defaultMode;
  const target = rel.repo
    ? (rel.repo.Model?.modelName ?? '<repo>')
    : (rel.collection?.collectionName ?? '<collection>');

  if (!rel.repo && !rel.collection) {
    return {
      target: '<unrouted>',
      field: rel.field,
      mode,
      affected: 0,
      ok: false,
      error: 'relation needs `repo` or `collection`',
    };
  }

  try {
    if (rel.repo) {
      // Policy-preserving path: repo-core owns chunking + strategy + hooks.
      // `PurgeableRepoLike` is the public minimal surface; bridge it to the
      // (unexported) repo shape `createMongoPurgePort` expects.
      const repo = rel.repo as unknown as Parameters<typeof createMongoPurgePort>[0];
      const port = createMongoPurgePort(repo, rel.field, match, ctx.session);
      const r = await runChunkedPurge(
        toStrategy(mode, rel),
        { batchSize: ctx.batchSize ?? 1000 },
        port,
      );
      return {
        target,
        field: rel.field,
        mode,
        affected: r.processed,
        ok: r.ok,
        error: r.error?.message,
      };
    }

    // Raw path — a collection without a Repository.
    const col = rel.collection as CollectionRWLike;
    const filter = { [rel.field]: match };
    if (mode === 'hard') {
      const res = await col.deleteMany(filter);
      return { target, field: rel.field, mode, affected: res.deletedCount ?? 0, ok: true };
    }
    const update =
      mode === 'soft'
        ? {
            $set: {
              [rel.softDeletedField ?? 'deleted']: true,
              [rel.softDeletedAtField ?? 'deletedAt']: new Date(),
            },
          }
        : { $set: rel.anonymizeFields ?? {} };
    const res = await col.updateMany(filter, update);
    return { target, field: rel.field, mode, affected: res.modifiedCount ?? 0, ok: true };
  } catch (err) {
    return {
      target,
      field: rel.field,
      mode,
      affected: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Purge every relation that references `value`. Returns a per-relation report
 * (never rejects for in-strategy errors). Pass arrays/objects as actual values.
 *
 * @example Better Auth user-delete cleanup (raw collections, hard delete):
 * ```ts
 * await cascadePurgeReferences({
 *   value: userId,
 *   relations: [
 *     { collection: db.collection('downloadgrants'), field: 'customerId' },
 *     { collection: db.collection('enrollments'),    field: 'customerId' },
 *     { collection: db.collection('member'),         field: 'userId' },
 *   ],
 * });
 * ```
 */
export async function cascadePurgeReferences(
  options: CascadePurgeReferencesOptions,
): Promise<ReferencePurgeResult[]> {
  const {
    value,
    relations,
    mode = 'hard',
    matchIdVariants = true,
    parallel = true,
    session,
    batchSize,
  } = options;
  if (!relations?.length || value === undefined || value === null) return [];

  const variants = matchIdVariants ? idVariants(value) : [value];
  const match = variants.length > 1 ? { $in: variants } : variants[0];
  const ctx = { session, batchSize };

  if (parallel) {
    // purgeRelation catches internally → Promise.all never rejects.
    return Promise.all(relations.map((rel) => purgeRelation(rel, match, mode, ctx)));
  }
  const out: ReferencePurgeResult[] = [];
  for (const rel of relations) out.push(await purgeRelation(rel, match, mode, ctx));
  return out;
}
