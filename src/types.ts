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

import type { RepositoryBase } from '@classytic/repo-core/repository';
import type { Document, Model, PipelineStage, PopulateOptions, Types } from 'mongoose';
import type { RepositoryPluginName } from './plugins/names.js';

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

/**
 * Select specification. `readonly string[]` widens the legacy `string[]`
 * form to also accept the immutable variant repo-core's contract uses
 * (`LookupPopulateOptions.select: readonly string[] | Record<string, 0
 * | 1>`), so `Repository<TDoc>` assigns to `StandardRepo<TDoc>` without
 * TS2322 on the `select` field. Any existing mutable-array caller stays
 * compatible — `string[]` is assignable to `readonly string[]`.
 */
export type SelectSpec = string | readonly string[] | Record<string, 0 | 1>;

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
/**
 * Partial-document update patch — the shape `repo.update(id, data)` accepts
 * for its `data` parameter. A `Partial<TDoc>` minus the fields a caller must
 * never set directly (`_id`, `createdAt`, `__v`).
 *
 * **Renamed from `UpdateInput<TDoc>` in 3.11.0** to eliminate a name
 * collision with `@classytic/repo-core/update`'s `UpdateInput` (the
 * `UpdateSpec | Record | Record[]` union consumed by `updateMany` /
 * `findOneAndUpdate`). The legacy name remains as a deprecated alias for
 * one release — remove in 3.12.
 */
export type UpdatePatch<TDoc> = Partial<Omit<TDoc, '_id' | 'createdAt' | '__v'>>;

/**
 * Typed Mongo update document — the operator-shape that `findOneAndUpdate`
 * / `updateMany` accept on the wire (`{ $set, $inc, $unset, ... }`).
 *
 * The explicit operator keys give IDE autocomplete + per-operator value
 * typing; the trailing `[op: string]: unknown` index signature lets a
 * caller-built `MongoOperatorUpdate` value assign to `Record<string,
 * unknown>` without a cast — matching repo-core's `UpdateInput` slot
 * (`UpdateSpec | Record<string, unknown> | Record<string, unknown>[]`)
 * and unblocking the historic
 *
 *   `normalizeUpdate(update) as unknown as Record<string, unknown>`
 *
 * footgun every domain package eventually wrote.
 *
 * Trade-off: with the index signature, an operator typo (`$st` instead
 * of `$set`) won't fail TypeScript — Mongo would silently drop it. The
 * common operators are listed explicitly so `obj.$set` / `obj.$inc`
 * autocomplete stays useful; the escape hatch covers everything else
 * (`$min`, `$max`, `$rename`, `$pop`, etc.).
 *
 * @example
 * ```ts
 * import type { MongoOperatorUpdate } from '@classytic/mongokit';
 *
 * const patch: MongoOperatorUpdate = {
 *   $set: { status: 'paid', paidAt: new Date() },
 *   $inc: { revision: 1 },
 * };
 * await repo.findOneAndUpdate({ _id: id }, patch);  // no cast
 * ```
 */
