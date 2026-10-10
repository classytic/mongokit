/**
 * Join scope — a joined collection is read under ITS OWN policy, or not at all.
 *
 * Policy plugins (`multiTenantPlugin`, `softDeletePlugin`) declare a scope rule on the MODEL they
 * are bound to, and every repository marks its model governed. {@link scopeJoins} walks a
 * pipeline (nested sub-pipelines and `$facet` branches included) and, for each `$lookup`,
 * `$unionWith` and `$graphLookup`, resolves `from` to the registered models that own that
 * collection, then prepends the union of their rules (fail closed). It REFUSES, with a closed
 * code, a `from` no model owns (the silent-empty-join: a wrong literal matches nothing and raises
 * nothing) and a collection no repository governs. `unscopedJoins` names collections the caller
 * asserts are company-wide; a collection with a declared rule cannot be unscoped that way —
 * `bypassTenant` is the explicit cross-tenant form.
 */

import mongoose, { type Connection, type PipelineStage } from 'mongoose';
import type { RepositoryContext } from '../types/repository.js';
import { createError } from '../utils/error.js';

/** Returns the predicate a read of the owning collection carries for this call, or none. */
export type CollectionScopeRule = (
  context: RepositoryContext,
  operation: string,
) => Record<string, unknown> | undefined;

export const JOIN_ERROR_CODES = {
  UNKNOWN_COLLECTION: 'mongokit.join.unknown_collection',
  UNGOVERNED_COLLECTION: 'mongokit.join.ungoverned_collection',
  UNSCOPE_REFUSED: 'mongokit.join.unscope_refused',
  UNRESOLVABLE_FROM: 'mongokit.join.unresolvable_from',
} as const;

const RULES = Symbol.for('@classytic/mongokit/collection-scope-rules');
const GOVERNED = Symbol.for('@classytic/mongokit/governed-model');
const TENANT_FIELDS = Symbol.for('@classytic/mongokit/tenant-fields');

type Holder = {
  [RULES]?: Set<CollectionScopeRule>;
  [GOVERNED]?: true;
  [TENANT_FIELDS]?: Set<string>;
};

/** Called by a policy plugin at bind: reads of this model's collection carry `rule`. */
export function declareCollectionScope(
  model: object,
  rule: CollectionScopeRule,
  meta: { tenantField?: string } = {},
): void {
  const holder = model as Holder;
  if (!holder[RULES]) {
    Object.defineProperty(holder, RULES, { value: new Set(), enumerable: false });
  }
  holder[RULES]?.add(rule);
  if (meta.tenantField) {
    if (!holder[TENANT_FIELDS])
      Object.defineProperty(holder, TENANT_FIELDS, { value: new Set(), enumerable: false });
    holder[TENANT_FIELDS]?.add(meta.tenantField);
  }
}

/** The tenant fields declared on this model by its repositories' tenant plugins. */
export function tenantFieldsOf(model: object): string[] {
  return [...((model as Holder)[TENANT_FIELDS] ?? [])];
}

/** Called by every Repository: this model's scope is known (possibly none). */
export function markGoverned(model: object): void {
  const holder = model as Holder;
  if (!holder[GOVERNED]) {
    Object.defineProperty(holder, GOVERNED, { value: true, enumerable: false });
  }
}

export interface JoinScopeEnv {
  connection: Connection;
  /** The base call's context, after its policy hooks ran. */
  context: RepositoryContext;
  operation: string;
  unscopedJoins?: readonly string[];
}

interface ModelLike {
  modelName: string;
  collection?: { collectionName?: string };
}

function owners(connection: Connection, collection: string): ModelLike[] {
  return (Object.values(connection.models) as ModelLike[]).filter(
    (m) => m.collection?.collectionName === collection,
  );
}

function resemblance(connection: Connection, from: string): string {
  const pluralize = mongoose.pluralize();
  const target = from.toLowerCase();
  const near = (Object.values(connection.models) as ModelLike[]).filter((m) => {
    const name = m.modelName.toLowerCase();
    return name === target || `${name}s` === target || pluralize?.(m.modelName) === target;
  });
  return near
    .map((m) => `model '${m.modelName}' lives in collection '${m.collection?.collectionName}'`)
    .join('; ');
}

