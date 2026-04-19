/**
 * MongoKit - Event-driven repository pattern for MongoDB
 *
 * Production-grade MongoDB repositories with zero dependencies -
 * smart pagination, events, and plugins.
 *
 * @module @classytic/mongokit
 * @author Classytic (https://github.com/classytic)
 * @license MIT
 *
 * @example
 * ```typescript
 * import { Repository, createRepository } from '@classytic/mongokit';
 * import { timestampPlugin, softDeletePlugin } from '@classytic/mongokit';
 *
 * // Create repository with plugins
 * const userRepo = createRepository(UserModel, [
 *   timestampPlugin(),
 *   softDeletePlugin(),
 * ]);
 *
 * // Create
 * const user = await userRepo.create({ name: 'John', email: 'john@example.com' });
 *
 * // Read with pagination (auto-detects offset vs keyset)
 * const users = await userRepo.getAll({ page: 1, limit: 20 });
 *
 * // Keyset pagination for infinite scroll
 * const stream = await userRepo.getAll({ sort: { createdAt: -1 }, limit: 50 });
 * const nextStream = await userRepo.getAll({ after: stream.next, sort: { createdAt: -1 } });
 *
 * // Update
 * await userRepo.update(user._id, { name: 'John Doe' });
 *
 * // Delete
 * await userRepo.delete(user._id);
 * ```
 */

