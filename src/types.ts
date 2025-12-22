/**
 * MongoKit Type Definitions
 * 
 * Production-grade types for MongoDB repository pattern with TypeScript
 * 
 * @module @classytic/mongokit
 */

import type {
  Model,
  Document,
  PopulateOptions,
  ClientSession,
  Types,
  PipelineStage,
} from 'mongoose';

// ============================================================================
// Core Types
// ============================================================================

/** Re-export mongoose ObjectId */
export type ObjectId = Types.ObjectId;

/** Generic document type */
export type AnyDocument = Document & Record<string, unknown>;

/** Generic model type */
export type AnyModel = Model<AnyDocument>;

/** Sort direction */
export type SortDirection = 1 | -1;

/** Sort specification */
export type SortSpec = Record<string, SortDirection>;

/** Populate specification */
export type PopulateSpec = string | string[] | PopulateOptions | PopulateOptions[];

/** Select specification */
export type SelectSpec = string | string[] | Record<string, 0 | 1>;

/** Filter query type for MongoDB queries (compatible with Mongoose 8 & 9) */
export type FilterQuery<T> = Record<string, unknown>;

/** Hook execution mode */
export type HookMode = 'sync' | 'async';

/** Repository options */
export interface RepositoryOptions {
  /** Whether repository event hooks are awaited */
  hooks?: HookMode;
}

// ============================================================================
// Pagination Types
// ============================================================================

/** Pagination configuration */
export interface PaginationConfig {
  /** Default number of documents per page (default: 10) */
  defaultLimit?: number;
  /** Maximum allowed limit (default: 100) */
  maxLimit?: number;
  /** Maximum allowed page number (default: 10000) */
  maxPage?: number;
  /** Page number that triggers performance warning (default: 100) */
  deepPageThreshold?: number;
  /** Cursor version for forward compatibility (default: 1) */
  cursorVersion?: number;
  /** Use estimatedDocumentCount for faster counts on large collections */
  useEstimatedCount?: boolean;
}

/** Base pagination options */
export interface BasePaginationOptions {
  /** MongoDB query filters */
  filters?: FilterQuery<AnyDocument>;
  /** Sort specification */
  sort?: SortSpec;
  /** Number of documents per page */
  limit?: number;
  /** Fields to select */
  select?: SelectSpec;
  /** Fields to populate */
  populate?: PopulateSpec;
  /** Return plain JavaScript objects */
  lean?: boolean;
  /** MongoDB session for transactions */
  session?: ClientSession;
}

/** Offset pagination options */
export interface OffsetPaginationOptions extends BasePaginationOptions {
  /** Page number (1-indexed) */
  page?: number;
}

/** Keyset (cursor) pagination options */
export interface KeysetPaginationOptions extends BasePaginationOptions {
  /** Cursor token for next page */
  after?: string;
  /** Sort is required for keyset pagination */
  sort: SortSpec;
}

/** Aggregate pagination options */
export interface AggregatePaginationOptions {
  /** Aggregation pipeline stages */
  pipeline?: PipelineStage[];
  /** Page number (1-indexed) */
  page?: number;
  /** Number of documents per page */
  limit?: number;
  /** MongoDB session for transactions */
  session?: ClientSession;
}

/** Offset pagination result */
export interface OffsetPaginationResult<T = unknown> {
  /** Pagination method used */
  method: 'offset';
  /** Array of documents */
  docs: T[];
  /** Current page number */
  page: number;
  /** Documents per page */
  limit: number;
  /** Total document count */
  total: number;
  /** Total page count */
  pages: number;
  /** Whether next page exists */
  hasNext: boolean;
  /** Whether previous page exists */
  hasPrev: boolean;
  /** Performance warning for deep pagination */
  warning?: string;
}

/** Keyset pagination result */
export interface KeysetPaginationResult<T = unknown> {
  /** Pagination method used */
  method: 'keyset';
  /** Array of documents */
  docs: T[];
  /** Documents per page */
  limit: number;
  /** Whether more documents exist */
  hasMore: boolean;
  /** Cursor token for next page */
  next: string | null;
}

/** Aggregate pagination result */
export interface AggregatePaginationResult<T = unknown> {
  /** Pagination method used */
  method: 'aggregate';
  /** Array of documents */
  docs: T[];
  /** Current page number */
  page: number;
  /** Documents per page */
  limit: number;
  /** Total document count */
  total: number;
  /** Total page count */
  pages: number;
  /** Whether next page exists */
  hasNext: boolean;
  /** Whether previous page exists */
  hasPrev: boolean;
  /** Performance warning for deep pagination */
  warning?: string;
}

/** Union type for all pagination results */
export type PaginationResult<T = unknown> =
  | OffsetPaginationResult<T>
  | KeysetPaginationResult<T>
  | AggregatePaginationResult<T>;

