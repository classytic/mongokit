/**
 * Multi-Tenant Plugin
 *
 * Automatically injects tenant isolation filters into all queries.
 * Ensures data isolation by adding organizationId (or custom tenant field)
 * to every read and write operation.
 *
 * Uses HOOK_PRIORITY.POLICY (100) to ensure tenant filters are injected
 * BEFORE cache keys are computed (HOOK_PRIORITY.CACHE = 200).
 *
 * @example
 * ```typescript
 * // Basic — scopes every operation by organizationId from context
 * const repo = new Repository(Invoice, [
 *   multiTenantPlugin({ tenantField: 'organizationId' }),
 * ]);
 *
 * const invoices = await repo.getAll(
 *   { filters: { status: 'paid' } },
 *   { organizationId: 'org_123' }
 * );
 * // Actual query: { status: 'paid', organizationId: 'org_123' }
 *
 * // Super admin bypass — skip scoping based on context
 * const repo = new Repository(Invoice, [
 *   multiTenantPlugin({
 *     tenantField: 'organizationId',
 *     skipWhen: (context) => context.role === 'superadmin',
 *   }),
 * ]);
 *
 * // Admin sees all orgs
 * await repo.getAll({ page: 1, limit: 10 }, { role: 'superadmin' });
 *
 * // Automatic context — resolve tenant from AsyncLocalStorage
 * const repo = new Repository(Invoice, [
 *   multiTenantPlugin({
 *     tenantField: 'organizationId',
 *     resolveContext: () => asyncLocalStorage.getStore()?.tenantId,
 *   }),
 * ]);
 * ```
 */

import { HOOK_PRIORITY } from '../Repository.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types.js';

export interface MultiTenantOptions {
  /** Field name used for tenant isolation (default: 'organizationId') */
  tenantField?: string;
  /** Context key to read tenant ID from (default: 'organizationId') */
  contextKey?: string;
  /** Throw if tenant ID is missing from context (default: true) */
  required?: boolean;
  /** Operations to skip tenant injection (e.g., for admin/system queries) */
  skipOperations?: string[];
  /**
   * Dynamic skip — receives the context and operation name, returns true to
   * bypass tenant scoping for this call. Use for role-based bypass (e.g.,
   * super admin) without needing a separate repo instance.
   *
   * @example
   * ```typescript
   * skipWhen: (context) => context.role === 'superadmin'
   * ```
   */
  skipWhen?: (context: RepositoryContext, operation: string) => boolean;
  /**
   * Resolve tenant ID from external source (e.g., AsyncLocalStorage, CLS).
   * Called when tenant ID is not found in context. If it returns a value,
   * that value is used as the tenant ID without requiring it in context.
   *
   * @example
   * ```typescript
   * resolveContext: () => asyncLocalStorage.getStore()?.tenantId
   * ```
   */
  resolveContext?: () => string | undefined;
}

export function multiTenantPlugin(options: MultiTenantOptions = {}): Plugin {
  const {
    tenantField = 'organizationId',
    contextKey = 'organizationId',
    required = true,
    skipOperations = [],
    skipWhen,
    resolveContext,
  } = options;

  // Operations that use context.filters (list-style queries)
  const filterOps = ['getAll', 'findAll', 'aggregatePaginate', 'lookupPopulate'];
  // Operations that use context.query (single-doc reads, count, exists, distinct, aggregate)
  const queryReadOps = [
    'getById',
    'getByQuery',
    'getOne',
    'count',
    'exists',
    'getOrCreate',
    'distinct',
    'aggregate',
  ];
  // Write operations that constrain by tenant via context.query
  const constrainedWriteOps = ['update', 'delete', 'restore'];
  // Operations that use context.filters OR context.query for tenant scoping (soft-delete extension methods)
  const filterReadOps = ['getDeleted'];
  // Write operations that inject tenant into document data
  const createOps = ['create', 'createMany'];
  // Batch operations that need tenant scoping on their query
  const batchQueryOps = ['updateMany', 'deleteMany'];
  // bulkWrite needs special handling — tenant injected per sub-operation
  const bulkOps = ['bulkWrite'];

  const allOps = [
    ...filterOps,
    ...filterReadOps,
    ...queryReadOps,
    ...constrainedWriteOps,
    ...createOps,
    ...batchQueryOps,
    ...bulkOps,
  ];

  return {
    name: 'multi-tenant',

    apply(repo: RepositoryInstance): void {
      for (const op of allOps) {
        if (skipOperations.includes(op)) continue;

        repo.on(
          `before:${op}`,
          (context: RepositoryContext) => {
            // Dynamic skip — let the caller bypass scoping per-request
            if (skipWhen?.(context, op)) return;

            // Resolve tenant ID: context first, then resolveContext fallback
            let tenantId = context[contextKey] as string | undefined;
            if (!tenantId && resolveContext) {
              tenantId = resolveContext();
              // Write it back to context so downstream hooks/plugins can see it
              if (tenantId) (context as Record<string, unknown>)[contextKey] = tenantId;
            }

            if (!tenantId && required) {
              throw new Error(
                `[mongokit] Multi-tenant: Missing '${contextKey}' in context for '${op}'. ` +
                  `Pass it via options or set required: false.`,
              );
            }

            if (!tenantId) return;

            // ── Filter-based reads (list queries) ──
            if (filterOps.includes(op) || filterReadOps.includes(op)) {
              context.filters = { ...context.filters, [tenantField]: tenantId };
            }

            // ── Query-based reads (single doc, count, exists, distinct, aggregate) ──
            if (queryReadOps.includes(op)) {
              context.query = { ...context.query, [tenantField]: tenantId };
            }

            // ── Create: inject tenant into document data ──
            if (op === 'create' && context.data) {
              context.data[tenantField] = tenantId;
            }
            if (op === 'createMany' && context.dataArray) {
              for (const doc of context.dataArray) {
                if (doc && typeof doc === 'object') {
                  doc[tenantField] = tenantId;
                }
              }
            }

            // ── Constrained writes (update, delete): add tenant to query ──
            if (constrainedWriteOps.includes(op)) {
              context.query = { ...context.query, [tenantField]: tenantId };
            }

            // ── Batch operations: scope query by tenant ──
            if (batchQueryOps.includes(op)) {
              context.query = { ...context.query, [tenantField]: tenantId };
            }

            // ── bulkWrite: inject tenant filter into each sub-operation ──
            if (op === 'bulkWrite' && context.operations) {
              const ops = context.operations as Record<string, unknown>[];
              for (const subOp of ops) {
                // updateOne/updateMany/deleteOne/deleteMany have filter
                for (const key of [
                  'updateOne',
                  'updateMany',
                  'deleteOne',
                  'deleteMany',
                  'replaceOne',
                ]) {
                  const opBody = subOp[key] as Record<string, unknown> | undefined;
                  if (opBody?.filter) {
                    opBody.filter = {
                      ...(opBody.filter as Record<string, unknown>),
                      [tenantField]: tenantId,
                    };
                  }
                }
                // insertOne: inject into document
                const insertBody = subOp.insertOne as Record<string, unknown> | undefined;
                if (insertBody?.document) {
                  (insertBody.document as Record<string, unknown>)[tenantField] = tenantId;
                }
              }
            }
          },
          { priority: HOOK_PRIORITY.POLICY },
        );
      }
    },
  };
}
