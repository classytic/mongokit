/**
 * Operation Registry
 * ────────────────────────────────────────────────────────────────────────────
 * Single source of truth that classifies every Repository operation, so
 * bundled and third-party plugins don't each maintain their own duplicated
 * op lists.
 *
 * Rationale: before this registry, multi-tenant, soft-delete, observability,
 * audit, and validation plugins each declared their own arrays of "which ops
 * does my plugin care about". Adding a new method (e.g. `findOneAndUpdate`)
 * meant touching every plugin separately — and missing one was silent.
 *
 * The registry exposes the **classification** (where the op's primary
 * scoping input lives, whether it mutates, whether `context.id` is
 * populated). Plugins switch on the classification instead of hardcoding
 * arrays, so adding a future op means one map entry — every plugin
 * auto-classifies.
 *
 * **Forward compatibility:** other repository kits (a future `pgkit`,
 * `prismakit`, etc.) can ship the same registry shape so cross-driver
 * plugins (multi-tenant, audit, observability) work identically. The
 * difference between drivers is the *filter grammar* (mongo `$in` vs
 * Prisma `{ in: [...] }`), not the context shape.
 */

import type { RepositoryOperation } from './types.js';

/**
 * Where a plugin should inject its scoping filter (multi-tenant scope,
 * soft-delete filter, etc.) on the RepositoryContext.
 *
 * - `data`        — single-doc create payload (`context.data`)
 * - `dataArray`   — multi-doc create payload (`context.dataArray`)
 * - `query`       — raw filter (`context.query`); the dominant convention
 * - `filters`     — paginated list options' filter sub-bag (`context.filters`)
 * - `operations`  — bulkWrite per-sub-op (special — plugins walk each entry)
 * - `none`        — no scoping target (op accepts no filter input)
 */
export type PolicyKey = 'data' | 'dataArray' | 'query' | 'filters' | 'operations' | 'none';

export interface OperationDescriptor {
  /** Where multi-tenant / soft-delete plugins inject their scoping filter. */
  policyKey: PolicyKey;
  /** Whether this op writes to the database. Drives audit + cache invalidation. */
  mutates: boolean;
  /** True when `context.id` is populated by the time before/after hooks fire. */
  hasIdContext: boolean;
}

/**
 * The registry. Order intentionally groups by category for readability.
 * Adding a new RepositoryOperation requires exactly one entry here, after
 * which every bundled plugin auto-classifies it correctly.
 */
export const OP_REGISTRY: Readonly<Record<RepositoryOperation, OperationDescriptor>> = {
  // ── Single-doc writes ────────────────────────────────────────────────
  create: { policyKey: 'data', mutates: true, hasIdContext: false },
  update: { policyKey: 'query', mutates: true, hasIdContext: true },
  findOneAndUpdate: { policyKey: 'query', mutates: true, hasIdContext: false },
  delete: { policyKey: 'query', mutates: true, hasIdContext: true },
  restore: { policyKey: 'query', mutates: true, hasIdContext: true },

  // ── Multi-doc writes ─────────────────────────────────────────────────
  createMany: { policyKey: 'dataArray', mutates: true, hasIdContext: false },
  updateMany: { policyKey: 'query', mutates: true, hasIdContext: false },
  deleteMany: { policyKey: 'query', mutates: true, hasIdContext: false },
  bulkWrite: { policyKey: 'operations', mutates: true, hasIdContext: false },

  // ── Reads — filter as primary input (raw `context.query`) ───────────
  // Includes findAll because its first positional arg IS the filter,
  // matching update / findOneAndUpdate / getOne semantics.
  // getOrCreate is classified as a read for plugin routing — its create
  // path is conditional, so audit/cache treat it as read-shaped.
  getById: { policyKey: 'query', mutates: false, hasIdContext: true },
  getByQuery: { policyKey: 'query', mutates: false, hasIdContext: false },
  getOne: { policyKey: 'query', mutates: false, hasIdContext: false },
  findAll: { policyKey: 'query', mutates: false, hasIdContext: false },
  getOrCreate: { policyKey: 'query', mutates: false, hasIdContext: false },
  count: { policyKey: 'query', mutates: false, hasIdContext: false },
  exists: { policyKey: 'query', mutates: false, hasIdContext: false },
  distinct: { policyKey: 'query', mutates: false, hasIdContext: false },
  // aggregate's primary input is a pipeline, but plugins inject scoping
  // via `context.query` and the Repository prepends a `$match` stage from
  // it (see Repository.aggregate). policyKey reflects where plugins write.
  aggregate: { policyKey: 'query', mutates: false, hasIdContext: false },

  // ── Reads — paginated options bag (`context.filters`) ───────────────
  getAll: { policyKey: 'filters', mutates: false, hasIdContext: false },
  aggregatePaginate: { policyKey: 'filters', mutates: false, hasIdContext: false },
  lookupPopulate: { policyKey: 'filters', mutates: false, hasIdContext: false },
};

/** All known repository operations, in registry order. */
export const ALL_OPERATIONS = Object.keys(OP_REGISTRY) as RepositoryOperation[];

/** Operations that mutate the database. Drives audit + cache invalidation lists. */
export const MUTATING_OPERATIONS: readonly RepositoryOperation[] = ALL_OPERATIONS.filter(
  (op) => OP_REGISTRY[op].mutates,
);

/** Operations that don't mutate. Drives default cacheable ops. */
export const READ_OPERATIONS: readonly RepositoryOperation[] = ALL_OPERATIONS.filter(
  (op) => !OP_REGISTRY[op].mutates,
);

/** Filter ops by their policy injection key. */
export function operationsByPolicyKey(key: PolicyKey): RepositoryOperation[] {
  return ALL_OPERATIONS.filter((op) => OP_REGISTRY[op].policyKey === key);
}
