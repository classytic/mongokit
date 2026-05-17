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

import {
  adminBypass as adminBypassShared,
  payloadHasTenantField,
} from '@classytic/repo-core/plugins';
import type { TenantConfig } from '@classytic/repo-core/tenant';
import mongoose from 'mongoose';
import { ALL_OPERATIONS, OP_REGISTRY } from '../operations.js';
import { HOOK_PRIORITY } from '../Repository.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types.js';

/**
 * Static tenant fields are picked from `@classytic/repo-core/tenant` so the
 * vocabulary (`tenantField`, `contextKey`, `required`, `fieldType`) stays
 * locked to the org-wide canonical source. Mongokit-specific runtime
 * callbacks (`skipWhen`, `resolveContext`, `skipOperations`,
 * `allowDataInjection`) extend on top — those genuinely differ from
 * sqlitekit's runtime shape because mongokit's `RepositoryContext` carries
 * Mongoose-specific bits the resolver may inspect.
 *
 * Mongokit defaults `fieldType` to `'string'` (not repo-core's `'objectId'`)
 * for back-compat — pre-3.x stored tenant ids as raw strings; flipping the
 * default would silently change cast behavior for existing apps.
 */
export interface MultiTenantOptions
  extends Pick<TenantConfig, 'tenantField' | 'contextKey' | 'required' | 'fieldType'> {
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
   * When `true`, bypass the `required` throw if the operation's policy
   * target already carries the tenant field. This lets hosts that stamp
   * the tenant into the payload themselves (e.g., `data[tenantField]`
   * on writes, `filters[tenantField]` on paginated reads) use the plugin
   * without having to hand-roll a `skipWhen` that duplicates this check.
   *
   * **Default: `false` (secure / fail-closed).** Tenant scope MUST come
   * from `context` or `resolveContext`, otherwise the plugin throws
   * (when `required: true`). This is the right posture for a security-
   * sensitive boundary: caller-supplied scope on the payload cannot be
   * trusted as authentication. If a host control-plane has already
   * authenticated the tenant out-of-band and stamps it onto every
   * write/read, set this to `true` explicitly — making the trust model
   * visible at the call site.
   *
   * **Migration from < 4.0:** the prior default was `true`. To preserve
   * the old behavior verbatim, set `allowDataInjection: true`. To get
   * the new secure default, leave it unset.
   *
   * Composition: a user-supplied `skipWhen` still runs first and can
   * always opt out. This option controls the behavior after `skipWhen`
   * and `resolveContext` have had their turn.
   *
   * Safety: when the payload supplies the tenant AND this is `true`,
   * the plugin skips its own injection (it does not overwrite). Cross-
   * tenant isolation is therefore only as strong as the caller's own
   * stamping — same guarantee as a hand-rolled `skipWhen`.
   */
  allowDataInjection?: boolean;
}

// `payloadHasTenantField` lives in `@classytic/repo-core/plugins` —
// same logic, shared by every kit. Imported below at top-of-file.

