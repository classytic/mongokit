/**
 * Repository contracts — construction options, the operation context every
 * hook receives, the plugin protocol, middleware, and the event vocabulary.
 */

import type { HttpError } from '@classytic/repo-core/errors';
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
import type {
  DistributionConfig,
  DistributionMissHandler,
  RepoCapabilities,
  RepositoryBase,
} from '@classytic/repo-core/repository';
import type { Model, PipelineStage } from 'mongoose';
import type { RepositoryPluginName } from '../plugins/names.js';
import type {
  AggregateDefaults,
  QueryDefaults,
  ReadConcernLevel,
  WriteConcernSpec,
} from '../repository/query-defaults.js';
import type {
  AnyDocument,
  FilterQuery,
  ObjectId,
  PopulateSpec,
  ReadPreferenceType,
  SelectSpec,
  SortSpec,
} from './core.js';
import type { CountStrategy } from './pagination.js';
import type { DocField } from './type-utils.js';

/** Hook execution mode */
export type HookMode = 'sync' | 'async';

/**
 * Minimal repo surface exposed to wrap-style middleware via the
 * `repo` field of `MiddlewareContext`. Intentionally narrow — middleware
 * shouldn't reach into the full `Repository` (that would couple every
 * middleware to the kit). The 5 floor methods plus `Model` cover every
 * legitimate middleware need (cross-doc reads, custom queries, type-
 * narrowing on `Model.modelName`).
 */
