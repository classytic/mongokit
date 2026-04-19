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

import { HOOK_PRIORITY as RC_HOOK_PRIORITY } from '@classytic/repo-core/hooks';
import {
  type PluginType as RcPluginType,
  RepositoryBase,
  validatePluginOrder,
} from '@classytic/repo-core/repository';
import type {
  CollationOptions as MongoCollationOptions,
  ReadConcernLike,
  ReadPreferenceLike,
} from 'mongodb';
import type { ClientSession, Model, PipelineStage, PopulateOptions } from 'mongoose';
import mongoose from 'mongoose';
import * as aggregateActions from './actions/aggregate.js';
import * as createActions from './actions/create.js';
import * as deleteActions from './actions/delete.js';
import * as readActions from './actions/read.js';
import * as updateActions from './actions/update.js';
import { PaginationEngine } from './pagination/PaginationEngine.js';
import { AggregationBuilder } from './query/AggregationBuilder.js';
import { LookupBuilder, type LookupOptions } from './query/LookupBuilder.js';
import { hasNearOperator, rewriteNearForCount } from './query/primitives/geo.js';
import { withTransaction as withTransactionHelper } from './transaction.js';
import { createTxBoundRepo } from './tx-bound.js';
import type {
  AggregateOptions,
  AggregatePaginationOptions,
  AggregatePaginationResult,
  CacheableOptions,
  CreateOptions,
  DeleteResult,
  FindOneAndUpdateOptions,
  HttpError,
  KeysetPaginationResult,
  LookupPopulateOptions,
  LookupPopulateResult,
  ObjectId,
  OffsetPaginationResult,
  OperationOptions,
  PaginationConfig,
  PluginType,
  PopulateSpec,
  PrioritizedHook,
  ReadOptions,
  ReadPreferenceType,
  RepositoryContext,
  RepositoryOptions,
  SessionOptions,
  SortSpec,
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
   * Create single document
   */
  async create(data: Record<string, unknown>, options: CreateOptions = {}): Promise<TDoc> {
    const context = await this._buildContext('create', { data, ...options });

    try {
      const result = await createActions.create(this.Model, context.data || data, options);
      await this._emitHook('after:create', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:create', { context, error });
      throw this._handleError(error as Error);
    }
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

    try {
      const result = await createActions.createMany(
        this.Model,
        context.dataArray || dataArray,
        options,
      );
      await this._emitHook('after:createMany', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:createMany', { context, error });
      throw this._handleError(error as Error);
    }
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
        const result = await readActions.getByQuery(
          this.Model,
          { [effectiveIdField]: id, ...(context.query || {}) },
          context,
        );
        await this._emitHook('after:getById', { context, result });
        return result;
      }

      // Validate id format before querying — avoids a DB round-trip for
      // structurally invalid ids. Uses the id-resolution primitive to detect
      // the schema's _id type (ObjectId / String / Number / UUID) so UUID
      // and custom-ID schemas aren't rejected by an ObjectId-only check.
      const idType = getSchemaIdType(this.Model.schema);
      if (!isValidIdForType(id, idType)) {
        if (context.throwOnNotFound === false || options.throwOnNotFound === false) {
          return null;
        }
        throw createError(404, 'Document not found');
      }

      const result = await readActions.getById(this.Model, id, context);
      await this._emitHook('after:getById', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:getById', { context, error });
      throw this._handleError(error as Error);
    }
  }

  /**
   * Get single document by query
   */
  async getByQuery(
    query: Record<string, unknown>,
    options: CacheableOptions = {},
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
    try {
      const result = await readActions.getByQuery(this.Model, finalQuery, context);
      await this._emitHook('after:getByQuery', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:getByQuery', { context, error });
      throw this._handleError(error as Error);
    }
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
    options: CacheableOptions = {},
  ): Promise<TDoc | null> {
    const populateSpec = options.populateOptions || options.populate;
    const context = await this._buildContext('getOne', {
      query,
      ...options,
      populate: populateSpec,
    });

    if ((context as Record<string, unknown>)._cacheHit) {
      const cachedResult = (context as Record<string, unknown>)._cachedResult as TDoc | null;
      await this._emitHook('after:getOne', { context, result: cachedResult, fromCache: true });
      return cachedResult;
    }

    const finalQuery = context.query || query;
    try {
      const result = await readActions.getByQuery(this.Model, finalQuery, context);
      await this._emitHook('after:getOne', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:getOne', { context, error });
      throw this._handleError(error as Error);
    }
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
    options: OperationOptions & { sort?: SortSpec | string } = {},
  ): Promise<TDoc[]> {
    // findAll's first arg is a filter (same shape as update/findOneAndUpdate/getOne).
    // We expose it on the context as `query` so plugins use the single, dominant
    // convention: `context.query` for any op whose primary input is a filter.
    // List-shaped ops with a paginated `{ filters, page, limit, ... }` options
    // bag (getAll, aggregatePaginate, lookupPopulate) keep `context.filters`.
    const context = await this._buildContext('findAll', { query: filters, ...options });
    const resolvedFilters = (context.query as Record<string, unknown> | undefined) ?? filters;

    try {
      const query = this.Model.find(resolvedFilters);
      const sortSpec = context.sort || options.sort;
      if (sortSpec) query.sort(this._parseSort(sortSpec));
      const selectSpec = context.select || options.select;
      if (selectSpec) query.select(selectSpec);
      if (options.populate || context.populate)
        query.populate(this._parsePopulate(context.populate || options.populate));
      if (context.lean ?? options.lean ?? true) query.lean();
      if (options.session) query.session(options.session);
      if (options.readPreference) query.read(options.readPreference);

      const result = (await query.exec()) as TDoc[];
      await this._emitHook('after:findAll', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:findAll', { context, error });
      throw this._handleError(error as Error);
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

    // Check if cache plugin returned a cached result
    if ((context as Record<string, unknown>)._cacheHit) {
      const cachedResult = (context as Record<string, unknown>)._cachedResult as
        | OffsetPaginationResult<TDoc>
        | KeysetPaginationResult<TDoc>;
      await this._emitHook('after:getAll', { context, result: cachedResult, fromCache: true });
      return cachedResult;
    }

    // noPagination: true → delegate to findAll() for raw array.
    // getAll's plugin contract is context.filters; findAll's is context.query
    // (its first arg is a filter, not a paginated bag). Pass the resolved
    // value down as findAll's positional filter — findAll re-runs its own
    // before:findAll hooks and rebuilds context.query from there.
    if (params.noPagination) {
      return this.findAll(context.filters ?? params.filters ?? {}, {
        ...options,
        sort: context.sort ?? params.sort,
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
      try {
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

        let result: OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc>;
        if (lookupResult.next !== undefined) {
          // Keyset mode result
          result = {
            method: 'keyset',
            docs: lookupResult.data,
            limit: lookupResult.limit ?? limit,
            hasMore: lookupResult.hasMore ?? false,
            next: lookupResult.next ?? null,
          };
        } else {
          // Offset mode result
          const total = lookupResult.total ?? 0;
          const resultLimit = lookupResult.limit ?? limit;
          const totalPages = Math.ceil(total / resultLimit);
          const currentPage = lookupResult.page ?? 1;
          // When countStrategy='none', total=0 so totalPages=0.
          // Use hasMore from lookupPopulate if available (limit+1 detection).
          const hasNext =
            lookupResult.hasMore !== undefined ? lookupResult.hasMore : currentPage < totalPages;
          result = {
            method: 'offset',
            docs: lookupResult.data,
            page: currentPage,
            limit: resultLimit,
            total,
            pages: totalPages,
            hasNext,
            hasPrev: currentPage > 1,
          };
        }
        await this._emitHook('after:getAll', { context, result });
        return result;
      } catch (error) {
        await this._emitErrorHook('error:getAll', { context, error });
        throw this._handleError(error as Error);
      }
    }

    try {
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

      await this._emitHook('after:getAll', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:getAll', { context, error });
      throw this._handleError(error as Error);
    }
  }

  /**
   * Get or create document
   * Routes through hook system for policy enforcement (multi-tenant, soft-delete)
   */
  async getOrCreate(
    query: Record<string, unknown>,
    createData: Record<string, unknown>,
    options: SessionOptions = {},
  ): Promise<TDoc | null> {
    const context = await this._buildContext('getOrCreate', {
      query,
      data: createData,
      ...options,
    });
    try {
      const finalQuery = context.query || query;
      const finalData = context.data || createData;
      const result = await readActions.getOrCreate(this.Model, finalQuery, finalData, options);
      await this._emitHook('after:getOrCreate', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:getOrCreate', { context, error });
      throw this._handleError(error as Error);
    }
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
    try {
      const finalQuery = context.query || query;
      const result = await readActions.count(this.Model, finalQuery, options);
      await this._emitHook('after:count', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:count', { context, error });
      throw this._handleError(error as Error);
    }
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
    try {
      const finalQuery = context.query || query;
      const result = await readActions.exists(this.Model, finalQuery, options);
      await this._emitHook('after:exists', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:exists', { context, error });
      throw this._handleError(error as Error);
    }
  }

  /**
   * Update document by ID
   */
  async update(
    id: string | ObjectId,
    data: Record<string, unknown>,
    options: UpdateOptions = {},
  ): Promise<TDoc> {
    const context = await this._buildContext('update', {
      id,
      data,
      ...options,
    });

    try {
      let result: TDoc;
      const effectiveIdField = options.idField ?? this.idField;
      if (effectiveIdField !== '_id') {
        // Custom idField: use updateByQuery with the custom field
        const updated = await updateActions.updateByQuery(
          this.Model,
          { [effectiveIdField]: id, ...(context.query || {}) },
          context.data || data,
          context,
        );
        if (!updated) throw createError(404, 'Document not found');
        result = updated;
      } else {
        result = await updateActions.update(this.Model, id, context.data || data, context);
      }
      await this._emitHook('after:update', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:update', { context, error });
      throw this._handleError(error as Error);
    }
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
    update: Record<string, unknown> | Record<string, unknown>[],
    options: FindOneAndUpdateOptions = {},
  ): Promise<TResult | null> {
    const context = await this._buildContext('findOneAndUpdate', {
      query: filter,
      data: update,
      ...options,
    });

    try {
      const finalQuery = (context.query as Record<string, unknown>) || filter;
      const finalUpdate =
        (context.data as Record<string, unknown> | Record<string, unknown>[]) || update;

      const result = await updateActions.findOneAndUpdate(this.Model, finalQuery, finalUpdate, {
        ...options,
        sort: options.sort,
        returnDocument: options.returnDocument ?? 'after',
        upsert: options.upsert ?? false,
        session: options.session,
      });

      await this._emitHook('after:findOneAndUpdate', { context, result });
      return result as TResult | null;
    } catch (error) {
      await this._emitErrorHook('error:findOneAndUpdate', { context, error });
      throw this._handleError(error as Error);
    }
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
    options: SessionOptions & { idField?: string; mode?: 'hard' | 'soft' } = {},
  ): Promise<DeleteResult> {
    const context = await this._buildContext('delete', {
      id,
      ...options,
      ...(options.mode ? { deleteMode: options.mode } : {}),
    });

    try {
      // softDeletePlugin set this from its before:delete hook when the mode
      // allowed it. For `mode: 'hard'` the plugin short-circuited and this
      // flag is never set, so we fall through to the physical delete path.
      if (context.softDeleted) {
        const result: DeleteResult = {
          success: true,
          message: 'Soft deleted successfully',
          id: String(id),
          soft: true,
        };
        await this._emitHook('after:delete', { context, result });
        return result;
      }

      const effectiveIdField = options.idField ?? this.idField;
      const deleteQuery =
        effectiveIdField !== '_id'
          ? { [effectiveIdField]: id, ...(context.query || {}) }
          : undefined;

      const result = deleteQuery
        ? await deleteActions.deleteByQuery(this.Model as unknown as Model<unknown>, deleteQuery, {
            session: options.session,
          })
        : await deleteActions.deleteById(this.Model, id, {
            session: options.session,
            query: context.query,
          });
      await this._emitHook('after:delete', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:delete', { context, error });
      throw this._handleError(error as Error);
    }
  }

  /**
   * Execute aggregation pipeline
   * Routes through hook system for policy enforcement (multi-tenant, soft-delete)
   *
   * @param pipeline - Aggregation pipeline stages
   * @param options - Aggregation options including governance controls
   */
  async aggregate<TResult = unknown>(
    pipeline: PipelineStage[],
    options: AggregateOptions = {},
  ): Promise<TResult[]> {
    const context = await this._buildContext('aggregate', {
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

    try {
      // If policy hooks injected filters, prepend $match to pipeline
      const finalPipeline = [...pipeline];
      if (context.query && Object.keys(context.query).length > 0) {
        finalPipeline.unshift({ $match: context.query } as PipelineStage);
      }

      const aggregation = this.Model.aggregate(finalPipeline);
      if (options.session) aggregation.session(options.session);
      if (options.allowDiskUse) aggregation.allowDiskUse(true);
      if (options.readPreference) aggregation.read(options.readPreference as ReadPreferenceLike);
      if (options.maxTimeMS) aggregation.option({ maxTimeMS: options.maxTimeMS });
      if (options.comment) aggregation.option({ comment: options.comment });
      if (options.readConcern)
        aggregation.option({ readConcern: options.readConcern as ReadConcernLike });
      if (options.collation) aggregation.collation(options.collation as MongoCollationOptions);

      const result = (await aggregation.exec()) as TResult[];
      await this._emitHook('after:aggregate', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:aggregate', { context, error });
      throw this._handleError(error as Error);
    }
  }

  /**
   * Aggregate pipeline with pagination
   * Best for: Complex queries, grouping, joins
   *
   * Policy hooks (multi-tenant, soft-delete) inject context.filters which are
   * prepended as a $match stage to the pipeline, ensuring tenant isolation.
   */
  async aggregatePaginate(
    options: AggregatePaginationOptions = {},
  ): Promise<AggregatePaginationResult<TDoc>> {
    const context = await this._buildContext('aggregatePaginate', options);

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

    try {
      const result = await this._pagination.aggregatePaginate(aggOptions);
      await this._emitHook('after:aggregatePaginate', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:aggregatePaginate', { context, error });
      throw this._handleError(error as Error);
    }
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
    try {
      const finalQuery = context.query || query;
      const readPreference = context.readPreference ?? options.readPreference;
      const result = await aggregateActions.distinct<T>(this.Model, field, finalQuery, {
        session: options.session,
        readPreference: readPreference as string | undefined,
      });
      await this._emitHook('after:distinct', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:distinct', { context, error });
      throw this._handleError(error as Error);
    }
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
  async lookupPopulate(options: LookupPopulateOptions): Promise<LookupPopulateResult<TDoc>> {
    const context = await this._buildContext('lookupPopulate', options);

    try {
      // Guard: cap max lookups to prevent unbounded pipeline growth
      const MAX_LOOKUPS = 10;
      const lookups = (context.lookups ?? options.lookups) as LookupOptions[];
      if (lookups.length > MAX_LOOKUPS) {
        throw createError(400, `Too many lookups (${lookups.length}). Maximum is ${MAX_LOOKUPS}.`);
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
          projection = { ...selectSpec };
        }
        // Auto-include lookup `as` fields so $project doesn't strip joined data
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
        const { encodeCursor, resolveCursorFilter } = await import('./pagination/utils/cursor.js');
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
        const docs = (await aggregation) as (TDoc & Record<string, unknown>)[];

        const hasMore = docs.length > limit;
        if (hasMore) docs.pop();

        const primaryField = getPrimaryField(normalizedSort);
        const nextCursor =
          hasMore && docs.length > 0
            ? encodeCursor(docs[docs.length - 1], primaryField, normalizedSort, cursorVersion)
            : null;

        await this._emitHook('after:lookupPopulate', { context, result: docs });

        return { data: docs as TDoc[], total: 0, limit, next: nextCursor, hasMore };
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
        const docs = (await aggregation) as TDoc[];

        const hasNext = docs.length > limit;
        if (hasNext) docs.pop();

        await this._emitHook('after:lookupPopulate', { context, result: docs });
        return { data: docs, total: 0, page, limit, hasMore: hasNext };
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

      const result = results[0] || { metadata: [], data: [] };
      const total = result.metadata[0]?.total || 0;
      const data = result.data || [];

      await this._emitHook('after:lookupPopulate', { context, result: data });

      return { data: data as TDoc[], total, page, limit };
    } catch (error) {
      await this._emitErrorHook('error:lookupPopulate', { context, error });
      throw this._handleError(error as Error);
    }
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

    try {
      const result = await buildQuery(this.Model);
      await this._emitHook(`after:${operation}`, { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook(`error:${operation}`, { context, error });
      throw this._handleError(error as Error);
    }
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
    const base = await super._buildContext(operation, options as Record<string, unknown>);
    return base as RepositoryContext;
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
      throw createError(
        400,
        `No text index found for ${this.model}. Cannot perform text search. ` +
          `Configure Repository with searchMode: 'regex' (and searchFields) or 'auto' to enable index-free search.`,
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
   * Handle errors with proper HTTP status codes
   */
  _handleError(error: Error): HttpError {
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
