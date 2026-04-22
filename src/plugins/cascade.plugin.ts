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

import mongoose, { type ClientSession } from 'mongoose';
import type {
  CascadeOptions,
  CascadeRelation,
  ObjectId,
  Plugin,
  RepositoryContext,
  RepositoryInstance,
} from '../types.js';

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
  const { relations, parallel = true, logger } = options;

  if (!relations || relations.length === 0) {
    throw new Error('cascadePlugin requires at least one relation');
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
  }

  return {
    name: 'cascade',

    apply(repo: RepositoryInstance): void {
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

        await runCascades(relations, cascadeOne, parallel);
      });

      // ─────────────────────────────────────────────────────────────────────
      // before:deleteMany — snapshot IDs that will be deleted
      // ─────────────────────────────────────────────────────────────────────
      repo.on('before:deleteMany', async (context: RepositoryContext) => {
        const query = context.query as Record<string, unknown>;
        if (!query || Object.keys(query).length === 0) return;

        const idField = ((repo as Record<string, unknown>).idField as string) || '_id';
        const docs = await repo.Model.find(query, { [idField]: 1 })
          .lean()
          .session((context.session ?? null) as ClientSession | null);
        const ids = docs.map((doc: Record<string, unknown>) => doc[idField]);

        context._cascadeIds = ids;
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
              await cascadeViaRepoBulkMany(relation, ids, cascadeCtx);
            } else {
              await cascadeViaLegacyModelMany(relation, ids, cascadeCtx, logger);
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

        await runCascades(relations, cascadeBulk, parallel);
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
 * Repo-routed cascade for a bulk parent deleteMany — `$in` over snapshot ids.
 */
async function cascadeViaRepoBulkMany(
  relation: CascadeRelation,
  parentIds: unknown[],
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
    { [relation.foreignKey]: { $in: parentIds } },
    {
      ...ctx.scopeForward,
      mode: ctx.shouldSoftDelete ? 'soft' : 'hard',
      session: ctx.session as ClientSession | undefined,
    },
  );
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
  ctx: CascadeContext,
  logger?: CascadeOptions['logger'],
): Promise<void> {
  const RelatedModel = mongoose.models[relation.model as string];
  if (!RelatedModel) {
    logger?.warn?.(`Cascade deleteMany skipped: model '${relation.model}' not found`);
    return;
  }

  const query = { [relation.foreignKey]: { $in: parentIds } };
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

/**
 * Execute a list of cascade operations, honoring the `parallel` flag.
 * Uses `allSettled` so one failure doesn't abort siblings; throws the first
 * rejection (with a composite message if several failed) after all complete.
 */
async function runCascades(
  relations: CascadeRelation[],
  fn: (rel: CascadeRelation) => Promise<void>,
  parallel: boolean,
): Promise<void> {
  if (parallel) {
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
