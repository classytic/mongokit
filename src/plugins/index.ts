/**
 * MongoKit Plugins
 *
 * Composable, extensible plugins for repository functionality
 */

// Core plugins
export { fieldFilterPlugin } from "./field-filter.plugin.js";
export { timestampPlugin } from "./timestamp.plugin.js";
export { auditLogPlugin } from "./audit-log.plugin.js";
export { softDeletePlugin } from "./soft-delete.plugin.js";
export type { SoftDeleteMethods } from "./soft-delete.plugin.js";
export { methodRegistryPlugin } from "./method-registry.plugin.js";
export type { MethodRegistryRepository } from "./method-registry.plugin.js";
export {
  validationChainPlugin,
  blockIf,
  requireField,
  autoInject,
  immutableField,
  uniqueField,
} from "./validation-chain.plugin.js";
export { elasticSearchPlugin } from "./elastic.plugin.js";
export type { ElasticSearchOptions } from "./elastic.plugin.js";
export { mongoOperationsPlugin } from "./mongo-operations.plugin.js";
export type { MongoOperationsMethods } from "./mongo-operations.plugin.js";
export { batchOperationsPlugin } from "./batch-operations.plugin.js";
export type { BatchOperationsMethods } from "./batch-operations.plugin.js";
export { aggregateHelpersPlugin } from "./aggregate-helpers.plugin.js";
export type { AggregateHelpersMethods } from "./aggregate-helpers.plugin.js";
export { subdocumentPlugin } from "./subdocument.plugin.js";
export type { SubdocumentMethods } from "./subdocument.plugin.js";
export { cachePlugin } from "./cache.plugin.js";
export type { CacheMethods } from "./cache.plugin.js";
export { cascadePlugin } from "./cascade.plugin.js";
export { multiTenantPlugin } from "./multi-tenant.plugin.js";
export type { MultiTenantOptions } from "./multi-tenant.plugin.js";
export { observabilityPlugin } from "./observability.plugin.js";
export type {
  ObservabilityOptions,
  OperationMetric,
} from "./observability.plugin.js";
export { auditTrailPlugin, AuditTrailQuery } from "./audit-trail.plugin.js";
export type {
  AuditTrailOptions,
  AuditTrailMethods,
  AuditEntry,
  AuditOperation,
  AuditQueryOptions,
  AuditQueryResult,
} from "./audit-trail.plugin.js";
export {
  customIdPlugin,
  getNextSequence,
  sequentialId,
  dateSequentialId,
  prefixedId,
} from "./custom-id.plugin.js";
export type {
  CustomIdOptions,
  IdGenerator,
  SequentialIdOptions,
  DateSequentialIdOptions,
  PrefixedIdOptions,
} from "./custom-id.plugin.js";