export function multiTenantPlugin(options: MultiTenantOptions = {}): Plugin {
  const {
    tenantField = 'organizationId',
    contextKey = 'organizationId',
    required = true,
    skipOperations = [],
    skipWhen,
    resolveContext,
    fieldType = 'string',
    allowDataInjection = false,
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
            // Per-call escape hatch — `bypassTenant: true` in the
            // options bag for THIS call. Most discoverable form for
            // one-off admin scripts, migrations, support-engineer
            // queries. Distinct from `skipWhen` (plugin-level
            // callback) and `skipOperations` (static op list); each
            // serves a different layer of decision.
            const perCallBypass = context.bypassTenant === true;
            // Plugin-level dynamic skip — runs after per-call bypass
            // because the per-call form is the most specific decision.
            const callbackBypass = !perCallBypass && skipWhen?.(context, op) === true;

            if (perCallBypass || callbackBypass) {
              // Emit an audit event so observability + audit plugins
              // can distinguish bypassed queries from tenant-scoped
              // ones. Compliance-heavy domains (healthcare, fintech)
              // need this distinction in their logs; without it, a
              // super-admin's cross-tenant read is indistinguishable
              // from a normal scoped read at the audit layer.
              //
              // Sync `emit` (not `emitAsync`) — the policy hook stays
              // sync so existing `expect(() => hook(...)).toThrow()`
              // tests keep working AND the throw path on missing
              // tenant remains synchronous. Audit listeners that need
              // guaranteed-landing should write to a durable buffer
              // synchronously inside the listener body (the standard
              // EventEmitter contract — async listeners' promises are
              // not awaited).
              repo.emit('after:tenant-bypass', {
                context,
                operation: op,
                reason: perCallBypass ? 'option' : 'callback',
              });
              return;
            }

            // Resolve tenant ID: context first, then resolveContext fallback
            let tenantId = context[contextKey] as string | undefined;
            if (!tenantId && resolveContext) {
              tenantId = resolveContext();
              // Write it back to context so downstream hooks/plugins can see it
              if (tenantId) (context as Record<string, unknown>)[contextKey] = tenantId;
            }

            // Host supplied the tenant directly on the payload (e.g. arc
            // stamps `data[tenantField]`). Trust it and skip both the
            // required-throw and our own injection — overwriting would
            // clobber the caller's explicit value.
            if (
              !tenantId &&
              allowDataInjection &&
              payloadHasTenantField(context, policyKey, tenantField)
            ) {
              return;
            }

            if (!tenantId && required) {
              throw new Error(
                [
                  `[mongokit] Multi-tenant: Missing '${contextKey}' in context for '${op}'.`,
                  '',
                  'Three ways to provide it — pick the one that fits the call site:',
                  '',
                  `  1. Per-call:        repo.${op}(..., { ${contextKey}: '<id>' })`,
                  '  2. Ambient (ALS):   `createTenantContext()` + `resolveContext` —',
                  '                       wrap the request in `tenantContext.run({ tenantId }, fn)`,',
                  '                       then every repo call inside the closure inherits the',
                  '                       tenant with no options-bag plumbing. See',
                  '                       `createTenantContext` in @classytic/mongokit.',
                  '  3. Cross-tenant:    `bypassTenant: true` per-call (admin / migration /',
                  '                       support), or `skipWhen: adminBypass({...})` at plugin',
                  '                       construction for an always-on role-based bypass.',
                  '',
                  'Or set `required: false` if this collection is genuinely not tenant-scoped.',
                ].join('\n'),
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

/**
 * Build the canonical `skipWhen` callback for role-based tenant
 * bypass — replaces the hand-rolled
 * `(ctx) => ctx.role === 'superadmin'` callback that ~6 packages
 * across the classytic codebase carry as boilerplate. Eliminates the
 * "I forgot to include 'platform_admin'" drift class — the role
 * vocabulary lives in one place.
 *
 * **Composes with `bypassTenant: true` per-call**, doesn't replace
 * it. `bypassTenant` is the deliberate per-call form for migration
 * scripts and one-off admin queries; `adminBypass` is the
 * always-on role-based bypass for users whose JWT / session carries
 * a privileged role.
 *
 * **NOT a substitute for authentication or RBAC.** This factory only
 * answers "should the tenant scope hook fire for this call?" — it
 * does NOT validate that the caller is authenticated, that their
 * role claim is genuine, or that the requested operation is
 * permitted. Always run auth + RBAC before the call reaches the
 * repository layer; this is the LAST gate, not the only one.
 *
 * @example Single role
 * ```ts
 * import { adminBypass, multiTenantPlugin } from '@classytic/mongokit';
 *
 * const repo = new Repository(InvoiceModel, [
 *   multiTenantPlugin({
 *     tenantField: 'organizationId',
 *     skipWhen: adminBypass({ adminRoles: ['superadmin'] }),
 *   }),
 * ]);
 *
 * await repo.getAll({}, { role: 'superadmin' }); // sees all orgs
 * await repo.getAll({}, { role: 'user', organizationId: 'org-1' }); // scoped
 * ```
 *
 * @example Multiple admin roles + custom field name
 * ```ts
 * skipWhen: adminBypass({
 *   roleField: 'principalRole',                  // ctx.principalRole, not ctx.role
 *   adminRoles: ['superadmin', 'platform_admin', 'support'],
 * }),
 * ```
 *
 * @example Composing with custom logic
 * ```ts
 * // adminBypass for the role check, then your own additional logic:
 * const adminCheck = adminBypass({ adminRoles: ['superadmin'] });
 * skipWhen: (ctx, op) => adminCheck(ctx, op) || ctx.internalSystemFlag === true,
 * ```
 *
 * @param options.roleField - Path on the context to read the role
 *   from. Defaults to `'role'`. Top-level keys only — for nested
 *   shapes (e.g. `ctx.user.role`), wrap your own `(ctx) => …` callback
 *   instead.
 * @param options.adminRoles - Role values that grant the bypass. The
 *   factory does an exact-match `includes` check — case-sensitive,
 *   no fuzzy matching. Lowercase your role vocabulary upstream.
 * @returns A `skipWhen`-compatible callback `(ctx, op) → boolean`.
 */
export function adminBypass(options: {
  roleField?: string;
  adminRoles: readonly string[];
}): (context: RepositoryContext, operation: string) => boolean {
  // Repo-core's `adminBypass` is the canonical impl; this kit-bound
  // wrapper preserves the existing mongokit return-type signature
  // (RepositoryContext over Record<string, unknown>) for backward
  // compatibility with hosts importing it from `@classytic/mongokit`.
  return adminBypassShared(options) as (context: RepositoryContext, operation: string) => boolean;
}