// ============================================================================
// Repository Types
// ============================================================================

/** Repository operation options */
export interface OperationOptions {
  /** MongoDB session for transactions */
  session?: ClientSession;
  /** Fields to select */
  select?: SelectSpec;
  /** Fields to populate */
  populate?: PopulateSpec;
  /** Return plain JavaScript objects */
  lean?: boolean;
  /** Throw error if document not found (default: true) */
  throwOnNotFound?: boolean;
  /** Additional query filters (e.g., for soft delete) */
  query?: Record<string, unknown>;
}

/** withTransaction options */
export interface WithTransactionOptions {
  /** Allow non-transactional fallback when transactions are unsupported */
  allowFallback?: boolean;
  /** Optional hook to observe fallback triggers */
  onFallback?: (error: Error) => void;
}

/** Create operation options */
export interface CreateOptions {
  /** MongoDB session for transactions */
  session?: ClientSession;
  /** Keep insertion order on error (default: true) */
  ordered?: boolean;
}

/** Update operation options */
export interface UpdateOptions extends OperationOptions {
  /** Enable update pipeline syntax */
  updatePipeline?: boolean;
}

/** Delete result */
export interface DeleteResult {
  success: boolean;
  message: string;
  count?: number;
}

/** Update many result */
export interface UpdateManyResult {
  matchedCount: number;
  modifiedCount: number;
}

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  violations?: Array<{
    field: string;
    reason: string;
  }>;
  message?: string;
}

/** Update with validation result */
export type UpdateWithValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: number; message: string; violations?: ValidationResult['violations'] } };

// ============================================================================
// Context Types
// ============================================================================

/** User context for operations */
export interface UserContext {
  _id?: ObjectId | string;
  id?: string;
  roles?: string | string[];
  [key: string]: unknown;
}

/** Repository operation context */
export interface RepositoryContext {
  /** Operation name */
  operation: string;
  /** Model name */
  model: string;
  /** Document data (for create/update) */
  data?: Record<string, unknown>;
  /** Array of documents (for createMany) */
  dataArray?: Record<string, unknown>[];
  /** Document ID (for update/delete/getById) */
  id?: string | ObjectId;
  /** Query filters */
  query?: FilterQuery<AnyDocument>;
  /** User making the request */
  user?: UserContext;
  /** Organization ID for multi-tenancy */
  organizationId?: string | ObjectId;
  /** Fields to select */
  select?: SelectSpec;
  /** Fields to populate */
  populate?: PopulateSpec;
  /** Return lean documents */
  lean?: boolean;
  /** MongoDB session */
  session?: ClientSession;
  /** Include soft-deleted documents */
  includeDeleted?: boolean;
  /** Custom context data from plugins */
  [key: string]: unknown;
}

// ============================================================================
// Plugin Types
// ============================================================================

/** Plugin interface */
export interface Plugin {
  /** Plugin name */
  name: string;
  /** Apply plugin to repository */
  apply(repo: RepositoryInstance): void;
}

/** Plugin function signature */
export type PluginFunction = (repo: RepositoryInstance) => void;

/** Plugin type (object or function) */
export type PluginType = Plugin | PluginFunction;

/** Repository instance for plugin type reference */
export interface RepositoryInstance {
  Model: Model<any>;
  model: string;
  _hooks: Map<string, Array<(data: any) => void | Promise<void>>>;
  _pagination: unknown;
  use(plugin: PluginType): this;
  on(event: string, listener: (data: any) => void | Promise<void>): this;
  emit(event: string, data: unknown): void;
  emitAsync(event: string, data: unknown): Promise<void>;
  registerMethod?(name: string, fn: Function): void;
  hasMethod?(name: string): boolean;
  [key: string]: unknown;
}

// ============================================================================
// Event Types
// ============================================================================

/** Repository event names */
export type RepositoryEvent =
  | 'before:create'
  | 'after:create'
  | 'error:create'
  | 'before:createMany'
  | 'after:createMany'
  | 'error:createMany'
  | 'before:update'
  | 'after:update'
  | 'error:update'
  | 'before:updateMany'
  | 'after:updateMany'
  | 'error:updateMany'
  | 'before:delete'
  | 'after:delete'
  | 'error:delete'
  | 'before:deleteMany'
  | 'after:deleteMany'
  | 'error:deleteMany'
  | 'before:getById'
  | 'after:getById'
  | 'before:getByQuery'
  | 'after:getByQuery'
  | 'before:getAll'
  | 'after:getAll'
  | 'before:aggregatePaginate'
  | 'method:registered'
  | 'error:hook';

/** Event payload */
export interface EventPayload {
  context: RepositoryContext;
  result?: unknown;
  error?: Error;
}

// ============================================================================
// Field Selection Types
// ============================================================================

