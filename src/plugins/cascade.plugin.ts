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
import type { CascadeOptions, CascadeRelation } from '../types/plugin-options.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';
import { collectIds, DEFAULT_ID_CHUNK, idChunks } from '../utils/id-chunks.js';
import { forwardScope, type RepoScope, tenantContextKeysOf } from '../utils/scope.js';

/**
 * The parent values each relation's `foreignKey` stores, keyed by `parentKey`,
 * captured BEFORE the parent is deleted. One delete and a `deleteMany` both
 * reduce to this, so restrict, detach and cascade each have ONE implementation.
 */
type ParentKeys = Map<string, unknown[]>;

/** The repository's own id field — the default `parentKey`. */
function idFieldOf(repo: RepositoryInstance): string {
  return ((repo as Record<string, unknown>).idField as string | undefined) || '_id';
}

const parentKeyOf = (relation: CascadeRelation, repo: RepositoryInstance): string =>
  relation.parentKey ?? idFieldOf(repo);

/** `{ fk: v }` for one parent (the shape a target's hooks expect), a sliced `$in` otherwise. */
const referencing = (
  relation: CascadeRelation,
  chunk: readonly unknown[],
): Record<string, unknown> => ({
  [relation.foreignKey]: chunk.length === 1 ? chunk[0] : { $in: chunk },
});

const targetNameOf = (relation: CascadeRelation): string =>
  relation.repo?.Model?.modelName ?? relation.model ?? '<unknown>';

/**
 * Parent key values for ONE id-addressed delete.
 *
 * The key the call was addressed by is already known (`context.id`). Any other
 * key a relation needs (`parentKey: '_id'` on an `orderNumber` repo) is read from
 * the target document, before the delete, through `loadTarget` (shared with
 * every other hook, under the operation's session).
 */
async function parentKeysOfDelete(
  context: RepositoryContext,
  repo: RepositoryInstance,
  keys: ReadonlySet<string>,
): Promise<ParentKeys> {
  const out: ParentKeys = new Map();
  const addressedBy =
    ((context as Record<string, unknown>).idField as string | undefined) ?? idFieldOf(repo);
  const needsRead = [...keys].some((key) => key !== addressedBy);
  const target = needsRead
    ? ((await context.loadTarget?.()) ??
      ((await (repo.Model as Model<unknown>)
        .findOne({ [addressedBy]: context.id }, null, {
          session: context.session as ClientSession | undefined,
        })
        .lean()) as Record<string, unknown> | null))
    : null;
  for (const key of keys) {
    const value = key === addressedBy ? context.id : target?.[key];
    out.set(key, value === undefined || value === null ? [] : [value]);
  }
  return out;
}

/** Parent key values for a `deleteMany` — streamed from the (already tenant-scoped) filter. */
async function parentKeysOfDeleteMany(
  context: RepositoryContext,
  repo: RepositoryInstance,
  keys: ReadonlySet<string>,
): Promise<ParentKeys> {
  const out: ParentKeys = new Map();
  for (const key of keys) {
    out.set(
      key,
      await collectIds(repo.Model as Model<unknown>, context.query as Record<string, unknown>, {
        session: context.session as ClientSession | undefined,
        idField: key,
      }),
    );
  }
  return out;
}

