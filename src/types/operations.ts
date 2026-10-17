/**
 * Per-operation option bags — the shapes every Repository method accepts —
 * plus the cross-kit result envelopes re-exported from repo-core.
 */

import type { PopulateOptions } from 'mongoose';
import type { ReadConcernLevel, WriteConcernSpec } from '../repository/query-defaults.js';
import type { ObjectId, PopulateSpec, ReadPreferenceType, SelectSpec, SortSpec } from './core.js';
import type { CollationOptions, CountStrategy } from './pagination.js';

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
  /** Write concern for this call; beats `queryDefaults.writeConcern`. Ignored by reads. */
  writeConcern?: WriteConcernSpec;
  /** Extensible — plugins can read custom fields from options */
  [key: string]: unknown;
}

/** Read options. Each field beats the repository and deployment `queryDefaults`. */
export interface ReadOptions extends SessionOptions {
  /** Read preference for replica sets (e.g. 'secondaryPreferred') */
  readPreference?: ReadPreferenceType;
  /** Server-side time bound for this command. */
  maxTimeMS?: number;
  readConcern?: ReadConcernLevel;
  /** Profiler / log tag. */
  comment?: string;
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

/**
 * Per-call cache options — TanStack-shaped (`staleTime`, `gcTime`, `swr`,
 * `tags`, `bypass`, `enabled`, `key`). Threaded through read methods via
 * `options.cache` (CRUD) or `aggRequest.cache` (aggregate).
 *
 * Mongokit 3.13+ delegates cache wiring to `@classytic/repo-core/cache` —
 * the unified plugin owns the canonical `CacheAdapter` / `CacheOptions` /
 * `RepositoryCacheHandle` types; kits import them directly.
 */
export interface CacheOperationOptions {
  /** Per-call cache override forwarded to the unified cache plugin. */
  cache?: import('@classytic/repo-core/cache').CacheOptions;
}

/**
 * `session.withTransaction()`'s own options param — `TransactionOptions` (readConcern,
 * writeConcern, readPreference, maxCommitTimeMS) PLUS the driver's `timeoutMS`, which is
 * NOT a field on `TransactionOptions` itself (verified against the installed mongodb
 * driver's `ClientSession.withTransaction` overload, mongodb.d.ts). `timeoutMS` bounds the
 * WHOLE `withTransaction` call, including its built-in retry loop (default 120s) — distinct
 * from `maxCommitTimeMS`, which only bounds a single `commitTransaction` server call.
 */
export type ConvenientTransactionOptions = import('mongoose').mongo.TransactionOptions & {
  timeoutMS?: number;
};

/** withTransaction options */
export interface WithTransactionOptions {
  /** Allow non-transactional fallback when transactions are unsupported */
  allowFallback?: boolean;
  /** Optional hook to observe fallback triggers */
  onFallback?: (error: Error) => void;
  /** MongoDB transaction options (readConcern, writeConcern, readPreference, maxCommitTimeMS, timeoutMS) */
  transactionOptions?: ConvenientTransactionOptions;
}

/** Create operation options */
export interface CreateOptions extends SessionOptions {
  /**
   * Keep insertion order on error. **Default `false`, which is the OPPOSITE of
   * the MongoDB driver's own default** — a deliberate choice for import
   * throughput, pinned by `tests/integration/createMany-partial-failure.test.ts`.
   *
   * The consequence is worth stating plainly, because it is the part that
   * surprises: with `false`, a REJECTED `createMany` can still have written
   * documents. Every valid document inserts and only the failures are reported,
   * so a caller that treats the rejection as "nothing happened" and retries
   * will double-insert everything that succeeded the first time.
   *
   * Retryable imports therefore need a unique index or an idempotency key —
   * not a try/catch. Pass `ordered: true` when the batch is an all-or-nothing
   * business operation, and a transaction when it must also be atomic.
   */
  ordered?: boolean;
}

/** Update operation options */
export interface UpdateOptions extends OperationOptions {
  /** Enable update pipeline syntax */
  updatePipeline?: boolean;
  /**
   * Optimistic-concurrency CAS (repo-core `WriteOptions.ifVersion`): apply
   * only if the stored version field equals this value; the write also
   * `$inc`s the version. Stale version → `VersionConflictError` (never
   * `null` — null stays "not found"). Version field: `RepositoryOptions.versionField`,
   * default `'__v'`.
   */
  ifVersion?: number;
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
  /** Force an index (name or key pattern). */
  hint?: string | Record<string, 1 | -1>;
}

/** Aggregate operation options */
export interface AggregateOptions extends ReadOptions {
  /** Allow aggregation to use disk for large sorts/groups */
  allowDiskUse?: boolean;
  /** Force an index (name or key pattern). */
  hint?: string | Record<string, 1 | -1>;
  /** Collections the caller asserts are company-wide, joinable without a governing repository. */
  unscopedJoins?: readonly string[];
  /** Collation for locale-aware string comparison */
  collation?: CollationOptions;
  /** Maximum allowed pipeline stages (governance) */
  maxPipelineStages?: number;
}

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
    | import('../query/LookupBuilder.js').LookupOptions[];
  /** Sort specification */
  sort?: SortSpec | string;
  /** Page number (offset mode, 1-indexed) */
  page?: number;
  /** Cursor token for next page (keyset mode) */
  after?: string;
  /** Cursor token for the PREVIOUS page (keyset mode). Mutually exclusive with `after`. */
  before?: string;
  /** Number of documents per page */
  limit?: number;
  /** Fields to select */
  select?: SelectSpec;
  /** Collation for locale-aware string comparison */
  collation?: CollationOptions;
  /** Count strategy for offset pagination. See {@link CountStrategy}. */
  countStrategy?: CountStrategy;
  /** Ceiling for `countStrategy: 'capped'` (default 10000). */
  countLimit?: number;
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
 * Lookup-populate + delete + bulk-update result envelopes. Re-exported from
 * repo-core so every kit shares the same shapes — arc's controllers narrow
 * on these types regardless of backend. `LookupRow<TDoc>` is the per-row
 * shape (base doc + joined `as` keys).
 */
export type {
  DeleteManyResult,
  DeleteResult,
  LookupPopulateResult,
  LookupRow,
  UpdateManyResult,
} from '@classytic/repo-core/repository';

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

/** Kit-native options for the portable `aggregate(req)`; each field beats every default. */
export interface AggregateCallOptions {
  /** Also return the winning plan (a second command). */
  explain?: 'queryPlanner' | 'executionStats' | 'allPlansExecution';
  /** Collections the caller asserts are company-wide (see `join-scope.ts`). */
  unscopedJoins?: readonly string[];
  maxTimeMS?: number;
  readPreference?: ReadPreferenceType;
  readConcern?: ReadConcernLevel;
  comment?: string;
}

/** `getByIds` options: chunked `$in` reads, optionally aligned with the input order. */
export interface GetByIdsOptions extends OperationOptions {
  /** Ids per `$in` command. Default `DEFAULT_ID_CHUNK` (10,000). */
  chunkSize?: number;
  /** Chunks in flight at once outside a session. Default 4. */
  concurrency?: number;
  /** Return `Array<TDoc | undefined>` aligned with the input ids instead of a Map. */
  preserveOrder?: boolean;
}