/** Field preset configuration */
export interface FieldPreset {
  /** Fields visible to everyone */
  public: string[];
  /** Additional fields for authenticated users */
  authenticated?: string[];
  /** Additional fields for admins */
  admin?: string[];
}

// ============================================================================
// Query Parser Types
// ============================================================================

/** Parsed query result */
export interface ParsedQuery {
  filters: FilterQuery<AnyDocument>;
  limit: number;
  sort: SortSpec | undefined;
  populate: string | undefined;
  search: string | undefined;
  page?: number;
  after?: string;
}

// ============================================================================
// Schema Builder Types
// ============================================================================

/** Field rules for schema building */
export interface FieldRules {
  [fieldName: string]: {
    /** Field cannot be updated */
    immutable?: boolean;
    /** Alias for immutable */
    immutableAfterCreate?: boolean;
    /** System-only field (omitted from create/update) */
    systemManaged?: boolean;
    /** Remove from required array */
    optional?: boolean;
  };
}

/** Schema builder options */
export interface SchemaBuilderOptions {
  /** Field rules for create/update */
  fieldRules?: FieldRules;
  /** Strict additional properties (default: false) */
  strictAdditionalProperties?: boolean;
  /** Date format: 'date' | 'datetime' */
  dateAs?: 'date' | 'datetime';
  /** Create schema options */
  create?: {
    /** Fields to omit from create schema */
    omitFields?: string[];
    /** Override required status */
    requiredOverrides?: Record<string, boolean>;
    /** Override optional status */
    optionalOverrides?: Record<string, boolean>;
    /** Schema overrides */
    schemaOverrides?: Record<string, unknown>;
  };
  /** Update schema options */
  update?: {
    /** Fields to omit from update schema */
    omitFields?: string[];
  };
  /** Query schema options */
  query?: {
    /** Filterable fields */
    filterableFields?: Record<string, { type: string } | unknown>;
  };
}

/** JSON Schema type */
export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | unknown;
  items?: unknown;
  enum?: string[];
  format?: string;
  pattern?: string;
}

/** CRUD schemas result - framework-agnostic JSON schemas */
export interface CrudSchemas {
  /** JSON Schema for create request body */
  createBody: JsonSchema;
  /** JSON Schema for update request body */
  updateBody: JsonSchema;
  /** JSON Schema for route params (id validation) */
  params: JsonSchema;
  /** JSON Schema for list/query parameters */
  listQuery: JsonSchema;
}

// ============================================================================
// Cursor Types
// ============================================================================

/** Value type identifier for cursor serialization */
export type ValueType = 'date' | 'objectid' | 'boolean' | 'number' | 'string' | 'unknown';

/** Cursor payload */
export interface CursorPayload {
  /** Primary sort field value */
  v: string | number | boolean;
  /** Value type identifier */
  t: ValueType;
  /** Document ID */
  id: string;
  /** ID type identifier */
  idType: ValueType;
  /** Sort specification */
  sort: SortSpec;
  /** Cursor version */
  ver: number;
}

/** Decoded cursor */
export interface DecodedCursor {
  /** Primary sort field value (rehydrated) */
  value: unknown;
  /** Document ID (rehydrated) */
  id: ObjectId | string;
  /** Sort specification */
  sort: SortSpec;
  /** Cursor version */
  version: number;
}

// ============================================================================
// Validator Types
// ============================================================================

/** Validator definition */
export interface ValidatorDefinition {
  /** Validator name */
  name: string;
  /** Operations to apply validator to */
  operations?: Array<'create' | 'createMany' | 'update' | 'delete'>;
  /** Validation function */
  validate: (context: RepositoryContext, repo?: RepositoryInstance) => void | Promise<void>;
}

/** Validation chain options */
export interface ValidationChainOptions {
  /** Stop on first validation error (default: true) */
  stopOnFirstError?: boolean;
}

// ============================================================================
// Logger Types
// ============================================================================

/** Logger interface for audit plugin */
export interface Logger {
  info?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

// ============================================================================
// Soft Delete Types
// ============================================================================

/** Filter mode for soft delete queries */
export type SoftDeleteFilterMode = 'null' | 'exists';

/** Soft delete plugin options */
export interface SoftDeleteOptions {
  /** Field name for deletion timestamp (default: 'deletedAt') */
  deletedField?: string;
  /** Field name for deleting user (default: 'deletedBy') */
  deletedByField?: string;
  /** Enable soft delete (default: true) */
  soft?: boolean;
  /**
   * Filter mode for excluding deleted documents (default: 'null')
   * - 'null': Filters where deletedField is null (works with `default: null` in schema)
   * - 'exists': Filters where deletedField does not exist (legacy behavior)
   */
  filterMode?: SoftDeleteFilterMode;
  /** Add restore method to repository (default: true) */
  addRestoreMethod?: boolean;
  /** Add getDeleted method to repository (default: true) */
  addGetDeletedMethod?: boolean;
  /**
   * TTL in days for auto-cleanup of deleted documents.
   * When set, creates a TTL index on the deletedField.
   * Documents will be automatically removed after the specified days.
   */
  ttlDays?: number;
}

/** Repository with soft delete methods */
export interface SoftDeleteRepository {
  /**
   * Restore a soft-deleted document by setting deletedAt to null
   * @param id - Document ID to restore
   * @param options - Optional session for transactions
   * @returns The restored document
   */
  restore(id: string | ObjectId, options?: { session?: ClientSession }): Promise<unknown>;

