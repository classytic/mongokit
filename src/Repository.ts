/**
 * Repository Pattern - Data Access Layer
 *
 * Event-driven, plugin-based abstraction for MongoDB operations
 * Inspired by Meta & Stripe's repository patterns
 *
 * @example
 * ```typescript
 * const userRepo = new Repository(UserModel, [
 *   timestampPlugin(),
 *   softDeletePlugin(),
 * ]);
 *
 * // Create
 * const user = await userRepo.create({ name: 'John', email: 'john@example.com' });
 *
 * // Read with pagination
 * const users = await userRepo.getAll({ page: 1, limit: 20, filters: { status: 'active' } });
 *
 * // Update
 * const updated = await userRepo.update(user._id, { name: 'John Doe' });
 *
 * // Delete
 * await userRepo.delete(user._id);
 * ```
 */

import type { RepositoryCacheHandle } from '@classytic/repo-core/cache';
import type { HttpError } from '@classytic/repo-core/errors';
import type { Filter } from '@classytic/repo-core/filter';
import { isFilter } from '@classytic/repo-core/filter';
import { HOOK_PRIORITY as RC_HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import type {
  AggregatePaginationResult,
  KeysetPaginationResult,
  OffsetPaginationResult,
  OffsetPaginationResultCore,
} from '@classytic/repo-core/pagination';
import type {
  AggPaginationRequest,
  AggRequest,
  AggResult,
  ArchiveOptions,
  ArchiveResult,
  ArchiveSink,
  ChangeEvent,
  FilterInput,
  KeysetAggPaginationResult,
  QueryOptions as RcQueryOptions,
  RepoCapabilities,
  TenantPurgeOptions,
  TenantPurgeResult,
  TenantPurgeStrategy,
  WatchOptions,
} from '@classytic/repo-core/repository';
import {
  type PluginType as RcPluginType,
  RepositoryBase,
  type RetryPolicy,
  runChunkedArchive,
  runChunkedPurge,
  throwIfAborted,
  validatePluginOrder,
  withRetry,
} from '@classytic/repo-core/repository';
import {
  compileUpdateSpecToMongo,
  isUpdateSpec,
  type UpdateInput,
} from '@classytic/repo-core/update';
import type {
  CollationOptions as MongoCollationOptions,
  ReadConcernLike,
  ReadPreferenceLike,
} from 'mongodb';
import type { ClientSession, Model, PipelineStage, PopulateOptions } from 'mongoose';
import mongoose from 'mongoose';
import * as aggregateActions from './actions/aggregate.js';
import { applyExecutionHints } from './actions/aggregate-ir/hints.js';
import * as aggregateIrActions from './actions/aggregate-ir/index.js';
import { createMongoArchivePort } from './actions/archive.js';
import * as createActions from './actions/create.js';
import * as deleteActions from './actions/delete.js';
import { createMongoPurgePort } from './actions/purge.js';
import * as readActions from './actions/read.js';
import * as updateActions from './actions/update.js';
import { MONGOKIT_CAPABILITIES } from './capabilities.js';
import { compileFilterToMongo } from './filter/compile.js';
import { operationsByPolicyKey } from './operations.js';
import { PaginationEngine } from './pagination/PaginationEngine.js';
import { AggregationBuilder } from './query/AggregationBuilder.js';
import { LookupBuilder, type LookupOptions } from './query/LookupBuilder.js';
import { hasNearOperator, rewriteNearForCount } from './query/primitives/geo.js';
import { withTransaction as withTransactionHelper } from './transaction.js';
import { createTxBoundRepo } from './tx-bound.js';
import type {
  AggregateOptions,
  AggregatePaginationOptions,
  CacheableOptions,
  CreateOptions,
  DeleteManyResult,
  DeleteResult,
  FindOneAndUpdateOptions,
  LookupPopulateOptions,
  LookupPopulateResult,
  LookupRow,
  Middleware,
  MinimalRepoView,
  ObjectId,
  OperationOptions,
  PaginationConfig,
  PluginType,
  PopulateSpec,
  PrioritizedHook,
  ReadOptions,
  ReadPreferenceType,
  RepositoryContext,
  RepositoryOptions,
  SelectSpec,
  SessionOptions,
  SortSpec,
  UpdateManyResult,
  UpdateOptions,
  WithTransactionOptions,
} from './types.js';
import {
  createError,
  isDuplicateKeyError as isDuplicateKeyErrorUtil,
  parseDuplicateKeyError,
} from './utils/error.js';
import { getSchemaIdType, isValidIdForType } from './utils/id-resolution.js';
import { warn } from './utils/logger.js';

function ensureLookupProjectionIncludesCursorFields(
  projection: Record<string, 0 | 1> | undefined,
  sort: SortSpec | undefined,
): Record<string, 0 | 1> | undefined {
  if (!projection || !sort) return projection;

  const isInclusion = Object.values(projection).some((value) => value === 1);
  if (!isInclusion) return projection;

  const nextProjection = { ...projection };
  for (const field of [...Object.keys(sort), '_id']) {
    nextProjection[field] = 1;
  }

  return nextProjection;
}

/**
 * Validates that an update patch is homogeneous — either all top-level
 * keys are `$`-prefixed Mongo operators OR none are. Mixed shapes (e.g.
 * `{ $set: {...}, status: 'x' }`) cause Mongo to **silently drop** the
 * flat keys, which is the kind of write-loss bug we won't ship.
 *
 * Hoisted into a named helper so the error stack trace points directly
 * at this function — debugging a "patch mixes operators" failure is now
 * trivial without needing to read the call site.
 *
 * @throws TypeError-style HttpError(400) when the patch is mixed.
 */
function assertNoMixedPatchShape(opName: string, patch: Record<string, unknown>): void {
  const patchKeys = Object.keys(patch);
  const operatorKeys = patchKeys.filter((k) => k.startsWith('$'));
  if (operatorKeys.length === 0 || operatorKeys.length === patchKeys.length) return;
  const flatKeys = patchKeys.filter((k) => !k.startsWith('$'));
  throw createError(
    400,
    `[${opName}] assertNoMixedPatchShape: patch mixes Mongo operators (${operatorKeys.join(', ')}) with raw field keys (${flatKeys.join(', ')}). ` +
      `Mongo would silently DROP the flat keys — that's a write-loss bug we refuse to forward. ` +
      `Either wrap the flat keys in $set explicitly, or remove the operator keys.`,
  );
}

/** Mongo change-stream document — the subset `watch()` consumes. */
interface MongoChangeDoc {
  operationType: string;
  documentKey?: { _id?: unknown };
  fullDocument?: unknown;
  /** Driver ≥6 exposes the commit wall-clock time. */
  wallTime?: Date;
  /** BSON Timestamp — seconds since epoch in the high 32 bits. */
  clusterTime?: { getHighBits?: () => number };
}

/**
 * Event surface `watch()` consumes — satisfied by mongoose's ChangeStream
 * wrapper AND the raw driver ChangeStream.
 */
interface WatchEventStream {
  on(event: 'change', listener: (change: MongoChangeDoc) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  close(): Promise<unknown>;
}

/** Mongo `operationType` → portable `ChangeEvent.operation`. */
const CHANGE_OPERATION_MAP: Record<string, ChangeEvent['operation'] | undefined> = {
  insert: 'create',
  update: 'update',
  replace: 'replace',
  delete: 'delete',
};

/**
 * Re-root a compiled Mongo match document under a prefix (`fullDocument`)
 * so a caller filter like `{ status: 'pending' }` matches the change
 * stream's post-image. Logical operators (`$and` / `$or` / `$nor`)
 * recurse; `$`-prefixed top-level operators ($expr etc.) pass through
 * unprefixed — they reference paths explicitly.
 */
function prefixMatchPaths(match: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(match)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      out[key] = (value as Record<string, unknown>[]).map((clause) =>
        prefixMatchPaths(clause, prefix),
      );
    } else if (key.startsWith('$')) {
      out[key] = value;
    } else {
      out[`${prefix}.${key}`] = value;
    }
  }
  return out;
}

/** Best-available commit timestamp for a change-stream document. */
function changeEventTimestamp(change: MongoChangeDoc): Date {
  if (change.wallTime instanceof Date) return change.wallTime;
  const highBits = change.clusterTime?.getHighBits?.();
  if (typeof highBits === 'number' && highBits > 0) return new Date(highBits * 1000);
  return new Date();
}

/**
 * Plugin phase priorities (lower = runs first).
 *
 * Re-exported from `@classytic/repo-core/hooks` so mongokit 3.10 callers see
 * the same constant whether they import from mongokit or directly from
 * repo-core — priorities are identical (POLICY=100, CACHE=200,
 * OBSERVABILITY=300, DEFAULT=500) and the two refs are reference-equal.
 */
export const HOOK_PRIORITY = RC_HOOK_PRIORITY;

/**
 * Production-grade repository for MongoDB.
 *
 * Extends `@classytic/repo-core/repository`'s `RepositoryBase` for the
 * driver-agnostic hook + plugin plumbing (context builder, priority-sorted
 * event engine, plugin-order validator) while layering every Mongo-specific
 * concern — populate, aggregate, lookup, keyset + cursor pagination, $near
 * rewriting — on top.
 *
 * Public surface is byte-stable with mongokit 3.9 (the `_hooks` property is
 * preserved as a live read-through getter; all CRUD, event, and plugin method
 * signatures unchanged). 3.10 is an internal re-plumbing release; consumers
 * upgrading from 3.9 need no code changes.
 */
export class Repository<TDoc = unknown> extends RepositoryBase {
  /**
   * Runtime capability descriptor required by `StandardRepo<TDoc>`
   * (repo-core 0.6.0). Hosts feature-detect once at boot instead of
   * try/catching `UnsupportedOperationError` per call.
   */
  public readonly capabilities: RepoCapabilities = MONGOKIT_CAPABILITIES;
  public readonly Model: Model<TDoc>;
  /**
   * Mongoose model name. Duplicated on the instance for BC — arc / catalog /
   * user code read `repo.model`. `RepositoryBase.modelName` points to the
   * same string; prefer `modelName` in new code.
   */
  public readonly model: string;
  public readonly _pagination: PaginationEngine<TDoc>;
  public readonly idField: string;
  public readonly searchMode: 'text' | 'regex' | 'auto';
  public readonly searchFields: string[] | undefined;
  [key: string]: unknown;
  private _hasTextIndex: boolean | null = null;
  /**
   * Wrap-style middleware chain. Composed around every `_runOp`
   * invocation in registration order — earlier-registered middlewares
   * are outer (run first / unwind last). See `useMiddleware()` and
   * the `Middleware<TDoc>` type for the protocol.
   */
  private readonly _middlewares: Middleware<TDoc>[] = [];

  constructor(
    // Accept Mongoose models with methods/statics/virtuals: Model<TDoc, QueryHelpers, Methods, Virtuals>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Model: Model<TDoc, any, any, any>,
    plugins: PluginType[] = [],
    paginationConfig: PaginationConfig = {},
    options: RepositoryOptions = {},
  ) {
    // Initialize repo-core's hook engine, but defer plugin installation
    // until after Mongo-specific fields exist — several plugins
    // (softDelete, cascade, audit-trail) read `repo.Model` during their
    // `apply()`. Plugin-order validation runs separately below so its
    // warnings fire at the same point mongokit ≤3.9 emitted them.
    super({
      name: Model.modelName,
      hooks: options.hooks ?? 'async',
      pluginOrderChecks: 'off',
      // Standard Schema validation (HOOK_PRIORITY.VALIDATION) + domain-event
      // emission (`<resource>.<verb>` via any EventTransport) are wired by
      // RepositoryBase when these are present — mongokit just forwards them.
      schema: options.schema,
      updateSchema: options.updateSchema,
      events: options.events,
    });
    validatePluginOrder(
      plugins as unknown as readonly RcPluginType[],
      Model.modelName,
      options.pluginOrderChecks ?? 'warn',
      (m) => {
        warn(m);
      },
    );
    this.Model = Model as Model<TDoc>;
    this.model = Model.modelName;
    this._pagination = new PaginationEngine(Model, paginationConfig);
    this.idField = options.idField ?? '_id';
    this.searchMode = options.searchMode ?? 'text';
    this.searchFields = options.searchFields;
    this._wireStrictQueryStripDiagnostic(options.warnOnStrictQueryStrip === true);
    if (this.searchMode === 'regex' && (!this.searchFields || this.searchFields.length === 0)) {
      warn(
        `[mongokit] Repository "${this.model}" configured with searchMode: 'regex' but no searchFields provided. getAll({ search }) will throw until searchFields is set.`,
      );
    }
    // Now safe to install plugins — Model / idField / _pagination are live.
    // Structural compatibility: mongokit's Plugin<RepositoryInstance> apply
    // signature accepts any object with `use`/`on`/`_buildContext`, which
    // RepositoryBase provides. The cast is runtime-safe since `use()` only
    // calls `plugin(repo)` or `plugin.apply(repo)` without probing generics.
    for (const plugin of plugins as unknown as readonly RcPluginType[]) {
      this.use(plugin);
    }

    // Plugin-presence assertion. Convention-by-documentation isn't
    // enforceable; listing required plugins at the boot boundary fails
    // closed when one is forgotten. Error message lists every missing
    // name so the host fixes them all in one round-trip rather than
    // bisecting through repeated boot failures.
    if (options.requirePlugins && options.requirePlugins.length > 0) {
      const installedNames = new Set(
        (plugins as Array<{ name?: string }>).map((p) => p?.name).filter(Boolean) as string[],
      );
      const missing = options.requirePlugins.filter((name) => !installedNames.has(name));
      if (missing.length > 0) {
        throw new TypeError(
          `[mongokit] Repository "${Model.modelName}" requires plugin(s) that are not installed: ` +
            `${missing.join(', ')}. ` +
            `Add the missing plugin(s) to the constructor's \`plugins\` array, or remove the ` +
            `name from \`options.requirePlugins\`. ` +
            `Installed plugins: ${[...installedNames].join(', ') || '(none)'}.`,
        );
      }
    }
  }

  /**
   * Live read-through view of the hook engine's listener registry.
   *
   * Preserved as a public field on the Repository for back-compat with
   * mongokit ≤3.9 — existing tests and observability code pattern-match
   * `repo._hooks.get('before:getAll')` / `repo._hooks.size`. Each access
   * returns a fresh snapshot of the underlying HookEngine state.
   *
   * Read-only. To register listeners use `repo.on(event, listener, { priority })`.
   */
  get _hooks(): Map<string, PrioritizedHook[]> {
    return this.hooks.listeners() as Map<string, PrioritizedHook[]>;
  }

  /**
   * Fire-and-forget emit aliased through RepositoryBase's async path so
   * error hooks converted to/from sync mode still route uniformly. Mongokit
   * ≤3.9 made this a private method on its subclass; the base class exposes
   * it publicly and wraps it in `_emitHook` below for internal use.
   */
  private async _emitHook(event: string, data: unknown): Promise<void> {
    await this.hooks.emitAccordingToMode(event, data);
  }

