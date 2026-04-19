/**
 * MongoKit Type Definitions
 *
 * Production-grade types for MongoDB repository pattern with TypeScript
 *
 * @module @classytic/mongokit
 */

/**
 * Global declaration merge: adds `softRequired` to Mongoose's SchemaTypeOptions
 * so consumers can annotate paths type-safely without importing anything.
 *
 * A path with `softRequired: true` keeps its DB-level `required: true`
 * invariant but is excluded from the auto-generated CRUD body `required[]`
 * array (see buildCrudSchemasFromModel).
 */
declare module 'mongoose' {
  interface SchemaTypeOptions<
    T,
    EnforcedDocType = any,
    THydratedDocumentType = HydratedDocument<EnforcedDocType>,
  > {
    /** mongokit: omit from auto-generated CRUD body `required` array. */
    softRequired?: boolean;
  }
}

import type {
  ClientSession,
  Document,
  Model,
  PipelineStage,
  PopulateOptions,
  Types,
} from 'mongoose';

// ============================================================================
// ============================================================================
// Core Types
// ============================================================================

/** Read Preference Type for replica sets */
export type ReadPreferenceType =
  | 'primary'
  | 'primaryPreferred'
  | 'secondary'
  | 'secondaryPreferred'
  | 'nearest'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** Re-export mongoose ObjectId */
export type ObjectId = Types.ObjectId;

/** Generic document type */
export type AnyDocument = Document & Record<string, unknown>;

/** Generic model type */
export type AnyModel = Model<AnyDocument>;

/** Sort direction */
export type SortDirection = 1 | -1;

/** Sort specification for MongoDB queries */
export type SortSpec = Record<string, SortDirection>;

/** Populate specification */
export type PopulateSpec = string | string[] | PopulateOptions | PopulateOptions[];

/** Select specification */
export type SelectSpec = string | string[] | Record<string, 0 | 1>;

/** Filter query type for MongoDB queries (compatible with Mongoose 8 & 9) */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type FilterQuery<_T = unknown> = Record<string, unknown>;

// ============================================================================
// Utility Types (Modern TypeScript Patterns)
// ============================================================================

/**
 * Infer document type from a Mongoose Model
 * @example
 * type UserDoc = InferDocument<typeof UserModel>;
 */
export type InferDocument<TModel> = TModel extends Model<infer TDoc> ? TDoc : never;

/**
 * Infer raw document shape (without Mongoose Document methods)
 * @example
 * type User = InferRawDoc<typeof UserModel>;
 */
export type InferRawDoc<TModel> =
  TModel extends Model<infer TDoc>
    ? TDoc extends Document
      ? Omit<TDoc, keyof Document>
      : TDoc
    : never;

/**
 * Make specific fields optional
 * @example
 * type CreateUser = PartialBy<User, 'createdAt' | 'updatedAt'>;
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Make specific fields required
 * @example
 * type UserWithId = RequiredBy<User, '_id'>;
 */
export type RequiredBy<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

/**
 * Extract keys of type T that have values of type V
 * @example
 * type StringFields = KeysOfType<User, string>; // 'name' | 'email'
 */
export type KeysOfType<T, V> = {
  [K in keyof T]: T[K] extends V ? K : never;
}[keyof T];

/**
 * Deep partial - makes all nested properties optional
 */
export type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T;

/**
 * Strict object type - prevents excess properties
 * Use with `satisfies` for compile-time validation
 */
export type Strict<T> = T & { [K in Exclude<string, keyof T>]?: never };

/**
 * NonNullable fields extractor
 */
export type NonNullableFields<T> = {
  [K in keyof T]: NonNullable<T[K]>;
};

/**
 * Create/Update input types from document
 */
export type CreateInput<TDoc> = Omit<TDoc, '_id' | 'createdAt' | 'updatedAt' | '__v'>;
export type UpdateInput<TDoc> = Partial<Omit<TDoc, '_id' | 'createdAt' | '__v'>>;

/** Hook execution mode */
export type HookMode = 'sync' | 'async';

/** Search strategy used by Repository.getAll when `search` is provided */
export type RepositorySearchMode = 'text' | 'regex' | 'auto';

