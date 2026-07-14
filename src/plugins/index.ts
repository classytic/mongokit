/**
 * MongoKit Plugins
 *
 * Composable, extensible plugins for repository functionality
 */

export type { AggregateHelpersMethods } from './aggregate-helpers.plugin.js';
export { aggregateHelpersPlugin } from './aggregate-helpers.plugin.js';
export { auditLogPlugin } from './audit-log.plugin.js';
export type {
  AuditEntry,
  AuditOperation,
  AuditQueryOptions,
  AuditQueryResult,
  AuditTrailMethods,
  AuditTrailOptions,
} from './audit-trail.plugin.js';
export { AuditTrailQuery, auditTrailPlugin } from './audit-trail.plugin.js';
export type { BatchOperationsMethods } from './batch-operations.plugin.js';
export { batchOperationsPlugin } from './batch-operations.plugin.js';
export {
  type CacheAdapter,
  type CacheOptions,
  cachePlugin,
  type RepositoryCacheHandle,
  type RepositoryCachePluginOptions,
} from './cache.plugin.js';
export { cascadePlugin } from './cascade.plugin.js';
export { type ChangeLogPluginOptions, changeLogPlugin } from './change-log.plugin.js';
export type {
  CustomIdOptions,
  DateSequentialIdOptions,
  IdGenerator,
  PrefixedIdOptions,
  SequentialIdOptions,
} from './custom-id.plugin.js';
export {
  customIdPlugin,
  dateSequentialId,
  getNextSequence,
  prefixedId,
  sequentialId,
} from './custom-id.plugin.js';
export type { ElasticSearchOptions } from './elastic.plugin.js';
export { elasticSearchPlugin } from './elastic.plugin.js';
// Core plugins
export { fieldFilterPlugin } from './field-filter.plugin.js';
export type { LeaseMethods, LeasePluginOptions } from './lease.plugin.js';
export { leasePlugin } from './lease.plugin.js';
export type { MethodRegistryRepository } from './method-registry.plugin.js';
export { methodRegistryPlugin } from './method-registry.plugin.js';
export type { MongoOperationsMethods } from './mongo-operations.plugin.js';
export { mongoOperationsPlugin } from './mongo-operations.plugin.js';
export type { MultiTenantOptions } from './multi-tenant.plugin.js';
export { multiTenantPlugin } from './multi-tenant.plugin.js';
export type {
  ObservabilityOptions,
  OperationMetric,
} from './observability.plugin.js';
export { observabilityPlugin } from './observability.plugin.js';
export { appendOnlyPlugin, type AppendOnlyPluginOptions } from './append-only.plugin.js';
export {
  immutableStatesPlugin,
  type ImmutableClaimView,
  type ImmutableStatesPluginOptions,
} from './immutable-states.plugin.js';
export type { SoftDeleteMethods } from './soft-delete.plugin.js';
export { softDeletePlugin } from './soft-delete.plugin.js';
export type { SubdocumentMethods } from './subdocument.plugin.js';
export { subdocumentPlugin } from './subdocument.plugin.js';
export type { TenantContext, TenantStore } from './tenant-context.js';
export { createTenantContext } from './tenant-context.js';
export { timestampPlugin } from './timestamp.plugin.js';
export {
  autoInject,
  blockIf,
  immutableField,
  requireField,
  uniqueField,
  validationChainPlugin,
} from './validation-chain.plugin.js';
