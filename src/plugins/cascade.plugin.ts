/**
 * Cascade Delete Plugin
 *
 * Automatically deletes related documents when a parent document is deleted.
 *
 * Two routing modes per relation:
 *
 *   1. **Repo-routed (preferred)** — pass `repo: targetRepo` on the relation.
 *      Cascade calls `targetRepo.delete(id, { mode })` / `targetRepo.deleteMany(
 *      query, { mode })`, so the target's `before:delete` / `before:deleteMany`
 *      hooks fire. Multi-tenant scoping, audit logging, cache invalidation,
 *      and the target's own `softDeletePlugin` (with its configured
 *      `deletedField`) all run correctly.
 *
 *   2. **Model-routed (legacy)** — pass `model: 'TargetModelName'`. Cascade
 *      writes directly via `mongoose.models[name].updateMany / deleteMany`,
 *      **bypassing** the target's hooks. Safe only for trivial targets with
 *      no policy plugins. Retained for backwards compatibility — prefer the
 *      repo-routed form for new code.
 *
 * The parent's delete mode propagates: a hard-deleted parent cascades hard,
 * a soft-deleted parent cascades soft — unless `relation.softDelete` overrides
 * the decision per-relation.
 *
 * @example Repo-routed (new)
 * ```ts
 * const productRepo = new Repository(Product, [
 *   methodRegistryPlugin(),
 *   cascadePlugin({
 *     relations: [
 *       { repo: stockEntryRepo,    foreignKey: 'product' },
 *       { repo: stockMovementRepo, foreignKey: 'product' },
 *     ],
 *   }),
 * ]);
 * ```
 *
 * @example Model-routed (legacy)
 * ```ts
 * cascadePlugin({
 *   relations: [
 *     { model: 'StockEntry', foreignKey: 'product' },
 *   ],
 * });
 * ```
 */

import mongoose, { type ClientSession, type Model } from 'mongoose';
import type { ObjectId } from '../types/core.js';
import type { CascadeOptions, CascadeRelation } from '../types/plugin-options.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';
import { collectIds, DEFAULT_ID_CHUNK, idChunks } from '../utils/id-chunks.js';

/** Internal payload for a single cascade operation. */
interface CascadeContext {
  /** Resolved target model (for logging and legacy writes). */
  targetModelName: string;
  /** Session that must thread through every call. */
  session: RepositoryContext['session'];
  /** Whether the cascade target should be soft-deleted. */
  shouldSoftDelete: boolean;
  /** Deleter identity, when available. */
  user?: RepositoryContext['user'];
  /**
   * Top-level scope fields to forward from the parent context to the target's
   * options — e.g. `organizationId`, `tenantId`. Required so the target's
   * multi-tenant plugin can resolve its scope from the cascade call.
   */
  scopeForward: Record<string, unknown>;
}

/**
 * Collect top-level parent-context fields that a target plugin (multi-tenant,
 * audit) will likely need. We can't know the target's contextKey, so we
 * forward a well-known allow-list: `organizationId`, `tenantId`, and `user`.
 * These are the conventions enforced by the built-in plugins.
 */
/**
 * Count referencing documents through the target REPOSITORY, carrying the parent's session
 * and scope.
 *
 * Both are load-bearing and were missing in the first cut:
 *   - without `session`, the count reads OUTSIDE the parent's transaction, so children
 *     created in the same uncommitted transaction are invisible and the guard passes;
 *   - without the forwarded scope, a tenant-scoped target either reads unscoped (refusing a
 *     delete because ANOTHER tenant references the row) or relies on ambient context that a
 *     background job does not have.
 *
 * REFUSES rather than falling back to `Model.countDocuments` when the repository has no
 * `count`: a raw count silently bypasses the target's own policy, which is the thing this
 * guard exists to respect.
 */