/** Repository options */
export interface RepositoryOptions {
  /** Whether repository event hooks are awaited */
  hooks?: HookMode;
  /** Custom ID field used by getById/update/delete (default: '_id').
   * Set to 'slug', 'code', 'chatId', etc. for non-ObjectId lookups. */
  idField?: string;
  /**
   * How Repository.getAll handles the `search` parameter.
   * - 'text' (default): uses MongoDB $text; requires a text index.
   * - 'regex': builds case-insensitive $or of $regex across `searchFields`. No index required.
   * - 'auto': uses 'text' if a text index exists, otherwise falls back to 'regex' when `searchFields` is set.
   *
   * Works standalone (Express/Nest/etc.) or alongside QueryParser — when the parser
   * already consumed `search` into filters, Repository does nothing extra.
   */
  searchMode?: RepositorySearchMode;
  /**
   * Fields used when searchMode is 'regex' (or 'auto' falling back to regex).
   * Required for regex mode to take effect.
   */
  searchFields?: string[];
  /**
   * How to react to a plugin composition that is known to be unsafe.
   * - 'warn' (default): log a warning via the configured logger.
   * - 'throw': fail fast at construction time — recommended for production.
   * - 'off': disable the check entirely.
   *
   * Checks currently enforced:
   *   - soft-delete must precede batch-operations (otherwise deleteMany /
   *     updateMany skip the soft-delete filter injection).
   *   - multi-tenant must precede cache (otherwise cache keys are computed
   *     before tenant scoping → cross-tenant cache poisoning risk).
   */
  pluginOrderChecks?: 'warn' | 'throw' | 'off';
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
  /**
   * Minimum cursor version accepted. Bump alongside `cursorVersion` when a
   * breaking format change ships so stale client cursors are rejected with a
   * clear error instead of silently paginating from the wrong position.
   * Default: 1 (accept any cursor <= cursorVersion).
   */
  minCursorVersion?: number;
  /**
   * Allowlist of primary sort fields for keyset pagination. When set, any
   * `getAll({ sort })` whose primary (non-_id) field is not in this list
   * throws at validation time.
   *
   * Use this to lock down keyset pagination to fields that are structurally
   * guaranteed non-null in your schema — keyset sort across null/non-null
   * boundaries is lossy (MongoDB's `$lt/$gt` semantics leave a gap at the
   * type boundary, so not every doc is reachable).
   *
   * `_id` is always allowed regardless of this list.
   * Undefined (default) = no allowlist, any sort field accepted.
   */
  strictKeysetSortFields?: string[];
  /** Use estimatedDocumentCount for faster counts on large collections */
  useEstimatedCount?: boolean;
}

/** MongoDB collation options for locale-aware string comparison */
export interface CollationOptions {
  locale: string;
  caseLevel?: boolean;
  caseFirst?: 'upper' | 'lower' | 'off';
  strength?: 1 | 2 | 3 | 4 | 5;
  numericOrdering?: boolean;
  alternate?: 'non-ignorable' | 'shifted';
  maxVariable?: 'punct' | 'space';
  backwards?: boolean;
}

/** Base pagination options */
export interface BasePaginationOptions {
  /** Pagination mode (explicit override) */
  mode?: 'offset' | 'keyset';
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
  /** Query hint (index name or document) */
  hint?: string | Record<string, 1 | -1>;
  /** Maximum execution time in milliseconds */
  maxTimeMS?: number;
  /** Read preference for replica sets (e.g. 'secondaryPreferred') */
  readPreference?: ReadPreferenceType;
  /** Collation for locale-aware string comparison and case-insensitive sorting */
  collation?: CollationOptions;
}