export interface MinimalRepoView<TDoc> {
  readonly Model: Model<TDoc>;
  readonly model: string;
  getById(id: string | ObjectId, options?: Record<string, unknown>): Promise<TDoc | null>;
  getAll?(params?: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  create(data: Record<string, unknown>, options?: Record<string, unknown>): Promise<TDoc>;
  update(
    id: string | ObjectId,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  delete(id: string | ObjectId, options?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Context passed to a wrap-style middleware. Middleware mutates
 * `context` before calling `await next()` to alter input; inspects /
 * transforms the resolved value to alter output; uses plain try/catch
 * around `next()` for error handling.
 *
 * The `before:` / `after:` / `error:` hook engine still fires from
 * within `next()` — hooks remain authoritative for policy / cache /
 * audit so security and correctness plugins keep working unchanged.
 * Middleware composes ergonomically on top.
 */
export interface MiddlewareContext<TDoc> {
  /** Operation name (`'create'`, `'getById'`, ..., or any plugin op). */
  readonly operation: string;
  /** Live repository context — mutate fields before `next()` to alter input. */
  readonly context: RepositoryContext;
  /**
   * Continue the chain — the next middleware (or, for the innermost
   * middleware, the actual op + after/error hooks). The return value
   * is the resolved op result; throwing propagates up the chain.
   */
  next: () => Promise<unknown>;
  /** Narrow view of the repo for cross-doc reads / custom queries. */
  readonly repo: MinimalRepoView<TDoc>;
}

/**
 * Wrap-style middleware — Prisma `$extends.query` / Express middleware
 * shape. Registered via `repo.useMiddleware(mw)`. Composes around every
 * `_runOp` invocation; runs in registration order (first-registered
 * runs outermost).
 *
 * @example Time every operation
 * ```ts
 * repo.useMiddleware(async ({ operation, next }) => {
 *   const start = performance.now();
 *   try { return await next(); }
 *   finally { console.log(`${operation} took ${performance.now() - start}ms`); }
 * });
 * ```
 */
export type Middleware<TDoc = unknown> = (ctx: MiddlewareContext<TDoc>) => Promise<unknown>;

/** Search strategy used by Repository.getAll when `search` is provided */
export type RepositorySearchMode = 'text' | 'regex' | 'auto' | 'prefix';

/** Repository options */
export interface RepositoryOptions {
  /** Whether repository event hooks are awaited */
  hooks?: HookMode;
  /** Custom ID field used by getById/update/delete (default: '_id').
   * Set to 'slug', 'code', 'chatId', etc. for non-ObjectId lookups. */
  idField?: string;
  /**
   * Field carrying the optimistic-concurrency version for `ifVersion` CAS
   * writes. Default `'__v'` — the versionKey every mongoose schema already
   * carries, so CAS works with zero schema changes. Note mongoose only
   * auto-increments `__v` on array-mutating `save()`; mongokit's CAS path
   * `$inc`s it explicitly on every versioned write, which is the contract.
   */
  versionField?: string;
  /**
   * How Repository.getAll handles the `search` parameter.
   * - 'text' (default): uses MongoDB $text; requires a text index.
   * - 'regex': builds case-insensitive $or of $regex across `searchFields`. No index required.
   * - 'auto': uses 'text' if a text index exists, otherwise falls back to 'regex' when `searchFields` is set.
   * - 'prefix': indexed search-as-you-type. Every write stores the normalised word tokens of
   *   `searchFields` in `searchKeysField`; a search matches documents where EVERY query word
   *   starts some token (`moh ali` finds "Mohammed Al-Ali"), via an anchored regex per word on
   *   a multikey index. Needs the keys path on the schema (`searchKeysPath()`) and an index
   *   (`searchKeysIndex()`); backfill existing rows with `rebuildSearchKeys`.
   *
   * Works standalone (Express/Nest/etc.) or alongside QueryParser — when the parser
   * already consumed `search` into filters, Repository does nothing extra.
   */
  searchMode?: RepositorySearchMode;
  /**
   * Fields used when searchMode is 'regex' (or 'auto' falling back to regex).
   * Required for regex mode to take effect. In 'prefix' mode: the source fields of the
   * search keys (required; dotted paths, strings/numbers or arrays of them).
   */
  searchFields?: string[];
  /**
   * 'prefix' mode only: field storing the search keys. Default `'_searchKeys'`.
   */
  searchKeysField?: string;
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

  /**
   * When `true` (default `false`), the repository checks every read/
   * write op's filter against the schema's declared paths and warns
   * once per `(modelName, fieldName)` pair if a filter key isn't on
   * the schema AND `strictQuery: true` is in effect.
   *
   * **Why this exists.** With `mongoose.set('strictQuery', true)` (the
   * mongoose 6 default; some projects pin it explicitly), filter keys
   * not declared on the schema are SILENTLY STRIPPED before the query
   * runs. `findOne({ code: 'X' })` on a schema without `code` becomes
   * `findOne({})` — returns the first doc, not null — and the bug
   * masquerades as "wrong row returned" without any error or log.
   *
   * The diagnostic catches the trap at runtime: log once per offending
   * key per model, so a single bad call surfaces during dev/staging
   * instead of in production. Costs O(filter keys) per call against
   * a constructor-cached set; negligible.
   *
   * Hosts who route mongokit's `warn` into their own logger (via
   * `configureLogger({ warn: ... })`) can ship this enabled in
   * production without polluting stdout.
   *
   * @default false
   */
  warnOnStrictQueryStrip?: boolean;

  /**
   * Names of plugins that MUST be present in the plugin chain at
   * construction time. Throws a `TypeError` from the constructor if
   * any listed plugin is absent — eliminates the silent-misconfig
   * shape where a host forgets to wire `multiTenantPlugin` and ships
   * a tenant-leak to production.
   *
   * Names match each plugin's exported `name` property (the plugin's
   * own canonical identifier, NOT the JavaScript function name).
   *
   * @example
   * ```ts
   * import { MONGOKIT_PLUGIN_NAMES } from '@classytic/mongokit';
   *
   * new Repository(OrderModel, [
   *   methodRegistryPlugin(),
   *   multiTenantPlugin({ tenantField: 'organizationId' }),
   *   softDeletePlugin(),
   *   auditLogPlugin({ logger }),
   * ], paginationConfig, {
   *   requirePlugins: [
   *     MONGOKIT_PLUGIN_NAMES.multiTenant,
   *     MONGOKIT_PLUGIN_NAMES.softDelete,
   *     MONGOKIT_PLUGIN_NAMES.auditLog,
   *   ],
   * });
   * ```
   */
  requirePlugins?: readonly RepositoryPluginName[];

  /**
   * Time bound and concerns for every command this repository issues. A per-call value
   * wins; unset fields fall back to `configureQueryDefaults` (see `repository/query-defaults.ts`).
   */
  queryDefaults?: QueryDefaults;
  /** Aggregation-only defaults, consulted before `queryDefaults`. */
  aggregateDefaults?: AggregateDefaults;

  /**
   * Declare the collection's shard key so every filter-taking verb
   * (`getAll`, `findAll`, `getOne`, `count`, `updateMany`, `aggregate`, …)
   * catches a filter that omits it — the query mongos has to fan out to
   * every shard. Id-addressed verbs (`getById`, `update`, `delete`,
   * `claim`) are not checked; their `_id` match is routed, not scattered.
   *
   * The check runs AFTER `before:*` hooks, so a tenant field injected by
   * `multiTenantPlugin` satisfies a `key: 'organizationId'` guard and the
   * guard only ever fires on the calls that dropped the scope —
   * `bypassTenant: true`, an unscoped repo, a hand-built cross-tenant
   * `$or`. List verbs a host legitimately runs cross-shard (a global
   * dashboard's `aggregate`) in `exemptOperations`.
   *
   * `onMissingKey` defaults to `'warn'` — once per operation name through
   * mongokit's logger (`configureLogger` routes it); pass `onMiss` to
   * observe every miss yourself, or `'throw'` for hosts where a scatter-
   * gather is never acceptable. Omit the option entirely and nothing runs.
   */
  distribution?: DistributionConfig & { onMiss?: DistributionMissHandler };

  /**
   * Override the whole runtime capability descriptor.
   *
   * By DEFAULT `repo.capabilities` is OBSERVED from the model's live
   * connection topology (see `capabilities.ts`) — a standalone `mongod`
   * reports `transactions: false`, and an unreadable topology reports
   * `false` with `transactionsResolution: 'unknown'` so money kernels fail
   * closed. Supply this only when you genuinely know better than the driver:
   * a proxied/wrapped connection, a non-mongoose seam, or a test that needs
   * to pin a descriptor.
   *
   * **Never pass `{ ...MONGOKIT_CAPABILITIES }` to quiet a boot gate.** That
   * re-creates the exact defect the observation replaced: a declared
   * capability nothing can falsify. If a deployment truly cannot do
   * transactions and you accept the risk, say so at the KERNEL
   * (`allowNonTransactional: true`), where the degradation is logged.
   */
  capabilities?: RepoCapabilities;

  /**
   * Standard Schema validator (Zod 3.24+, Valibot 1+, ArkType 2+, ...)
   * for write payloads. Forwarded to `RepositoryBase`, which validates
   * `create` data and every `createMany` doc at
   * `HOOK_PRIORITY.VALIDATION` (150) — after policy plugins, before
   * cache/observability. Failures throw an `HttpError` 400 with
   * structured `validationErrors`. Validator output replaces the
   * payload, so schema-declared coercions/defaults flow into the write.
   */
  schema?: import('@classytic/repo-core/schema').StandardSchemaV1;
  /**
   * Standard Schema validator for `update` payloads. Separate slot
   * because updates are partial — derive one explicitly (e.g.
   * `schema.partial()` in Zod).
   */
  updateSchema?: import('@classytic/repo-core/schema').StandardSchemaV1;
  /**
   * Domain-event emission. Pass any arc / `@classytic/primitives`-
   * compatible transport and every mutating op publishes
   * `<resource>.<verb>` events (`user.created`, `user.updated`, ...).
   * Omit and the wiring is inert. See `@classytic/repo-core/events`.
   */
  events?: import('@classytic/repo-core/events').RepositoryEventsOptions;
}

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
  session?: unknown;
  /** Read preference for replica sets */
  readPreference?: ReadPreferenceType;
  /**
   * Per-call escape hatch — plugin names listed here that opt into the
   * mechanism (`auditLog`, `auditTrail`, `observability`) skip their
   * work for this call. Threaded from `OperationOptions.skipPlugins`
   * via `_buildContext`. Security/correctness plugins (multi-tenant
   * scope, cache invalidation, soft-delete filter) deliberately ignore
   * this — those must not be skippable per-call.
   */
  skipPlugins?: readonly string[];

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
  /** Cursor for the PREVIOUS page (keyset pagination). Mutually exclusive with `after`. */
  before?: string;
  /** Search query string */
  search?: string;
  /** Pagination mode */
  mode?: 'offset' | 'keyset';
  /** Query hint */
  hint?: string | Record<string, 1 | -1>;
  /** Maximum execution time in milliseconds */
  maxTimeMS?: number;
  /** Per-call read concern / comment / write concern / disk use (see `queryDefaults`). */
  readConcern?: ReadConcernLevel;
  comment?: string;
  writeConcern?: WriteConcernSpec;
  allowDiskUse?: boolean;
  /** Collections the caller asserts are company-wide (joins only). */
  unscopedJoins?: readonly string[];
  /** Count strategy for offset pagination. See {@link CountStrategy}. */
  countStrategy?: CountStrategy;
  /** Ceiling for `countStrategy: 'capped'` (default 10000). */
  countLimit?: number;

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

  /**
   * Per-call cache options forwarded by the unified cache plugin
   * (`@classytic/repo-core/cache`). Kits copy this from the caller's
   * `options.cache` onto the context so the plugin's `before:<op>`
   * hook can read it.
   */
  cache?: import('@classytic/repo-core/cache').CacheOptions;
  /** Whether result was served from cache (internal — set by cache plugin) */
  _cacheHit?: boolean;
  /** Cached result (internal — set by cache plugin) */
  _cachedResult?: unknown;
  /** Resolved cache options stash (internal — set by cache plugin) */
  _cacheKey?: string;
  /** Resolved cache options stash (internal — set by cache plugin) */
  _cacheResolved?: unknown;
  /** Cache hit status (internal — `'fresh'` or `'stale'`) */
  _cacheStatus?: 'fresh' | 'stale' | 'miss' | 'disabled' | 'bypass';

  // ─────────────────────────────────────────────────────────────────────────
  // Cascade Plugin Context
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parent key values captured before a delete, by `parentKey` (internal —
   * cascade plugin). Restrict, detach and cascade all read these.
   */
  _cascadeParentKeys?: Map<string, unknown[]>;

  // ─────────────────────────────────────────────────────────────────────────
  // Per-operation shared reads
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Memo shared by every hook of THIS operation: N plugins that need the same read pay for
   * one. Scoped to the operation, so it can never serve a value across writes. A rejected
   * load is forgotten, so the next caller retries.
   */
  memo?: <T>(key: string, load: () => Promise<T>) => Promise<T>;
  /**
   * The persisted document an id-addressed operation targets, as it is BEFORE the write,
   * read once under the operation's session (not tenant-filtered — the write's own filter
   * decides whether it applies). Use this instead of `Model.findById(context.id)` in a hook.
   */
  loadTarget?: () => Promise<Record<string, unknown> | null>;

  // ─────────────────────────────────────────────────────────────────────────
  // Extension Point (for custom plugins)
  // ─────────────────────────────────────────────────────────────────────────

  /** Custom context data from plugins */
  [key: string]: unknown;
}

/**
 * Plugin interface — generic over the repo type so kit-internal plugins
 * can target the narrower `RepositoryInstance` while cross-package
 * plugins from `@classytic/repo-core/cache` etc. that target the
 * shared `RepositoryBase` flow through the same array.
 *
 * `RepositoryInstance` formally `extends RepositoryBase` (see below),
 * so `Plugin<RepositoryBase>` is structurally assignable to
 * `Plugin<RepositoryInstance>` via TypeScript's method-bivariance
 * rule for interface methods. No host-site casts required.
 */
export interface Plugin<TRepo extends RepositoryBase = RepositoryInstance> {
  /** Plugin name */
  name: string;
  /** Apply plugin to repository */
  apply(repo: TRepo): void;
}

/** Plugin function signature. Same TRepo widening as `Plugin`. */
export type PluginFunction<TRepo extends RepositoryBase = RepositoryInstance> = (
  repo: TRepo,
) => void;

/** Plugin type (object or function). */
export type PluginType<TRepo extends RepositoryBase = RepositoryInstance> =
  | Plugin<TRepo>
  | PluginFunction<TRepo>;

/** Hook with priority for deterministic phase ordering */
export interface PrioritizedHook {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listener: (data: any) => void | Promise<void>;
  priority: number;
}

/**
 * Repository instance for plugin type reference.
 *
 * Extends `@classytic/repo-core/repository`'s `RepositoryBase` so the
 * full hook + adapter contract is included. This keeps mongokit's
 * `Plugin<RepositoryInstance>` and repo-core's `Plugin<RepositoryBase>`
 * structurally aligned — cross-package plugins (`cachePlugin` from
 * `@classytic/repo-core/cache` etc.) flow into mongokit's `plugins[]`
 * array without per-call casts at the host site.
 *
 * The `[key: string]: unknown` index signature at the bottom keeps
 * dynamic plugin-method registration (`registerMethod`) compatible.
 */
export interface RepositoryInstance extends RepositoryBase {
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
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
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
  | 'bulkWrite'
  | 'bulkUpsert'
  | 'claim'
  | 'claimVersion'
  | 'cursor'
  | 'iterate'
  | 'watch';

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

/**
 * Combines all plugin method types into a single type.
 * Useful when you're using all plugins and want full type safety.
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
 * await repo.increment(id, 'views', 1);
 * await repo.restore(id);
 * await repo.cache?.invalidateByTags(['org:abc']);
 * ```
 */
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

  // BatchOperationsMethods — only bulkWrite lives in the plugin now;
  // updateMany + deleteMany are primitives on Repository<TDoc> and are
  // picked up from the base class, not from this intersection.
  bulkWrite(
    operations: Record<string, unknown>[],
    options?: { session?: unknown; ordered?: boolean },
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
  restore(
    id: string | ObjectId,
    options?: {
      session?: unknown;
      organizationId?: unknown;
      bypassTenant?: boolean;
      [key: string]: unknown;
    },
  ): Promise<TDoc>;
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
      session?: unknown;
    },
  ): Promise<OffsetPaginationResult<TDoc>>;

  // Cache (unified plugin from `@classytic/repo-core/cache`)
  /**
   * Cache plugin handle (set by `cachePlugin({ adapter })`). Exposes the
   * `CacheEngine` plus convenience invalidation helpers. `undefined` when
   * no cache plugin is wired.
   */
  cache?: import('@classytic/repo-core/cache').RepositoryCacheHandle;
};

/**
 * Helper type to add all plugin methods to a repository class.
 * Cleaner than manually typing the intersection.
 *
 * @example
 * ```typescript
 * const orderRepo = new OrderRepo(Model, [...allPlugins]) as WithPlugins<IOrder, OrderRepo>;
 * await orderRepo.getCustomerOrders('123'); // custom methods
 * await orderRepo.increment(orderId, 'total', 100); // plugin methods
 * ```
 */
export type WithPlugins<TDoc, TRepo extends RepositoryInstance = RepositoryInstance> = TRepo &
  AllPluginMethods<TDoc>;
