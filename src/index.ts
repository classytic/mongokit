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
  FilterQuery,
  LookupOptions,
  ParsedQuery,
  PopulateOption,
  QueryParserOptions,
  SearchMode,
  SortSpec,
} from './query/index.js';
// Query utilities - Modern MongoDB query building
export {
  AggregationBuilder,
  LookupBuilder,
  QueryParser,
} from './query/index.js';
// Core exports
export { HOOK_PRIORITY, Repository } from './Repository.js';
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
export { createError, parseDuplicateKeyError } from './utils/error.js';
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
