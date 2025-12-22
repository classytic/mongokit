/**
 * MongoKit - Event-driven repository pattern for MongoDB
 * 
 * Production-grade MongoDB repositories with zero dependencies -
 * smart pagination, events, and plugins.
 * 
 * @module @classytic/mongokit
 * @author Sadman Chowdhury (Github: @siam923)
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

// Core exports
export { Repository } from './Repository.js';
export { PaginationEngine } from './pagination/PaginationEngine.js';

// Plugins
export { fieldFilterPlugin } from './plugins/field-filter.plugin.js';
export { timestampPlugin } from './plugins/timestamp.plugin.js';
export { auditLogPlugin } from './plugins/audit-log.plugin.js';
export { softDeletePlugin } from './plugins/soft-delete.plugin.js';
export { methodRegistryPlugin } from './plugins/method-registry.plugin.js';
export {
  validationChainPlugin,
  blockIf,
  requireField,
  autoInject,
  immutableField,
  uniqueField,
} from './plugins/validation-chain.plugin.js';
export { mongoOperationsPlugin } from './plugins/mongo-operations.plugin.js';
export { batchOperationsPlugin } from './plugins/batch-operations.plugin.js';
export { aggregateHelpersPlugin } from './plugins/aggregate-helpers.plugin.js';
export { subdocumentPlugin } from './plugins/subdocument.plugin.js';
export { cachePlugin } from './plugins/cache.plugin.js';
export { cascadePlugin } from './plugins/cascade.plugin.js';

// Utilities
export {
  getFieldsForUser,
  getMongooseProjection,
  filterResponseData,
  createFieldPreset,
} from './utils/field-selection.js';

export { createError } from './utils/error.js';

export { createMemoryCache } from './utils/memory-cache.js';

// Schema builder utilities
export {
  buildCrudSchemasFromMongooseSchema,
  buildCrudSchemasFromModel,
  getImmutableFields,
  getSystemManagedFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
} from './utils/mongooseToJsonSchema.js';

// Query parser
export { default as queryParser, QueryParser } from './utils/queryParser.js';

// Actions (for advanced use cases)
export * as actions from './actions/index.js';

// Types
export type {
  // Core types
  ObjectId,
  AnyDocument,
  AnyModel,
  SortDirection,
  SortSpec,
  PopulateSpec,
  SelectSpec,
  HookMode,
  RepositoryOptions,
  
  // Pagination
  PaginationConfig,
  OffsetPaginationOptions,
  KeysetPaginationOptions,
  AggregatePaginationOptions,
  OffsetPaginationResult,
  KeysetPaginationResult,
  AggregatePaginationResult,
  PaginationResult,
  
  // Repository
  OperationOptions,
  WithTransactionOptions,
  CreateOptions,
  UpdateOptions,
  DeleteResult,
  UpdateManyResult,
  ValidationResult,
  UpdateWithValidationResult,
  
  // Context
  UserContext,
  RepositoryContext,
  
  // Plugins
  Plugin,
  PluginFunction,
  PluginType,
  RepositoryInstance,
  
  // Events
  RepositoryEvent,
  EventPayload,
  
  // Field Selection
  FieldPreset,
  
  // Query Parser
  ParsedQuery,
  FilterQuery,
  
  // Schema Builder
  FieldRules,
  SchemaBuilderOptions,
  JsonSchema,
  CrudSchemas,
  
  // Cursor
  DecodedCursor,
  
  // Validators
  ValidatorDefinition,
  ValidationChainOptions,
  
  // Logger
  Logger,
  
  // Soft Delete
  SoftDeleteOptions,
  SoftDeleteFilterMode,
  SoftDeleteRepository,
  
  // Aggregates
  LookupOptions,
  GroupResult,
  MinMaxResult,
  
  // Cache
  CacheAdapter,
  CacheOptions,
  CacheOperationOptions,
  CacheStats,

  // Cascade Delete
  CascadeRelation,
  CascadeOptions,

  // Error
  HttpError,
} from './types.js';

// Query parser types
export type { QueryParserOptions, OperatorMap, FilterValue } from './utils/queryParser.js';

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
  options: import('./types.js').RepositoryOptions = {}
): Repository<TDoc> {
  return new Repository(Model, plugins, paginationConfig, options);
}

export default Repository;