/** Offset pagination options */
export interface OffsetPaginationOptions extends BasePaginationOptions {
  /** Page number (1-indexed) */
  page?: number;
  /** Count strategy for filtered queries (default: 'exact') */
  countStrategy?: 'exact' | 'estimated' | 'none';
  /**
   * Optional alternate filter used for the count query only. The primary
   * `filters` is still used for `.find()`. Lets callers (Repository) run a
   * sort-only query like `$near` for results while counting with a
   * count-compatible rewrite (e.g. `$geoWithin: $centerSphere`) that
   * returns the same document set but works with `countDocuments`.
   */
  countFilters?: FilterQuery<AnyDocument>;
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
  /** Query hint (index name or document) for aggregation */
  hint?: string | Record<string, 1 | -1>;
  /** Maximum execution time in milliseconds */
  maxTimeMS?: number;
  /** Count strategy (default: 'exact' via $facet).
   * 'estimated' is accepted but treated as 'exact' in aggregation context
   * since estimatedDocumentCount is not available inside pipelines. */
  countStrategy?: 'exact' | 'estimated' | 'none';
  /** Pagination mode (reserved for API consistency) */
  mode?: 'offset';
  /** Read preference for replica sets (e.g. 'secondaryPreferred') */
  readPreference?: ReadPreferenceType;
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

/** Session-only options — shared base for lightweight operations */
export interface SessionOptions {
  /** MongoDB session for transactions */
  session?: ClientSession;
  /** Organization/tenant ID for multi-tenant plugin scoping */
  organizationId?: string | ObjectId;
  /** Extensible — plugins can read custom fields from options */
  [key: string]: unknown;
}

/** Read options — session + readPreference for read-only operations */
export interface ReadOptions extends SessionOptions {
  /** Read preference for replica sets (e.g. 'secondaryPreferred') */
  readPreference?: ReadPreferenceType;
}

/** Repository operation options */
export interface OperationOptions extends ReadOptions {
  /** Fields to select */
  select?: SelectSpec;
  /** Fields to populate */
  populate?: PopulateSpec;
  /** Advanced populate options (from QueryParser or Arc's BaseController) */
  populateOptions?: PopulateOptions[];
  /** Return plain JavaScript objects */
  lean?: boolean;
  /** Throw error if document not found (default: true) */
  throwOnNotFound?: boolean;
  /** Override the ID field for this call (default: repo.idField or '_id').
   * Use when the same repo sometimes queries by _id and sometimes by slug/code. */
  idField?: string;
  /** Additional query filters (e.g., for soft delete) */
  query?: Record<string, unknown>;
}

/** Cache-aware operation options — extends OperationOptions with cache controls */
export interface CacheableOptions extends OperationOptions {
  /** Skip cache for this operation (read from DB directly) */
  skipCache?: boolean;
  /** Custom TTL for this operation in seconds */
  cacheTtl?: number;
}

/** withTransaction options */
export interface WithTransactionOptions {
  /** Allow non-transactional fallback when transactions are unsupported */
  allowFallback?: boolean;
  /** Optional hook to observe fallback triggers */
  onFallback?: (error: Error) => void;
  /** MongoDB transaction options (readConcern, writeConcern, readPreference, maxCommitTimeMS) */
  transactionOptions?: import('mongoose').mongo.TransactionOptions;
}

/** Create operation options */
export interface CreateOptions extends SessionOptions {
  /** Keep insertion order on error (default: false).
   * When false, all valid documents insert even if some fail (e.g. duplicates).
   * Set to true to abort remaining inserts on first error. */
  ordered?: boolean;
}

/** Update operation options */
export interface UpdateOptions extends OperationOptions {
  /** Enable update pipeline syntax */
  updatePipeline?: boolean;
  /** Array filters for positional operator $[<identifier>] updates */
  arrayFilters?: Record<string, unknown>[];
}

/**
 * Options for atomic findOneAndUpdate (compare-and-set primitive).
 *
 * Designed for outbox/lock/semaphore patterns that need a single round-trip
 * match-and-mutate. Goes through the full hook pipeline (multi-tenant scope,
 * soft-delete, audit) the same way `update()` does.
 */
export interface FindOneAndUpdateOptions extends OperationOptions {
  /** Sort to disambiguate when filter matches multiple docs (e.g. FIFO claim). */
  sort?: SortSpec;
  /** Return doc state before or after the update. Default: 'after'. */
  returnDocument?: 'before' | 'after';
  /** Insert if no doc matches. Default: false. */
  upsert?: boolean;
  /** Array filters for positional `$[<identifier>]` updates. */
  arrayFilters?: Record<string, unknown>[];
  /** Allow aggregation-pipeline updates (array form). Default: false. */
  updatePipeline?: boolean;
  /** Run mongoose schema validators on the update. Default: true. */
  runValidators?: boolean;
  /** Collation for locale-aware string comparison. */
  collation?: CollationOptions;
  /** Maximum execution time in milliseconds. */
  maxTimeMS?: number;
}

/** Aggregate operation options */
export interface AggregateOptions extends ReadOptions {
  /** Allow aggregation to use disk for large sorts/groups */
  allowDiskUse?: boolean;
  /** Comment for profiler/logs */
  comment?: string;
  /** Maximum execution time in milliseconds */
  maxTimeMS?: number;
  /** Read concern level */
  readConcern?: { level: string };
  /** Collation for locale-aware string comparison */
  collation?: CollationOptions;
  /** Maximum allowed pipeline stages (governance) */
  maxPipelineStages?: number;
}

/** Lookup populate options */
/**
 * Mongokit's `lookupPopulate` options — kit-native superset of the
 * portable `LookupPopulateOptions` from repo-core. Widens two slots:
 *
 *   - `lookups`: accepts either the portable `LookupSpec[]` (works on
 *     every kit) or mongokit's `LookupOptions[]` (adds `pipeline` /
 *     `let` / `sanitize` for mongo-correlated joins).
 *   - `select`: accepts mongoose's space-separated string form
 *     (`'name email'`) in addition to the portable array / inclusion
 *     map. Kept for arc + existing controller convenience.
 *
 * For cross-kit code: type the variable as
 * `import('@classytic/repo-core/repository').LookupPopulateOptions<TDoc>`
 * — every kit's `lookupPopulate` accepts that shape.
 */
export interface LookupPopulateOptions extends ReadOptions {
  /** MongoDB query filters */
  filters?: Record<string, unknown>;
  /**
   * Portable `LookupSpec[]` (cross-kit) or mongokit-native
   * `LookupOptions[]` (with `pipeline` / `let` / `sanitize`). The
   * portable shape is a structural subset, so callers can mix.
   */
  lookups:
    | readonly import('@classytic/repo-core/repository').LookupSpec[]
    | import('./query/LookupBuilder.js').LookupOptions[];
  /** Sort specification */
  sort?: SortSpec | string;
  /** Page number (offset mode, 1-indexed) */
  page?: number;
  /** Cursor token for next page (keyset mode) */
  after?: string;
  /** Number of documents per page */
  limit?: number;
  /** Fields to select */
  select?: SelectSpec;
  /** Collation for locale-aware string comparison */
  collation?: CollationOptions;
  /** Count strategy for offset pagination */
  countStrategy?: 'exact' | 'estimated' | 'none';
}

/**
 * Lookup populate result — re-exported from repo-core so mongokit and
 * sqlitekit produce identical shapes for cross-kit `lookupPopulate`
 * callers. Same discriminated union `getAll` returns: narrow on
 * `result.method` for `'offset'` (page/total/pages/hasNext/hasPrev) vs
 * `'keyset'` (hasMore/next).
 *
 * `LookupRow<TDoc>` is the per-row shape (base doc + joined `as` keys).
 * Mongokit code that previously used `LookupPopulateResult<T>` keeps
 * working — `T` is forwarded as the base-doc generic.
 */
/**
 * Delete + bulk-update results. Re-exported from repo-core so every kit
 * shares the same envelope shape — arc's controllers narrow on these
 * types regardless of backend.
 */
export type {
  DeleteResult,
  LookupPopulateResult,
  LookupRow,
  UpdateManyResult,
} from '@classytic/repo-core/repository';

import type { ValidationResult } from '@classytic/repo-core/schema';

/**
 * Union emitted by the validation-chain plugin. Keeps the violation shape
 * from `ValidationResult` without re-exporting the type — consumers that
 * need `ValidationResult`, `CrudSchemas`, `JsonSchema`, `SchemaBuilderOptions`,
 * `FieldRule` or `FieldRules` import them straight from
 * `@classytic/repo-core/schema`.
 */
export type UpdateWithValidationResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: {
        code: number;
        message: string;
        violations?: ValidationResult['violations'];
      };
    };

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
  // ─────────────────────────────────────────────────────────────────────────
  // Core Context (always present)
  // ─────────────────────────────────────────────────────────────────────────

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
  /** Read preference for replica sets */
  readPreference?: ReadPreferenceType;

  // ─────────────────────────────────────────────────────────────────────────
  // Pagination Context (for getAll operations)
  // ─────────────────────────────────────────────────────────────────────────

  /** Pagination filters */
  filters?: Record<string, unknown>;
  /** Sort specification */
  sort?: SortSpec;
  /** Page number (offset pagination) */
  page?: number;
  /** Items per page */
  limit?: number;
  /** Cursor for next page (keyset pagination) */
  after?: string;
  /** Search query string */
  search?: string;
  /** Pagination mode */
  mode?: 'offset' | 'keyset';
  /** Query hint */
  hint?: string | Record<string, 1 | -1>;
  /** Maximum execution time in milliseconds */
  maxTimeMS?: number;
  /** Count strategy for offset pagination */
  countStrategy?: 'exact' | 'estimated' | 'none';

  // ─────────────────────────────────────────────────────────────────────────
  // Soft Delete Plugin Context
  // ─────────────────────────────────────────────────────────────────────────

  /** Whether this is a soft delete operation (set by softDeletePlugin) */
  softDeleted?: boolean;
  /** Include soft-deleted documents in queries */
  includeDeleted?: boolean;
  /**
   * Caller-requested delete semantics, read by softDeletePlugin.
   *
   * - `undefined` (default) — plugin decides: soft if wired, hard otherwise.
   * - `'hard'` — bypass soft-delete and physically remove the document.
   *   All policy hooks (multi-tenant scope, audit trails, cache invalidation)
   *   still fire; only the soft-delete interception is skipped.
   * - `'soft'` — reserved. Currently treated as default since softDeletePlugin
   *   is the only source of soft semantics.
   */
  deleteMode?: 'hard' | 'soft';

  // ─────────────────────────────────────────────────────────────────────────
  // Cache Plugin Context
  // ─────────────────────────────────────────────────────────────────────────

  /** Skip cache for this operation */
  skipCache?: boolean;
  /** Custom TTL for this operation (seconds) */
  cacheTtl?: number;
  /** Whether result was served from cache (internal) */
  _cacheHit?: boolean;
  /** Cached result (internal) */
  _cachedResult?: unknown;

  // ─────────────────────────────────────────────────────────────────────────
  // Cascade Plugin Context
  // ─────────────────────────────────────────────────────────────────────────

  /** IDs to cascade delete (internal) */
  _cascadeIds?: unknown[];

  // ─────────────────────────────────────────────────────────────────────────
  // Extension Point (for custom plugins)
  // ─────────────────────────────────────────────────────────────────────────

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