async function countReferencing(
  relation: CascadeRelation,
  filter: Record<string, unknown>,
  session: ClientSession | undefined,
  scopeForward: Record<string, unknown>,
): Promise<number> {
  const targetRepo = relation.repo as
    | (RepositoryInstance & {
        count?: (q: Record<string, unknown>, o?: Record<string, unknown>) => Promise<number>;
      })
    | undefined;

  if (!targetRepo || typeof targetRepo.count !== 'function') {
    throw new Error(
      `cascadePlugin: onDelete:'restrict' on '${relation.foreignKey}' needs a repository with ` +
        "`count()` — a raw model count would bypass the target's tenant scoping and policy",
    );
  }

  const options: Record<string, unknown> = { ...scopeForward };
  if (session) options.session = session;
  return targetRepo.count(filter, options);
}

/**
 * ENFORCE that a guarded foreign key is indexed.
 *
 * `restrict` and `detach` issue a query per relation on every delete. MongoDB gives no index
 * for free the way an FK constraint does, so an unindexed `foreignKey` turns each delete into
 * a COLLECTION SCAN of the child collection — invisible in tests (small fixtures) and
 * crippling in production, which is the shape of defect this codebase treats as the default
 * hazard.
 *
 * Documentation was not enough: a type comment saying the key "SHOULD" be indexed stops no
 * scan. This is checked at BIND time, where the declaration is, and THROWS — the policies are
 * opt-in and brand new, so nothing pre-existing can be broken by refusing.
 *
 * Prefix rule, matching Mongo's own: an index on `{a:1, b:1}` serves a query on `a`, so the
 * foreign key qualifies when it is the FIRST key of any declared index. `schema.indexes()`
 * includes path-level `{index: true}` as well as explicit `schema.index(...)` calls.
 */
function assertForeignKeyIndexed(relation: CascadeRelation): void {
  const schema = relation.repo?.Model?.schema as
    | { indexes?: () => Array<[Record<string, unknown>, unknown]> }
    | undefined;
  if (!schema || typeof schema.indexes !== 'function') return; // nothing to inspect

  const indexed = schema.indexes().some(([keys]) => Object.keys(keys)[0] === relation.foreignKey);
  if (indexed) return;

  const target = relation.repo?.Model?.modelName ?? relation.model ?? '<unknown>';
  throw new Error(
    `cascadePlugin: onDelete:'${relation.onDelete}' on '${relation.foreignKey}' requires an index ` +
      `on ${target}.${relation.foreignKey} — the guard queries it on every delete, and Mongo has ` +
      'no foreign-key index. Add `index: true` to the path or a leading `schema.index(...)`.',
  );
}

/**
 * A TTL index on the PROTECTED parent makes `restrict` a promise the plugin cannot keep.
 *
 * `restrict` means "do not delete this document while anything references it". A TTL index
 * means "delete this document N seconds after its date field, server-side". Mongo's expiry
 * thread runs no application code — no repository, no hook, no count — so it will remove a
 * referenced parent and leave every child dangling, silently, at a time nobody chose.
 *
 * The two are a direct contradiction, so this THROWS rather than warns. Refusing at bind time
 * is the only point where anyone can see both declarations at once; at runtime the expiry
 * simply happens.
 *
 * NOTE this is about the PARENT (the repo declaring the relations). A TTL on the CHILD is
 * fine and even useful — expiring children is how references legitimately drain away.
 */
function assertNoTtlOnProtectedParent(repo: RepositoryInstance, relation: CascadeRelation): void {
  const schema = repo.Model?.schema as
    | { indexes?: () => Array<[Record<string, unknown>, Record<string, unknown> | undefined]> }
    | undefined;
  if (!schema || typeof schema.indexes !== 'function') return;

  const ttl = schema.indexes().find(([, options]) => options?.expireAfterSeconds !== undefined);
  if (!ttl) return;

  const parent = repo.Model?.modelName ?? '<unknown>';
  const key = Object.keys(ttl[0])[0];
  throw new Error(
    `cascadePlugin: ${parent} declares onDelete:'restrict' on '${relation.foreignKey}' but also ` +
      `carries a TTL index on '${key}' (expireAfterSeconds). Mongo's expiry runs server-side and ` +
      'fires no hooks, so it would delete a referenced document and orphan its children — the ' +
      'restrict guarantee cannot hold. Remove the TTL, or use a retention sweep that deletes ' +
      'through the repository.',
  );
}