/** The predicate a join into `from` must carry, `undefined` for none; throws when unknown. */
export function scopeForCollection(
  from: unknown,
  env: JoinScopeEnv,
): Record<string, unknown> | undefined {
  if (typeof from !== 'string' || from.length === 0) {
    throw createError(
      500,
      `[mongokit] a join's 'from' must be a collection name, got ${JSON.stringify(from)}`,
      {
        code: JOIN_ERROR_CODES.UNRESOLVABLE_FROM,
        meta: { from },
      },
    );
  }
  const unscoped = env.unscopedJoins?.includes(from) === true;
  const found = owners(env.connection, from);
  if (found.length === 0) {
    if (unscoped) return undefined;
    const hint = resemblance(env.connection, from);
    throw createError(
      500,
      `[mongokit] join into '${from}': no registered model owns that collection, so the join would ` +
        `match nothing.${hint ? ` Did you mean: ${hint}?` : ''} Take 'from' from Model.collection.name.`,
      { code: JOIN_ERROR_CODES.UNKNOWN_COLLECTION, meta: { from, suggestion: hint || undefined } },
    );
  }
  const governed = found.some((m) => (m as Holder)[GOVERNED] === true);
  const rules = new Set<CollectionScopeRule>();
  for (const m of found) for (const r of (m as Holder)[RULES] ?? []) rules.add(r);
  if (!governed && rules.size === 0) {
    if (unscoped) return undefined;
    throw createError(
      500,
      `[mongokit] join into '${from}': no repository governs it, so its tenant/soft-delete scope is ` +
        `unknown. Build its repository, or list it in unscopedJoins if it is company-wide.`,
      {
        code: JOIN_ERROR_CODES.UNGOVERNED_COLLECTION,
        meta: { from, models: found.map((m) => m.modelName) },
      },
    );
  }
  const predicates: Record<string, unknown>[] = [];
  for (const rule of rules) {
    const p = rule(env.context, env.operation);
    if (p && Object.keys(p).length > 0) predicates.push(p);
  }
  if (predicates.length === 0) return undefined;
  if (unscoped) {
    throw createError(
      500,
      `[mongokit] join into '${from}': it is scoped by its repository and cannot be listed in ` +
        'unscopedJoins. Use bypassTenant for a deliberate cross-tenant read.',
      { code: JOIN_ERROR_CODES.UNSCOPE_REFUSED, meta: { from } },
    );
  }
  return predicates.length === 1 ? predicates[0] : { $and: predicates };
}

type Stage = Record<string, unknown>;

function scopedPipeline(
  sub: unknown,
  scope: Record<string, unknown> | undefined,
  env: JoinScopeEnv,
): unknown[] {
  const walked = walk(Array.isArray(sub) ? sub : [], env);
  return scope ? [{ $match: scope }, ...walked] : walked;
}

/**
 * Return `pipeline` with every join scoped; throws on an unknown or ungoverned `from`. The result
 * is the one documented narrowing of a caller's stage array to mongoose's stage union (stage
 * validity is the server's call); `aggregatePipeline` no longer carries its own.
 */
export function scopeJoins(pipeline: readonly unknown[], env: JoinScopeEnv): PipelineStage[] {
  return walk(pipeline, env) as PipelineStage[];
}

function walk(pipeline: readonly unknown[], env: JoinScopeEnv): unknown[] {
  return pipeline.map((raw): unknown => {
    const stage = raw as Stage;
    if (stage.$lookup) {
      const l = stage.$lookup as Stage;
      if (l.from === undefined)
        return { $lookup: { ...l, pipeline: scopedPipeline(l.pipeline, undefined, env) } };
      const scope = scopeForCollection(l.from, env);
      if (!scope && l.pipeline === undefined) return stage;
      return { $lookup: { ...l, pipeline: scopedPipeline(l.pipeline, scope, env) } };
    }
    if (stage.$unionWith) {
      const u =
        typeof stage.$unionWith === 'string'
          ? { coll: stage.$unionWith }
          : (stage.$unionWith as Stage);
      if (u.coll === undefined)
        return { $unionWith: { ...u, pipeline: scopedPipeline(u.pipeline, undefined, env) } };
      const scope = scopeForCollection(u.coll, env);
      if (!scope && u.pipeline === undefined) return stage;
      return { $unionWith: { ...u, pipeline: scopedPipeline(u.pipeline, scope, env) } };
    }
    if (stage.$graphLookup) {
      const g = stage.$graphLookup as Stage;
      const scope = scopeForCollection(g.from, env);
      if (!scope) return stage;
      const existing = g.restrictSearchWithMatch as Record<string, unknown> | undefined;
      return {
        $graphLookup: {
          ...g,
          restrictSearchWithMatch: existing ? { $and: [existing, scope] } : scope,
        },
      };
    }
    if (stage.$facet) {
      const branches = stage.$facet as Record<string, unknown[]>;
      return {
        $facet: Object.fromEntries(Object.entries(branches).map(([k, v]) => [k, walk(v, env)])),
      };
    }
    return stage;
  });
}