  /**
   * Get all soft-deleted documents
   * @param params - Query parameters (filters, pagination, etc.)
   * @param options - Query options (select, populate, etc.)
   * @returns Paginated result of deleted documents
   */
  getDeleted(
    params?: {
      filters?: Record<string, unknown>;
      sort?: SortSpec | string;
      page?: number;
      limit?: number;
    },
    options?: { select?: SelectSpec; populate?: PopulateSpec; lean?: boolean; session?: ClientSession }
  ): Promise<OffsetPaginationResult<unknown>>;
}

// ============================================================================
// Aggregate Types
// ============================================================================

/** Lookup options for aggregate */
export interface LookupOptions {
  /** Collection to join */
  from: string;
  /** Local field to match */
  localField: string;
  /** Foreign field to match */
  foreignField: string;
  /** Output array field name */
  as: string;
  /** Additional pipeline stages */
  pipeline?: PipelineStage[];
  /** Initial match query */
  query?: FilterQuery<AnyDocument>;
  /** Operation options */
  options?: { session?: ClientSession };
}

/** Group result */
export interface GroupResult {
  _id: unknown;
  count: number;
}

/** Min/Max result */
export interface MinMaxResult {
  min: unknown;
  max: unknown;
}

// ============================================================================
// Cache Types
// ============================================================================

/**
 * Cache adapter interface - bring your own cache implementation
 * Works with Redis, Memcached, in-memory, or any key-value store
 * 
 * @example Redis implementation:
 * ```typescript
 * const redisCache: CacheAdapter = {
 *   async get(key) { return JSON.parse(await redis.get(key) || 'null'); },
 *   async set(key, value, ttl) { await redis.setex(key, ttl, JSON.stringify(value)); },
 *   async del(key) { await redis.del(key); },
 *   async clear(pattern) { 
 *     const keys = await redis.keys(pattern || '*');
 *     if (keys.length) await redis.del(...keys);
 *   }
 * };
 * ```
 */
export interface CacheAdapter {
  /** Get value by key, returns null if not found or expired */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Set value with TTL in seconds */
  set<T = unknown>(key: string, value: T, ttl: number): Promise<void>;
  /** Delete single key */
  del(key: string): Promise<void>;
  /** Clear keys matching pattern (optional, used for bulk invalidation) */
  clear?(pattern?: string): Promise<void>;
}

/** Cache plugin options */
export interface CacheOptions {
  /** Cache adapter implementation (required) */
  adapter: CacheAdapter;
  /** Default TTL in seconds (default: 60) */
  ttl?: number;
  /** TTL for byId queries in seconds (default: same as ttl) */
  byIdTtl?: number;
  /** TTL for query/list results in seconds (default: same as ttl) */
  queryTtl?: number;
  /** Key prefix for namespacing (default: 'mk') */
  prefix?: string;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** 
   * Skip caching for queries with these characteristics:
   * - largeLimit: Skip if limit > value (default: 100)
   */
  skipIf?: {
    largeLimit?: number;
  };
}

/** Options for cache-aware operations */
export interface CacheOperationOptions {
  /** Skip cache for this operation (read from DB directly) */
  skipCache?: boolean;
  /** Custom TTL for this operation in seconds */
  cacheTtl?: number;
}

/** Cache statistics (for debugging/monitoring) */
export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
}

// ============================================================================
// Cascade Delete Types
// ============================================================================

/** Cascade relation definition */
export interface CascadeRelation {
  /** Model name to cascade delete to */
  model: string;
  /** Foreign key field in the related model that references the deleted document */
  foreignKey: string;
  /** Whether to use soft delete if available (default: follows parent behavior) */
  softDelete?: boolean;
}

/** Cascade delete plugin options */
export interface CascadeOptions {
  /** Relations to cascade delete */
  relations: CascadeRelation[];
  /** Run cascade deletes in parallel (default: true) */
  parallel?: boolean;
  /** Logger for cascade operations */
  logger?: Logger;
}

// ============================================================================
// HTTP Error Type
// ============================================================================

/** HTTP Error with status code */
export interface HttpError extends Error {
  status: number;
  validationErrors?: Array<{ validator: string; error: string }>;
}