/**
 * `detach` — clear the reference through the target REPOSITORY (`SET NULL`).
 *
 * Routed through `repo.updateMany`, not `repo.Model.updateMany`. The first cut used the raw
 * model while the comment beside it claimed the target's hooks ran: they did not, so tenant
 * policy, audit hooks, cache invalidation and update hooks were all skipped on a write that
 * mutates the child. A comment asserting a guarantee the code does not provide is worse than
 * no comment.
 */
async function detachReferences(
  relation: CascadeRelation,
  filter: Record<string, unknown>,
  ctx: { session: ClientSession | undefined; scopeForward: Record<string, unknown> },
): Promise<void> {
  const update = { $unset: { [relation.foreignKey]: '' } };
  const options: Record<string, unknown> = { ...ctx.scopeForward };
  if (ctx.session) options.session = ctx.session;

  const targetRepo = relation.repo as
    | (RepositoryInstance & {
        updateMany?: (
          q: Record<string, unknown>,
          u: unknown,
          o?: Record<string, unknown>,
        ) => Promise<unknown>;
      })
    | undefined;

  if (targetRepo && typeof targetRepo.updateMany === 'function') {
    await targetRepo.updateMany(filter, update, options);
    return;
  }
  if (targetRepo) {
    throw new Error(
      `cascadePlugin: onDelete:'detach' on '${relation.foreignKey}' needs a repository with ` +
        "`updateMany()` — a raw model update would skip the child's hooks and tenant policy",
    );
  }
  // Legacy model-routed form: documented as hook-bypassing everywhere else in this plugin.
  await mongoose.models[relation.model as string]
    ?.updateMany(filter, update, ctx.session ? { session: ctx.session } : {})
    .exec();
}

function collectScopeForward(context: RepositoryContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (context.organizationId !== undefined) out.organizationId = context.organizationId;
  if ((context as Record<string, unknown>).tenantId !== undefined) {
    out.tenantId = (context as Record<string, unknown>).tenantId;
  }
  if (context.user !== undefined) out.user = context.user;
  return out;
}

/**
 * Cascade delete plugin.
 */