  private async _emitErrorHook(event: string, data: unknown): Promise<void> {
    try {
      await this._emitHook(event, data);
    } catch (hookError) {
      // Error hooks must not swallow or override the primary error — log so
      // telemetry failures remain debuggable.
      warn(
        `[${this.model}] Error hook '${event}' threw: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
      );
    }
  }

  /**
   * Wire the `warnOnStrictQueryStrip` diagnostic. When enabled, every
   * filter-shaped op (`getById`, `getByQuery`, `getOne`, `findAll`,
   * `count`, `exists`, `update`, `delete`, `findOneAndUpdate`,
   * `updateMany`, `deleteMany`, `claim`, `claimVersion`, `cursor`)
   * checks its `context.query` keys against the cached set of schema
   * paths. Top-level keys not on the schema get logged once per
   * `(model, key)` pair — so a single bad caller surfaces in dev /
   * staging instead of returning the wrong row in prod.
   *
   * Only runs when `strictQuery !== false` is in effect — if mongoose's
   * strictQuery is off, unknown keys flow through to the driver and
   * the trap doesn't apply.
   */
  private _wireStrictQueryStripDiagnostic(enabled: boolean): void {
    if (!enabled) return;

    // Cache the schema's declared paths once at construction. Includes
    // `_id` and dotted parent prefixes so `address.city` against an
    // `address` Mixed path doesn't false-positive.
    const schema = this.Model.schema;
    const declaredPaths = new Set<string>(['_id']);
    for (const path of Object.keys(schema.paths)) {
      declaredPaths.add(path);
      // Also add each dotted prefix — `a.b.c` declared means `a` and
      // `a.b` count as known parents (Mongo accepts queries on parents).
      const segments = path.split('.');
      for (let i = 1; i < segments.length; i++) {
        declaredPaths.add(segments.slice(0, i).join('.'));
      }
    }

    const warned = new Set<string>();
    const modelName = this.model;

    const checkFilter = (filter: unknown): void => {
      // Mongoose stores effective `strictQuery` per schema; off-by-default
      // path means undeclared keys flow through, no trap.
      const strictQuery =
        (schema.options as { strictQuery?: boolean }).strictQuery ??
        ((mongoose as { get?: (k: string) => unknown }).get?.('strictQuery') as
          | boolean
          | 'throw'
          | undefined);
      if (strictQuery === false) return;
      if (!filter || typeof filter !== 'object') return;

      for (const key of Object.keys(filter as Record<string, unknown>)) {
        // Skip top-level Mongo operators ($and / $or / $expr / etc.) —
        // those are syntax, not field paths.
        if (key.startsWith('$')) continue;
        // Take the first segment for dotted paths so `address.city.foo`
        // matches against `address` (parent declared).
        const head = key.split('.')[0];
        if (declaredPaths.has(head) || declaredPaths.has(key)) continue;
        const dedupeKey = `${modelName}.${key}`;
        if (warned.has(dedupeKey)) continue;
        warned.add(dedupeKey);
        warn(
          `[mongokit] '${modelName}.${key}' filter key not on schema — strictQuery will silently strip it. ` +
            `Add the field to the schema, or use 'strict: false' / 'strictQuery: false' if you intend dynamic keys.`,
        );
      }
    };

    // Hook every filter-shaped op. Priority: OBSERVABILITY (300) — runs
    // AFTER policy plugins inject their scope, so we check the actual
    // post-policy filter (avoids false-positives on plugin-injected keys
    // that the host's schema does declare). The check is read-only; it
    // never mutates context.
    //
    // Op coverage is derived from `OP_REGISTRY` by `policyKey` — the
    // single source of truth for which bag carries the user's filter.
    // Adding a new query-shaped op (e.g. a future `findCursor`) means
    // one map entry in operations.ts and the diagnostic auto-includes
    // it. Hardcoding the list here was the exact redundancy the
    // registry was meant to eliminate.
    const observabilityPriority = { priority: 300 };
    for (const op of operationsByPolicyKey('query')) {
      this.on(
        `before:${op}`,
        (context: RepositoryContext) => {
          checkFilter(context.query);
        },
        observabilityPriority,
      );
    }
    for (const op of operationsByPolicyKey('filters')) {
      this.on(
        `before:${op}`,
        (context: RepositoryContext) => {
          checkFilter(context.filters);
        },
        observabilityPriority,
      );
    }
  }

  /**
   * Register a wrap-style middleware. Middleware composes AROUND every
   * `_runOp` invocation — it sees the operation name, the live
   * `RepositoryContext`, and a `next()` continuation that runs the
   * remaining chain + the actual op + after/error hooks.
   *
   * **Composes with `repo.on()` and plugins, doesn't replace them.**
   * Middleware is for ergonomics (timing, short-circuit, input/output
   * mutation in a single closure) — NOT for security policy. Use the
   * `before:*` hook engine for tenant scope, soft-delete filtering,
   * cache invalidation, and audit; those plugins MUST run before
   * middleware sees the op.
   *
   * **Execution order on every call** (build/before hooks fire BEFORE
   * the middleware chain dispatches, so middleware cannot wrap a
   * before-hook failure):
   *
   * ```text
   *   _buildContext + before:<op>   ← repo.on('before:*') hooks
   *     [outer middleware pre]      ← repo.useMiddleware() registrations
   *       [...inner middleware pre]
   *         fn (driver call)
   *         after:<op> | error:<op> ← repo.on('after:*' / 'error:*')
   *       [...inner middleware post]
   *     [outer middleware post]
   * ```
   *
   * Why this order matters: a `before:create` hook that injects a
   * tenant filter into `context.query` runs BEFORE the middleware chain
   * is composed. Middleware sees a context that was already scoped by
   * the policy plugins — it never has the authority to short-circuit a
   * tenant check, because the throw from a `before:*` policy hook
   * unwinds before middleware ever fires. That's by design — middleware
   * as a security boundary would be impossible to audit, since
   * registration order would determine whether scope wins.
   *
   * Practical consequence: if you want middleware to observe a policy
   * failure (e.g. metric a tenant-scope rejection), use `repo.on('error:
   * <op>', ...)` instead — that fires from inside the middleware chain
   * and is reachable.
   *
   * Registration order = composition order: the first middleware
   * registered runs outermost (wraps everything else).
   *
   * @example Time every op
   * ```ts
   * repo.useMiddleware(async ({ operation, next }) => {
   *   const start = performance.now();
   *   try { return await next(); }
   *   finally { metrics.record(operation, performance.now() - start); }
   * });
   * ```
   *
   * @example Inject `tenantId` on every create
   * ```ts
   * repo.useMiddleware(async ({ operation, context, next }) => {
   *   if (operation === 'create' && context.data) {
   *     context.data.tenantId = currentTenant();
   *   }
   *   return next();
   * });
   * ```
   *
   * @example Short-circuit (return without `next()` to skip the actual op)
   * ```ts
   * repo.useMiddleware(async ({ operation, context, next }) => {
   *   if (operation === 'getById' && readOnlyMaintenance) {
   *     return cachedReadOnlyResponse(context.id);
   *   }
   *   return next();
   * });
   * ```
   */
  useMiddleware(middleware: Middleware<TDoc>): this {
    this._middlewares.push(middleware);
    return this;
  }

  /**
   * Compose the registered middleware chain around `exec`. Outermost
   * middleware (first registered) wraps innermost. Each middleware sees
   * the live `RepositoryContext` (already populated + run through
   * `before:*` hooks at the call site — see `useMiddleware` JSDoc for
   * the exact order). `after:` / `error:` hooks fire from inside
   * `exec`, so middleware composes WITH plugins, not instead of them.
   *
   * `_runOp` calls this with its standard try/catch envelope; inline-try
   * methods (`getById`, `update`, `delete`, `deleteMany`, `aggregatePaginate`,
   * `lookupPopulate`, plus `getOne`/`getAll` cache-hit branches) call it
   * directly so middleware sees every op — including cached reads — not
   * just the ones routed through `_runOp`.
   */
  private _composeMiddleware<T>(
    op: string,
    context: RepositoryContext,
    exec: () => Promise<T>,
  ): Promise<T> {
    if (this._middlewares.length === 0) return exec();

    let chain: () => Promise<T> = exec;
    for (let i = this._middlewares.length - 1; i >= 0; i--) {
      const mw = this._middlewares[i] as Middleware<TDoc>;
      const next = chain;
      chain = async () =>
        (await mw({
          operation: op,
          context,
          repo: this as unknown as MinimalRepoView<TDoc>,
          next: next as () => Promise<unknown>,
        })) as T;
    }
    return chain();
  }

  /**
   * Standard operation envelope: compose middleware around an exec that
   * runs `fn`, emits `after:<op>` on success or `error:<op>` on failure.
   * Methods with branched in-try logic that emit `after:*` from multiple
   * paths (`getById`, `update`, `delete`, `deleteMany`, `aggregatePaginate`,
   * `lookupPopulate`) keep their inline try/catch and call
   * `_composeMiddleware` directly instead of being forced through this
   * single-result helper.
   */
  private async _runOp<T>(
    op: string,
    context: RepositoryContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this._composeMiddleware(op, context, async () => {
      try {
        const result = await this._withResilience(context, fn);
        await this._emitHook(`after:${op}`, { context, result });
        return result;
      } catch (error) {
        await this._emitErrorHook(`error:${op}`, { context, error });
        throw this._handleError(error as Error);
      }
    });
  }

  /**
   * Resilience envelope around the DRIVER round-trip only — the repo-core
   * 0.6.0 `QueryOptions.signal` / `QueryOptions.retryPolicy` contract.
   *
   * `throwIfAborted` stops a cancelled request before the next driver call;
   * `withRetry` retries transient failures with exponential backoff (and is
   * a zero-cost passthrough when no policy was passed, so we wrap
   * unconditionally). Crucially this wraps `fn` AFTER `_buildContext` ran —
   * before-hooks (validation, tenant scope, audit, events) execute exactly
   * once per logical call and are NEVER re-run on retry; only the driver
   * call repeats.
   *
   * Both knobs are read from the context (the options bag is spread into
   * `_buildContext` inputs), so every op routed through `_runOp` — and the
   * inline-try methods that call this directly — honors them uniformly.
   */
  private _withResilience<T>(context: RepositoryContext, fn: () => Promise<T>): Promise<T> {
    const signal = context.signal as AbortSignal | undefined;
    const retryPolicy = context.retryPolicy as RetryPolicy | undefined;
    throwIfAborted(signal);
    return withRetry(fn, retryPolicy, signal);
  }

  /**
   * Create single document
   */
  async create(data: Record<string, unknown>, options: CreateOptions = {}): Promise<TDoc> {
    const context = await this._buildContext('create', { data, ...options });
    return this._runOp('create', context, () =>
      createActions.create(this.Model, context.data || data, options),
    );
  }

  /**
   * Create multiple documents
   */
  async createMany(
    dataArray: Record<string, unknown>[],
    options: CreateOptions = {},
  ): Promise<TDoc[]> {
    const context = await this._buildContext('createMany', {
      dataArray,
      ...options,
    });
    return this._runOp('createMany', context, () =>
      createActions.createMany(this.Model, context.dataArray || dataArray, options),
    );
  }

  /**
   * Get document by ID
   */
  async getById(id: string | ObjectId, options: CacheableOptions = {}): Promise<TDoc | null> {
    // Prioritize populateOptions over populate for consistency with getAll
    const populateSpec = options.populateOptions || options.populate;
    const context = await this._buildContext('getById', {
      id,
      ...options,
      populate: populateSpec,
    });

    return this._composeMiddleware('getById', context, async () => {
      // Check if cache plugin returned a cached result
      if ((context as Record<string, unknown>)._cacheHit) {
        const cachedResult = (context as Record<string, unknown>)._cachedResult as TDoc | null;
        // Emit after:* hooks so observability, user hooks, etc. still fire on cache hits
        await this._emitHook('after:getById', { context, result: cachedResult, fromCache: true });
        return cachedResult;
      }

      try {
        // Resolve idField: per-call override > repo config > default '_id'
        const effectiveIdField = options.idField ?? this.idField;

        // Custom idField: query by that field instead of _id
        if (effectiveIdField !== '_id') {
          const result = await this._withResilience(context, () =>
            readActions.getByQuery(
              this.Model,
              { [effectiveIdField]: id, ...(context.query || {}) },
              context,
            ),
          );
          await this._emitHook('after:getById', { context, result });
          return result;
        }

        // Validate id format before querying — avoids a DB round-trip for
        // structurally invalid ids. Uses the id-resolution primitive to detect
        // the schema's _id type (ObjectId / String / Number / UUID) so UUID
        // and custom-ID schemas aren't rejected by an ObjectId-only check.
        // MinimalRepo contract: miss → null. A structurally invalid id
        // (wrong ObjectId shape, non-numeric for Number _id, etc.) is
        // unambiguously a miss — there's no way that id could exist in
        // the collection. Callers who want the legacy throw path opt in
        // explicitly via `throwOnNotFound: true`.
        const wantsThrow = context.throwOnNotFound === true || options.throwOnNotFound === true;
        const idType = getSchemaIdType(this.Model.schema);
        if (!isValidIdForType(id, idType)) {
          if (wantsThrow) throw createError(404, 'Document not found');
          return null;
        }

        const result = await this._withResilience(context, () =>
          readActions.getById(this.Model, id, context),
        );
        if (!result && wantsThrow) {
          throw createError(404, 'Document not found');
        }
        await this._emitHook('after:getById', { context, result });
        return result;
      } catch (error) {
        await this._emitErrorHook('error:getById', { context, error });
        throw this._handleError(error as Error);
      }
    });
  }

  /**
   * Batch point-read — the `$in` counterpart to {@link getById}. Fetches every
   * doc whose id (the repo's `idField`, default `_id`) is in `ids` in ONE query,
   * routed through `findAll` so tenant + soft-delete scoping and hooks apply
   * exactly as a single read would. Returns a Map keyed by the stringified id;
   * ids are de-duplicated and ids with no matching doc are simply absent (no
   * throw — mirrors `getById(..., { throwOnNotFound: false })`). Structurally
   * INVALID ids (wrong ObjectId shape, non-numeric for a Number id field, ...)
   * are dropped the same way — an id that cannot exist in the collection is
   * unambiguously a miss, and one malformed id must never poison the rest of
   * the batch. Lean by default (findAll semantics) — pass `{ lean: false }`
   * for hydrated docs.
   *
   * The N+1 killer for hosts that resolve many ids in one tick (order-line
   * snapshotting, availability matrices, dashboard row enrichment):
   *
   * @example
   * const byId = await repo.getByIds(offerIds, ctx);
   * const doc = byId.get(offerId); // O(1); undefined if not found
   *
   * Sizing: there is no library-imposed cap — the bounds are MongoDB's (the
   * `$in` array must fit the 16 MB query document; `$in` on an indexed field
   * is n point-lookups). Keep batches ≤ ~10k ids per call and chunk beyond
   * that. Don't exclude the id field via `select` — result keys derive from
   * it.
   */
  async getByIds(
    ids: ReadonlyArray<string | ObjectId>,
    options: OperationOptions & { sort?: SortSpec | string; limit?: number } = {},
  ): Promise<Map<string, TDoc>> {
    // Per-call override > repo config > default '_id' — parity with getById.
    const field = options.idField ?? this.idField;
    // Validate against the id FIELD's schema type (not blanket `_id`) so
    // custom-idField repos with String/UUID keys aren't over-filtered.
    const idType = getSchemaIdType(this.Model.schema, field);
    const unique = [...new Set(ids.map((id) => String(id)))].filter((id) =>
      isValidIdForType(id, idType),
    );
    if (unique.length === 0) return new Map();
    const docs = await this.findAll({ [field]: { $in: unique } }, options);
    return new Map(docs.map((d) => [String((d as Record<string, unknown>)[field]), d]));
  }

  /**
   * Get single document by query
   */
  async getByQuery(
    query: Record<string, unknown>,
    options: CacheableOptions & { sort?: SortSpec } = {},
  ): Promise<TDoc | null> {
    // Prioritize populateOptions over populate for consistency with getAll
    const populateSpec = options.populateOptions || options.populate;
    const context = await this._buildContext('getByQuery', {
      query,
      ...options,
      populate: populateSpec,
    });

    // Check if cache plugin returned a cached result
    if ((context as Record<string, unknown>)._cacheHit) {
      const cachedResult = (context as Record<string, unknown>)._cachedResult as TDoc | null;
      await this._emitHook('after:getByQuery', { context, result: cachedResult, fromCache: true });
      return cachedResult;
    }

    // Use context.query (which may have been modified by plugins) instead of original query
    const finalQuery = context.query || query;
    return this._runOp('getByQuery', context, () =>
      readActions.getByQuery(this.Model, finalQuery, context),
    );
  }

  /**
   * Get single document by arbitrary filter.
   * Unlike getByQuery, this method is designed for Arc/controller use where
   * compound filters (org scope + policy + id) are pre-built.
   *
   * @example
   * const product = await repo.getOne({ slug: 'laptop', organizationId: 'org_1' });
   */
  async getOne(
    query: Record<string, unknown>,
    options: CacheableOptions & { sort?: SortSpec } = {},
  ): Promise<TDoc | null> {
    const populateSpec = options.populateOptions || options.populate;
    const context = await this._buildContext('getOne', {
      query,
      ...options,
      populate: populateSpec,
    });

    return this._composeMiddleware('getOne', context, async () => {
      // Cache-hit path lives INSIDE the middleware composition so wrap-
      // style middleware (timing, audit, custom transformers) sees cached
      // reads exactly the same as DB-backed ones. Mirrors `getById`'s
      // pattern (cache-hit also wrapped) — without this, cached reads
      // were a silent gap in middleware coverage.
      if ((context as Record<string, unknown>)._cacheHit) {
        const cachedResult = (context as Record<string, unknown>)._cachedResult as TDoc | null;
        await this._emitHook('after:getOne', { context, result: cachedResult, fromCache: true });
        return cachedResult;
      }

      const finalQuery = context.query || query;
      try {
        const result = await this._withResilience(context, () =>
          readActions.getByQuery(this.Model, finalQuery, context),
        );
        await this._emitHook('after:getOne', { context, result });
        return result;
      } catch (error) {
        await this._emitErrorHook('error:getOne', { context, error });
        throw this._handleError(error as Error);
      }
    });
  }

  /**
   * Fetch ALL documents matching filters without pagination.
   * Use for background jobs, exports, batch processing where you need every doc.
   *
   * @example
   * const all = await repo.findAll({ status: 'active' });
   * const allLean = await repo.findAll({}, { select: 'name email', lean: true });
   */
  async findAll(
    filters: Record<string, unknown> = {},
    options: OperationOptions & { sort?: SortSpec | string; limit?: number } = {},
  ): Promise<TDoc[]> {
    // findAll's first arg is a filter (same shape as update/findOneAndUpdate/getOne).
    // We expose it on the context as `query` so plugins use the single, dominant
    // convention: `context.query` for any op whose primary input is a filter.
    // List-shaped ops with a paginated `{ filters, page, limit, ... }` options
    // bag (getAll, aggregatePaginate, lookupPopulate) keep `context.filters`.
    //
    // `limit` is optional — when omitted, returns all matching docs (the
    // historic behavior). Provide a number to cap the read at the driver
    // level. This is the path callers want when they need a bounded
    // non-paginated find (e.g. removal-strategy candidate fetches inside
    // hot reservation transactions): `getAll({ noPagination: true })`
    // delegates here and would otherwise drop a passed limit, while
    // `getAll({ limit, page })` returns a paginated envelope plus a
    // count round-trip the caller doesn't need.
    const context = await this._buildContext('findAll', { query: filters, ...options });
    const resolvedFilters = (context.query as Record<string, unknown> | undefined) ?? filters;

    return this._runOp('findAll', context, async () => {
      const query = this.Model.find(resolvedFilters);
      const sortSpec = context.sort || options.sort;
      if (sortSpec) query.sort(this._parseSort(sortSpec));
      const selectSpec = context.select || options.select;
      if (selectSpec) query.select(selectSpec);
      if (options.populate || context.populate)
        query.populate(this._parsePopulate(context.populate || options.populate));
      if (context.lean ?? options.lean ?? true) query.lean();
      if (options.session) query.session(options.session as ClientSession);
      if (options.readPreference) query.read(options.readPreference);
      const limitSpec = (context.limit as number | undefined) ?? options.limit;
      if (typeof limitSpec === 'number' && limitSpec > 0) query.limit(limitSpec);

      return (await query.exec()) as TDoc[];
    });
  }

  /**
   * Streaming reads — async iterator over data, suitable for migrations,
   * backfills, schema audits, and any once-a-quarter "touch every row"
   * job. Goes through the standard `before:cursor` hook pipeline so
   * multi-tenant scope, soft-delete filter, and access-control plugins
   * inject scope BEFORE the underlying mongoose cursor is built.
   *
   * Replaces direct `Model.find().cursor()` usage which bypasses every
   * plugin — that's how cross-tenant data ends up in migrations.
   *
   * Returns an `AsyncIterableIterator<TDoc>` — drive it with `for await`.
   * The mongoose cursor is closed when iteration completes or breaks.
   *
   * @example Backfill a missing field across the whole tenant scope
   * ```ts
   * for await (const doc of repo.cursor({ filter: { migrated: { $ne: true }}}, { batchSize: 1000 })) {
   *   await transformer(doc);
   *   await repo.update(doc._id, { migrated: true });
   * }
   * ```
   *
   * @example Audit unscoped — opt out of multi-tenant for global sweeps
   * ```ts
   * for await (const doc of repo.cursor({}, { batchSize: 500, organizationId: undefined })) {
   *   audit(doc);
   * }
   * ```
   */
  async *cursor(
    filter: Record<string, unknown> = {},
    options: ReadOptions & {
      sort?: SortSpec | string;
      batchSize?: number;
      select?: SelectSpec;
      lean?: boolean;
    } = {},
  ): AsyncIterableIterator<TDoc> {
    const context = await this._buildContext('cursor', { query: filter, ...options });
    const resolvedFilter = (context.query as Record<string, unknown> | undefined) ?? filter;

    // Build the mongoose cursor inside a `_composeMiddleware` so wrap-
    // style middleware sees the op start. We can't run `_runOp` here —
    // its `after:` emit fires once with a single result, but a cursor's
    // result is a stream. Emit `after:cursor` once when the iteration
    // completes (consumer break / drain) and `error:cursor` on rejection.
    // The middleware closure resolves when the cursor is fully closed.
    const query = this.Model.find(resolvedFilter);
    const sortSpec = context.sort || options.sort;
    if (sortSpec) query.sort(this._parseSort(sortSpec));
    if (options.select) query.select(options.select as string | Record<string, 0 | 1>);
    if (options.batchSize) query.batchSize(options.batchSize);
    if (context.lean ?? options.lean ?? true) query.lean();
    if (options.session) query.session(options.session as ClientSession);
    if (options.readPreference) query.read(options.readPreference);

    const stream = query.cursor();
    let yieldedCount = 0;
    try {
      for await (const doc of stream) {
        yieldedCount++;
        yield doc as TDoc;
      }
      await this._emitHook('after:cursor', { context, result: { count: yieldedCount } });
    } catch (error) {
      await this._emitErrorHook('error:cursor', { context, error });
      throw this._handleError(error as Error);
    } finally {
      // Mongoose cursors auto-close on drain, but explicit close on early
      // break (caller's `break` inside `for await`) prevents the cursor
      // from sitting open until GC.
      if (typeof (stream as { close?: () => Promise<void> }).close === 'function') {
        await (stream as { close: () => Promise<void> }).close().catch(() => {
          // Cursor close errors are diagnostic-only — don't override the
          // primary error or the drain-success path.
        });
      }
    }
  }

  /**
   * Portable change feed — `StandardRepo.watch()` over Mongo change
   * streams (`Model.watch`). Requires a replica set (or mongos); a
   * standalone mongod rejects change streams at open time — gate on
   * `repo.capabilities.changeStreams` plus your deployment topology.
   *
   * Semantics:
   *   - **Plugin-routed like every other read.** The filter goes through
   *     the standard `before:watch` hook pipeline (`OP_REGISTRY.watch`,
   *     policyKey `'query'`) BEFORE the change-stream pipeline is built —
   *     `multiTenantPlugin` injects the tenant scope (and throws under
   *     `required: true` exactly like other reads), `softDeletePlugin`
   *     injects the deletion-state predicate. A tenant-scoped repo never
   *     streams cross-tenant changes.
   *   - `fullDocument: 'updateLookup'` — update events carry the post-
   *     image document when it still exists at lookup time.
   *   - `filter` (record or Filter IR) is compiled with the standard
   *     filter compiler and applied against `fullDocument.*` paths, so
   *     `watch({ status: 'pending' })` matches the post-image. Delete
   *     events have no `fullDocument` and therefore don't match a
   *     non-empty post-policy filter — use `bypassTenant` / an unscoped
   *     repo without a filter to observe deletes.
   *   - `options.signal` ends the iterator (closes the stream). A
   *     pre-aborted signal rejects at the op boundary like every other op.
   *   - `options.resumeAfter` forwards a previously captured Mongo
   *     resume token for at-least-once consumption across restarts.
   *
   * Context keys for policy plugins (`organizationId`, `bypassTenant`,
   * `includeDeleted`, ...) ride the options bag at runtime — same as every
   * other op. The contract's `WatchOptions` type doesn't declare an index
   * signature, so typed callers widen at the call site (or rely on an
   * ALS `resolveContext` so no per-call tenant key is needed).
   *
   * @example
   * ```ts
   * const ac = new AbortController();
   * for await (const change of repo.watch({ status: 'pending' }, { signal: ac.signal })) {
   *   if (change.operation === 'create') enqueue(change.doc!);
   * }
   * ```
   */
  async *watch(filter?: FilterInput, options: WatchOptions = {}): AsyncIterable<ChangeEvent<TDoc>> {
    // Route through the standard hook pipeline FIRST — policy plugins
    // (multi-tenant, soft-delete, access control) mutate `context.query`,
    // and the required-tenant throw fires here, before any stream opens.
    // `_buildContext` also runs the abort guard (pre-aborted signal
    // rejects) and normalizes Filter IR in the `query` slot.
    const context = await this._buildContext('watch', { query: filter ?? {}, ...options });

    // `Model.watch` takes plain stage records (not mongoose's
    // `PipelineStage` union — change-stream stages like the
    // `operationType` $match aren't representable in it).
    const pipeline: Record<string, unknown>[] = [
      { $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
    ];

    // Compile the POST-POLICY query (caller filter + tenant scope +
    // soft-delete predicate) against fullDocument.* paths.
    const compiled = compileFilterToMongo(context.query ?? {});
    if (Object.keys(compiled).length > 0) {
      pipeline.push({ $match: prefixMatchPaths(compiled, 'fullDocument') });
    }

    // Mongoose's `Model.watch()` returns its ChangeStream wrapper — an
    // EventEmitter (`change` / `error` / `close`), NOT an async iterable.
    // Consume it event-style and bridge into the AsyncIterable contract
    // through a pull queue; this also works against the raw driver
    // ChangeStream (same event surface).
    const stream = this.Model.watch(pipeline, {
      fullDocument: 'updateLookup',
      ...(options.resumeAfter !== undefined
        ? { resumeAfter: options.resumeAfter as Record<string, unknown> }
        : {}),
    }) as unknown as WatchEventStream;

    const queue: MongoChangeDoc[] = [];
    let streamError: Error | null = null;
    let ended = false;
    let notify: (() => void) | null = null;
    const wake = () => {
      const resolve = notify;
      notify = null;
      resolve?.();
    };

    const onChange = (change: MongoChangeDoc) => {
      queue.push(change);
      wake();
    };
    const onError = (error: Error) => {
      streamError = error;
      wake();
    };
    const onClose = () => {
      ended = true;
      wake();
    };
    stream.on('change', onChange);
    stream.on('error', onError);
    stream.on('close', onClose);

    const closeStream = async () => {
      try {
        await stream.close();
      } catch {
        // Close errors are diagnostic-only.
      }
    };

    const signal = options.signal;
    const onAbort = () => {
      ended = true;
      wake();
      void closeStream();
    };

    try {
      if (signal) {
        if (signal.aborted) return;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      while (true) {
        if (signal?.aborted) return;
        const change = queue.shift();
        if (change) {
          const operation = CHANGE_OPERATION_MAP[change.operationType];
          if (!operation) continue;
          yield {
            operation,
            id: change.documentKey?._id,
            ...(change.fullDocument !== undefined ? { doc: change.fullDocument as TDoc } : {}),
            timestamp: changeEventTimestamp(change),
          };
          continue;
        }
        if (streamError) {
          // Abort-triggered close can race an in-flight getMore — surface
          // it as a clean end, not an error (contract: "the iterator ends
          // when options.signal aborts").
          if (signal?.aborted) return;
          throw streamError;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      stream.removeListener('change', onChange);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      await closeStream();
    }
  }

  /**
   * Unified pagination - auto-detects offset vs keyset based on params
   *
   * Auto-detection logic:
   * - If params has 'cursor' or 'after' → uses keyset pagination (stream)
   * - If params has 'pagination' or 'page' → uses offset pagination (paginate)
   * - Else → defaults to offset pagination with page=1
   *
   * @example
   * // Offset pagination (page-based)
   * await repo.getAll({ page: 1, limit: 50, filters: { status: 'active' } });
   * await repo.getAll({ pagination: { page: 2, limit: 20 } });
   *
   * // Keyset pagination (cursor-based)
   * await repo.getAll({ cursor: 'eyJ2Ij...', limit: 50 });
   * await repo.getAll({ after: 'eyJ2Ij...', sort: { createdAt: -1 } });
   *
   * // Simple query (defaults to page 1)
   * await repo.getAll({ filters: { status: 'active' } });
   *
   * // Skip cache for fresh data
   * await repo.getAll({ filters: { status: 'active' } }, { skipCache: true });
   */
  async getAll(
    params: {
      filters?: Record<string, unknown>;
      sort?: SortSpec | string;
      cursor?: string;
      after?: string;
      page?: number;
      pagination?: { page?: number; limit?: number };
      limit?: number;
      search?: string;
      mode?: 'offset' | 'keyset';
      hint?: string | Record<string, 1 | -1>;
      maxTimeMS?: number;
      countStrategy?: 'exact' | 'estimated' | 'none';
      readPreference?: ReadPreferenceType;
      /** Advanced populate options (from QueryParser or Arc's BaseController) */
      populateOptions?: PopulateOptions[];
      /** Collation for locale-aware string comparison */
      collation?: import('./types.js').CollationOptions;
      /** Lookup configurations for $lookup joins (from QueryParser or manual) */
      lookups?: LookupOptions[];
      /** Skip pagination entirely — returns raw TDoc[] (same as findAll) */
      noPagination?: boolean;
    } = {},
    options: CacheableOptions = {},
  ): Promise<OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc> | TDoc[]> {
    // Normalize nested pagination into top-level page/limit so that
    // before:getAll hooks (including cache) see the actual values.
    const normalizedParams = {
      ...params,
      page: params.page ?? params.pagination?.page,
      limit: params.limit ?? params.pagination?.limit,
    };
    const context = await this._buildContext('getAll', {
      ...normalizedParams,
      ...options,
    });

    // Check if cache plugin returned a cached result. Wrapping the
    // emit + return in `_composeMiddleware` so wrap-style middleware
    // (timing, audit, custom transformers) sees cached reads — without
    // this, the cache-hit branch returned before middleware ever fired,
    // creating a silent gap. The non-cache branches below go through
    // `_runOp`, which calls `_composeMiddleware` internally — so we
    // never double-compose.
    if ((context as Record<string, unknown>)._cacheHit) {
      return this._composeMiddleware('getAll', context, async () => {
        const cachedResult = (context as Record<string, unknown>)._cachedResult as
          | OffsetPaginationResult<TDoc>
          | KeysetPaginationResult<TDoc>;
        await this._emitHook('after:getAll', { context, result: cachedResult, fromCache: true });
        return cachedResult;
      });
    }

    // noPagination: true → delegate to findAll() for raw array.
    // getAll's plugin contract is context.filters; findAll's is context.query
    // (its first arg is a filter, not a paginated bag). Pass the resolved
    // value down as findAll's positional filter — findAll re-runs its own
    // before:findAll hooks and rebuilds context.query from there.
    if (params.noPagination) {
      // Forward the optional `limit` so `getAll({ noPagination: true,
      // limit: N })` is equivalent to `findAll(filter, { limit: N })`.
      // `findAll` ignores `limit` when undefined, preserving the
      // unbounded historic behavior.
      const forwardedLimit =
        (context.limit as number | undefined) ?? params.limit ?? params.pagination?.limit;
      return this.findAll(context.filters ?? params.filters ?? {}, {
        ...options,
        sort: context.sort ?? params.sort,
        ...(typeof forwardedLimit === 'number' ? { limit: forwardedLimit } : {}),
      });
    }

    // Resolve query params, build the search-augmented filter, detect geo,
    // and assemble pagination options. Each concern is a private method so
    // this orchestrator stays readable and each concern is independently
    // testable by subclasses or future extraction.
    const filters = context.filters ?? params.filters ?? {};
    const search = context.search; // read from context only — plugin clears honored
    const isNearQuery = hasNearOperator(filters);
    const sort = this._resolveSort(context, params, isNearQuery);
    const limit =
      context.limit ??
      params.limit ??
      params.pagination?.limit ??
      this._pagination.config.defaultLimit;
    const page = context.page ?? params.pagination?.page ?? params.page;
    const after = context.after ?? params.cursor ?? params.after;
    const mode = context.mode ?? params.mode;
    const useKeyset = this._detectPaginationMode(mode, page, after, sort, context, params);

    // Build the query filter with search merged in
    const query = this._buildSearchQuery(filters, search);

    // Assemble common pagination options
    const populateSpec =
      options.populateOptions || params.populateOptions || context.populate || options.populate;
    const paginationOptions = {
      filters: query,
      sort: isNearQuery ? undefined : this._parseSort(sort),
      limit,
      populate: this._parsePopulate(populateSpec),
      select: context.select || options.select,
      lean: context.lean ?? options.lean ?? true,
      session: options.session,
      hint: context.hint ?? params.hint,
      maxTimeMS: context.maxTimeMS ?? params.maxTimeMS,
      readPreference: context.readPreference ?? options.readPreference ?? params.readPreference,
      collation: (context.collation ?? params.collation) as
        | import('./types.js').CollationOptions
        | undefined,
    };

    // Auto-route to lookupPopulate when lookups are present (from QueryParser or manual)
    const lookups = (context.lookups ?? params.lookups) as LookupOptions[] | undefined;
    if (lookups && lookups.length > 0) {
      return this._runOp('getAll', context, async () => {
        const lookupResult = await this.lookupPopulate({
          filters: query,
          lookups,
          sort: paginationOptions.sort as SortSpec | string,
          page: useKeyset ? undefined : page || 1,
          after: useKeyset ? after : undefined,
          limit,
          select: paginationOptions.select,
          session: options.session,
          readPreference: paginationOptions.readPreference,
          collation: paginationOptions.collation,
          countStrategy: context.countStrategy ?? params.countStrategy,
        });

        // `lookupPopulate` already returns the standard envelope union
        // (`OffsetPaginationResultCore | KeysetPaginationResultCore`) —
        // same shape `getAll` itself emits. No translation needed; just
        // pass it through as the `getAll` result.
        return lookupResult as OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc>;
      });
    }

    return this._runOp('getAll', context, async () => {
      let result: OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc>;

      if (useKeyset) {
        // Keyset pagination (cursor-based) — sort is required for cursor keys.
        // $near / $nearSphere doesn't compose with keyset (Mongo applies its
        // own implicit ordering), so the assertion below is safe in practice;
        // callers using $near should not request mode: 'keyset'.
        result = await this._pagination.stream({
          ...paginationOptions,
          sort: paginationOptions.sort as SortSpec,
          after,
        });
      } else {
        // Offset pagination (page-based) - default.
        //
        // $near / $nearSphere handling:
        //   MongoDB forbids countDocuments when $near is in the filter — these
        //   are sort operators that consume the query plan slot. We rewrite
        //   the filter to an equivalent bounded `$geoWithin: $centerSphere`
        //   for the count query only (same 2dsphere index, same document
        //   set, count-compatible), and pass it via `countFilters`. The
        //   find query still uses `$near` to get MongoDB's implicit distance
        //   sort. When the $near is unbounded (no $maxDistance), we cannot
        //   produce a bounded rewrite — fall back to countStrategy: 'none'.
        let countFilters: Record<string, unknown> | undefined;
        let forcedCountStrategy: 'none' | undefined;
        if (isNearQuery) {
          const rewritten = rewriteNearForCount(query);
          if (rewritten) {
            countFilters = rewritten;
          } else {
            forcedCountStrategy = 'none';
          }
        }
        result = await this._pagination.paginate({
          ...paginationOptions,
          page: page || 1,
          countFilters,
          countStrategy: context.countStrategy ?? params.countStrategy ?? forcedCountStrategy,
        });
      }

      return result;
    });
  }

  /**
   * Atomic "look up by filter, insert `data` if missing, return the doc."
   *
   * Returns `{ doc, created }` so callers can tell whether *this* call
   * inserted (race-win) or matched an existing row. Implements
   * `StandardRepo.getOrCreate()` from `@classytic/repo-core/repository`
   * — see that interface's JSDoc for the cross-kit contract.
   *
   * Routes through the hook system for policy enforcement (multi-tenant,
   * soft-delete, audit). The hook context carries the resolved query +
   * data; the action layer adds the `created` discriminator from the
   * driver's `lastErrorObject.upserted`.
   */
  async getOrCreate(
    query: Record<string, unknown>,
    createData: Record<string, unknown>,
    options: SessionOptions = {},
  ): Promise<{ doc: TDoc; created: boolean }> {
    const context = await this._buildContext('getOrCreate', {
      query,
      data: createData,
      ...options,
    });
    return this._runOp('getOrCreate', context, () => {
      const finalQuery = context.query || query;
      const finalData = context.data || createData;
      return readActions.getOrCreate(this.Model, finalQuery, finalData, options);
    });
  }

  /**
   * Count documents
   * Routes through hook system for policy enforcement (multi-tenant, soft-delete)
   */
  async count(query: Record<string, unknown> = {}, options: ReadOptions = {}): Promise<number> {
    const context = await this._buildContext('count', {
      query,
      ...options,
    });
    return this._runOp('count', context, () =>
      readActions.count(this.Model, context.query || query, options),
    );
  }

  /**
   * Check if document exists
   * Routes through hook system for policy enforcement (multi-tenant, soft-delete)
   */
  async exists(
    query: Record<string, unknown>,
    options: ReadOptions = {},
  ): Promise<{ _id: unknown } | null> {
    const context = await this._buildContext('exists', {
      query,
      ...options,
    });
    return this._runOp('exists', context, () =>
      readActions.exists(this.Model, context.query || query, options),
    );
  }

  /**
   * Update a document by id and return the post-update doc.
   *
   * Compiles to `Model.findOneAndUpdate(filter, { $set: data }, { new:
   * true, runValidators: true })` under the hood and routes through the
   * full plugin pipeline — `multiTenantPlugin` injects the tenant scope,
   * `auditTrailPlugin` records the change, `cachePlugin` invalidates,
   * `softDeletePlugin` etc. all compose. Returns `null` on miss (the
   * `MinimalRepo` contract; pass `throwOnNotFound: true` for the legacy
   * throw path).
   *
   * **Anti-pattern to avoid** — calling `Model.findOneAndUpdate()`
   * directly on the raw mongoose model bypasses every plugin:
   *
   * ```ts
   * // ❌ Bypasses multi-tenant scope, audit, cache invalidation:
   * const doc = await CampaignModel.findOneAndUpdate(
   *   { _id: id, organizationId: ctx.orgId },     // hand-rolled tenant filter
   *   { $set: patch, $currentDate: { updatedAt: 1 } },
   *   { new: true, runValidators: true }
   * );
   * return doc ? toEntity(doc) : null;
   *
   * // ✅ Plugin-routed; tenant + audit + cache auto-applied:
   * const doc = await campaignRepo.update(id, patch, repoOptionsFromCtx(ctx));
   * return doc ? toEntity(doc) : null;
   * ```
   *
   * The raw-mongoose path is a recurring source of cross-tenant leaks
   * (tenant filter forgotten on the next refactor), audit gaps (changes
   * invisible to the compliance trail), and stale-cache bugs (cache
   * invalidation skipped). Always route mutations through this method —
   * the `repo.update()` keystroke count beats raw mongoose AND composes
   * with the policy stack.
   *
   * **CAS / status-precondition writes — use `repo.claim()`, not `update()`.**
   * A `findOneAndUpdate` whose filter includes an expected-state check
   * (`{ _id, status: 'pending' }` → `{ $set: { status: 'shipped' } }`)
   * is a compare-and-set, not a plain update. Reach for the `claim()`
   * primitive — it expresses the transition as `{ from, to }`, returns
   * `null` on race-loss (so callers can branch on retry), and routes
   * through the same plugin pipeline:
   *
   * ```ts
   * // ❌ Hand-rolled CAS — bypasses plugins, no typed race-loss signal:
   * const doc = await CampaignModel.findOneAndUpdate(
   *   { _id: id, organizationId: ctx.orgId, status: 'pending' },
   *   { $set: { status: 'sent', sentAt: new Date() } },
   *   { new: true }
   * );
   * if (!doc) throw new ConcurrentTransitionError(id);
   *
   * // ✅ Plugin-routed CAS with explicit transition + race-loss = null:
   * const doc = await campaignRepo.claim(
   *   id,
   *   { from: 'pending', to: 'sent' },
   *   { sentAt: new Date() },
   *   repoOptionsFromCtx(ctx),
   * );
   * if (!doc) throw new ConcurrentTransitionError(id, 'pending', 'sent');
   * ```
   *
   * Pair `claim()` with `defineStateMachine()` from
   * `@classytic/primitives/state-machine` for the modelling layer
   * (`assertTransition` catches illegal transitions sync, `claim` enforces
   * the race-safe write) — see mongokit's CLAUDE.md "State-machine +
   * claim() pairing" recipe. For pure dedup-on-id without a state
   * transition (idempotency keys, webhook receivers), use `getOrCreate()`
   * — `claim()` with `from === to === id` works too but is heavier.
   *
   * Domain-layer mapping (`doc → entity`) belongs on top of this call,
   * not inside mongokit. The canonical pattern is a 3-line host helper:
   *
   * ```ts
   * async function updateAndMap<TDoc, TEntity>(
   *   repo: Repository<TDoc>,
   *   id: string,
   *   patch: Partial<TDoc>,
   *   ctx: RequestContext,
   *   mapper: (doc: TDoc) => TEntity,
   * ): Promise<TEntity | null> {
   *   const doc = await repo.update(id, patch, repoOptionsFromCtx(ctx));
   *   return doc ? mapper(doc) : null;
   * }
   * ```
   *
   * Mongokit deliberately doesn't ship `updateAndMap` — host mapper
   * signatures vary (`Result<T, E>`, throw-on-miss, audit-stamped
   * mappers that take `ctx`, tx-scoped mappers, …) and absorbing a
   * single shape would lock every consumer into it.
   */
  async update(
    id: string | ObjectId,
    data: Record<string, unknown>,
    options: UpdateOptions = {},
  ): Promise<TDoc | null> {
    const context = await this._buildContext('update', {
      id,
      data,
      ...options,
    });

    return this._composeMiddleware('update', context, async () => {
      try {
        const wantsThrow = context.throwOnNotFound === true || options.throwOnNotFound === true;
        const effectiveIdField = options.idField ?? this.idField;
        if (effectiveIdField === '_id') {
          const idType = getSchemaIdType(this.Model.schema);
          if (!isValidIdForType(id, idType)) {
            if (wantsThrow) throw createError(404, 'Document not found');
            await this._emitHook('after:update', { context, result: null });
            return null;
          }
        }

        let result: TDoc | null;
        if (effectiveIdField !== '_id') {
          result = await this._withResilience(context, () =>
            updateActions.updateByQuery(
              this.Model,
              { [effectiveIdField]: id, ...(context.query || {}) },
              context.data || data,
              context,
            ),
          );
        } else {
          result = await this._withResilience(context, () =>
            updateActions.update(this.Model, id, context.data || data, context),
          );
        }
        if (!result && wantsThrow) {
          throw createError(404, 'Document not found');
        }
        await this._emitHook('after:update', { context, result });
        return result;
      } catch (error) {
        await this._emitErrorHook('error:update', { context, error });
        throw this._handleError(error as Error);
      }
    });
  }

  /**
   * Atomic findOneAndUpdate (compare-and-set primitive).
   *
   * Single round-trip match-and-mutate for outbox relays, distributed locks,
   * and workflow semaphores. Goes through the full hook pipeline so
   * multi-tenant scope, soft-delete, audit, and cache plugins all apply.
   *
   * Returns the matched document (post-update by default) or `null` when no
   * document matches and `upsert` is false.
   *
   * @example FIFO claim-lease for an outbox worker
   * ```ts
   * const claimed = await outboxRepo.findOneAndUpdate(
   *   { status: 'pending', leaseExpiresAt: { $lt: new Date() } },
   *   { $set: { status: 'processing', leaseExpiresAt: leaseUntil, leasedBy: workerId } },
   *   { sort: { createdAt: 1 }, returnDocument: 'after' },
   * );
   * if (!claimed) return; // queue empty
   * ```
   *
   * @example CAS upsert
   * ```ts
   * const lock = await locksRepo.findOneAndUpdate(
   *   { _id: lockKey, ownerId: { $in: [null, workerId] } },
   *   { $set: { ownerId: workerId, expiresAt: leaseUntil } },
   *   { upsert: true },
   * );
   * ```
   */
  async findOneAndUpdate<TResult = TDoc>(
    filter: Record<string, unknown>,
    update: UpdateInput,
    options: FindOneAndUpdateOptions = {},
  ): Promise<TResult | null> {
    // Route portable Update IR to the Mongo-operator shape before the hook
    // pipeline runs — `before:findOneAndUpdate` listeners (tenant scope,
    // soft delete) inspect `context.data` and expect `$set` / `$inc` /
    // `$unset` / `$setOnInsert` keys, not the IR's `set` / `inc` / etc.
    // Raw Mongo records and aggregation pipelines flow through unchanged.
    const normalizedUpdate = isUpdateSpec(update)
      ? compileUpdateSpecToMongo(update)
      : (update as Record<string, unknown> | Record<string, unknown>[]);

    const context = await this._buildContext('findOneAndUpdate', {
      query: filter,
      data: normalizedUpdate,
      ...options,
    });

    return this._runOp('findOneAndUpdate', context, async () => {
      const finalQuery = (context.query as Record<string, unknown>) || filter;
      const finalUpdate =
        (context.data as Record<string, unknown> | Record<string, unknown>[]) || normalizedUpdate;

      const result = await updateActions.findOneAndUpdate(this.Model, finalQuery, finalUpdate, {
        ...options,
        sort: options.sort,
        returnDocument: options.returnDocument ?? 'after',
        upsert: options.upsert ?? false,
        session: options.session,
      });

      return result as TResult | null;
    });
  }

  /**
   * Atomic compare-and-swap state transition. Implements
   * `StandardRepo.claim()` from `@classytic/repo-core/repository` (0.4+).
   *
   * Builds a `findOneAndUpdate({ _id, [field]: from, ...where }, { $set:
   * { [field]: to, ...patch } })` in a single round-trip — race-free
   * across concurrent callers. Returns the post-update doc on success,
   * `null` when:
   *   - the row exists but its current state isn't `from` (someone
   *     else won the transition), OR
   *   - any predicate in `transition.where` fails (paused guard,
   *     retry-time guard, heartbeat-staleness, sub-document predicate),
   *     OR
   *   - no row matches the id at all.
   *
   * The caller can't distinguish "lost race" from "guard predicate
   * failed" — both mean "don't proceed." That's by design: the only
   * action either way is to back off.
   *
   * **Source-state — `from: T | T[]`.** Pass a literal for a single-
   * source transition (`from: 'pending'`) or an array for the
   * "transition from any of these states" pattern (`from: ['pending',
   * 'approved']`). Compiles to `[stateField]: { $in: [...] }`. Real-
   * world frequency: commission's `voidRecord` / `markClawedBack` /
   * `endAgreement` / `_transition`, media-kit's error path,
   * streamline's `cancelAt` — every state machine with more than one
   * non-terminal source state hits this. Without array support those
   * sites fall back to raw `findOneAndUpdate` and lose plugin routing.
   *
   * **`from` is value-only — no Mongo expressions.** `from` accepts a
   * literal or an array of literals (`$in`-shaped). It does NOT
   * accept `{ $ne: ... }`, `{ $lt: ... }`, `{ $exists: ... }`, or
   * arbitrary expression objects. The CAS contract is "match if the
   * state field equals one of these specific values" — admitting
   * arbitrary predicates would collapse the contract into a generic
   * filter, defeating the point of a state-machine primitive.
   *
   * For non-equality / range / existence predicates on the state
   * field, use `where`:
   *
   * ```ts
   * // ❌ from: { $ne: 'ended' }    — not supported, would silently work-as-filter
   * // ✅ Use `where` for $ne / $lt / $exists / arbitrary mongo predicates:
   * await repo.claim(id, {
   *   from: 'active',                          // exact-match state
   *   to: 'closed',
   *   where: { closedAt: { $exists: false } }, // additional predicates
   * });
   * ```
   *
   * **Dotted-path `field` is supported** — `field: 'scheduling.status'`
   * for nested state fields works. Mongo's filter and `$set` both
   * honor dotted paths, and the from===to optimization handles them
   * correctly (literal comparison on the path string). Use for
   * domain models that nest the state under a sub-document
   * (`lpn.state`, `package.condition.state`, `scheduling.status`).
   *
   * **`from === to` is allowed — idempotent re-claim.** Yard's
   * `reviseDeparture` writes `departed → departed` to update the
   * row's payload while asserting the row hasn't moved on. The CAS
   * still returns `null` on race-loss (row left the source state),
   * so the safety property holds. Use the same semantic as a "touch
   * with state assertion" primitive.
   *
   * When `from === to` (and `from` is a literal, not an array), the
   * implementation **skips the redundant `$set: { [stateField]: to }`
   * write** — the filter has already pinned the state field to that
   * exact value, so writing it again is a no-op disk operation.
   * Workloads doing high-replay dedup (yard's `gate-event.append`,
   * outbox replay storms, idempotent first-write CAS) save one disk
   * write + one journal flush + one replication-log entry per replay.
   * Three observable behaviours follow:
   *
   *   - With a non-empty patch: only the patch fields land in `$set`;
   *     the redundant state-field key is dropped.
   *   - With an empty patch and `upsert: false`: the call lowers to
   *     a plain `findOne` round-trip — pure assertion, zero writes.
   *     Plugin pipeline (before/after `claim` hooks) still fires
   *     correctly — only the internal driver shape changes.
   *   - With an empty patch and `upsert: true`: the update becomes
   *     `{ $setOnInsert: { [stateField]: to } }` — no-op on match,
   *     populates the inserted row's state field on miss. This is
   *     the "pure dedup" insert-or-confirm path.
   *
   * For pure-dedup recipes (no real state column, just an external
   * id used as both filter and `from`/`to`), see CLAUDE.md — yard's
   * `gate-event.append` is the canonical worked example.
   *
   * **`upsert: true` — insert-or-claim.** Set `options.upsert: true`
   * for the upsert-claim pattern: insert when the row doesn't exist,
   * else CAS-transition the existing row. Yard's `gate-event.append`
   * uses this for idempotent event landing. With `upsert` on, claim
   * NEVER returns null on miss — it inserts. Pair with
   * `$setOnInsert` in the operator patch for insert-only fields.
   * The default (`upsert: false`) keeps the canonical "match
   * exactly, else null" semantic.
   *
   * **Patch shape** — accepts BOTH flat (`{ field: value }`) and Mongo
   * operator (`{ $set, $inc, $unset, $setOnInsert, ... }`) forms.
   * Operator form is load-bearing for versioned docs (`$inc: {
   * version: 1 }`) and upsert-claim (`$setOnInsert: { createdBy }`);
   * flat form is the textbook ergonomic case. Mixing flat keys with
   * `$`-keys throws — Mongo would silently drop the flat keys,
   * which would mask data-loss bugs.
   *
   * Multi-tenant scope, soft-delete filter, cache invalidation, and
   * audit hooks all flow through automatically — `claim` is registered
   * in `OP_REGISTRY` (policyKey: 'query', mutates: true), so plugins
   * that iterate the registry pick it up without changes.
   *
   * **Caller responsibility for tenant context.** When
   * `multiTenantPlugin` is mounted, plugin-injected scoping reads the
   * tenant key from the **options bag** — `claim(id, transition, patch,
   * { organizationId: '...' })`. Without it, the plugin throws
   * `'Missing organizationId'` at runtime. Use
   * `repoOptionsFromCtx(ctx)` (or your own context helper) to forward
   * request-scoped tenant fields; do not assume the plugin reads them
   * from a global.
   *
   * @example Textbook transition (flat patch)
   * ```ts
   * const claimed = await runRepo.claim(runId, { from: 'waiting', to: 'running' }, {
   *   lastHeartbeat: new Date(),
   *   workerId: 'worker-12',
   * });
   * if (!claimed) return; // someone else got it (or no match)
   * ```
   *
   * @example Versioned doc — operator patch with `$inc`
   * ```ts
   * const claimed = await orderRepo.claim(
   *   orderId,
   *   { from: 'pending', to: 'shipped' },
   *   {
   *     $set: { shippedAt: new Date() },
   *     $inc: { version: 1 },
   *   },
   * );
   * ```
   *
   * @example Compound-filter claim (paused guard + retry timer)
   * ```ts
   * const claimed = await runRepo.claim(
   *   runId,
   *   {
   *     from: 'waiting',
   *     to: 'running',
   *     where: {
   *       paused: { $ne: true },
   *       'scheduling.retryAfter': { $lte: new Date() },
   *     },
   *   },
   *   { lastHeartbeat: new Date() },
   *   { organizationId: ctx.orgId }, // tenant fwd — see note above
   * );
   * ```
   *
   * Pairs with `defineStateMachine()` from
   * `@classytic/primitives/state-machine`:
   *   - State machine validates "is from→to legal in the model?"
   *   - `claim()` performs the atomic "did we win?"
   */
  async claim(
    id: string | ObjectId,
    transition: {
      field?: string;
      from: unknown | readonly unknown[];
      to: unknown;
      where?: Record<string, unknown>;
    },
    patch: Record<string, unknown> = {},
    options: SessionOptions & { idField?: string; upsert?: boolean } = {},
  ): Promise<TDoc | null> {
    const stateField = transition.field ?? 'status';
    // `this.idField` is constructor-initialised to `'_id'` (line 197), so
    // a third `?? '_id'` fallback would be dead code. Match the resolution
    // shape `getById` / `update` / `delete` use — same name (`effectiveIdField`),
    // same 2-step cascade — so future refactors can grep one pattern.
    const effectiveIdField = options.idField ?? this.idField;
    // Source-state spec — literal or array. Array compiles to `$in`
    // for multi-source transitions (commission's `voidRecord`,
    // media-kit's error path, every "from any non-terminal" pattern).
    // Without this, multi-source CAS sites had to fall back to raw
    // `findOneAndUpdate` and lose plugin routing.
    const fromSpec = Array.isArray(transition.from) ? { $in: transition.from } : transition.from;
    // Build the CAS filter + update upfront so plugins observing
    // before:claim see the same shape they would for findOneAndUpdate.
    // `where` predicates AND-merge alongside the id + state-field
    // match. Order: `where` first, then id/state — so the canonical
    // CAS keys land last and dominate any duplicate keys callers
    // accidentally include in `where` (defensive — overlapping the
    // state field in `where` would be a wiring bug, but spreading id
    // last means a wiring bug can't silently break the CAS).
    const filter: Record<string, unknown> = {
      ...(transition.where ?? {}),
      [effectiveIdField]: id,
      [stateField]: fromSpec,
    };
    // Patch normalisation — accept BOTH flat (`{ field: value }`) AND
    // operator (`{ $set: ..., $inc: ..., $unset: ... }`) shapes. Operator
    // shape is the load-bearing case for versioned data: claiming with
    // `$inc: { version: 1 }` was the canonical pattern that forced
    // commission/yard back to raw `findOneAndUpdate`. Fields are
    // homogeneous — mixing `$op` keys with flat keys throws (validation
    // hoisted to `assertNoMixedPatchShape` so error stacks point at the
    // rule directly).
    assertNoMixedPatchShape('claim', patch);
    const patchKeys = Object.keys(patch);
    const operatorPatchKeys = patchKeys.filter((k) => k.startsWith('$'));
    // When `from === to`, the state-field write `$set: { [stateField]:
    // to }` is provably redundant — the filter already pinned the
    // field at this exact value. Under high-replay workloads (yard's
    // gate-event.append, outbox dedup, idempotent first-write CAS),
    // skipping the no-op `$set` saves one disk write per replay. Only
    // safe when `from` is a literal (array form would write whatever
    // matched the `$in`, which may differ from `to`).
    const isArrayFrom = Array.isArray(transition.from);
    const isStateNoop = !isArrayFrom && transition.from === transition.to;

    let update: Record<string, unknown>;
    if (operatorPatchKeys.length === 0) {
      // Flat patch — wrap in $set. Canonical state transition lands
      // LAST so it dominates any caller key collision, EXCEPT when
      // from === to (then the state-field write is dropped entirely).
      const patchKeysCount = patchKeys.length;
      if (isStateNoop) {
        update = patchKeysCount === 0 ? {} : { $set: { ...patch } };
      } else {
        update = { $set: { ...patch, [stateField]: transition.to } };
      }
    } else {
      // Operator patch — pass operators through ($inc, $unset, $push,
      // $addToSet, …); merge the state transition into $set so callers
      // don't have to remember to set the target state alongside their
      // counter bumps. Order: callerSet first, then the canonical
      // transition.to — so a caller's $set can't accidentally write
      // the wrong target state. The state-field write is the load-
      // bearing CAS effect; nothing in `patch` may overwrite it.
      //
      // When from === to: same redundant-write skip as the flat path.
      // If callerSet is empty, drop the $set operator entirely (and
      // drop the whole update if no other operators remain).
      const callerSet = (patch.$set as Record<string, unknown> | undefined) ?? {};
      if (isStateNoop) {
        const callerSetKeys = Object.keys(callerSet);
        if (callerSetKeys.length === 0) {
          // No $set needed — strip it from the spread.
          // biome-ignore lint/correctness/noUnusedVariables: destructured to drop $set
          const { $set, ...rest } = patch;
          void $set;
          update = rest;
        } else {
          update = { ...patch, $set: { ...callerSet } };
        }
      } else {
        update = {
          ...patch,
          $set: { ...callerSet, [stateField]: transition.to },
        };
      }
    }
    // Edge case: optimization left an empty update document. Mongo
    // rejects empty updates ("Empty update document"), so:
    //   - With `upsert: true` — substitute a `$setOnInsert` sentinel.
    //     On match: no-op (sentinel only fires on insert). On miss:
    //     inserts a doc with the canonical state value. This is the
    //     yard `gate-event.append` shape — the optimization eliminates
    //     the per-replay disk write at the heart of that pattern.
    //   - With `upsert: false` — leave the update empty; the run-op
    //     branch below falls back to `findOne` for the pure-assertion
    //     read (no write at all).
    if (Object.keys(update).length === 0 && options.upsert) {
      update = { $setOnInsert: { [stateField]: transition.to } };
    }

    const context = await this._buildContext('claim', {
      id,
      query: filter,
      data: update,
      transition,
      ...options,
    });

    return this._runOp('claim', context, async () => {
      const finalQuery = (context.query as Record<string, unknown>) || filter;
      const finalUpdate = (context.data as Record<string, unknown>) || update;

      // Same id-shape guard `getById` / `update` / `delete` apply: a
      // structurally invalid id (e.g. `'bad-id'` against an ObjectId
      // `_id`) is unambiguously a CAS miss — there's no way that id
      // could exist. Short-circuit before mongoose raises CastError so
      // the contract stays "null on miss" instead of throwing on a
      // shape mismatch. Only the default `_id` path runs the check —
      // custom string-typed `idField` accepts any string.
      //
      // Skip the guard when `upsert: true` — an invalid-shape id is
      // still a valid INSERT target if the schema's idField accepts
      // arbitrary input (e.g. business keys / slugs). Leaving the
      // guard on would force `null` returns even when the caller
      // explicitly opted into upsert semantics.
      if (effectiveIdField === '_id' && !options.upsert) {
        const idType = getSchemaIdType(this.Model.schema);
        if (!isValidIdForType(id, idType)) {
          return null;
        }
      }

      // Pure-assertion fast path. When the optimization above left an
      // empty update document AND upsert is false, there's nothing to
      // write — the call is a state assertion ("is the row in source
      // state? if so, return it"). Substitute a plain `findOne` so we
      // don't pay a write round-trip + journal flush + replication
      // log entry for a no-op. Plugin pipeline still sees the call as
      // a `claim` (before/after hooks fire from `_runOp`); only the
      // internal driver call shape changes.
      if (Object.keys(finalUpdate).length === 0) {
        const found = (await this.Model.findOne(finalQuery, null, {
          session: options.session as ClientSession | undefined,
        })) as TDoc | null;
        return found;
      }

      const result = await updateActions.findOneAndUpdate(this.Model, finalQuery, finalUpdate, {
        returnDocument: 'after',
        // `upsert` defaults to false — that's the canonical CAS
        // semantic ("match exactly, else null"). Callers opt in
        // explicitly via `options.upsert` for the upsert-claim
        // pattern (yard's gate-event.append, idempotent first-write
        // CAS in any insert-or-transition flow). With upsert on,
        // this method NEVER returns null on miss — it inserts.
        upsert: options.upsert ?? false,
        session: options.session as ClientSession | undefined,
      });
      return result as TDoc | null;
    });
  }

  /**
   * Optimistic-concurrency CAS via a version stamp.
   *
   * Sibling to `claim()` — distinct mental model:
   *   - `claim()` is a state machine: "move from status A to status B, atomically"
   *   - `claimVersion()` is optimistic locking: "I expect version N; if it
   *     still is, apply this update and increment the version"
   *
   * Builds `findOneAndUpdate({ _id, [versionField]: from, ...where },
   * { ...update, $inc: { [versionField]: by ?? 1 } })` in one
   * round-trip. Returns the post-update doc on success, `null` when:
   *   - the row doesn't exist, OR
   *   - the row's version isn't `from` (someone else committed first —
   *     standard race-loss signal), OR
   *   - any predicate in `transition.where` fails (state guard, tenant
   *     guard expressed inline, etc.)
   *
   * **`from: undefined` is tolerated.** Lean reads return `version:
   * number | undefined` because the field defaults are absent on
   * fresh-from-mongo POJOs. Passing `from: undefined` matches docs
   * whose version field is *missing entirely* — exactly what you want
   * on a first-write CAS. Callers no longer need `?? 0` at every site.
   *
   * The caller's `update` is freeform — pass either a Mongo operator
   * shape (`{ $set: { status: 'submitted', updatedAt: now } }`) or a
   * field-shape object (auto-wrapped in `$set`). The version `$inc` is
   * MERGED into the update, so callers don't have to remember to bump
   * the counter.
   *
   * **Compound CAS via `where`.** State machines that key on both
   * version AND status (yard's `transition()`, every package whose
   * "ready to commit" gate is more than a version stamp) need to
   * AND-merge additional predicates. Pass them via
   * `transition.where` — same shape and semantics as `claim`'s
   * `where` field. Without this, claimVersion was forced back to raw
   * `findOneAndUpdate` for every state-AND-version site.
   *
   * Multi-tenant scope, soft-delete filter, cache invalidation, and
   * audit hooks all fire — `claimVersion` is in `OP_REGISTRY`
   * (policyKey: 'query', mutates: true) so plugins iterate the registry
   * and pick it up automatically.
   *
   * **Caller responsibility for tenant context.** When
   * `multiTenantPlugin` is mounted, the plugin reads the tenant key
   * from the **options bag** (`{ organizationId: '...' }`). Without it,
   * the plugin throws `'Missing organizationId'` at runtime. Use
   * `repoOptionsFromCtx(ctx)` to forward — same as `claim()` and every
   * other repo op.
   *
   * @example Order submission with version check
   * ```ts
   * const submitted = await orderRepo.claimVersion(
   *   orderId,
   *   { from: order.version },
   *   { $set: { status: 'submitted', submittedAt: new Date() } },
   * );
   * if (!submitted) throw new ConcurrentEditError();
   * ```
   *
   * @example Compound CAS — version + status
   * ```ts
   * const transitioned = await yardRepo.claimVersion(
   *   loadId,
   *   {
   *     from: load.version, // number | undefined OK
   *     where: { status: 'queued' },
   *   },
   *   { $set: { status: 'in-progress', startedAt: new Date() } },
   * );
   * if (!transitioned) throw new ConcurrentEditError();
   * ```
   *
   * @example Custom version field name + step
   * ```ts
   * await runRepo.claimVersion(
   *   runId,
   *   { field: 'rev', from: 12, by: 1 },
   *   { lastHeartbeat: new Date() },  // field-shape auto-wraps in $set
   * );
   * ```
   */
  async claimVersion(
    id: string | ObjectId,
    transition: {
      field?: string;
      from: number | undefined;
      by?: number;
      where?: Record<string, unknown>;
    },
    update: Record<string, unknown>,
    options: SessionOptions & { idField?: string } = {},
  ): Promise<TDoc | null> {
    const versionField = transition.field ?? 'version';
    const versionStep = transition.by ?? 1;
    const effectiveIdField = options.idField ?? this.idField;

    // Normalize update — accept Mongo-operator shape ({ $set: ... }) or
    // field-shape ({ status: 'x' }), then merge in the version $inc.
    // Same shape rule the rest of mongokit's CAS surface enforces
    // (validation hoisted to `assertNoMixedPatchShape` so the error
    // stack points at the rule directly).
    assertNoMixedPatchShape('claimVersion', update);
    const operatorKeys = Object.keys(update).filter((k) => k.startsWith('$'));
    const operatorUpdate: Record<string, unknown> =
      operatorKeys.length > 0 ? { ...update } : { $set: { ...update } };
    // Bump the version stamp. Two paths:
    //   - Normal case (`from` is numeric): merge a `$inc` for the
    //     version field on top of any caller-supplied `$inc`.
    //   - First-write case (`from === undefined`): the doc's version
    //     is null OR missing. `$inc` against null throws in mongo
    //     ("Cannot apply $inc to a value of non-numeric type"), so we
    //     initialize via `$set` instead. The CAS filter already
    //     restricts the match to docs whose version is null/missing,
    //     so this is correctness-preserving.
    const callerInc = (operatorUpdate.$inc as Record<string, number> | undefined) ?? {};
    if (transition.from === undefined) {
      // First-write CAS — version is initialized via `$set`. If the
      // caller's update ALSO writes the version field (in $set OR $inc),
      // the implicit init would silently fight the caller's intent.
      // Throw loudly so the conflict surfaces at the call site instead
      // of producing whichever value lands last.
      const callerSet = (operatorUpdate.$set as Record<string, unknown> | undefined) ?? {};
      if (Object.hasOwn(callerSet, versionField)) {
        throw createError(
          400,
          `[claimVersion] first-write CAS (from: undefined) initializes the version field via $set, ` +
            `but the caller's update also writes $set.${versionField}. The implicit init would silently ` +
            `clobber the caller's value. Either remove ${versionField} from your $set, or pass a numeric ` +
            `\`from\` to use the standard $inc path.`,
        );
      }
      if (Object.hasOwn(callerInc, versionField)) {
        throw createError(
          400,
          `[claimVersion] first-write CAS (from: undefined) initializes the version field via $set, ` +
            `which can't coexist with $inc on the same field in one update. Remove ${versionField} from ` +
            `your $inc, or pass a numeric \`from\` to use the standard $inc path.`,
        );
      }
      // Only retain $inc if caller had OTHER fields in it.
      if (Object.keys(callerInc).length > 0) {
        operatorUpdate.$inc = callerInc;
      } else {
        delete operatorUpdate.$inc;
      }
      operatorUpdate.$set = { ...callerSet, [versionField]: versionStep };
    } else {
      operatorUpdate.$inc = { ...callerInc, [versionField]: versionStep };
    }

    // Compound CAS — `where` AND-merges with the canonical id + version
    // keys. Order: `where` first so the canonical CAS keys land last
    // and dominate any duplicate keys (defensive against wiring bugs).
    // Same merge order as `claim`'s where.
    //
    // `from: undefined` → match docs whose version field is missing OR
    // null (mongo's null-equality covers both). Mongoose strips
    // undefined from filters before sending, so an explicit `null`
    // value is required for the first-write CAS to work.
    const versionMatch = transition.from === undefined ? null : transition.from;
    const filter: Record<string, unknown> = {
      ...(transition.where ?? {}),
      [effectiveIdField]: id,
      [versionField]: versionMatch,
    };

    const context = await this._buildContext('claimVersion', {
      id,
      query: filter,
      data: operatorUpdate,
      transition,
      ...options,
    });

    return this._runOp('claimVersion', context, async () => {
      const finalQuery = (context.query as Record<string, unknown>) || filter;
      const finalUpdate = (context.data as Record<string, unknown>) || operatorUpdate;

      // Same id-shape guard as `claim` / `getById` / `update` — invalid
      // shape is unambiguously a CAS miss, not a CastError.
      if (effectiveIdField === '_id') {
        const idType = getSchemaIdType(this.Model.schema);
        if (!isValidIdForType(id, idType)) {
          return null;
        }
      }

      const result = await updateActions.findOneAndUpdate(this.Model, finalQuery, finalUpdate, {
        returnDocument: 'after',
        upsert: false,
        session: options.session as ClientSession | undefined,
      });
      return result as TDoc | null;
    });
  }

  /**
   * Delete a document by ID.
   *
   * By default the behavior is decided by the plugin stack:
   *   - With `softDeletePlugin` wired → soft delete (sets `deletedAt`)
   *   - Without the plugin → physical delete
   *
   * Pass `mode: 'hard'` to force physical deletion regardless of plugins.
   * All policy hooks (multi-tenant scope, audit trails, cache invalidation,
   * cascade) still fire — only the soft-delete interception is skipped. This
   * is the GDPR / admin-cleanup path.
   *
   * @example
   * ```ts
   * // Respects softDeletePlugin — soft if wired
   * await userRepo.delete(userId);
   *
   * // GDPR erasure — physical delete, audit hooks still fire
   * await userRepo.delete(userId, { mode: 'hard', organizationId: 'org_123' });
   * ```
   */
  async delete(
    id: string | ObjectId,
    options: SessionOptions & {
      idField?: string;
      mode?: 'hard' | 'soft';
      /** Legacy opt-in: throw a 404 error on miss instead of returning `null`. */
      throwOnNotFound?: boolean;
    } = {},
  ): Promise<DeleteResult | null> {
    const context = await this._buildContext('delete', {
      id,
      ...options,
      ...(options.mode ? { deleteMode: options.mode } : {}),
    });

    return this._composeMiddleware('delete', context, async () => {
      try {
        if (context.softDeleted) {
          const result: DeleteResult = {
            message: 'Soft deleted successfully',
            id: String(id),
            soft: true,
          };
          await this._emitHook('after:delete', { context, result });
          return result;
        }

        const effectiveIdField = options.idField ?? this.idField;

        // MinimalRepo contract: miss → `null`. Short-circuit invalid-shape
        // ids (e.g. 'no-such-id' on an ObjectId _id) before mongoose raises
        // CastError. Callers who want the legacy throw path opt in via
        // `throwOnNotFound: true`.
        const wantsThrow =
          (context as Record<string, unknown>).throwOnNotFound === true ||
          (options as Record<string, unknown>).throwOnNotFound === true;
        if (effectiveIdField === '_id') {
          const idType = getSchemaIdType(this.Model.schema);
          if (!isValidIdForType(id, idType)) {
            if (wantsThrow) throw createError(404, 'Document not found');
            await this._emitHook('after:delete', { context, result: null });
            return null;
          }
        }

        const deleteQuery =
          effectiveIdField !== '_id'
            ? { [effectiveIdField]: id, ...(context.query || {}) }
            : undefined;

        const result = await this._withResilience(context, () =>
          deleteQuery
            ? deleteActions.deleteByQuery(this.Model as unknown as Model<unknown>, deleteQuery, {
                session: options.session,
              })
            : deleteActions.deleteById(this.Model, id, {
                session: options.session,
                query: context.query,
              }),
        );
        if (!result && wantsThrow) {
          throw createError(404, 'Document not found');
        }
        await this._emitHook('after:delete', { context, result });
        return result;
      } catch (error) {
        await this._emitErrorHook('error:delete', { context, error });
        throw this._handleError(error as Error);
      }
    });
  }

  /**
   * Update every document matching the filter.
   *
   * Promoted from `batchOperationsPlugin` to a class primitive in 3.11.0 so
   * the surface matches sqlitekit's always-available `updateMany`. Consumers
   * who forget to wire `batchOperationsPlugin` no longer get a runtime
   * `TypeError: repo.updateMany is not a function` — the method is always
   * here.
   *
   * Accepts three `update` forms via `UpdateInput`:
   *   - Portable `UpdateSpec` from `@classytic/repo-core/update` (compiled to
   *     `$set`/`$unset`/`$inc`/`$setOnInsert` before hooks run).
   *   - Raw Mongo operator record (`{ $set, $inc, ... }`) — passed through.
   *   - Mongo aggregation pipeline (`[...]`) — requires `updatePipeline: true`
   *     to guard against accidental pipeline updates.
   *
   * Refuses empty filters (defense-in-depth against mass-update accidents)
   * both before and after policy hooks inject tenant scope.
   */
  async updateMany(
    filter: Record<string, unknown>,
    update: UpdateInput,
    options: SessionOptions & {
      updatePipeline?: boolean;
      [key: string]: unknown;
    } = {},
  ): Promise<UpdateManyResult> {
    // Normalize portable Update IR → Mongo operator record before the hook
    // pipeline runs, so policy listeners see the compiled shape.
    const normalizedData: Record<string, unknown> | Record<string, unknown>[] = isUpdateSpec(update)
      ? compileUpdateSpecToMongo(update)
      : (update as Record<string, unknown> | Record<string, unknown>[]);

    const context = await this._buildContext('updateMany', {
      query: filter,
      data: normalizedData,
      ...options,
    });

    return this._runOp('updateMany', context, async () => {
      // Use context.query — policy hooks (multi-tenant) may have injected tenant filters
      const finalQuery = (context.query || filter) as Record<string, unknown>;

      if (!finalQuery || Object.keys(finalQuery).length === 0) {
        throw createError(
          400,
          'updateMany requires a non-empty query filter. Pass an explicit filter to prevent accidental mass updates.',
        );
      }

      if (Array.isArray(normalizedData) && options.updatePipeline !== true) {
        throw createError(
          400,
          'Update pipelines (array updates) are disabled by default; pass `{ updatePipeline: true }` to explicitly allow pipeline-style updates.',
        );
      }

      // Use context.data if hooks modified the update payload, otherwise normalized data
      const finalData = (context.data || normalizedData) as
        | Record<string, unknown>
        | Record<string, unknown>[];

      const result = await this.Model.updateMany(finalQuery, finalData, {
        runValidators: true,
        session: options.session as ClientSession | undefined,
        ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
      }).exec();

      return result as UpdateManyResult;
    });
  }

  /**
   * Delete every document matching the filter.
   *
   * Promoted from `batchOperationsPlugin` to a class primitive in 3.11.0 for
   * the same reason as `updateMany` — sqlitekit parity and no silent "method
   * is undefined" footgun when the batch plugin isn't wired.
   *
   * Behavior mirrors `delete()`: defaults to soft delete when
   * `softDeletePlugin` is wired, physical delete otherwise. Pass
   * `{ mode: 'hard' }` to bypass soft-delete — multi-tenant scoping, audit,
   * and cache hooks still fire.
   *
   * Rejects empty filters up front AND after policy hooks, so a policy-plugin
   * bug that zeroes out the query can't be exploited to wipe a collection.
   */
  async deleteMany(
    filter: Record<string, unknown>,
    options: SessionOptions & {
      mode?: 'hard' | 'soft';
      [key: string]: unknown;
    } = {},
  ): Promise<DeleteManyResult> {
    // Reject empty filters up front (before policy hooks can run and mask
    // a {} that the caller genuinely passed). Post-policy check below
    // still catches any hook that zeroes out the query.
    if (!filter || Object.keys(filter).length === 0) {
      throw createError(
        400,
        'deleteMany requires a non-empty query filter. Pass an explicit filter to prevent accidental mass deletes.',
      );
    }

    const mode = options.mode;

    const context = await this._buildContext('deleteMany', {
      query: filter,
      ...options,
      ...(mode ? { deleteMode: mode } : {}),
    });

    return this._composeMiddleware('deleteMany', context, async () => {
      try {
        if (context.softDeleted) {
          // The plugin's updateMany ran with the filter narrowed to non-deleted
          // rows, so its `modifiedCount` is the count of rows that transitioned
          // to soft-deleted — what `DeleteManyResult.deletedCount` is supposed
          // to report under the cross-kit contract. Default to 0 only when an
          // older plugin variant didn't stamp the count (forward-compat).
          const softCount = (context.softDeletedCount as number | undefined) ?? 0;
          const result: DeleteManyResult = {
            acknowledged: true,
            deletedCount: softCount,
            soft: true,
          };
          await this._emitHook('after:deleteMany', { context, result });
          return result;
        }

        const finalQuery = (context.query || filter) as Record<string, unknown>;

        if (!finalQuery || Object.keys(finalQuery).length === 0) {
          throw createError(
            400,
            'deleteMany requires a non-empty query filter after policy hooks.',
          );
        }

        const result = await this._withResilience(context, () =>
          this.Model.deleteMany(finalQuery, {
            session: options.session as ClientSession | undefined,
          }).exec(),
        );

        await this._emitHook('after:deleteMany', { context, result });
        return result as DeleteManyResult;
      } catch (error) {
        await this._emitErrorHook('error:deleteMany', { context, error });
        throw this._handleError(error as Error) as HttpError;
      }
    });
  }

  /**
   * Compliance-grade cleanup primitive — see `StandardRepo.purgeByField`
   * for the cross-kit contract. Mongokit composes the kit-agnostic
   * `runChunkedPurge` orchestrator (loop, signal, progress, result
   * envelope) with `createMongoPurgePort` (driver-specific id selection
   * + strategy writes). See [actions/purge.ts](./actions/purge.ts) for
   * the port implementation.
   */
  async purgeByField(
    field: string,
    value: unknown,
    strategy: TenantPurgeStrategy,
    options: TenantPurgeOptions = {},
  ): Promise<TenantPurgeResult> {
    const port = createMongoPurgePort<TDoc>(
      this,
      field,
      value,
      options.session as ClientSession | undefined,
    );
    return runChunkedPurge(strategy, options, port);
  }

  /**
   * Chunked cold-storage extraction — see `StandardRepo.archiveByFilter`
   * for the cross-kit contract (write-before-delete, at-least-once,
   * duplicate-tolerant sinks). Mongokit composes the kit-agnostic
   * `runChunkedArchive` orchestrator with `createMongoArchivePort`
   * (`_id`-ordered lean reads + plugin-routed deleteMany removal). See
   * [actions/archive.ts](./actions/archive.ts) for the port.
   *
   * Accepts Filter IR or a Mongo-shaped filter record — compiled once via
   * `compileFilterToMongo`, same dual-dialect rule as every other verb.
   */
  async archiveByFilter(
    filter: Record<string, unknown> | Filter,
    sink: ArchiveSink<TDoc>,
    options: ArchiveOptions & { session?: ClientSession } = {},
  ): Promise<ArchiveResult> {
    const compiled = compileFilterToMongo(filter) as Record<string, unknown>;
    const port = createMongoArchivePort<TDoc>(this, compiled, options.session);
    return runChunkedArchive(options, sink, port);
  }

  /**
   * Kit-native aggregation pipeline — takes a MongoDB stage array and
   * returns the raw pipeline output. Use this for `$lookup`, `$unwind`,
   * `$facet`, `$graphLookup`, and any other mongo-specific power
   * features that don't translate to SQL.
   *
   * For backend-portable aggregations (filter + group + measures +
   * sort + limit) use `aggregate(req: AggRequest)` instead — it
   * compiles the repo-core IR to the equivalent pipeline internally
   * and produces the same row shape sqlitekit emits.
   *
   * Routes through the hook system for policy enforcement
   * (multi-tenant, soft-delete).
   *
   * @param pipeline - MongoDB aggregation stage array
   * @param options  - Aggregation options including governance controls
   */
  async aggregatePipeline<TResult = unknown>(
    pipeline: PipelineStage[],
    options: AggregateOptions = {},
  ): Promise<TResult[]> {
    const context = await this._buildContext('aggregatePipeline', {
      pipeline,
      ...options,
    });

    // Governance: enforce max pipeline stage count
    const maxStages = options.maxPipelineStages;
    if (maxStages && pipeline.length > maxStages) {
      throw createError(
        400,
        `Aggregation pipeline exceeds maximum allowed stages (${pipeline.length} > ${maxStages})`,
      );
    }

    return this._runOp('aggregatePipeline', context, async () => {
      // If policy hooks injected filters, prepend $match to pipeline
      const finalPipeline = [...pipeline];
      if (context.query && Object.keys(context.query).length > 0) {
        finalPipeline.unshift({ $match: context.query } as PipelineStage);
      }

      const aggregation = this.Model.aggregate(finalPipeline);
      if (options.session) aggregation.session(options.session as ClientSession);
      if (options.allowDiskUse) aggregation.allowDiskUse(true);
      if (options.readPreference) aggregation.read(options.readPreference as ReadPreferenceLike);
      if (options.maxTimeMS) aggregation.option({ maxTimeMS: options.maxTimeMS });
      if (options.comment) aggregation.option({ comment: options.comment });
      if (options.readConcern)
        aggregation.option({ readConcern: options.readConcern as ReadConcernLike });
      if (options.collation) aggregation.collation(options.collation as MongoCollationOptions);

      return (await aggregation.exec()) as TResult[];
    });
  }

  /**
   * Paginated kit-native aggregation pipeline. Same mongo-specific
   * scope as `aggregatePipeline` — reach for this when you need
   * `$lookup` / `$unwind` / `$facet` alongside pagination.
   *
   * Prefer `aggregatePaginate(req: AggPaginationRequest)` for
   * cross-backend dashboard code; that method compiles the portable
   * IR to an equivalent pipeline.
   *
   * Policy hooks (multi-tenant, soft-delete) inject context.filters
   * which are prepended as a `$match` stage.
   */
  async aggregatePipelinePaginate(
    options: AggregatePaginationOptions = {},
  ): Promise<AggregatePaginationResult<TDoc>> {
    const context = await this._buildContext('aggregatePipelinePaginate', options);

    // Merge policy-injected filters into pipeline as leading $match
    const pipelineFromContext =
      (context.pipeline as PipelineStage[] | undefined) || options.pipeline || [];
    const finalPipeline = [...pipelineFromContext];
    if (context.filters && Object.keys(context.filters).length > 0) {
      finalPipeline.unshift({ $match: context.filters } as PipelineStage);
    }

    const aggOptions: AggregatePaginationOptions = {
      ...(context as unknown as AggregatePaginationOptions),
      pipeline: finalPipeline,
    };

    return this._runOp('aggregatePipelinePaginate', context, () =>
      this._pagination.aggregatePaginate(aggOptions),
    );
  }

  /**
   * Portable aggregation. Compiles the repo-core `AggRequest` IR to
   * `[{$match}, {$group}, {$addFields}, {$project}, {$match}, {$sort},
   * {$skip}, {$limit}]` against this repo's collection. Output rows
   * carry one key per `groupBy` column plus one key per measure alias
   * — identical shape to sqlitekit's `aggregate(req)`, so dashboards
   * work unchanged across backends.
   *
   * Without `groupBy`: returns a single-row result with just the
   * measures (scalar aggregation). Pass
   * `{ measures: { total: { op: 'sum', field: 'amount' } } }` for a
   * simple summary.
   *
   * For mongo-specific power features (`$lookup`, `$unwind`, `$facet`,
   * `$graphLookup`, window operators) reach for `aggregatePipeline`
   * — that's the kit-native escape hatch.
   *
   * Routes through the hook system for policy enforcement
   * (multi-tenant, soft-delete) — plugins inject their scope into
   * `context.filter`, which is merged into the pre-aggregate `$match`
   * before compilation.
   */
  async aggregate<TRow extends Record<string, unknown> = Record<string, unknown>>(
    req: AggRequest,
    options: RcQueryOptions = {},
  ): Promise<AggResult<TRow>> {
    // Spread `options` into the context so multi-tenant / soft-delete /
    // policy plugins see the same `organizationId` / `bypassTenant` /
    // `user` keys they receive on findAll / getById / count / etc.
    // Without this every-other-read-method-takes-options gap leaves the
    // before:aggregate hook unable to read the tenant id and it throws
    // "Missing 'organizationId' in context" when `multiTenantPlugin({
    // required: true })` is wired. The internal merge layer
    // (`_injectPolicyScopeIntoAgg`) already pulls `context.query` into
    // `req.filter` after plugins write — so once the orgId reaches
    // context, scoping just works.
    const context = await this._buildContext('aggregate', { aggRequest: req, ...options });
    // The unified cache plugin (`@classytic/repo-core/cache`) registered a
    // `before:aggregate` hook in `_buildContext`. On a hit it stamps
    // `_cacheHit` + `_cachedResult` onto the context — short-circuit here
    // so the DB round-trip is skipped. Mirrors the `getById` cache path.
    const cached = this._cachedValue<AggResult<TRow>>(context);
    if (cached !== undefined) {
      await this._emitHook('after:aggregate', { context, result: cached, fromCache: true });
      return cached;
    }
    return this._runOp('aggregate', context, async () => {
      const finalReq = this._injectPolicyScopeIntoAgg(req, context);
      const rows = await aggregateIrActions.executeAgg<TRow>(this.Model, finalReq, {
        session: context.session as ClientSession | undefined,
      });
      return { rows };
    });
  }

  /**
   * Invalidate every aggregate-cache entry tagged with ANY of the
   * given tags. Delegates to the unified cache plugin's handle
   * (`repo.cache.invalidateByTags`) — wired by `cachePlugin({ adapter })`.
   *
   * Pass no tags to wipe the entire cache namespace (requires the
   * adapter to implement `clear`).
   *
   * Returns the count of distinct entries cleared (`-1` when the call
   * routed through `adapter.clear()` and the adapter doesn't report a
   * count). No-op (returns `0`) when no cache plugin is wired.
   */
  async invalidateAggregateCache(tags?: readonly string[]): Promise<number> {
    const handle = (this as unknown as { cache?: RepositoryCacheHandle }).cache;
    if (!handle) return 0;
    if (!tags || tags.length === 0) {
      await handle.clear();
      return -1;
    }
    return handle.invalidateByTags(tags);
  }

  /**
   * Paginated portable aggregation. Two pagination modes, picked by
   * the request shape:
   *
   * - **Offset (default)** — `page` + `limit`. Returns the standard
   *   `{ method: 'offset', data, total, pages, hasNext, hasPrev, ... }`
   *   envelope. `countStrategy: 'none'` skips the second round-trip
   *   that computes `total`; the envelope reports `total: 0`,
   *   `pages: 0`, and derives `hasNext` from a `LIMIT N+1` peek on
   *   the data pipeline.
   * - **Keyset** — `pagination: 'keyset'` (or `after` set). Returns
   *   `{ method: 'keyset', data, hasMore, next, limit }`. `sort` is
   *   required — the cursor encodes the sort-key tuple of the last
   *   row. Each subsequent page passes the previous `next` back as
   *   `after`. Scales to arbitrary group counts because the planner
   *   uses `(sort_keys) > (cursor)` instead of `OFFSET N`.
   */
  async aggregatePaginate<TRow extends Record<string, unknown> = Record<string, unknown>>(
    req: AggPaginationRequest,
    options: RcQueryOptions = {},
  ): Promise<OffsetPaginationResultCore<TRow> | KeysetAggPaginationResult<TRow>> {
    // Same options-bag pass-through as `aggregate()` — see that method's
    // comment for why this is required for tenant-scoped paginated aggs.
    const context = await this._buildContext('aggregatePaginate', { aggRequest: req, ...options });
    const limit = Math.max(1, Math.min(req.limit ?? 20, 1000));
    const session = context.session as ClientSession | undefined;
    const useKeyset = aggregateIrActions.isKeysetMode(req);

    // Unified cache short-circuit — the cache plugin's
    // `before:aggregatePaginate` hook (registered through `_buildContext`)
    // stamps `_cacheHit` on context when the cached envelope is fresh.
    const cachedEnvelope = this._cachedValue<
      OffsetPaginationResultCore<TRow> | KeysetAggPaginationResult<TRow>
    >(context);
    if (cachedEnvelope !== undefined) {
      await this._emitHook('after:aggregatePaginate', {
        context,
        result: cachedEnvelope,
        fromCache: true,
      });
      return cachedEnvelope;
    }

    return this._composeMiddleware('aggregatePaginate', context, async () => {
      try {
        const finalReq = this._injectPolicyScopeIntoAgg(req, context);
        const result = await this._executeAggregatePaginate<TRow>(
          finalReq,
          useKeyset,
          limit,
          session,
        );
        await this._emitHook('after:aggregatePaginate', { context, result });
        return result;
      } catch (error) {
        await this._emitErrorHook('error:aggregatePaginate', { context, error });
        throw this._handleError(error as Error);
      }
    });
  }

  /**
   * Internal: the actual aggregate-paginate execution body. Extracted
   * so `aggregatePaginate` can wrap it in the cache layer without
   * duplicating the keyset / offset branch logic.
   *
   * Receives `finalReq` (already policy-scoped) so the cache key
   * built by the outer wrapper matches the request the executor
   * sees — no cross-tenant cache poisoning.
   */
  private async _executeAggregatePaginate<TRow extends Record<string, unknown>>(
    finalReq: AggPaginationRequest,
    useKeyset: boolean,
    limit: number,
    session: ClientSession | undefined,
  ): Promise<OffsetPaginationResultCore<TRow> | KeysetAggPaginationResult<TRow>> {
    // ── Keyset path ─────────────────────────────────────────────
    if (useKeyset) {
      if (!finalReq.sort || Object.keys(finalReq.sort).length === 0) {
        throw new Error(
          'mongokit/aggregatePaginate: keyset pagination requires `sort` — the cursor anchors on the sort-key tuple',
        );
      }
      const cursor = finalReq.after
        ? aggregateIrActions.decodeAggCursor(finalReq.after)
        : undefined;
      const keysetMatch = cursor
        ? aggregateIrActions.buildKeysetPredicate(finalReq.sort, cursor)
        : undefined;

      // Build base pipeline minus pagination stages, splice the
      // cursor predicate at the post-projection boundary, then add
      // sort + limit (peek limit+1 for hasMore detection).
      const { pipeline, prePaginationIndex } = aggregateIrActions.buildAggPipeline(finalReq);
      const headStages = pipeline.slice(0, prePaginationIndex);
      const tailStages: PipelineStage[] = [];
      if (keysetMatch) tailStages.push(keysetMatch);
      tailStages.push({ $sort: finalReq.sort } as PipelineStage);
      tailStages.push({ $limit: limit + 1 } as PipelineStage);

      const aggregation = this.Model.aggregate([...headStages, ...tailStages]);
      if (session) aggregation.session(session);
      // Forward `executionHints` to the keyset path too — same
      // hint behaviour the offset path gets via `executeAgg` /
      // `countAggGroups`.
      applyExecutionHints(aggregation, finalReq.executionHints);
      const peeked = (await aggregation.exec()) as TRow[];
      const hasMore = peeked.length > limit;
      const data = hasMore ? peeked.slice(0, limit) : peeked;
      const next =
        hasMore && data.length > 0
          ? aggregateIrActions.encodeAggCursor(
              data[data.length - 1] as Record<string, unknown>,
              finalReq.sort,
            )
          : null;

      return { method: 'keyset', data, limit, hasMore, next } as KeysetAggPaginationResult<TRow>;
    }

    // ── Offset path ─────────────────────────────────────────────
    const page = Math.max(1, finalReq.page ?? 1);
    const countStrategy = finalReq.countStrategy ?? 'exact';
    const offset = (page - 1) * limit;

    if (countStrategy === 'none') {
      // Peek one extra row to detect hasNext without running the count.
      const peek = await aggregateIrActions.executeAgg<TRow>(
        this.Model,
        { ...finalReq, limit: limit + 1, offset },
        session ? { session } : {},
      );
      const hasNext = peek.length > limit;
      const data = hasNext ? peek.slice(0, limit) : peek;
      return {
        method: 'offset',
        data,
        page,
        limit,
        total: 0,
        pages: 0,
        hasNext,
        hasPrev: page > 1,
      };
    }

    const [data, total] = await Promise.all([
      aggregateIrActions.executeAgg<TRow>(
        this.Model,
        { ...finalReq, limit, offset },
        session ? { session } : {},
      ),
      aggregateIrActions.countAggGroups(this.Model, finalReq, session ? { session } : {}),
    ]);
    const pages = Math.max(1, Math.ceil(total / limit));
    return {
      method: 'offset',
      data,
      page,
      limit,
      total,
      pages,
      hasNext: page * limit < total,
      hasPrev: page > 1,
    };
  }

  /**
   * Merge policy-hook-injected filters (multi-tenant scope,
   * soft-delete) into the pre-aggregate `filter` slot of the request.
   * Plugins speak mongo-query shape (`context.query` / `context.filters`);
   * the caller's `req.filter` may be either Filter IR or a mongo query.
   *
   * Each part is compiled through `compileFilterToMongo` BEFORE the
   * `$and` merge — otherwise an IR node like `eq('status', 'paid')`
   * (`{ op, field, value }`) gets nested inside `$and` as a literal,
   * `compileFilterToMongo` of the merged value finds no top-level `op`
   * (so `isFilter` is false), and Mongo receives the IR object as a
   * raw query clause that matches no real document. Symptom: aggregates
   * silently return 0 rows whenever a callerpasses IR + a policy
   * plugin is installed.
   */
  private _injectPolicyScopeIntoAgg<T extends AggRequest>(req: T, context: RepositoryContext): T {
    const scopeCandidates: unknown[] = [];
    for (const candidate of [context.filters, context.query]) {
      if (candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0) {
        scopeCandidates.push(candidate);
      }
    }
    if (scopeCandidates.length === 0) return req;

    const parts: Record<string, unknown>[] = [];
    for (const c of scopeCandidates) {
      const compiled = compileFilterToMongo(c);
      if (Object.keys(compiled).length > 0) parts.push(compiled);
    }
    if (req.filter) {
      const compiled = compileFilterToMongo(req.filter);
      if (Object.keys(compiled).length > 0) parts.push(compiled);
    }
    if (parts.length === 0) return req;

    const merged = parts.length === 1 ? parts[0] : { $and: parts };
    return { ...req, filter: merged };
  }

  /**
   * Get distinct values
   * Routes through hook system for policy enforcement (multi-tenant, soft-delete)
   */
  async distinct<T = unknown>(
    field: string,
    query: Record<string, unknown> = {},
    options: ReadOptions = {},
  ): Promise<T[]> {
    const context = await this._buildContext('distinct', {
      query,
      ...options,
    });
    return this._runOp('distinct', context, () => {
      const finalQuery = context.query || query;
      const readPreference = context.readPreference ?? options.readPreference;
      return aggregateActions.distinct<T>(this.Model, field, finalQuery, {
        session: options.session,
        readPreference: readPreference as string | undefined,
      });
    });
  }

  /**
   * Query with custom field lookups ($lookup)
   * Best for: Joins on slugs, SKUs, codes, or other indexed custom fields
   *
   * @example
   * ```typescript
   * // Join employees with departments using slug instead of ObjectId
   * const employees = await employeeRepo.lookupPopulate({
   *   filters: { status: 'active' },
   *   lookups: [
   *     {
   *       from: 'departments',
   *       localField: 'departmentSlug',
   *       foreignField: 'slug',
   *       as: 'department',
   *       single: true
   *     }
   *   ],
   *   sort: '-createdAt',
   *   page: 1,
   *   limit: 50
   * });
   * ```
   */
  async lookupPopulate<TExtra extends Record<string, unknown> = Record<string, unknown>>(
    options: LookupPopulateOptions<TDoc>,
  ): Promise<LookupPopulateResult<TDoc, TExtra>> {
    const context = await this._buildContext('lookupPopulate', options);

    return this._composeMiddleware('lookupPopulate', context, async () => {
      try {
        const MAX_LOOKUPS = 10;
        const lookups = (context.lookups ?? options.lookups) as LookupOptions[];
        if (lookups.length > MAX_LOOKUPS) {
          throw createError(
            400,
            `Too many lookups (${lookups.length}). Maximum is ${MAX_LOOKUPS}.`,
          );
        }

        const filters = context.filters ?? options.filters;
        const sort = context.sort ?? options.sort;
        const limit = context.limit ?? options.limit ?? this._pagination.config.defaultLimit ?? 20;
        const readPref = context.readPreference ?? options.readPreference;
        const session = (context.session ?? options.session) as ClientSession | undefined;
        const collation = (context.collation ?? options.collation) as
          | import('./types.js').CollationOptions
          | undefined;
        const after = context.after ?? options.after;
        const pageFromContext = context.page ?? options.page;
        const isKeyset = !!after || (!pageFromContext && !!sort);
        const countStrategy = context.countStrategy ?? options.countStrategy ?? 'exact';

        // ── Build the select projection (shared by both modes) ──
        const selectSpec = context.select ?? options.select;
        let projection: Record<string, 0 | 1> | undefined;
        if (selectSpec) {
          if (typeof selectSpec === 'string') {
            projection = {};
            for (const field of selectSpec.split(',').map((f) => f.trim())) {
              if (field.startsWith('-')) {
                projection[field.substring(1)] = 0;
              } else {
                projection[field] = 1;
              }
            }
          } else if (Array.isArray(selectSpec)) {
            projection = {};
            for (const field of selectSpec) {
              if (field.startsWith('-')) {
                projection[field.substring(1)] = 0;
              } else {
                projection[field] = 1;
              }
            }
          } else {
            // After string + Array.isArray checks above, selectSpec is the
            // Record form. Array.isArray's predicate (`x is any[]`) does
            // not narrow `readonly string[]` out of the union, so cast.
            projection = { ...(selectSpec as Record<string, 0 | 1>) };
          }
          // Auto-include lookup `as` fields so $project doesn't strip joined data
          if (projection) {
            const isInclusion = Object.values(projection).some((v) => v === 1);
            if (isInclusion) {
              for (const lookup of lookups) {
                const asField = lookup.as || lookup.from;
                if (!(asField in projection)) {
                  projection[asField] = 1;
                }
              }
            }
          }
        }

        // ── Helper: append lookup + coalesce + project stages ──
        const appendLookupStages = (pipeline: PipelineStage[]) => {
          pipeline.push(...LookupBuilder.multiple(lookups));
          for (const lookup of lookups) {
            if (lookup.single) {
              const asField = lookup.as || lookup.from;
              pipeline.push({
                $addFields: { [asField]: { $ifNull: [`$${asField}`, null] } },
              } as PipelineStage);
            }
          }
          const finalProjection = ensureLookupProjectionIncludesCursorFields(
            projection,
            isKeyset && sort ? this._parseSort(sort) : undefined,
          );
          if (finalProjection) {
            pipeline.push({ $project: finalProjection });
          }
        };

        // ═══════════════════════════════════════════════════════
        // KEYSET MODE: no $facet, no $skip — O(1) cursor-based
        // ═══════════════════════════════════════════════════════
        if (isKeyset && sort) {
          const parsedSort = this._parseSort(sort);
          const { validateKeysetSort } = await import('./pagination/utils/sort.js');
          const { encodeCursor, resolveCursorFilter } = await import(
            './pagination/utils/cursor.js'
          );
          const { getPrimaryField } = await import('./pagination/utils/sort.js');

          const normalizedSort = validateKeysetSort(
            parsedSort,
            this._pagination.config.strictKeysetSortFields,
          );
          const cursorVersion = this._pagination.config.cursorVersion ?? 1;
          const minCursorVersion = this._pagination.config.minCursorVersion ?? 1;
          const matchFilters = after
            ? resolveCursorFilter(
                after,
                normalizedSort,
                cursorVersion,
                { ...(filters || {}) },
                minCursorVersion,
              )
            : { ...(filters || {}) };

          // Ensure sort fields are in projection so cursor encoding has the values
          if (projection) {
            const isInclusion = Object.values(projection).some((v) => v === 1);
            if (isInclusion) {
              for (const sortField of Object.keys(normalizedSort)) {
                if (!(sortField in projection)) {
                  projection[sortField] = 1;
                }
              }
            }
          }

          // Build pipeline: match → sort → limit+1 → lookup → project
          const pipeline: PipelineStage[] = [];
          if (Object.keys(matchFilters).length > 0) {
            pipeline.push({ $match: matchFilters });
          }
          pipeline.push({ $sort: normalizedSort });
          pipeline.push({ $limit: limit + 1 });
          appendLookupStages(pipeline);

          const aggregation = this.Model.aggregate(pipeline).session(session || null);
          if (collation) aggregation.collation(collation);
          if (readPref) aggregation.read(readPref as ReadPreferenceLike);
          const data = (await aggregation) as (TDoc & Record<string, unknown>)[];

          const hasMore = data.length > limit;
          if (hasMore) data.pop();

          const primaryField = getPrimaryField(normalizedSort);
          const nextCursor =
            hasMore && data.length > 0
              ? encodeCursor(data[data.length - 1], primaryField, normalizedSort, cursorVersion)
              : null;

          // Standard keyset envelope — same shape `getAll({ sort, after })`
          // returns, so callers narrow on `result.method === 'keyset'` and
          // share the same handling whether the rows came from a plain
          // read or a join.
          const result: LookupPopulateResult<TDoc, TExtra> = {
            method: 'keyset',
            data: data as unknown as LookupRow<TDoc, TExtra>[],
            limit,
            hasMore,
            next: nextCursor,
          };
          await this._emitHook('after:lookupPopulate', { context, result });
          return result;
        }

        // ═══════════════════════════════════════════════════════
        // OFFSET MODE: $facet or sequential for count + data
        // ═══════════════════════════════════════════════════════
        const page = pageFromContext ?? 1;
        const skip = (page - 1) * limit;

        if (skip > 10000) {
          warn(
            `[mongokit] Large offset (${skip}) in lookupPopulate. ` +
              `Consider using keyset pagination: getAll({ sort, after, limit, lookups })`,
          );
        }

        // Data pipeline
        const dataPipeline: PipelineStage[] = [];
        if (filters && Object.keys(filters).length > 0) {
          dataPipeline.push({ $match: filters });
        }
        if (sort) {
          dataPipeline.push({ $sort: this._parseSort(sort) });
        }

        if (countStrategy === 'none') {
          // No count — fetch limit+1 for hasNext detection
          dataPipeline.push({ $skip: skip }, { $limit: limit + 1 });
          appendLookupStages(dataPipeline);

          const aggregation = this.Model.aggregate(dataPipeline).session(session || null);
          if (collation) aggregation.collation(collation);
          if (readPref) aggregation.read(readPref as ReadPreferenceLike);
          const data = (await aggregation) as TDoc[];

          const hasNext = data.length > limit;
          if (hasNext) data.pop();

          // Standard offset envelope with `countStrategy: 'none'`: total
          // and pages are 0, hasNext comes from the limit+1 peek. Same
          // shape `getAll({ page, limit, countStrategy: 'none' })` returns.
          const result: LookupPopulateResult<TDoc, TExtra> = {
            method: 'offset',
            data: data as unknown as LookupRow<TDoc, TExtra>[],
            page,
            limit,
            total: 0,
            pages: 0,
            hasNext,
            hasPrev: page > 1,
          };
          await this._emitHook('after:lookupPopulate', { context, result });
          return result;
        }

        // Default: use $facet for parallel count + data
        dataPipeline.push({ $skip: skip }, { $limit: limit });
        appendLookupStages(dataPipeline);

        const countPipeline: PipelineStage[] = [];
        if (filters && Object.keys(filters).length > 0) {
          countPipeline.push({ $match: filters });
        }
        countPipeline.push({ $count: 'total' });

        const pipeline: PipelineStage[] = [
          {
            $facet: {
              metadata: countPipeline,
              data: dataPipeline,
            },
          } as PipelineStage,
        ];

        const aggregation = this.Model.aggregate(pipeline).session(session || null);
        if (collation) aggregation.collation(collation);
        if (readPref) aggregation.read(readPref as ReadPreferenceLike);
        const results = await aggregation;

        const facetResult = results[0] || { metadata: [], data: [] };
        const total = facetResult.metadata[0]?.total || 0;
        const data = (facetResult.data || []) as TDoc[];
        const pages = Math.max(1, Math.ceil(total / limit));

        // Standard offset envelope — same shape `getAll({ page, limit })`
        // returns. Cross-kit `lookupPopulate` consumers get an identical
        // result regardless of backend.
        const result: LookupPopulateResult<TDoc, TExtra> = {
          method: 'offset',
          data: data as unknown as LookupRow<TDoc, TExtra>[],
          page,
          limit,
          total,
          pages,
          hasNext: page * limit < total,
          hasPrev: page > 1,
        };
        await this._emitHook('after:lookupPopulate', { context, result });
        return result;
      } catch (error) {
        await this._emitErrorHook('error:lookupPopulate', { context, error });
        throw this._handleError(error as Error);
      }
    });
  }

  /**
   * Create an aggregation builder for this model
   * Useful for building complex custom aggregations
   *
   * @example
   * ```typescript
   * const pipeline = repo.buildAggregation()
   *   .match({ status: 'active' })
   *   .lookup('departments', 'deptSlug', 'slug', 'department', true)
   *   .group({ _id: '$department', count: { $sum: 1 } })
   *   .sort({ count: -1 })
   *   .build();
   *
   * const results = await repo.Model.aggregate(pipeline);
   * ```
   */
  buildAggregation(): AggregationBuilder {
    return new AggregationBuilder();
  }

  /**
   * Create a lookup builder
   * Useful for building $lookup stages independently
   *
   * @example
   * ```typescript
   * const lookupStages = repo.buildLookup('departments')
   *   .localField('deptSlug')
   *   .foreignField('slug')
   *   .as('department')
   *   .single()
   *   .build();
   *
   * const pipeline = [
   *   { $match: { status: 'active' } },
   *   ...lookupStages
   * ];
   * ```
   */
  buildLookup(from?: string): LookupBuilder {
    return new LookupBuilder(from);
  }

  /**
   * Execute callback within a MongoDB transaction with automatic retry on
   * transient failures.
   *
   * **BREAKING (3.10):** the callback now receives a **tx-bound repository**,
   * not a raw `ClientSession`. This matches repo-core's `StandardRepo.withTransaction`
   * contract that every kit (sqlitekit, pgkit, prismakit) already implements
   * — so cross-kit plugins and apps are portable. Session threading happens
   * transparently: every CRUD call on `txRepo` auto-injects the session into
   * its options bag, including plugin-added methods (`upsert`, `increment`,
   * `updateMany`, `restore`, ...). Nested `txRepo.withTransaction(...)` throws.
   *
   * For raw-session cross-repo workflows — multiple repositories coordinating
   * writes — use the standalone `withTransaction(connection, fn)` export
   * from `@classytic/mongokit`. That helper remains session-based by design.
   *
   * @param callback - Receives a tx-bound `Repository<TDoc>` — call its
   *                   methods directly, no need to pass `{ session }` manually
   * @param options.allowFallback - Run without transaction on standalone MongoDB (default: false)
   * @param options.onFallback - Called when falling back to non-transactional execution
   * @param options.transactionOptions - MongoDB driver transaction options (readConcern, writeConcern, etc.)
   *
   * @example
   * ```typescript
   * const order = await repo.withTransaction(async (txRepo) => {
   *   const created = await txRepo.create({ total: 100 });
   *   await txRepo.update(created._id, { confirmed: true });
   *   return created;
   * });
   *
   * // With fallback for standalone/dev environments
   * await repo.withTransaction(
   *   async (txRepo) => {
   *     await txRepo.create(doc);
   *   },
   *   {
   *     allowFallback: true,
   *     onFallback: (err) => logger.warn('Running without transaction', err),
   *   },
   * );
   *
   * // Cross-repo with explicit session:
   * import { withTransaction } from '@classytic/mongokit';
   * await withTransaction(mongoose.connection, async (session) => {
   *   const order = await orderRepo.create(data, { session });
   *   await inventoryRepo.decrement(..., { session });
   * });
   * ```
   */
  async withTransaction<T>(
    callback: (txRepo: this) => Promise<T>,
    options: WithTransactionOptions = {},
  ): Promise<T> {
    return withTransactionHelper(
      this.Model.db as unknown as { startSession(): Promise<ClientSession> },
      async (session) => {
        const txRepo = createTxBoundRepo(this, session) as this;
        return callback(txRepo);
      },
      options,
    );
  }

  /**
   * Execute custom query with event emission
   */
  async _executeQuery<T>(buildQuery: (Model: Model<TDoc>) => Promise<T>): Promise<T> {
    const operation = buildQuery.name || 'custom';
    const context = await this._buildContext(operation, {});
    return this._runOp(operation, context, () => buildQuery(this.Model));
  }

  /**
   * Build operation context and run before-hooks (sorted by priority).
   *
   * Narrows `RepositoryBase._buildContext`'s return type to mongokit's
   * richer `RepositoryContext` (which carries `softDeleted`, `_cacheHit`,
   * populate / readPreference / session, etc.). Runtime is inherited from
   * the base class — this override is purely a type-narrowing shim.
   *
   * Hook execution order is deterministic:
   * 1. POLICY (100) — tenant isolation, soft-delete filtering, validation
   * 2. CACHE  (200) — cache lookup (after policy filters are injected)
   * 3. OBSERVABILITY (300) — audit logging, metrics
   * 4. DEFAULT (500) — user-registered hooks
   */
  override async _buildContext(
    operation: string,
    options: Record<string, unknown> | object,
  ): Promise<RepositoryContext> {
    // Abort guard at the op boundary (repo-core 0.6.0 `QueryOptions.signal`
    // contract): a pre-aborted request is rejected BEFORE before-hooks run
    // and before any driver round-trip. Every operation — class methods AND
    // plugin-contributed ones (restore, getDeleted, lease, ...) — funnels
    // through this override, so the check covers the whole surface once.
    throwIfAborted((options as { signal?: AbortSignal }).signal);

    // Coerce repo-core Filter IR nodes into MongoDB query objects at the
    // boundary. App code that imports `eq`, `and`, `in_` etc. from
    // `@classytic/repo-core/filter` and passes them as `query` / `filters` /
    // `having` lands them here as objects with a discriminating `op` field;
    // `compileFilterToMongo` recognizes the IR shape and translates,
    // otherwise it passes the input through (already-Mongo queries are
    // unchanged). Doing this once in `_buildContext` covers every CRUD
    // method without per-method coercion drift.
    const normalized = this._normalizeFilterSlots(options as Record<string, unknown>);
    const base = await super._buildContext(operation, normalized);
    return base as RepositoryContext;
  }

  /**
   * Walk the well-known filter-carrying keys (`query`, `filters`,
   * `having`) and route any Filter IR through `compileFilterToMongo`.
   * Plain Mongo queries pass through untouched — `isFilter` is the
   * discriminator. Returns a shallow clone; never mutates input.
   */
  private _normalizeFilterSlots(options: Record<string, unknown>): Record<string, unknown> {
    let cloned: Record<string, unknown> | null = null;
    for (const key of ['query', 'filters', 'having'] as const) {
      const value = options[key];
      if (value === undefined || value === null) continue;
      if (!isFilter(value)) continue;
      cloned ??= { ...options };
      cloned[key] = compileFilterToMongo(value);
    }
    return cloned ?? options;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getAll helpers — single-responsibility methods extracted from the
  // 280-line getAll orchestrator. Each is independently understandable and
  // overridable by subclasses.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the effective sort for getAll. Handles $near conflict detection
   * (warns + drops explicit sort when $near is in filters).
   */
  private _resolveSort(
    context: RepositoryContext,
    params: Record<string, unknown>,
    isNearQuery: boolean,
  ): SortSpec | string | undefined {
    const explicitSort = (context.sort ?? params.sort) as SortSpec | string | undefined;
    if (isNearQuery) {
      if (explicitSort !== undefined) {
        warn(
          `[mongokit] Repository "${this.model}" dropping explicit sort (${JSON.stringify(
            explicitSort,
          )}) because the filter contains $near / $nearSphere. MongoDB forbids explicit sort with $near. Use [withinRadius] instead of [near] if you need a custom sort.`,
        );
      }
      return undefined;
    }
    return explicitSort ?? '-createdAt';
  }

  /**
   * Detect whether to use keyset (cursor) or offset (page) pagination.
   */
  private _detectPaginationMode(
    mode: 'offset' | 'keyset' | undefined,
    page: number | undefined,
    after: string | undefined,
    sort: SortSpec | string | undefined,
    context: RepositoryContext,
    params: Record<string, unknown>,
  ): boolean {
    if (mode) return mode === 'keyset';
    return !page && !!(after || (sort !== '-createdAt' && (context.sort ?? params.sort)));
  }

  /**
   * Build the MongoDB query filter with search merged in. Handles text
   * search ($text), regex search ($or of $regex), and the search-resolver
   * plugin contract (search already cleared by a before:getAll hook).
   */
  private _buildSearchQuery(
    filters: Record<string, unknown>,
    search: string | undefined,
  ): Record<string, unknown> {
    const query: Record<string, unknown> = { ...filters };
    if (!search) return query;

    if (this._hasTextIndex === null) {
      this._hasTextIndex = this.Model.schema
        .indexes()
        .some(
          (idx: unknown[]) =>
            idx[0] && Object.values(idx[0] as Record<string, unknown>).includes('text'),
        );
    }

    let effectiveMode: 'text' | 'regex' = this.searchMode === 'regex' ? 'regex' : 'text';
    if (this.searchMode === 'auto') {
      effectiveMode = this._hasTextIndex ? 'text' : 'regex';
    }

    if (effectiveMode === 'regex') {
      if (!this.searchFields || this.searchFields.length === 0) {
        throw createError(
          400,
          `Repository "${this.model}" configured with searchMode: '${this.searchMode}' but no searchFields provided.`,
        );
      }
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const orConds = this.searchFields.map((field) => ({
        [field]: { $regex: escaped, $options: 'i' },
      }));
      if (Array.isArray(query.$or)) {
        const existingOr = query.$or as Record<string, unknown>[];
        delete query.$or;
        const existingAnd = Array.isArray(query.$and)
          ? (query.$and as Record<string, unknown>[])
          : [];
        query.$and = [...existingAnd, { $or: existingOr }, { $or: orConds }];
      } else {
        query.$or = orConds;
      }
    } else if (this._hasTextIndex) {
      query.$text = { $search: search };
    } else {
      const modelName = String(this.model);
      throw createError(
        400,
        `No text index found for ${modelName}. Cannot perform text search. ` +
          `Configure ${modelName}'s Repository with { searchMode: 'regex', searchFields: [...] } ` +
          `to enable index-free search, or create a text index on the collection for searchMode: 'text'. ` +
          `See https://github.com/classytic/mongokit/blob/main/docs/README.md#queryparser-url--filter`,
        {
          code: 'SEARCH_NOT_CONFIGURED',
          meta: {
            model: modelName,
            configuredMode: this.searchMode,
            availableModes: ['text', 'regex', 'auto'],
            data: 'https://github.com/classytic/mongokit/blob/main/docs/README.md#queryparser-url--filter',
          },
        },
      );
    }

    return query;
  }

  /**
   * Parse sort string or object
   */
  _parseSort(sort: SortSpec | string | undefined): SortSpec {
    if (!sort) return { createdAt: -1 };
    if (typeof sort === 'object') {
      if (Object.keys(sort).length === 0) return { createdAt: -1 };
      return sort;
    }

    const sortObj: SortSpec = {};
    const fields = sort.split(',').map((s) => s.trim());
    for (const field of fields) {
      if (field.startsWith('-')) {
        sortObj[field.substring(1)] = -1;
      } else {
        sortObj[field] = 1;
      }
    }
    return sortObj;
  }

  /**
   * Parse populate specification
   */
  _parsePopulate(populate: PopulateSpec | undefined): string[] | PopulateOptions[] {
    if (!populate) return [];
    if (typeof populate === 'string') return populate.split(',').map((p) => p.trim());
    if (Array.isArray(populate))
      return populate.map((p) => (typeof p === 'string' ? p.trim() : p)) as
        | string[]
        | PopulateOptions[];
    return [populate];
  }

  /**
   * Classify a driver error as an authoritative duplicate-key conflict.
   *
   * Used by arc's outbox / idempotency adapters to distinguish
   * "write already landed (idempotent no-op)" from "transient DB error
   * (must retry)". Every backend signals duplicate keys differently —
   * MongoDB `code: 11000`, Prisma `P2002`, Postgres `23505` — so this
   * predicate lives on the kit that knows its driver. Cross-driver
   * adapters then depend only on the boolean outcome, not the shape of
   * the underlying error.
   *
   * Deliberately narrow: matches ONLY `code === 11000` and
   * `codeName === 'DuplicateKey'`. Does NOT match
   * `err.name === 'MongoServerError'`, which is also true for
   * WriteConflict, NotWritablePrimary, ExceededTimeLimit, and every
   * other server-side error — treating those as duplicate keys would
   * silently swallow transactional retries.
   *
   * @example
   * try {
   *   await outboxRepo.create(event);
   * } catch (err) {
   *   if (outboxRepo.isDuplicateKeyError(err)) {
   *     // Idempotent no-op — event was already written by a prior attempt.
   *     return;
   *   }
   *   throw err; // transient DB error — upstream retries
   * }
   */
  isDuplicateKeyError(err: unknown): boolean {
    return isDuplicateKeyErrorUtil(err);
  }

  /**
   * Handle errors with proper HTTP status codes.
   *
   * **Transactional retry signal preservation.** MongoDB driver errors
   * carry `errorLabels` (e.g. `'TransientTransactionError'`,
   * `'UnknownTransactionCommitResult'`) that `mongoose.Connection.
   * withTransaction()` reads via `error.hasErrorLabel(label)` to decide
   * whether to auto-retry the transaction. Wrapping such an error in a
   * fresh `Error` via `createError(...)` strips both the labels and the
   * `hasErrorLabel` method — the retry signal vanishes and concurrent
   * writers see WriteConflicts surface to userland instead of being
   * retried by the driver. To keep the standard MongoDB transaction-
   * retry mechanism intact, we re-throw any error that carries
   * `errorLabels` exactly as we received it. The caller still sees a
   * thrown error — only the wrapping layer is skipped.
   */
  _handleError(error: Error): HttpError {
    // Preserve transactional retry labels — must run BEFORE any wrap.
    // `session.withTransaction` only retries when the thrown error
    // carries `'TransientTransactionError'` or
    // `'UnknownTransactionCommitResult'` on `errorLabels`, read via
    // `hasErrorLabel(label)` (a method on the MongoServerError /
    // MongoNetworkError prototype, present on EVERY driver error —
    // including E11000 dupes — so its mere existence isn't enough).
    // Only short-circuit when an actual retry label is set; otherwise
    // fall through to normal wrap so E11000 → 409, validation → 400,
    // etc. continue to work as documented.
    const labels = (error as { errorLabels?: unknown }).errorLabels;
    const hasLabel = (error as { hasErrorLabel?: (l: string) => boolean }).hasErrorLabel;
    const carriesRetryLabel =
      (Array.isArray(labels) &&
        (labels.includes('TransientTransactionError') ||
          labels.includes('UnknownTransactionCommitResult'))) ||
      (typeof hasLabel === 'function' &&
        (hasLabel.call(error, 'TransientTransactionError') ||
          hasLabel.call(error, 'UnknownTransactionCommitResult')));
    if (carriesRetryLabel) {
      return error as unknown as HttpError;
    }
    // Mongoose validation error → 400
    if (error instanceof mongoose.Error.ValidationError) {
      const messages = Object.values(error.errors).map((err) => (err as Error).message);
      return createError(400, `Validation Error: ${messages.join(', ')}`);
    }
    // Mongoose cast error (invalid ObjectId, etc.) → 400
    if (error instanceof mongoose.Error.CastError) {
      return createError(400, `Invalid ${error.path}: ${error.value}`);
    }
    // MongoDB E11000 duplicate key → 409
    const duplicateErr = parseDuplicateKeyError(error);
    if (duplicateErr) return duplicateErr;
    // Already an HttpError (from createError or plugins)
    if ((error as HttpError).status && error.message) return error as HttpError;
    return createError(500, error.message || 'Internal Server Error');
  }
}

export default Repository;