/** Hook with priority for deterministic phase ordering */
export interface PrioritizedHook {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listener: (data: any) => void | Promise<void>;
  priority: number;
}

/** Repository instance for plugin type reference */
export interface RepositoryInstance {
  Model: Model<any>;
  model: string;
  _hooks: Map<string, PrioritizedHook[]>;
  _pagination: unknown;
  use(plugin: PluginType): this;
  on(
    event: RepositoryEvent | (string & {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (data: any) => void | Promise<void>,
    options?: { priority?: number },
  ): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: RepositoryEvent | (string & {}), listener: (data: any) => void | Promise<void>): this;
  removeAllListeners(event?: string): this;
  emit(event: string, data: unknown): void;
  emitAsync(event: string, data: unknown): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMethod?(name: string, fn: (...args: any[]) => any): void;
  hasMethod?(name: string): boolean;

  // Internal methods exposed to plugins (typed to avoid casts)
  _buildContext(
    operation: string,
    options: Record<string, unknown> | object,
  ): Promise<RepositoryContext>;
  _handleError(error: Error): HttpError;
  update(
    id: string | ObjectId,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  aggregatePipeline(
    pipeline: PipelineStage[],
    options?: Record<string, unknown>,
  ): Promise<unknown[]>;
  getByQuery(query: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  _executeQuery<T>(buildQuery: (Model: Model<any>) => Promise<T>): Promise<T>;

  [key: string]: unknown;
}

// ============================================================================
// Event Types (Template Literal Types)
// ============================================================================

/** Repository operation names */
export type RepositoryOperation =
  | 'create'
  | 'createMany'
  | 'update'
  | 'updateMany'
  | 'findOneAndUpdate'
  | 'delete'
  | 'deleteMany'
  | 'restore'
  | 'getById'
  | 'getByQuery'
  | 'getOne'
  | 'getAll'
  | 'findAll'
  | 'getOrCreate'
  | 'count'
  | 'exists'
  | 'distinct'
  | 'aggregate'
  | 'aggregatePaginate'
  | 'aggregatePipeline'
  | 'aggregatePipelinePaginate'
  | 'lookupPopulate'
  | 'bulkWrite';

/** Event lifecycle phases */
export type EventPhase = 'before' | 'after' | 'error';

/** Repository event names (generated from template literals) */
export type RepositoryEvent =
  | `${EventPhase}:${RepositoryOperation}`
  | 'method:registered'
  | 'error:hook';

/**
 * Type-safe event handler map
 *
 * Hook signature contract:
 * - `before:*` — receives `context: RepositoryContext` directly (not wrapped).
 *   Plugins mutate context in-place to inject filters, data, etc.
 * - `after:*`  — receives `{ context, result }` where result is the operation output.
 * - `error:*`  — receives `{ context, error }` where error is the caught Error.
 */
export type EventHandlers<TDoc = unknown> = {
  [K in RepositoryEvent]?: K extends `before:${string}`
    ? (context: RepositoryContext) => void | Promise<void>
    : K extends `after:${string}`
      ? (payload: { context: RepositoryContext; result: TDoc | TDoc[] }) => void | Promise<void>
      : K extends `error:${string}`
        ? (payload: { context: RepositoryContext; error: Error }) => void | Promise<void>
        : (payload: { context: RepositoryContext }) => void | Promise<void>;
};

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

// Schema-builder types (`SchemaBuilderOptions`, `JsonSchema`, `CrudSchemas`,
// `FieldRules`, `ValidationResult`) are re-exported further up from
// `@classytic/repo-core/schema`. Every kit shares the same contract so an
// HTTP layer wired against mongokit's `buildCrudSchemasFromModel` stays
// unchanged when you swap to sqlitekit's `buildCrudSchemasFromTable`.

// ============================================================================
// Cursor Types
// ============================================================================

/** Value type identifier for cursor serialization */
export type ValueType = 'date' | 'objectid' | 'boolean' | 'number' | 'string' | 'null' | 'unknown';

/** Cursor payload */
export interface CursorPayload {
  /** Primary sort field value (legacy single-field) */
  v: string | number | boolean | null;
  /** Value type identifier (legacy single-field) */
  t: ValueType;
  /** Document ID */
  id: string;
  /** ID type identifier */
  idType: ValueType;
  /** Sort specification */
  sort: SortSpec;
  /** Cursor version */
  ver: number;
  /** Compound sort field values (multi-field keyset) */
  vals?: Record<string, string | number | boolean | null>;
  /** Compound sort value types */
  types?: Record<string, ValueType>;
}

/** Decoded cursor */
export interface DecodedCursor {
  /** Primary sort field value (rehydrated) — legacy compat */
  value: unknown;
  /** Document ID (rehydrated) */
  id: ObjectId | string;
  /** Sort specification */
  sort: SortSpec;
  /** Cursor version */
  version: number;
  /** All sort field values (rehydrated) — for compound sort */
  values?: Record<string, unknown>;
}

// ============================================================================
// Validator Types
// ============================================================================

/** Validator definition */
export interface ValidatorDefinition {
  /** Validator name */
  name: string;
  /** Operations to apply validator to */
  operations?: Array<'create' | 'createMany' | 'update' | 'findOneAndUpdate' | 'delete'>;
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
export interface SoftDeleteRepository<TDoc = unknown> {
  /**
   * Restore a soft-deleted document by setting deletedAt to null
   * @param id - Document ID to restore
   * @param options - Optional session for transactions
   * @returns The restored document
   */
  restore(id: string | ObjectId, options?: { session?: ClientSession }): Promise<TDoc>;

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
    options?: {
      select?: SelectSpec;
      populate?: PopulateSpec;
      lean?: boolean;
      session?: ClientSession;
    },
  ): Promise<OffsetPaginationResult<TDoc>>;
}

// ============================================================================
// Aggregate Types
// ============================================================================

/** Lookup options for aggregate */
// LookupOptions moved to query/LookupBuilder.ts for better modularity
// Import from '@classytic/mongokit' if needed:
// import type { LookupOptions } from '@classytic/mongokit';
export type { LookupOptions } from './query/LookupBuilder.js';

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
 * Cache adapter interface — bring your own cache implementation.
 * Works with Redis, Memcached, in-memory, or any key-value store.
 *
 * Shape is aligned with `@classytic/repo-core/cache#CacheAdapter` and arc's
 * `CacheStore` so one adapter implementation satisfies every consumer. The
 * `delete` method is named for consistency with `Map.delete` / `Set.delete` /
 * `MinimalRepo.delete(id)` — your Redis wrapper translates to `redis.del`.
 *
 * @example Redis implementation:
 * ```typescript
 * const redisCache: CacheAdapter = {
 *   async get(key) { return JSON.parse(await redis.get(key) || 'null'); },
 *   async set(key, value, ttl) { await redis.setex(key, ttl, JSON.stringify(value)); },
 *   async delete(key) { await redis.del(key); },
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
  /** Delete a single key. No-op when the key doesn't exist. */
  delete(key: string): Promise<void>;
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
  /**
   * TTL jitter to mitigate cache stampedes. When many entries share the same
   * TTL and expire simultaneously, every concurrent reader misses and hammers
   * the DB at once. Jitter spreads expirations over a window.
   *
   * - `number` in [0, 1]: fractional symmetric jitter. `0.1` multiplies the
   *   TTL by a random factor in [0.9, 1.1]. Default: 0 (no jitter).
   * - `function(ttl)`: full control — receive the configured TTL (seconds),
   *   return the effective TTL (seconds) to store with.
   */
  jitter?: number | ((ttlSeconds: number) => number);
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
  errors: number;
}

// ============================================================================
// Cascade Delete Types
// ============================================================================

/** Cascade relation definition */
export interface CascadeRelation {
  /**
   * Preferred: a Repository instance for the target collection. When present,
   * cascade routes deletes through `repo.delete` / `repo.deleteMany`, so the
   * target's `before:delete` / `before:deleteMany` hooks fire — meaning
   * multi-tenant scoping, audit logging, cache invalidation, and the target's
   * own soft-delete plugin (with its configured `deletedField`) all run
   * correctly. Strongly recommended for any target that has policy plugins.
   */
  repo?: RepositoryInstance;
  /**
   * Legacy: a Mongoose model name. When set without `repo`, cascade writes
   * directly via `RelatedModel.updateMany` / `RelatedModel.deleteMany`. This
   * path bypasses the target's hooks — it will NOT enforce tenant scoping,
   * fire audit events, or honor a custom `deletedField`. Only safe for
   * trivial targets with no policy plugins. Prefer `repo` for new code.
   */
  model?: string;
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
  /**
   * Structured metadata for duplicate-key (E11000) errors. Safe to surface in
   * logs/audit. Includes the offending field names and a boolean-only mirror
   * of whether each field had a duplicate value — never the value itself
   * unless `parseDuplicateKeyError` was called with `{ exposeValues: true }`.
   */
  duplicate?: {
    fields: string[];
    /** Only populated when parseDuplicateKeyError was called with exposeValues:true. */
    values?: Record<string, unknown>;
  };
}

// ============================================================================
// Plugin Method Combinations (Helper Types)
// ============================================================================

/**
 * Combines all plugin method types into a single type
 * Useful when you're using all plugins and want full type safety
 *
 * @example
 * ```typescript
 * import { Repository } from '@classytic/mongokit';
 * import type { AllPluginMethods } from '@classytic/mongokit';
 *
 * class UserRepo extends Repository<IUser> {}
 *
 * const repo = new UserRepo(Model, [...allPlugins]) as UserRepo & AllPluginMethods<IUser>;
 *
 * // TypeScript knows about all plugin methods!
 * await repo.increment(id, 'views', 1);
 * await repo.restore(id);
 * await repo.invalidateCache(id);
 * ```
 *
 * Note: Import the individual plugin method types if you need them:
 * ```typescript
 * import type {
 *   MongoOperationsMethods,
 *   BatchOperationsMethods,
 *   AggregateHelpersMethods,
 *   SubdocumentMethods,
 *   SoftDeleteMethods,
 *   CacheMethods,
 * } from '@classytic/mongokit';
 * ```
 */
/**
 * Extract string keys from a document type, with `string` fallback for untyped usage.
 * Provides autocomplete for known fields while still accepting arbitrary strings
 * (e.g. for nested paths like 'address.city').
 */
export type DocField<TDoc> = (keyof TDoc & string) | (string & {});

export type AllPluginMethods<TDoc> = {
  // MongoOperationsMethods
  upsert(
    query: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  increment(
    id: string | ObjectId,
    field: DocField<TDoc>,
    value?: number,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  decrement(
    id: string | ObjectId,
    field: DocField<TDoc>,
    value?: number,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  pushToArray(
    id: string | ObjectId,
    field: DocField<TDoc>,
    value: unknown,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  pullFromArray(
    id: string | ObjectId,
    field: DocField<TDoc>,
    value: unknown,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  addToSet(
    id: string | ObjectId,
    field: DocField<TDoc>,
    value: unknown,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  setField(
    id: string | ObjectId,
    field: DocField<TDoc>,
    value: unknown,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  unsetField(
    id: string | ObjectId,
    fields: DocField<TDoc> | DocField<TDoc>[],
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  renameField(
    id: string | ObjectId,
    oldName: DocField<TDoc>,
    newName: string,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  multiplyField(
    id: string | ObjectId,
    field: DocField<TDoc>,
    multiplier: number,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  setMin(
    id: string | ObjectId,
    field: DocField<TDoc>,
    value: unknown,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  setMax(
    id: string | ObjectId,
    field: DocField<TDoc>,
    value: unknown,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;

  // MongoOperationsMethods — atomicUpdate
  atomicUpdate(
    id: string | ObjectId,
    operators: Record<string, Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;

  // BatchOperationsMethods
  updateMany(
    query: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: { session?: ClientSession; updatePipeline?: boolean },
  ): Promise<{
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    upsertedCount: number;
    upsertedId: unknown;
  }>;
  deleteMany(
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;
  bulkWrite(
    operations: Record<string, unknown>[],
    options?: { session?: ClientSession; ordered?: boolean },
  ): Promise<{
    ok: number;
    insertedCount: number;
    upsertedCount: number;
    matchedCount: number;
    modifiedCount: number;
    deletedCount: number;
    insertedIds: Record<number, unknown>;
    upsertedIds: Record<number, unknown>;
  }>;

  // AggregateHelpersMethods
  groupBy(
    field: DocField<TDoc>,
    options?: { limit?: number; session?: unknown },
  ): Promise<Array<{ _id: unknown; count: number }>>;
  sum(
    field: DocField<TDoc>,
    query?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<number>;
  average(
    field: DocField<TDoc>,
    query?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<number>;
  min(
    field: DocField<TDoc>,
    query?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<number>;
  max(
    field: DocField<TDoc>,
    query?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<number>;

  // SubdocumentMethods
  addSubdocument(
    parentId: string | ObjectId,
    arrayPath: DocField<TDoc>,
    subData: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
  getSubdocument(
    parentId: string | ObjectId,
    arrayPath: DocField<TDoc>,
    subId: string | ObjectId,
    options?: { lean?: boolean; session?: unknown },
  ): Promise<Record<string, unknown>>;
  updateSubdocument(
    parentId: string | ObjectId,
    arrayPath: DocField<TDoc>,
    subId: string | ObjectId,
    updateData: Record<string, unknown>,
    options?: { session?: unknown },
  ): Promise<TDoc>;
  deleteSubdocument(
    parentId: string | ObjectId,
    arrayPath: DocField<TDoc>,
    subId: string | ObjectId,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;

  // SoftDeleteMethods
  restore(id: string | ObjectId, options?: { session?: ClientSession }): Promise<TDoc>;
  getDeleted(
    params?: {
      filters?: Record<string, unknown>;
      sort?: SortSpec | string;
      page?: number;
      limit?: number;
    },
    options?: {
      select?: SelectSpec;
      populate?: PopulateSpec;
      lean?: boolean;
      session?: ClientSession;
    },
  ): Promise<OffsetPaginationResult<TDoc>>;

  // CacheMethods
  invalidateCache(id: string): Promise<void>;
  invalidateListCache(): Promise<void>;
  invalidateAllCache(): Promise<void>;
  getCacheStats(): CacheStats;
  resetCacheStats(): void;
};

/**
 * Helper type to add all plugin methods to a repository class
 * Cleaner than manually typing the intersection
 *
 * @example
 * ```typescript
 * import { Repository } from '@classytic/mongokit';
 * import type { WithPlugins } from '@classytic/mongokit';
 *
 * class OrderRepo extends Repository<IOrder> {
 *   async getCustomerOrders(customerId: string) {
 *     return this.getAll({ filters: { customerId } });
 *   }
 * }
 *
 * const orderRepo = new OrderRepo(Model, [
 *   ...allPlugins
 * ]) as WithPlugins<IOrder, OrderRepo>;
 *
 * // Works: custom methods + plugin methods
 * await orderRepo.getCustomerOrders('123');
 * await orderRepo.increment(orderId, 'total', 100);
 * ```
 */
export type WithPlugins<TDoc, TRepo extends RepositoryInstance = RepositoryInstance> = TRepo &
  AllPluginMethods<TDoc>;

// ============================================================================
// Controller Interfaces (Framework-Agnostic)
// ============================================================================

export type {
  IController,
  IControllerResponse,
  IRequestContext,
  IResponseFormatter,
} from './types/controller.types.js';