export function cascadePlugin(options: CascadeOptions): Plugin {
  const { relations, parallel = true, batchSize = DEFAULT_ID_CHUNK, logger } = options;

  if (!relations || relations.length === 0) {
    throw new Error('cascadePlugin requires at least one relation');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(
      `cascadePlugin: batchSize must be a positive integer, got ${String(batchSize)}`,
    );
  }

  // Validate shape up front — each relation needs exactly one routing target.
  for (const rel of relations) {
    if (!rel.repo && !rel.model) {
      throw new Error(
        'cascadePlugin: each relation needs either `repo` (preferred) or `model` (legacy)',
      );
    }
    if (!rel.foreignKey) {
      throw new Error('cascadePlugin: each relation needs `foreignKey`');
    }
    /**
     * `restrict` must be able to COUNT the referencing documents before the parent goes,
     * and the legacy model-routed path writes through `mongoose.models[...]` without the
     * target's scoping. A restrict that counted unscoped rows would refuse a delete on
     * evidence from another tenant, so it requires the repo-routed form.
     */
    if (rel.onDelete === 'restrict' && !rel.repo) {
      throw new Error(
        `cascadePlugin: relation on '${rel.foreignKey}' uses onDelete:'restrict', which requires ` +
          "`repo` (the legacy `model` route cannot apply the target's tenant scoping to the count)",
      );
    }
  }

  const restrictions = relations.filter((r) => r.onDelete === 'restrict');
  const detachments = relations.filter((r) => r.onDelete === 'detach');
  /** Everything else keeps the historical behaviour — an absent `onDelete` is `cascade`. */
  const cascades = relations.filter((r) => (r.onDelete ?? 'cascade') === 'cascade');

  return {
    name: 'cascade',

    apply(repo: RepositoryInstance): void {
      /**
       * Bind time, not construction time: the relation carries a repo whose Model (and
       * therefore its schema) is only reliably available once the plugin is applied.
       */
      for (const relation of [...restrictions, ...detachments]) assertForeignKeyIndexed(relation);
      for (const relation of restrictions) assertNoTtlOnProtectedParent(repo, relation);

      // ─────────────────────────────────────────────────────────────────────
      // before:delete — RESTRICT. Refuse while references remain.
      //
      // `before`, not `after`: a refusal issued once the parent is already gone is not a
      // refusal.
      //
      // ## This is an application DELETE GUARD, not `ON DELETE RESTRICT`
      //
      // A real FK constraint is enforced by the storage engine under a predicate lock. This
      // is count-then-delete, so a child inserted between the two survives as a dangling
      // reference:
      //
      //     count children -> 0   |   <concurrent insert of a child>   |   delete parent
      //
      // A transaction narrows but does NOT close that window: MongoDB has no predicate lock,
      // and a document inserted into another collection is not in this transaction's write
      // set, so nothing conflicts. Closing it needs a fence both sides share (a version/guard
      // document the child create also touches), which this plugin does not impose.
      //
      // So: it stops the ORDINARY case — an operator deleting a referenced parent — which is
      // what soft delete was being used to prevent. It is not a concurrency-safe integrity
      // guarantee, and must not be described as one.
      // ─────────────────────────────────────────────────────────────────────
      if (restrictions.length > 0) {
        repo.on('before:delete', async (context: RepositoryContext) => {
          const id = context.id;
          if (!id) return;

          const scopeForward = collectScopeForward(context);

          for (const relation of restrictions) {
            const remaining = await countReferencing(
              relation,
              { [relation.foreignKey]: id },
              context.session as ClientSession | undefined,
              scopeForward,
            );

            if (remaining > 0) {
              const target = relation.repo?.Model?.modelName ?? relation.model ?? '<unknown>';
              const err = new Error(
                `Cannot delete this ${context.model ?? 'document'}: ${remaining} ${target} ` +
                  `record(s) still reference it via '${relation.foreignKey}'. ` +
                  'Remove or reassign them first.',
              ) as Error & { code?: string; details?: Record<string, unknown> };
              // A stable code so a host can map it to 409 rather than parsing prose.
              err.code = 'REFERENCE_RESTRICTED';
              err.details = {
                model: context.model,
                id: String(id),
                referencedBy: target,
                foreignKey: relation.foreignKey,
                count: remaining,
              };
              throw err;
            }
          }
        });
      }

      // ─────────────────────────────────────────────────────────────────────
      // after:delete — cascade for a single deleted document
      // ─────────────────────────────────────────────────────────────────────
      repo.on('after:delete', async (payload: { context: RepositoryContext; result?: unknown }) => {
        const { context } = payload;
        const deletedId = context.id;

        if (!deletedId) {
          logger?.warn?.('Cascade delete skipped: no document ID in context', {
            model: context.model,
          });
          return;
        }

        // Parent behavior drives the default. Hard parent = hard cascade;
        // soft parent (plugin set context.softDeleted) = soft cascade.
        const isSoftParent = context.softDeleted === true;

        const scopeForward = collectScopeForward(context);

        const cascadeOne = async (relation: CascadeRelation) => {
          const shouldSoftDelete = relation.softDelete ?? isSoftParent;
          const cascadeCtx: CascadeContext = {
            targetModelName: relation.repo
              ? (relation.repo.Model?.modelName ?? '<unknown>')
              : (relation.model ?? '<unknown>'),
            session: context.session as ClientSession | undefined,
            shouldSoftDelete,
            user: context.user,
            scopeForward,
          };

          try {
            if (relation.repo) {
              await cascadeViaRepoBulk(relation, deletedId, cascadeCtx);
            } else {
              await cascadeViaLegacyModel(relation, deletedId, cascadeCtx, logger);
            }
          } catch (error) {
            logger?.error?.(`Cascade delete failed for '${cascadeCtx.targetModelName}'`, {
              parentModel: context.model,
              parentId: String(deletedId),
              relatedModel: cascadeCtx.targetModelName,
              foreignKey: relation.foreignKey,
              error: (error as Error).message,
            });
            throw error;
          }
        };

        /**
         * `detach` — the RDBMS `SET NULL`. Clear the pointer, keep the child.
         *
         * Runs beside the cascades and before them in intent: a detached child must not be
         * reachable through a reference to a document that no longer exists. Routed through
         * the target repo so its hooks and scoping apply, exactly as cascade is.
         */
        const detachOne = async (relation: CascadeRelation) =>
          detachReferences(
            relation,
            { [relation.foreignKey]: deletedId },
            {
              session: context.session as ClientSession | undefined,
              scopeForward,
            },
          );

        const txSession = context.session as ClientSession | undefined;
        if (detachments.length > 0) await runCascades(detachments, detachOne, parallel, txSession);
        await runCascades(cascades, cascadeOne, parallel, txSession);
      });

      // ─────────────────────────────────────────────────────────────────────
      // before:deleteMany — snapshot IDs that will be deleted
      // ─────────────────────────────────────────────────────────────────────
      repo.on('before:deleteMany', async (context: RepositoryContext) => {
        const query = context.query as Record<string, unknown>;
        if (!query || Object.keys(query).length === 0) return;

        const idField = ((repo as Record<string, unknown>).idField as string) || '_id';
        // Streamed, not `find().lean()` into an array-of-docs — the snapshot is inherently
        // O(matched) but the transient doubling isn't. See utils/id-chunks.ts.
        const ids = await collectIds(repo.Model as Model<unknown>, query, {
          session: context.session as ClientSession | undefined,
          idField,
        });

        context._cascadeIds = ids;

        /**
         * RESTRICT applies to bulk too — and its absence here was a destructive bug.
         *
         * The first cut split the policies on the single-delete path only and then passed
         * ALL relations to the bulk cascade, so `deleteMany` DELETED the children of a
         * `restrict` relation (and of a `detach` one). Bulk was therefore strictly worse
         * than declaring nothing at all. Checked in the same hook that snapshots the ids,
         * so it cannot be reordered apart from them.
         */
        if (restrictions.length > 0 && ids.length > 0) {
          const scopeForward = collectScopeForward(context);
          for (const relation of restrictions) {
            // Sliced `$in`, SUMMED across slices — the pass case (the common one) must
            // scan every slice anyway to prove zero, and the refusal then reports the
            // TRUE blocker count instead of a first-slice lower bound.
            let remaining = 0;
            for (const chunk of idChunks(ids, batchSize)) {
              remaining += await countReferencing(
                relation,
                { [relation.foreignKey]: { $in: chunk } },
                context.session as ClientSession | undefined,
                scopeForward,
              );
            }
            if (remaining > 0) {
              const target = relation.repo?.Model?.modelName ?? relation.model ?? '<unknown>';
              const err = new Error(
                `Cannot delete these ${context.model ?? 'documents'}: ${remaining} ${target} ` +
                  `record(s) still reference ${ids.length} of them via '${relation.foreignKey}'. ` +
                  'Remove or reassign them first.',
              ) as Error & { code?: string; details?: Record<string, unknown> };
              err.code = 'REFERENCE_RESTRICTED';
              err.details = {
                model: context.model,
                ids: ids.map(String),
                referencedBy: target,
                foreignKey: relation.foreignKey,
                count: remaining,
              };
              throw err;
            }
          }
        }
      });

      // ─────────────────────────────────────────────────────────────────────
      // after:deleteMany — cascade using snapshotted IDs
      // ─────────────────────────────────────────────────────────────────────
      repo.on('after:deleteMany', async (payload: { context: RepositoryContext }) => {
        const { context } = payload;
        const ids = context._cascadeIds as unknown[] | undefined;

        if (!ids || ids.length === 0) return;

        const isSoftParent = context.softDeleted === true;

        const scopeForward = collectScopeForward(context);

        const cascadeBulk = async (relation: CascadeRelation) => {
          const shouldSoftDelete = relation.softDelete ?? isSoftParent;
          const cascadeCtx: CascadeContext = {
            targetModelName: relation.repo
              ? (relation.repo.Model?.modelName ?? '<unknown>')
              : (relation.model ?? '<unknown>'),
            session: context.session as ClientSession | undefined,
            shouldSoftDelete,
            user: context.user,
            scopeForward,
          };

          try {
            if (relation.repo) {
              await cascadeViaRepoBulkMany(relation, ids, batchSize, cascadeCtx);
            } else {
              await cascadeViaLegacyModelMany(relation, ids, batchSize, cascadeCtx, logger);
            }
          } catch (error) {
            logger?.error?.(`Cascade deleteMany failed for '${cascadeCtx.targetModelName}'`, {
              parentModel: context.model,
              relatedModel: cascadeCtx.targetModelName,
              foreignKey: relation.foreignKey,
              error: (error as Error).message,
            });
            throw error;
          }
        };

        /** `detach` in bulk — the same `$unset`, routed through the target repository, sliced. */
        const detachBulk = async (relation: CascadeRelation) => {
          for (const chunk of idChunks(ids, batchSize)) {
            await detachReferences(
              relation,
              { [relation.foreignKey]: { $in: chunk } },
              {
                session: context.session as ClientSession | undefined,
                scopeForward,
              },
            );
          }
        };

        const txSession = context.session as ClientSession | undefined;
        if (detachments.length > 0) await runCascades(detachments, detachBulk, parallel, txSession);
        // `cascades`, NOT `relations` — passing every relation here is what made bulk delete
        // the children of a `restrict`/`detach` declaration.
        await runCascades(cascades, cascadeBulk, parallel, txSession);
      });
    },
  };
}