export interface MongoOperatorUpdate {
  /** Assign top-level or dotted-path values. */
  $set?: Record<string, unknown>;
  /** Set only on insert (upsert path). */
  $setOnInsert?: Record<string, unknown>;
  /** Remove fields (`Mongo` accepts `''`, `1`, or `true`). */
  $unset?: Record<string, '' | 1 | true>;
  /** Atomic numeric increment / decrement. */
  $inc?: Record<string, number>;
  /** Atomic numeric multiplication. */
  $mul?: Record<string, number>;
  /** Push to array (or `{ $each, $position, $slice, $sort }`). */
  $push?: Record<string, unknown>;
  /** Pull matching values from array. */
  $pull?: Record<string, unknown>;
  /** Pull a list of literals from array. */
  $pullAll?: Record<string, unknown[]>;
  /** Push only when not already present. */
  $addToSet?: Record<string, unknown>;
  /** Remove first / last element (`-1` / `1`). */
  $pop?: Record<string, -1 | 1>;
  /** Set only when the new value is smaller / larger. */
  $min?: Record<string, unknown>;
  $max?: Record<string, unknown>;
  /** Rename top-level fields. */
  $rename?: Record<string, string>;
  /** Auto-set Date / Timestamp on this update. */
  $currentDate?: Record<string, true | { $type: 'date' | 'timestamp' }>;
  /** Bitwise ops on integer fields. */
  $bit?: Record<string, { and?: number; or?: number; xor?: number }>;
  /**
   * Escape hatch for any operator not explicitly listed above (e.g.
   * positional-array operators like `$[<identifier>]` inside a path
   * key). Index signature is what makes the type assign to
   * `Record<string, unknown>` without a cast.
   */
  [op: string]: unknown;
}

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
 *
 * @example Stamp tenant on every create
 * ```ts
 * repo.useMiddleware(async ({ operation, context, next }) => {
 *   if (operation === 'create' && context.data) {
 *     context.data.tenantId = currentTenant();
 *   }
 *   return next();
 * });
 * ```
 *
 * @example Short-circuit (skip the actual op) — return without calling next()
 * ```ts
 * repo.useMiddleware(async ({ operation, context, next }) => {
 *   if (operation === 'getById' && readOnlyMode) {
 *     return cachedReadOnlyResponse(context.id);
 *   }
 *   return next();
 * });
 * ```
 */
export type Middleware<TDoc = unknown> = (ctx: MiddlewareContext<TDoc>) => Promise<unknown>;

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
   * Bundled plugins as of 3.13:
   *   - `'multi-tenant'` (from `multiTenantPlugin`)
   *   - `'softDelete'` (from `softDeletePlugin`)
   *   - `'auditLog'` (from `auditLogPlugin`)
   *   - `'auditTrail'` (from `auditTrailPlugin`)
   *   - `'cache'` (from `cachePlugin`)
   *   - `'observability'` (from `observabilityPlugin`)
   *   - `'method-registry'` (from `methodRegistryPlugin`)
   *   - `'batch-operations'`, `'mongo-operations'`,
   *     `'aggregate-helpers'`, `'subdocument'`, `'cascade'`,
   *     `'custom-id'`, `'elastic-search'`, `'fieldFilter'`,
   *     `'validation-chain'`, `'lease'`, `'timestamp'`
   *
   * Naming follows each plugin's `name` field — kebab-case for some,
   * camelCase for others. The error message lists "Installed plugins"
   * verbatim so a typo surfaces as a side-by-side diff.
   *
   * **Why this exists.** "Always wire `multiTenantPlugin`" and "always
   * wire `softDeletePlugin`" are documented as conventions in 7+ and
   * 9+ CLAUDE.md files across the classytic codebase respectively,
   * but documentation drifts and convention-by-comment isn't
   * enforceable. Listing the required plugins at the boot boundary
   * fails closed — the constructor throws with the missing name, the
   * bug surfaces on first run (or first test), not in production.
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
   *
   * If any name in this list isn't matched by a plugin's `name`
   * property in the chain, the constructor throws with the missing
   * names listed.
   */
  requirePlugins?: readonly RepositoryPluginName[];

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
  session?: unknown;
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
  session?: unknown;
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

// Pagination result shapes are owned by `@classytic/repo-core/pagination`.
// Mongokit no longer declares its own — see CHANGELOG 3.12.0. Internal call
// sites that surface a `warning?: string` use the `TExtra` slot:
//   `OffsetPaginationResult<TDoc, { warning?: string }>`.
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';

// ============================================================================
// Repository Types
// ============================================================================

