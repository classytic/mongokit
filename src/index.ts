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
 * import { createRepository } from '@classytic/mongokit';
 *
 * // Create repository with declarative config (plugins composed in the
 * // canonical safe order automatically)
 * const userRepo = createRepository(UserModel, {
 *   timestamps: true,
 *   softDelete: true,
 * });
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

export {
  type CascadePurgeReferencesOptions,
  type CollectionRWLike,
  cascadePurgeReferences,
  type PurgeableRepoLike,
  type PurgeMode,
  type ReferencePurgeResult,
  type ReferenceRelation,
} from './actions/cascade-references.js';
// Repo-core-owned types are NOT re-exported from this barrel by design.
// `OffsetPaginationResult` / `KeysetPaginationResult` /
// `AggregatePaginationResult` / `AnyPaginationResult` (formerly
// `PaginationResult`) live in `@classytic/repo-core/pagination`;
// `HttpError` lives in `@classytic/repo-core/errors`; `CrudSchemas` lives
// in `@classytic/repo-core/schema`. Two import paths for the same type
// would defeat the "single source of truth" migration that 3.12
// completed — consumers must import them from repo-core directly.
// See CHANGELOG 3.12.0 ("Breaking changes — type re-export removals").
// Actions (for advanced use cases - standalone utilities)
export * as actions from './actions/index.js';
// Query primitives are NOT re-exported from the top-level barrel on purpose —
// that would defeat tree-shaking. Import them directly from their module:
//
//   import { parseGeoFilter } from '@classytic/mongokit/query/primitives/geo';
//   import { coerceFieldValue } from '@classytic/mongokit/query/primitives/coercion';
//   import { extractSchemaIndexes } from '@classytic/mongokit/query/primitives/indexes';
//
// See package.json `exports` for the available subpaths.
// Core exports
export { MONGOKIT_CAPABILITIES } from './capabilities.js';
export type { AuditConfig, CreateRepositoryConfig } from './create-repository.js';
export { createRepository } from './create-repository.js';
// Filter compiler — exposed for hosts that want to reuse mongokit's
// bracket-syntax + Filter-IR → Mongo query translation in materialized
// aggregation hooks or custom routes (mirrors what arc's IR aggregation
// path uses internally so wire-shape stays consistent across both).
export { compileFilterToMongo } from './filter/compile.js';
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
export { type AppendOnlyPluginOptions, appendOnlyPlugin } from './plugins/append-only.plugin.js';
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
export {
  type CacheAdapter,
  type CacheOptions,
  cachePlugin,
  type RepositoryCacheHandle,
  type RepositoryCachePluginOptions,
} from './plugins/cache.plugin.js';
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
export {
  type ImmutableClaimView,
  type ImmutableStatesPluginOptions,
  immutableStatesPlugin,
} from './plugins/immutable-states.plugin.js';
export type { LeaseMethods, LeasePluginOptions } from './plugins/lease.plugin.js';
export { leasePlugin } from './plugins/lease.plugin.js';
export { methodRegistryPlugin } from './plugins/method-registry.plugin.js';
export type { MongoOperationsMethods } from './plugins/mongo-operations.plugin.js';
export { mongoOperationsPlugin } from './plugins/mongo-operations.plugin.js';
export type { MultiTenantOptions } from './plugins/multi-tenant.plugin.js';
export { adminBypass, multiTenantPlugin } from './plugins/multi-tenant.plugin.js';
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
export { HOOK_PRIORITY, Repository, type TransitionMachine } from './Repository.js';
export { batchTransaction, isTransactionUnsupported, withTransaction } from './transaction.js';
// Types
export type {
  AggregateOptions,
  AggregatePaginationOptions,
  // Plugin Method Combinations (Helper Types)
  AllPluginMethods,
  AnyDocument,
  AnyModel,
  BasePaginationOptions,
  // Cache (legacy mongokit-specific helpers — unified cache types live
  // in `@classytic/repo-core/cache`; see `cachePlugin` re-export above)
  CacheableOptions,
  CacheOperationOptions,
  CascadeOptions,
  // Cascade Delete
  CascadeRelation,
  CollationOptions,
  CreateInput,
  CreateOptions,
  // Cursor
  CursorPayload,
  DecodedCursor,
  DeepPartial,
  DeleteResult,
  DocField,
  EventHandlers,
  EventPayload,
  EventPhase,
  // Field Selection
  FieldPreset,
  FindOneAndUpdateOptions,
  // Aggregates
  GroupResult,
  HookMode,
  // Controller (Framework-Agnostic)
  IController,
  IControllerResponse,
  // Utility types (modern TS patterns)
  InferDocument,
  InferRawDoc,
  IRequestContext,
  IResponseFormatter,
  KeysetPaginationOptions,
  KeysOfType,
  // Logger
  Logger,
  LookupPopulateOptions,
  LookupPopulateResult,
  // Wrap-style middleware (additive — composes with `repo.on()` hooks)
  Middleware,
  MiddlewareContext,
  MinimalRepoView,
  MinMaxResult,
  // Mongo update-document shape (typed operators + index signature)
  MongoOperatorUpdate,
  NonNullableFields,
  // Core types
  ObjectId,
  OffsetPaginationOptions,
  // Repository
  OperationOptions,
  // Pagination
  PaginationConfig,
  PartialBy,
  // Plugins
  Plugin,
  PluginFunction,
  PluginType,
  PopulateSpec,
  PrioritizedHook,
  ReadOptions,
  ReadPreferenceType,
  RepositoryContext,
  RepositoryEvent,
  RepositoryInstance,
  // Events (template literal types)
  RepositoryOperation,
  RepositoryOptions,
  RequiredBy,
  SelectSpec,
  SessionOptions,
  SoftDeleteFilterMode,
  // Soft Delete
  SoftDeleteOptions,
  SoftDeleteRepository,
  SortDirection,
  Strict,
  UpdateManyResult,
  UpdateOptions,
  UpdatePatch,
  UpdateWithValidationResult,
  // Context
  UserContext,
  ValidationChainOptions,
  // Validators
  ValidatorDefinition,
  ValueType,
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
export { idVariants } from './utils/id-resolution.js';
export { configureLogger } from './utils/logger.js';
export { createMemoryCache } from './utils/memory-cache.js';
// Schema builders — the mongoose-specific introspectors. Policy helpers
// (`getImmutableFields`, `validateUpdateBody`, etc.) are shipped by
// `@classytic/repo-core/schema` for cross-kit consistency.
export {
  buildCrudSchemasFromModel,
  buildCrudSchemasFromMongooseSchema,
} from './utils/mongooseToJsonSchema.js';
export { createOptionsExtractor, repoOptionsFromCtx, systemContext } from './utils/repo-options.js';
export { toPlain } from './utils/to-plain.js';

// Re-export Repository as default
import { Repository } from './Repository.js';

export default Repository;
