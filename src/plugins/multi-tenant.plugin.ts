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

import mongoose from 'mongoose';
import { ALL_OPERATIONS, OP_REGISTRY } from '../operations.js';
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
  /**
   * How to store/query the tenant ID.
   *
   * - `'string'` (default): inject the tenant ID as-is (raw string).
   * - `'objectId'`: cast to `mongoose.Types.ObjectId` before injecting.
   *
   * Choose `'objectId'` when the schema declares the tenant field as
   * `Schema.Types.ObjectId` (e.g., Flow, accounting). This enables
   * `$lookup` and `.populate()` against the referenced collection.
   */
  fieldType?: 'string' | 'objectId';
}

export function multiTenantPlugin(options: MultiTenantOptions = {}): Plugin {
  const {
    tenantField = 'organizationId',
    contextKey = 'organizationId',
    required = true,
    skipOperations = [],
    skipWhen,
    resolveContext,
    fieldType = 'string',
  } = options;

  // Built-in ops come from the central registry (so adding a new op like
  // findOneAndUpdate auto-classifies here). `extraOps` lets plugin/extension
  // methods (e.g. soft-delete's `getDeleted`) opt in without forking this list.
  // Each gets the same scoping based on which `context.*` key it expects.
  const extraOps: { op: string; policyKey: 'filters' | 'query' }[] = [
    { op: 'getDeleted', policyKey: 'filters' },
  ];

  return {
    name: 'multi-tenant',

    apply(repo: RepositoryInstance): void {
      const builtInOps = ALL_OPERATIONS.map((op) => ({
        op: op as string,
        policyKey: OP_REGISTRY[op].policyKey,
      }));
      const allOps = [...builtInOps, ...extraOps];

      for (const { op, policyKey } of allOps) {
        if (skipOperations.includes(op)) continue;
        if (policyKey === 'none') continue;

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

            // Cast tenant ID based on fieldType
            const castId: string | mongoose.Types.ObjectId =
              fieldType === 'objectId' ? new mongoose.Types.ObjectId(tenantId) : tenantId;

            switch (policyKey) {
              case 'filters':
                context.filters = { ...context.filters, [tenantField]: castId };
                break;

              case 'query':
                context.query = { ...context.query, [tenantField]: castId };
                break;

              case 'data':
                if (context.data) context.data[tenantField] = castId;
                break;

              case 'dataArray':
                if (context.dataArray) {
                  for (const doc of context.dataArray) {
                    if (doc && typeof doc === 'object') {
                      doc[tenantField] = castId;
                    }
                  }
                }
                break;

              case 'operations':
                // bulkWrite — walk each sub-op and inject the filter / doc.
                if (context.operations) {
                  const ops = context.operations as Record<string, unknown>[];
                  for (const subOp of ops) {
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
                          [tenantField]: castId,
                        };
                      }
                    }
                    const insertBody = subOp.insertOne as Record<string, unknown> | undefined;
                    if (insertBody?.document) {
                      (insertBody.document as Record<string, unknown>)[tenantField] = castId;
                    }
                  }
                }
                break;
            }
          },
          { priority: HOOK_PRIORITY.POLICY },
        );
      }
    },
  };
}
