/**
 * `createRepository(model, config)` — the config-driven repository
 * factory and the recommended way to construct a mongokit repo.
 *
 * Features light up only when their config key is present, and the
 * factory composes the underlying plugins in the canonical safe order —
 * plugin-order mistakes (tenant after cache, soft-delete after batch)
 * become impossible instead of merely warned about. Because the factory
 * owns the ordering, `pluginOrderChecks` defaults to `'throw'` here
 * (any violation would be a factory bug, not user error).
 *
 * Canonical stack (constraints from `PLUGIN_ORDER_CONSTRAINTS`):
 *
 *   methodRegistry → multiTenant → softDelete → timestamps → customId
 *     → cache → audit → batch → ...config.plugins (appended last)
 *
 *   - multi-tenant precedes soft-delete and cache (tenant scope must be
 *     in the filter before the deletion predicate and the cache key).
 *   - soft-delete precedes batch-operations (bulk update/delete must see
 *     the deletion filter).
 *   - methodRegistry is always installed first — batch (and several
 *     other plugins) contribute methods through it.
 *
 * For full manual control over the plugin chain, drop down to
 * `new Repository(model, plugins, paginationConfig, options)`.
 *
 * @example
 * ```ts
 * const orderRepo = createRepository<IOrder>(OrderModel, {
 *   tenant: { tenantField: 'organizationId', required: true },
 *   softDelete: true,
 *   timestamps: true,
 *   batch: true,
 *   schema: orderCreateSchema,        // Standard Schema (Zod/Valibot/...)
 *   events: { transport: eventBus },  // publishes order.created, ...
 * });
 * ```
 */

import type { Model } from 'mongoose';
import { auditLogPlugin } from './plugins/audit-log.plugin.js';
import { type AuditTrailOptions, auditTrailPlugin } from './plugins/audit-trail.plugin.js';
import { batchOperationsPlugin } from './plugins/batch-operations.plugin.js';
import { cachePlugin, type RepositoryCachePluginOptions } from './plugins/cache.plugin.js';
import { type CustomIdOptions, customIdPlugin } from './plugins/custom-id.plugin.js';
import { methodRegistryPlugin } from './plugins/method-registry.plugin.js';
import { type MultiTenantOptions, multiTenantPlugin } from './plugins/multi-tenant.plugin.js';
import { softDeletePlugin } from './plugins/soft-delete.plugin.js';
import { timestampPlugin } from './plugins/timestamp.plugin.js';
import { Repository } from './Repository.js';
import type {
  Logger,
  PaginationConfig,
  PluginType,
  RepositoryOptions,
  SoftDeleteOptions,
} from './types.js';

/**
 * Audit config — either a `Logger` (routes to `auditLogPlugin`, which
 * writes structured log lines through your logger) or an
 * `AuditTrailOptions` object (routes to `auditTrailPlugin`, which
 * persists a queryable compliance ledger in its own collection).
 *
 * Discrimination: a value carrying any of the `Logger` function members
 * (`info` / `warn` / `error` / `debug`) is treated as a logger; anything
 * else is treated as `AuditTrailOptions` (all of whose members are
 * data-shaped except `metadata` / `onError`, which don't overlap with
 * the logger member names).
 */
export type AuditConfig = Logger | AuditTrailOptions;

function isLoggerAudit(value: AuditConfig): value is Logger {
  const v = value as Record<string, unknown>;
  return (
    typeof v.info === 'function' ||
    typeof v.warn === 'function' ||
    typeof v.error === 'function' ||
    typeof v.debug === 'function'
  );
}

/**
 * Declarative repository config. Every key is optional; a feature's
 * plugin is installed only when its key is present. The remaining
 * `RepositoryOptions` keys (`idField`, `hooks`, `schema`, `updateSchema`,
 * `events`, `requirePlugins`, ...) pass through to the `Repository`
 * constructor unchanged.
 */
export interface CreateRepositoryConfig extends RepositoryOptions {
  /** Multi-tenant scoping — forwarded to `multiTenantPlugin`. */
  tenant?: MultiTenantOptions;
  /** Soft-delete — `true` for defaults, or `SoftDeleteOptions`. */
  softDelete?: boolean | SoftDeleteOptions;
  /** createdAt/updatedAt stamping — `timestampPlugin` takes no options. */
  timestamps?: boolean;
  /** Batch ops (`updateMany`/`deleteMany`/`bulkWrite`) via `batchOperationsPlugin`. */
  batch?: boolean;
  /** Read-through cache — forwarded to `cachePlugin`. */
  cache?: RepositoryCachePluginOptions;
  /** Audit — `Logger` → `auditLogPlugin`; `AuditTrailOptions` → `auditTrailPlugin`. */
  audit?: AuditConfig;
  /** Custom ID generation — forwarded to `customIdPlugin`. */
  customId?: CustomIdOptions;
  /** Extra plugins appended AFTER the canonical stack. */
  plugins?: PluginType[];
  /** Pagination engine config (defaultLimit, maxLimit, ...). */
  pagination?: PaginationConfig;
}

/**
 * Build a `Repository` from a declarative config. See module JSDoc for
 * ordering guarantees and an example.
 */
export function createRepository<TDoc>(
  // Accept Mongoose models with methods/statics/virtuals, mirroring the
  // Repository constructor's parameter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<TDoc, any, any, any>,
  config: CreateRepositoryConfig = {},
): Repository<TDoc> {
  const {
    tenant,
    softDelete,
    timestamps,
    batch,
    cache,
    audit,
    customId,
    plugins = [],
    pagination = {},
    ...repositoryOptions
  } = config;

  // Canonical order — see module JSDoc. methodRegistry always first so
  // every method-contributing plugin (batch, soft-delete's restore, ...)
  // registers through it.
  const stack: PluginType[] = [methodRegistryPlugin()];
  if (tenant) stack.push(multiTenantPlugin(tenant));
  if (softDelete) stack.push(softDeletePlugin(softDelete === true ? {} : softDelete));
  if (timestamps) stack.push(timestampPlugin());
  if (customId) stack.push(customIdPlugin(customId));
  if (cache) stack.push(cachePlugin(cache));
  if (audit) stack.push(isLoggerAudit(audit) ? auditLogPlugin(audit) : auditTrailPlugin(audit));
  if (batch) stack.push(batchOperationsPlugin());
  stack.push(...plugins);

  return new Repository<TDoc>(model, stack, pagination, {
    // The factory owns the ordering, so violations are bugs — fail fast.
    // An explicit caller-provided mode still wins.
    pluginOrderChecks: repositoryOptions.pluginOrderChecks ?? 'throw',
    ...repositoryOptions,
  });
}