// Actions (for advanced use cases - standalone utilities)
export * as actions from './actions/index.js';
export type { OperationDescriptor, PolicyKey } from './operations.js';
// Operation registry — single source of truth that classifies every
// repository operation. Custom plugin authors can drive their own
// op-iteration loops from this instead of maintaining parallel lists.
// Other repository kits (pgkit, prismakit, etc.) can ship the same
// registry shape so cross-driver plugins work identically.
export {
  ALL_OPERATIONS,
  MUTATING_OPERATIONS,
  OP_REGISTRY,
  operationsByPolicyKey,
  READ_OPERATIONS,
} from './operations.js';
export { PaginationEngine } from './pagination/PaginationEngine.js';
export type { AggregateHelpersMethods } from './plugins/aggregate-helpers.plugin.js';
export { aggregateHelpersPlugin } from './plugins/aggregate-helpers.plugin.js';
export { auditLogPlugin } from './plugins/audit-log.plugin.js';
export type {
  AuditEntry,
  AuditOperation,
  AuditQueryOptions,
  AuditQueryResult,
  AuditTrailMethods,
  AuditTrailOptions,
} from './plugins/audit-trail.plugin.js';
export { AuditTrailQuery, auditTrailPlugin } from './plugins/audit-trail.plugin.js';
export type { BatchOperationsMethods, BulkWriteResult } from './plugins/batch-operations.plugin.js';
export { batchOperationsPlugin } from './plugins/batch-operations.plugin.js';
export type { CacheMethods } from './plugins/cache.plugin.js';
export { cachePlugin } from './plugins/cache.plugin.js';
export { cascadePlugin } from './plugins/cascade.plugin.js';
export type {
  CustomIdOptions,
  DateSequentialIdOptions,
  IdGenerator,
  PrefixedIdOptions,
  SequentialIdOptions,
} from './plugins/custom-id.plugin.js';
export {
  customIdPlugin,
  dateSequentialId,
  getNextSequence,
  prefixedId,
  sequentialId,
} from './plugins/custom-id.plugin.js';
export type { ElasticSearchOptions } from './plugins/elastic.plugin.js';
export { elasticSearchPlugin } from './plugins/elastic.plugin.js';
// Plugins
export { fieldFilterPlugin } from './plugins/field-filter.plugin.js';
export { methodRegistryPlugin } from './plugins/method-registry.plugin.js';
export type { MongoOperationsMethods } from './plugins/mongo-operations.plugin.js';
export { mongoOperationsPlugin } from './plugins/mongo-operations.plugin.js';
export type { MultiTenantOptions } from './plugins/multi-tenant.plugin.js';
export { multiTenantPlugin } from './plugins/multi-tenant.plugin.js';
export type {
  ObservabilityOptions,
  OperationMetric,
} from './plugins/observability.plugin.js';
export { observabilityPlugin } from './plugins/observability.plugin.js';
export type { SoftDeleteMethods } from './plugins/soft-delete.plugin.js';
export { softDeletePlugin } from './plugins/soft-delete.plugin.js';
export type { SubdocumentMethods } from './plugins/subdocument.plugin.js';
export { subdocumentPlugin } from './plugins/subdocument.plugin.js';
export type { TenantContext, TenantStore } from './plugins/tenant-context.js';
export { createTenantContext } from './plugins/tenant-context.js';
export { timestampPlugin } from './plugins/timestamp.plugin.js';
export {
  autoInject,
  blockIf,
  immutableField,
  requireField,
  uniqueField,
  validationChainPlugin,
} from './plugins/validation-chain.plugin.js';
// Query types
export type {
  FieldType,
  FilterQuery,
  LookupOptions,
  ParsedQuery,
  PopulateOption,
  QueryParserOptions,
  SchemaLike,
  SearchMode,
  SortSpec,
} from './query/index.js';
// Query utilities - Modern MongoDB query building
export {
  AggregationBuilder,
  LookupBuilder,
  QueryParser,
} from './query/index.js';
// Query primitives are NOT re-exported from the top-level barrel on purpose —
// that would defeat tree-shaking. Import them directly from their module:
//
//   import { parseGeoFilter } from '@classytic/mongokit/query/primitives/geo';
//   import { coerceFieldValue } from '@classytic/mongokit/query/primitives/coercion';
//   import { extractSchemaIndexes } from '@classytic/mongokit/query/primitives/indexes';
//
// See package.json `exports` for the available subpaths.
// Core exports
export { HOOK_PRIORITY, Repository } from './Repository.js';
export { isTransactionUnsupported, withTransaction } from './transaction.js';
// Types
export type {
  AggregateOptions,
  AggregatePaginationOptions,
  AggregatePaginationResult,
  // Plugin Method Combinations (Helper Types)
  AllPluginMethods,
  AnyDocument,
  AnyModel,
  // Cache
  CacheAdapter,
  CacheableOptions,
  CacheOperationOptions,
  CacheOptions,
  CacheStats,
  CascadeOptions,
  // Cascade Delete
  CascadeRelation,
  CollationOptions,
  CreateInput,
  CreateOptions,
  CrudSchemas,
  // Cursor
  DecodedCursor,
  DeepPartial,
  DeleteResult,
  DocField,
  EventHandlers,
  EventPayload,
  EventPhase,
  // Field Selection
  FieldPreset,
  // Schema Builder
  FieldRules,
  FindOneAndUpdateOptions,
  // Aggregates
  GroupResult,
  HookMode,
  // Error
  HttpError,
  // Controller (Framework-Agnostic)
  IController,
  IControllerResponse,
  // Utility types (modern TS patterns)
  InferDocument,
  InferRawDoc,
  IRequestContext,
  IResponseFormatter,
  JsonSchema,
  KeysetPaginationOptions,
  KeysetPaginationResult,
  KeysOfType,
  // Logger
  Logger,
  LookupPopulateOptions,
  LookupPopulateResult,
  MinMaxResult,
  NonNullableFields,
  // Core types
  ObjectId,
  OffsetPaginationOptions,
  OffsetPaginationResult,
  // Repository
  OperationOptions,
  // Pagination
  PaginationConfig,
  PaginationResult,
  PartialBy,
  // Plugins
  Plugin,
  PluginFunction,
  PluginType,
  PopulateSpec,
  ReadOptions,
  ReadPreferenceType,
  RepositoryContext,
  RepositoryEvent,
  RepositoryInstance,
  // Events (template literal types)
  RepositoryOperation,
  RepositoryOptions,
  RequiredBy,
  SchemaBuilderOptions,
  SelectSpec,
  SessionOptions,
  SoftDeleteFilterMode,
  // Soft Delete
  SoftDeleteOptions,
  SoftDeleteRepository,
  SortDirection,
  Strict,
  UpdateInput,
  UpdateManyResult,
  UpdateOptions,
  UpdateWithValidationResult,
  // Context
  UserContext,
  ValidationChainOptions,
  ValidationResult,
  // Validators
  ValidatorDefinition,
  WithPlugins,
  WithTransactionOptions,
} from './types.js';
export { createError, isDuplicateKeyError, parseDuplicateKeyError } from './utils/error.js';
// Utilities
export {
  createFieldPreset,
  filterResponseData,
  getFieldsForUser,
  getMongooseProjection,
} from './utils/field-selection.js';
export { configureLogger } from './utils/logger.js';
export { createMemoryCache } from './utils/memory-cache.js';
// Schema builder utilities
export {
  buildCrudSchemasFromModel,
  buildCrudSchemasFromMongooseSchema,
  getImmutableFields,
  getSystemManagedFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
} from './utils/mongooseToJsonSchema.js';

// Re-export Repository as default
import { Repository } from './Repository.js';

/**
 * Factory function to create a repository instance
 *
 * @param Model - Mongoose model
 * @param plugins - Array of plugins to apply
 * @returns Repository instance
 *
 * @example
 * const userRepo = createRepository(UserModel, [timestampPlugin()]);
 */
export function createRepository<TDoc>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Model: import('mongoose').Model<TDoc, any, any, any>,
  plugins: import('./types.js').PluginType[] = [],
  paginationConfig: import('./types.js').PaginationConfig = {},
  options: import('./types.js').RepositoryOptions = {},
): Repository<TDoc> {
  return new Repository(Model, plugins, paginationConfig, options);
}

export default Repository;