/** Session-only options — shared base for lightweight operations */
export interface SessionOptions {
  /** MongoDB session for transactions */
  session?: unknown;
  /** Organization/tenant ID for multi-tenant plugin scoping */
  organizationId?: string | ObjectId;
  /**
   * Per-call escape hatch — plugins listed here that opt into the
   * mechanism (`auditLog`, `auditTrail`, `observability`) read this
   * from `RepositoryContext` and skip their work for this call. Use
   * on hot paths (e.g. heartbeats / counters) where the audit overhead
   * dominates.
   *
   * Plugins that enforce correctness or security (multi-tenant scope,
   * cache invalidation, soft-delete filter) deliberately ignore this
   * flag — security/correctness must not be skippable per-call.
   *
   * **Match exactly by `plugin.name`** (camelCase, NOT kebab-case):
   *   - `'auditLog'` — see `auditLogPlugin()` in
   *     `src/plugins/audit-log.plugin.ts` (`name: 'auditLog'`)
   *   - `'auditTrail'` — see `auditTrailPlugin()` in
   *     `src/plugins/audit-trail.plugin.ts` (`name: 'auditTrail'`)
   *   - `'observability'` — see `observabilityPlugin()` in
   *     `src/plugins/observability.plugin.ts` (`name: 'observability'`)
   *
   * Pre-3.13.0 docs referenced `'audit-log'` / `'audit-trail'` —
   * those don't match any plugin's `name` field, so passing them
   * silently fails to skip anything. The strings above are the
   * authoritative ones.
   */
  skipPlugins?: readonly string[];
  /**
   * Per-call escape hatch for `multiTenantPlugin`. When `true`, the
   * tenant scope hook returns without injecting `organizationId` (or
   * the configured `tenantField`) into the operation's policy slot
   * for THIS call only. The plugin emits `after:tenant-bypass` with
   * `{ context, operation, reason: 'option' }` so audit / observability
   * plugins can distinguish bypassed queries from tenant-scoped ones.
   *
   * Reach for this when:
   *   - A super-admin / platform-admin user needs cross-tenant read
   *     for support tooling.
   *   - A migration script writes / backfills across tenants
   *     deliberately.
   *   - A scheduled job (TTL cleanup, cross-tenant aggregate, billing
   *     rollup) needs the unscoped view.
   *
   * **`bypassTenant` is the most-specific decision** — runs before
   * `skipWhen` (plugin-level callback) and `resolveContext` (CLS
   * fallback). Distinct from `skipWhen` which fires for every call
   * and reads context to decide; `bypassTenant: true` is a deliberate
   * per-call opt-out with no role check, so the calling code carries
   * the responsibility.
   *
   * **NOT a substitute for proper access control.** This flag bypasses
   * tenant scoping; it does NOT bypass authentication, RBAC, or any
   * other host-level access check. Wrap it with your auth boundary at
   * the controller / service layer.
   *
   * @example
   * ```ts
   * // Support engineer pulling a customer's order across tenants:
   * await orderRepo.findAll({}, { bypassTenant: true });
   *
   * // Migration backfill across the whole estate:
   * for await (const doc of repo.cursor({}, { bypassTenant: true })) { ... }
   * ```
   */
  bypassTenant?: boolean;
  /**
   * Per-call escape hatch for `appendOnlyPlugin` — deliberate
   * maintenance on an immutable-facts collection (backfill repair,
   * migration). Audited via `after:append-only-bypass`; grep for this
   * flag the same way you grep `bypassTenant` / `mode: 'hard'`. NOT a
   * substitute for access control — gate it at the host layer.
   */
  bypassAppendOnly?: boolean;
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

/**
 * Cache-aware operation options — extends OperationOptions with the
 * unified cache plugin's per-call shape. Pass `cache: { staleTime, swr,
 * tags, bypass, ... }` to override freshness for this call.
 */
export interface CacheableOptions extends OperationOptions {
  /** Per-call cache override forwarded to the unified cache plugin. */
  cache?: import('@classytic/repo-core/cache').CacheOptions;
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
 * portable `LookupPopulateOptions<TBase>` from repo-core. Widens three
 * slots so arc / mongoose consumers compose cleanly:
 *
 *   - `filters`: accepts Filter IR, a `Partial<TBase> & Record<string,
 *     unknown>` literal (same shape repo-core's contract uses), or a
 *     plain `Record<string, unknown>` for legacy callers.
 *   - `lookups`: accepts either the portable `LookupSpec[]` (works on
 *     every kit) or mongokit's `LookupOptions[]` (adds `pipeline` /
 *     `let` / `sanitize` for mongo-correlated joins).
 *   - `select`: accepts mongoose's space-separated string form
 *     (`'name email'`) in addition to the portable array / inclusion
 *     map. Kept for arc + existing controller convenience.
 *
 * `TBase` defaults to `unknown` so legacy non-generic usage still
 * compiles; pass the doc type for arc `RepositoryLike<TDoc>` structural
 * assignment — `LookupPopulateOptions<TDoc>` is bit-compatible with
 * `import('@classytic/repo-core/repository').LookupPopulateOptions<TDoc>`.
 */
export interface LookupPopulateOptions<TBase = unknown> {
  /**
   * Base-table filter. Accepts Filter IR from repo-core, a typed
   * `Partial<TBase> & Record<string, unknown>` literal (what arc
   * controllers produce when typed against `StandardRepo<TDoc>`), or
   * a plain `Record<string, unknown>` for ad-hoc callers.
   */
  filters?:
    | import('@classytic/repo-core/filter').Filter
    | (Partial<TBase> & Record<string, unknown>)
    | Record<string, unknown>;
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
  /**
   * Transaction session. Typed `unknown` to match repo-core's
   * `RepositorySession` contract — mongokit narrows to `ClientSession`
   * internally. Not inherited from `ReadOptions` because the repo-core
   * contract type has no `[key: string]: unknown` escape hatch, and
   * arc's `Partial<StandardRepo<TDoc>>` boundary rejects index-signature
   * drift under strict function-type variance.
   */
  session?: unknown;
  /** Read preference for replica sets (e.g. 'secondaryPreferred') */
  readPreference?: ReadPreferenceType;
  /** Multi-tenant plugin scoping (applied via before:lookupPopulate hook). */
  organizationId?: string | ObjectId;
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
  DeleteManyResult,
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
  | 'bulkWrite'
  | 'claim'
  | 'claimVersion'
  | 'cursor'
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
  restore(id: string | ObjectId, options?: { session?: unknown }): Promise<TDoc>;

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
      session?: unknown;
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
//
// Mongokit 3.13+ delegates cache wiring to `@classytic/repo-core/cache`.
// The unified plugin owns the canonical `CacheAdapter` / `CacheOptions` /
// `RepositoryCacheHandle` types — kits import them directly. The legacy
// mongokit-specific `CacheStats` shape is gone (the repo-core plugin
// surfaces observability via `RepositoryCachePluginOptions.log`).

/**
 * Per-call cache options — TanStack-shaped (`staleTime`, `gcTime`, `swr`,
 * `tags`, `bypass`, `enabled`, `key`). Threaded through read methods via
 * `options.cache` (CRUD) or `aggRequest.cache` (aggregate).
 */
export interface CacheOperationOptions {
  /** Per-call cache override forwarded to the unified cache plugin. */
  cache?: import('@classytic/repo-core/cache').CacheOptions;
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

// `HttpError` moved to `@classytic/repo-core/errors` (canonical home for
// the throwable error contract across the org — same playbook as the
// pagination and tenant relocations). Mongokit imports it for internal
// signatures (`_handleError(error: Error): HttpError`) but does NOT
// re-export it — consumers `import type { HttpError } from '@classytic/repo-core/errors'`
// directly. See CHANGELOG 3.12.0 for the breaking change.
import type { HttpError } from '@classytic/repo-core/errors';

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
 * await repo.cache?.invalidateByTags(['org:abc']);
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
  restore(id: string | ObjectId, options?: { session?: unknown }): Promise<TDoc>;
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