type ScopedRepo = RepositoryInstance & {
  count?: (q: Record<string, unknown>, o?: Record<string, unknown>) => Promise<number>;
  updateMany?: (
    q: Record<string, unknown>,
    u: unknown,
    o?: Record<string, unknown>,
  ) => Promise<unknown>;
  deleteMany?: (q: Record<string, unknown>, o?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * RESTRICT — refuse while any child still references a parent being deleted.
 *
 * Counted through the target REPOSITORY with the forwarded scope and session:
 * a raw model count would bypass the target's tenant scoping (refusing on
 * another tenant's evidence) or read outside the transaction (missing children
 * created in it). Sliced `$in`, SUMMED, so the refusal reports the true count.
 *
 * ## An application delete GUARD, not `ON DELETE RESTRICT`
 *
 * This is count-then-delete. A child inserted between the two survives as a
 * dangling reference, and a transaction narrows but does not close that window
 * (Mongo has no predicate lock; the child's insert is not in this write set).
 * It stops the ordinary case, an operator deleting a referenced parent, and must
 * not be described as a concurrency-safe integrity guarantee.
 */
async function assertUnreferenced(
  relation: CascadeRelation,
  values: readonly unknown[],
  scope: RepoScope,
  batchSize: number,
  context: RepositoryContext,
  single: boolean,
): Promise<void> {
  const target = relation.repo as ScopedRepo | undefined;
  if (typeof target?.count !== 'function') {
    throw new Error(
      `cascadePlugin: onDelete:'restrict' on '${relation.foreignKey}' needs a repository with ` +
        "`count()` — a raw model count would bypass the target's tenant scoping and policy",
    );
  }
  let remaining = 0;
  for (const chunk of idChunks(values, batchSize)) {
    remaining += await target.count(referencing(relation, chunk), { ...scope });
  }
  if (remaining === 0) return;

  const referencedBy = targetNameOf(relation);
  const err = new Error(
    single
      ? `Cannot delete this ${context.model ?? 'document'}: ${remaining} ${referencedBy} record(s) ` +
          `still reference it via '${relation.foreignKey}'. Remove or reassign them first.`
      : `Cannot delete these ${context.model ?? 'documents'}: ${remaining} ${referencedBy} record(s) ` +
          `still reference ${values.length} of them via '${relation.foreignKey}'. Remove or reassign them first.`,
  ) as Error & { code?: string; details?: Record<string, unknown> };
  // A stable code so a host can map it to 409 rather than parsing prose.
  err.code = 'REFERENCE_RESTRICTED';
  err.details = {
    model: context.model,
    ...(single ? { id: String(context.id) } : { ids: values.map(String) }),
    referencedBy,
    foreignKey: relation.foreignKey,
    count: remaining,
  };
  throw err;
}

/**
 * DETACH — the RDBMS `SET NULL`: clear the pointer, keep the child.
 *
 * Through the target repository's `updateMany`, so its tenant policy, audit,
 * cache and update hooks run. A repo without one is refused rather than written
 * raw; the legacy `model` route is documented as hook-bypassing.
 */
async function detach(
  relation: CascadeRelation,
  values: readonly unknown[],
  scope: RepoScope,
  batchSize: number,
): Promise<void> {
  const update = { $unset: { [relation.foreignKey]: '' } };
  const target = relation.repo as ScopedRepo | undefined;
  if (target && typeof target.updateMany !== 'function') {
    throw new Error(
      `cascadePlugin: onDelete:'detach' on '${relation.foreignKey}' needs a repository with ` +
        "`updateMany()` — a raw model update would skip the child's hooks and tenant policy",
    );
  }
  for (const chunk of idChunks(values, batchSize)) {
    const filter = referencing(relation, chunk);
    if (target?.updateMany) await target.updateMany(filter, update, { ...scope });
    else
      await mongoose.models[relation.model as string]
        ?.updateMany(filter, update, { session: scope.session })
        .exec();
  }
}

/**
 * CASCADE — delete the children, soft when the parent was soft (or the relation
 * says so).
 *
 * Repo-routed: `target.deleteMany` with the forwarded scope, so the target's own
 * tenant policy, audit and soft-delete plugin (with ITS `deletedField`) apply.
 * Legacy `model` route: a raw write that bypasses the target's hooks.
 */
async function cascade(
  relation: CascadeRelation,
  values: readonly unknown[],
  scope: RepoScope,
  batchSize: number,
  soft: boolean,
  logger: CascadeOptions['logger'],
): Promise<void> {
  const target = relation.repo as ScopedRepo | undefined;
  if (target && typeof target.deleteMany !== 'function') {
    throw new Error(
      `cascadePlugin: target repo for '${targetNameOf(relation)}' is missing deleteMany(). ` +
        'Ensure the target is a mongokit Repository or implements the StandardRepo deleteMany contract.',
    );
  }
  const RelatedModel = target ? undefined : mongoose.models[relation.model as string];
  if (!target && !RelatedModel) {
    logger?.warn?.(`Cascade delete skipped: model '${relation.model}' not found`);
    return;
  }
  const user = scope.user as { _id?: unknown; id?: unknown } | undefined;
  for (const chunk of idChunks(values, batchSize)) {
    const filter = referencing(relation, chunk);
    if (target?.deleteMany) {
      await target.deleteMany(filter, { ...scope, mode: soft ? 'soft' : 'hard' });
    } else if (soft) {
      await RelatedModel?.updateMany(
        filter,
        { deletedAt: new Date(), ...(user ? { deletedBy: user._id || user.id } : {}) },
        { session: scope.session },
      );
    } else {
      await RelatedModel?.deleteMany(filter, { session: scope.session });
    }
  }
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
     * `restrict` must COUNT the referencing documents through the target's scoping;
     * the legacy `model` route cannot, and would refuse on another tenant's evidence.
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
  /** An absent `onDelete` is `cascade`, the historical behaviour. */
  const cascades = relations.filter((r) => (r.onDelete ?? 'cascade') === 'cascade');

  return {
    name: 'cascade',

    apply(repo: RepositoryInstance): void {
      // Bind time: the relation's repo (and so its schema) is reliably available here.
      for (const relation of [...restrictions, ...detachments]) assertForeignKeyIndexed(relation);
      for (const relation of restrictions) assertNoTtlOnProtectedParent(repo, relation);

      const keys = new Set(relations.map((relation) => parentKeyOf(relation, repo)));
      /** Tenant keys of the parent AND every target, so each hop carries what its plugin reads. */
      const tenantKeys = tenantContextKeysOf(repo, ...relations.map((relation) => relation.repo));
      const scopeOf = (context: RepositoryContext): RepoScope =>
        forwardScope(context as Record<string, unknown>, tenantKeys);

      /**
       * BEFORE the parent goes: capture the key values (they cannot be read after a
       * hard delete) and refuse on a restrict. `before`, because a refusal issued
       * once the parent is gone is not a refusal.
       */
      const prepare = async (context: RepositoryContext, single: boolean): Promise<void> => {
        const parentKeys = single
          ? await parentKeysOfDelete(context, repo, keys)
          : await parentKeysOfDeleteMany(context, repo, keys);
        context._cascadeParentKeys = parentKeys;

        const scope = scopeOf(context);
        for (const relation of restrictions) {
          const values = parentKeys.get(parentKeyOf(relation, repo)) ?? [];
          if (values.length > 0)
            await assertUnreferenced(relation, values, scope, batchSize, context, single);
        }
      };

      /** AFTER: detach, then cascade — over the captured values, with the forwarded scope. */
      const propagate = async (context: RepositoryContext): Promise<void> => {
        const parentKeys = context._cascadeParentKeys;
        if (!parentKeys) return;
        const scope = scopeOf(context);
        const soft = context.softDeleted === true;
        const session = context.session as ClientSession | undefined;
        const valuesOf = (relation: CascadeRelation) =>
          parentKeys.get(parentKeyOf(relation, repo)) ?? [];

        const guarded =
          (verb: string, fn: (relation: CascadeRelation) => Promise<void>) =>
          async (relation: CascadeRelation) => {
            if (valuesOf(relation).length === 0) return;
            try {
              await fn(relation);
            } catch (error) {
              logger?.error?.(`Cascade ${verb} failed for '${targetNameOf(relation)}'`, {
                parentModel: context.model,
                relatedModel: targetNameOf(relation),
                foreignKey: relation.foreignKey,
                error: (error as Error).message,
              });
              throw error;
            }
          };

        // Detach first: a kept child must never point at a parent that no longer exists.
        await runCascades(
          detachments,
          guarded('detach', (relation) => detach(relation, valuesOf(relation), scope, batchSize)),
          parallel,
          session,
        );
        // `cascades`, never `relations`: passing every relation deleted the children of
        // a `restrict` / `detach` declaration.
        await runCascades(
          cascades,
          guarded('delete', (relation) =>
            cascade(
              relation,
              valuesOf(relation),
              scope,
              batchSize,
              relation.softDelete ?? soft,
              logger,
            ),
          ),
          parallel,
          session,
        );
      };

      repo.on('before:delete', (context: RepositoryContext) => {
        if (context.id === undefined || context.id === null) return;
        return prepare(context, true);
      });
      repo.on('after:delete', async (payload: { context: RepositoryContext; result?: unknown }) => {
        // A MISS deleted nothing (absent, or another tenant's row), so there is nothing
        // to cascade. The hook fires on a miss too; without this, it cascaded anyway.
        if (!payload.result) return;
        await propagate(payload.context);
      });

      repo.on('before:deleteMany', (context: RepositoryContext) => {
        const query = context.query as Record<string, unknown> | undefined;
        if (!query || Object.keys(query).length === 0) return;
        return prepare(context, false);
      });
      repo.on('after:deleteMany', (payload: { context: RepositoryContext }) =>
        propagate(payload.context),
      );
    },
  };
}

// ============================================================================
// Bind-time checks
// ============================================================================

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
