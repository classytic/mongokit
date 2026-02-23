/**
 * Multi-Tenant Plugin
 *
 * Automatically injects tenant isolation filters into all queries.
 * Ensures data isolation by adding organizationId (or custom tenant field)
 * to every read and write operation.
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

import type { Plugin, RepositoryInstance, RepositoryContext } from '../types.js';

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

  const readOps = ['getById', 'getByQuery', 'getAll', 'aggregatePaginate', 'lookupPopulate'];
  const writeOps = ['create', 'createMany', 'update', 'delete'];
  const allOps = [...readOps, ...writeOps];

  return {
    name: 'multi-tenant',

    apply(repo: RepositoryInstance): void {
      for (const op of allOps) {
        if (skipOperations.includes(op)) continue;

        // before:* hooks receive context directly (not wrapped in { context })
        repo.on(`before:${op}`, (context: RepositoryContext) => {
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
              `Pass it via options or set required: false.`
            );
          }

          if (!tenantId) return;

          // Inject into query filters for reads
          if (readOps.includes(op)) {
            if (op === 'getAll' || op === 'aggregatePaginate' || op === 'lookupPopulate') {
              context.filters = { ...context.filters, [tenantField]: tenantId };
            } else {
              context.query = { ...context.query, [tenantField]: tenantId };
            }
          }

          // Inject into document data for writes
          if (op === 'create' && context.data) {
            context.data[tenantField] = tenantId;
          }
          if (op === 'createMany' && context.dataArray) {
            for (const doc of context.dataArray) {
              doc[tenantField] = tenantId;
            }
          }

          // Constrain update/delete by tenant (prevents cross-tenant mutation)
          if (op === 'update' || op === 'delete') {
            context.query = { ...context.query, [tenantField]: tenantId };
          }
        });
      }
    },
  };
}

export default multiTenantPlugin;