// ============================================================================
// Routing helpers
// ============================================================================

/**
 * Repo-routed cascade for a single parent delete.
 * Calls `repo.deleteMany({ [fk]: parentId }, { mode })` — respects all target
 * hooks (multi-tenant, audit, target's own soft-delete plugin).
 */
async function cascadeViaRepoBulk(
  relation: CascadeRelation,
  parentId: string | ObjectId | unknown,
  ctx: CascadeContext,
): Promise<void> {
  const targetRepo = relation.repo as RepositoryInstance & {
    deleteMany?: (
      query: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  };

  if (typeof targetRepo.deleteMany !== 'function') {
    throw new Error(
      `cascadePlugin: target repo for '${ctx.targetModelName}' is missing deleteMany(). ` +
        `Ensure the target is a mongokit Repository or implements the StandardRepo deleteMany contract.`,
    );
  }

  await targetRepo.deleteMany(
    { [relation.foreignKey]: parentId },
    {
      ...ctx.scopeForward, // forward organizationId / tenantId / user
      mode: ctx.shouldSoftDelete ? 'soft' : 'hard',
      session: ctx.session as ClientSession | undefined,
    },
  );
}

/**
 * Repo-routed cascade for a bulk parent deleteMany — sliced `$in` over snapshot ids
 * (`batchSize` bounds each query document; see `utils/id-chunks.ts`).
 */
async function cascadeViaRepoBulkMany(
  relation: CascadeRelation,
  parentIds: unknown[],
  batchSize: number,
  ctx: CascadeContext,
): Promise<void> {
  const targetRepo = relation.repo as RepositoryInstance & {
    deleteMany?: (
      query: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  };

  if (typeof targetRepo.deleteMany !== 'function') {
    throw new Error(
      `cascadePlugin: target repo for '${ctx.targetModelName}' is missing deleteMany(). ` +
        `Ensure the target is a mongokit Repository or implements the StandardRepo deleteMany contract.`,
    );
  }

  for (const chunk of idChunks(parentIds, batchSize)) {
    await targetRepo.deleteMany(
      { [relation.foreignKey]: { $in: chunk } },
      {
        ...ctx.scopeForward,
        mode: ctx.shouldSoftDelete ? 'soft' : 'hard',
        session: ctx.session as ClientSession | undefined,
      },
    );
  }
}

/**
 * Legacy cascade via `mongoose.models[name]`. Bypasses target hooks.
 * Retained for backwards compatibility with existing cascadePlugin consumers.
 */
async function cascadeViaLegacyModel(
  relation: CascadeRelation,
  parentId: string | ObjectId | unknown,
  ctx: CascadeContext,
  logger?: CascadeOptions['logger'],
): Promise<void> {
  const RelatedModel = mongoose.models[relation.model as string];
  if (!RelatedModel) {
    logger?.warn?.(`Cascade delete skipped: model '${relation.model}' not found`);
    return;
  }

  const query = { [relation.foreignKey]: parentId };
  if (ctx.shouldSoftDelete) {
    await RelatedModel.updateMany(
      query,
      {
        deletedAt: new Date(),
        ...(ctx.user ? { deletedBy: ctx.user._id || ctx.user.id } : {}),
      },
      { session: ctx.session as ClientSession | undefined },
    );
  } else {
    await RelatedModel.deleteMany(query, { session: ctx.session as ClientSession | undefined });
  }
}

async function cascadeViaLegacyModelMany(
  relation: CascadeRelation,
  parentIds: unknown[],
  batchSize: number,
  ctx: CascadeContext,
  logger?: CascadeOptions['logger'],
): Promise<void> {
  const RelatedModel = mongoose.models[relation.model as string];
  if (!RelatedModel) {
    logger?.warn?.(`Cascade deleteMany skipped: model '${relation.model}' not found`);
    return;
  }

  for (const chunk of idChunks(parentIds, batchSize)) {
    const query = { [relation.foreignKey]: { $in: chunk } };
    if (ctx.shouldSoftDelete) {
      await RelatedModel.updateMany(
        query,
        {
          deletedAt: new Date(),
          ...(ctx.user ? { deletedBy: ctx.user._id || ctx.user.id } : {}),
        },
        { session: ctx.session as ClientSession | undefined },
      );
    } else {
      await RelatedModel.deleteMany(query, { session: ctx.session as ClientSession | undefined });
    }
  }
}

/**
 * Execute a list of cascade operations, honoring the `parallel` flag.
 * Uses `allSettled` so one failure doesn't abort siblings; throws the first
 * rejection (with a composite message if several failed) after all complete.
 *
 * **`parallel` is IGNORED inside a transaction.** A `ClientSession` is not
 * safe for concurrent operations — MongoDB's driver serialises commands per
 * session, and issuing several at once is undefined behaviour that surfaces
 * as transaction-state errors rather than a clean failure. Since cascades
 * began propagating the parent session, `parallel: true` (the default) meant
 * every multi-relation cascade inside `withTransaction()` was doing exactly
 * that. Sequential execution is the only correct mode there, so the flag is
 * downgraded rather than obeyed — the alternative is a throughput option
 * that silently corrupts transactions.
 */
async function runCascades(
  relations: CascadeRelation[],
  fn: (rel: CascadeRelation) => Promise<void>,
  parallel: boolean,
  session?: ClientSession | undefined,
): Promise<void> {
  if (parallel && !session) {
    const results = await Promise.allSettled(relations.map(fn));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length) {
      const err = failures[0].reason as Error;
      if (failures.length > 1) {
        err.message = `${failures.length} cascade deletes failed. First: ${err.message}`;
      }
      throw err;
    }
  } else {
    for (const relation of relations) {
      await fn(relation);
    }
  }
}
