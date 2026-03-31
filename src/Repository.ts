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
import type {
  AggregatePaginationOptions,
  AggregatePaginationResult,
  DeleteResult,
  HookMode,
  HttpError,
  KeysetPaginationResult,
  ObjectId,
  OffsetPaginationResult,
  PaginationConfig,
  Plugin,
  PluginType,
  PopulateSpec,
  ReadPreferenceType,
  RepositoryContext,
  RepositoryOptions,
  SelectSpec,
  SortSpec,
  UpdateOptions,
  WithTransactionOptions,
} from './types.js';
import { createError, parseDuplicateKeyError } from './utils/error.js';
import { warn } from './utils/logger.js';

type HookListener = (data: any) => void | Promise<void>;

/** Hook with priority for phase ordering */
interface PrioritizedHook {
  listener: HookListener;
  priority: number;
}

/**
 * Plugin phase priorities (lower = runs first)
 * Policy hooks (multi-tenant, soft-delete, validation) MUST run before cache
 * to ensure filters are injected before cache keys are computed.
 */
export const HOOK_PRIORITY = {
  /** Policy enforcement: tenant isolation, soft-delete filtering, validation */
  POLICY: 100,
  /** Caching: lookup/store after policy filters are applied */
  CACHE: 200,
  /** Observability: audit logging, metrics, telemetry */
  OBSERVABILITY: 300,
  /** Default priority for user-registered hooks */
  DEFAULT: 500,
} as const;

/**
 * Production-grade repository for MongoDB
 * Event-driven, plugin-based, with smart pagination
 */
export class Repository<TDoc = any> {
  public readonly Model: Model<TDoc>;
  public readonly model: string;
  public readonly _hooks: Map<string, PrioritizedHook[]>;
  public readonly _pagination: PaginationEngine<TDoc>;
  private readonly _hookMode: HookMode;
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
    this.Model = Model as Model<TDoc>;
    this.model = Model.modelName;
    this._hooks = new Map();
    this._pagination = new PaginationEngine(Model, paginationConfig);
    this._hookMode = options.hooks ?? 'async';
    plugins.forEach((plugin) => {
      this.use(plugin);
    });
  }

  /**
   * Register a plugin
   */
  use(plugin: PluginType): this {
    if (typeof plugin === 'function') {
      plugin(this);
    } else if (plugin && typeof (plugin as Plugin).apply === 'function') {
      (plugin as Plugin).apply(this);
    }
    return this;
  }

  /**
   * Register event listener with optional priority for phase ordering.
   *
   * @param event - Event name (e.g. 'before:getAll')
   * @param listener - Hook function
   * @param options - Optional { priority } — use HOOK_PRIORITY constants.
   *                  Lower priority numbers run first.
   *                  Default: HOOK_PRIORITY.DEFAULT (500)
   */
  on(event: string, listener: HookListener, options?: { priority?: number }): this {
    if (!this._hooks.has(event)) {
      this._hooks.set(event, []);
    }
    const hooks = this._hooks.get(event)!;
    const priority = options?.priority ?? HOOK_PRIORITY.DEFAULT;
    hooks.push({ listener, priority });
    // Keep sorted by priority (stable — equal priorities keep registration order)
    hooks.sort((a, b) => a.priority - b.priority);
    return this;
  }

  /**
   * Remove a specific event listener
   */
  off(event: string, listener: HookListener): this {
    const hooks = this._hooks.get(event);
    if (hooks) {
      const idx = hooks.findIndex((h) => h.listener === listener);
      if (idx !== -1) hooks.splice(idx, 1);
    }
    return this;
  }

  /**
   * Remove all listeners for an event, or all listeners entirely
   */
  removeAllListeners(event?: string): this {
    if (event) {
      this._hooks.delete(event);
    } else {
      this._hooks.clear();
    }
    return this;
  }

  /**
   * Emit event (sync - for backwards compatibility)
   */
  emit(event: string, data: unknown): void {
    const hooks = this._hooks.get(event) || [];
    for (const { listener } of hooks) {
      try {
        const result = listener(data);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          void (result as Promise<unknown>).catch((error: unknown) => {
            if (event === 'error:hook') return;
            const err = error instanceof Error ? error : new Error(String(error));
            this.emit('error:hook', { event, error: err });
          });
        }
      } catch (error) {
        if (event === 'error:hook') continue;
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit('error:hook', { event, error: err });
      }
    }
  }

  /**
   * Emit event and await all async handlers (sorted by priority)
   */
  async emitAsync(event: string, data: unknown): Promise<void> {
    const hooks = this._hooks.get(event) || [];
    for (const { listener } of hooks) {
      await listener(data);
    }
  }

  private async _emitHook(event: string, data: unknown): Promise<void> {
    if (this._hookMode === 'async') {
      await this.emitAsync(event, data);
      return;
    }
    this.emit(event, data);
  }

  private async _emitErrorHook(event: string, data: unknown): Promise<void> {
    try {
      await this._emitHook(event, data);
    } catch (hookError) {
      // Error hooks should never block or override the original error flow,
      // but we log the failure so silent telemetry/tracking bugs are debuggable.
      warn(
        `[${this.model}] Error hook '${event}' threw: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
      );
    }
  }

  /**
   * Create single document
   */
  async create(
    data: Record<string, unknown>,
    options: { session?: ClientSession } = {},
  ): Promise<TDoc> {
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
    options: { session?: ClientSession; ordered?: boolean } = {},
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
  async getById(
    id: string | ObjectId,
    options: {
      select?: SelectSpec;
      populate?: PopulateSpec;
      populateOptions?: PopulateOptions[];
      lean?: boolean;
      session?: ClientSession;
      throwOnNotFound?: boolean;
      skipCache?: boolean;
      cacheTtl?: number;
      readPreference?: ReadPreferenceType;
    } = {},
  ): Promise<TDoc | null> {
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
    options: {
      select?: SelectSpec;
      populate?: PopulateSpec;
      populateOptions?: PopulateOptions[];
      lean?: boolean;
      session?: ClientSession;
      throwOnNotFound?: boolean;
      skipCache?: boolean;
      cacheTtl?: number;
      readPreference?: ReadPreferenceType;
    } = {},
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
      /** Lookup configurations for $lookup joins (from QueryParser or manual) */
      lookups?: LookupOptions[];
    } = {},
    options: {
      select?: SelectSpec;
      populate?: PopulateSpec;
      populateOptions?: PopulateOptions[];
      lean?: boolean;
      session?: ClientSession;
      skipCache?: boolean;
      cacheTtl?: number;
      readPreference?: ReadPreferenceType;
    } = {},
  ): Promise<OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc>> {
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

    // Resolve all query params from context (plugin-modifiable) with params as fallback.
    // This ensures plugins can override any query parameter via before:getAll hooks,
    // and cache keys (computed from context) match the actual query behavior.
    const filters = context.filters ?? params.filters ?? {};
    const search = context.search ?? params.search;
    const sort = context.sort ?? params.sort ?? '-createdAt';
    const limit =
      context.limit ??
      params.limit ??
      params.pagination?.limit ??
      this._pagination.config.defaultLimit;
    const page = context.page ?? params.pagination?.page ?? params.page;
    const after = context.after ?? params.cursor ?? params.after;
    const mode = context.mode ?? params.mode;

    // Pagination mode explicit check or auto-detect if not explicitly provided
    let useKeyset = false;
    if (mode) {
      useKeyset = mode === 'keyset';
    } else {
      useKeyset = !page && !!(after || (sort !== '-createdAt' && (context.sort ?? params.sort)));
    }

    // Build query with search support
    const query: Record<string, unknown> = { ...filters };
    if (search) {
      if (this._hasTextIndex === null) {
        // Cache the result of checking for a text index
        this._hasTextIndex = this.Model.schema
          .indexes()
          .some((idx: any) => idx[0] && Object.values(idx[0]).includes('text'));
      }

      if (this._hasTextIndex) {
        query.$text = { $search: search };
      } else {
        throw createError(
          400,
          `No text index found for ${this.model}. Cannot perform text search.`,
        );
      }
    }

    // Common options
    // Prioritize populateOptions (from QueryParser advanced format) over populate (simple string)
    const populateSpec =
      options.populateOptions || params.populateOptions || context.populate || options.populate;
    const paginationOptions = {
      filters: query,
      sort: this._parseSort(sort),
      limit,
      populate: this._parsePopulate(populateSpec),
      select: context.select || options.select,
      lean: context.lean ?? options.lean ?? true,
      session: options.session,
      hint: context.hint ?? params.hint,
      maxTimeMS: context.maxTimeMS ?? params.maxTimeMS,
      readPreference: context.readPreference ?? options.readPreference ?? params.readPreference,
    };

    // Auto-route to lookupPopulate when lookups are present (from QueryParser or manual)
    const lookups = params.lookups;
    if (lookups && lookups.length > 0) {
      try {
        const lookupResult = await this.lookupPopulate({
          filters: query,
          lookups,
          sort: paginationOptions.sort as SortSpec | string,
          page: page || 1,
          limit,
          select: paginationOptions.select,
          session: options.session,
          readPreference: paginationOptions.readPreference,
        });
        const totalPages = Math.ceil((lookupResult.total ?? 0) / (lookupResult.limit ?? limit));
        const currentPage = lookupResult.page ?? 1;
        const result: OffsetPaginationResult<TDoc> = {
          method: 'offset',
          docs: lookupResult.data,
          page: currentPage,
          limit: lookupResult.limit ?? limit,
          total: lookupResult.total ?? 0,
          pages: totalPages,
          hasNext: currentPage < totalPages,
          hasPrev: currentPage > 1,
        };
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
        // Keyset pagination (cursor-based)
        result = await this._pagination.stream({
          ...paginationOptions,
          sort: paginationOptions.sort,
          after,
        });
      } else {
        // Offset pagination (page-based) - default
        result = await this._pagination.paginate({
          ...paginationOptions,
          page: page || 1,
          countStrategy: context.countStrategy ?? params.countStrategy,
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
    options: { session?: ClientSession } = {},
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
  async count(
    query: Record<string, unknown> = {},
    options: {
      session?: ClientSession;
      readPreference?: ReadPreferenceType;
    } = {},
  ): Promise<number> {
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
    options: {
      session?: ClientSession;
      readPreference?: ReadPreferenceType;
    } = {},
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
      const result = await updateActions.update(this.Model, id, context.data || data, context);
      await this._emitHook('after:update', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:update', { context, error });
      throw this._handleError(error as Error);
    }
  }

  /**
   * Delete document by ID
   */
  async delete(
    id: string | ObjectId,
    options: { session?: ClientSession } = {},
  ): Promise<DeleteResult> {
    const context = await this._buildContext('delete', { id, ...options });

    try {
      // Check if soft delete was performed by plugin
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

      const result = await deleteActions.deleteById(this.Model, id, {
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
    options: {
      session?: ClientSession;
      allowDiskUse?: boolean;
      comment?: string;
      readPreference?: ReadPreferenceType;
      maxTimeMS?: number;
      readConcern?: { level: string };
      collation?: Record<string, unknown>;
      maxPipelineStages?: number;
    } = {},
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
      if (options.readPreference) aggregation.read(options.readPreference as any);
      if (options.maxTimeMS) aggregation.option({ maxTimeMS: options.maxTimeMS });
      if (options.comment) aggregation.option({ comment: options.comment });
      if (options.readConcern) aggregation.option({ readConcern: options.readConcern as any });
      if (options.collation) aggregation.collation(options.collation as any);

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
    const context = await this._buildContext(
      'aggregatePaginate',
      options as unknown as Record<string, unknown>,
    );

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
    options: {
      session?: ClientSession;
      readPreference?: ReadPreferenceType;
    } = {},
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
  async lookupPopulate(options: {
    filters?: Record<string, unknown>;
    lookups: LookupOptions[];
    sort?: SortSpec | string;
    page?: number;
    limit?: number;
    select?: SelectSpec;
    session?: ClientSession;
    readPreference?: ReadPreferenceType;
  }): Promise<{ data: TDoc[]; total?: number; page?: number; limit?: number }> {
    const context = await this._buildContext('lookupPopulate', options);

    try {
      // Use context values (plugin-modifiable) with fallback to options
      const filters = context.filters ?? options.filters;
      const sort = context.sort ?? options.sort;
      const page = context.page ?? options.page ?? 1;
      const limit = context.limit ?? options.limit ?? this._pagination.config.defaultLimit ?? 20;
      const skip = (page - 1) * limit;
      const readPref = context.readPreference ?? options.readPreference;

      // MongoDB $facet results must be <16MB - warn for large offsets or limits
      const SAFE_LIMIT = 1000;
      const SAFE_MAX_OFFSET = 10000;

      if (limit > SAFE_LIMIT) {
        warn(
          `[mongokit] Large limit (${limit}) in lookupPopulate. $facet results must be <16MB. ` +
            `Consider using smaller limits or stream-based pagination for large datasets.`,
        );
      }

      if (skip > SAFE_MAX_OFFSET) {
        warn(
          `[mongokit] Large offset (${skip}) in lookupPopulate. $facet with high offsets can exceed 16MB. ` +
            `For deep pagination, consider using keyset/cursor-based pagination instead.`,
        );
      }

      // ── Count pipeline: count BEFORE lookups to get correct total ──
      // Bug fix: Previously $count ran after $lookup+$unwind inside $facet,
      // causing inflated totals when $unwind duplicated rows.
      const countPipeline: PipelineStage[] = [];
      if (filters && Object.keys(filters).length > 0) {
        countPipeline.push({ $match: filters });
      }
      countPipeline.push({ $count: 'total' });

      // ── Data pipeline: match → sort → skip/limit → lookup → project ──
      // Lookups run AFTER pagination for correct counts and better performance
      const dataPipeline: PipelineStage[] = [];
      if (filters && Object.keys(filters).length > 0) {
        dataPipeline.push({ $match: filters });
      }
      if (sort) {
        dataPipeline.push({ $sort: this._parseSort(sort) });
      }
      dataPipeline.push({ $skip: skip }, { $limit: limit });

      // Add lookups after pagination (join only the page's documents)
      const lookupStages = LookupBuilder.multiple(options.lookups);
      dataPipeline.push(...lookupStages);

      // Bug fix #2: Coalesce undefined → null for single lookups with no match
      // $unwind with preserveNullAndEmptyArrays produces missing field, not null
      for (const lookup of options.lookups) {
        if (lookup.single) {
          const asField = lookup.as || lookup.from;
          dataPipeline.push({
            $addFields: { [asField]: { $ifNull: [`$${asField}`, null] } },
          } as PipelineStage);
        }
      }

      // Add projection if select is provided
      const selectSpec = context.select ?? options.select;
      if (selectSpec) {
        let projection: Record<string, 0 | 1>;
        if (typeof selectSpec === 'string') {
          projection = {};
          const fields = selectSpec.split(',').map((f) => f.trim());
          for (const field of fields) {
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
        // Bug fix #3: Auto-include lookup `as` fields so $project doesn't strip joined data
        const isInclusion = Object.values(projection).some((v) => v === 1);
        if (isInclusion) {
          for (const lookup of options.lookups) {
            const asField = lookup.as || lookup.from;
            if (!(asField in projection)) {
              projection[asField] = 1;
            }
          }
        }
        dataPipeline.push({ $project: projection });
      }

      // Use $facet to run count and data pipelines in parallel
      const pipeline: PipelineStage[] = [
        {
          $facet: {
            metadata: countPipeline,
            data: dataPipeline,
          },
        } as PipelineStage,
      ];

      // Execute aggregation
      const aggregation = this.Model.aggregate(pipeline).session(options.session || null);
      if (readPref) aggregation.read(readPref as any);
      const results = await aggregation;

      const result = results[0] || { metadata: [], data: [] };
      const total = result.metadata[0]?.total || 0;
      const data = result.data || [];

      await this._emitHook('after:lookupPopulate', { context, result: data });

      return {
        data: data as TDoc[],
        total,
        page,
        limit,
      };
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
   * Execute callback within a transaction with automatic retry on transient failures.
   *
   * Uses the MongoDB driver's `session.withTransaction()` which automatically retries
   * on `TransientTransactionError` and `UnknownTransactionCommitResult`.
   *
   * The callback always receives a `ClientSession`. When `allowFallback` is true
   * and the MongoDB deployment doesn't support transactions (e.g., standalone),
   * the callback runs without a transaction on the same session.
   *
   * @param callback - Receives a `ClientSession` to pass to repository operations
   * @param options.allowFallback - Run without transaction on standalone MongoDB (default: false)
   * @param options.onFallback - Called when falling back to non-transactional execution
   * @param options.transactionOptions - MongoDB driver transaction options (readConcern, writeConcern, etc.)
   *
   * @example
   * ```typescript
   * const result = await repo.withTransaction(async (session) => {
   *   const order = await repo.create({ total: 100 }, { session });
   *   await paymentRepo.create({ orderId: order._id }, { session });
   *   return order;
   * });
   *
   * // With fallback for standalone/dev environments
   * await repo.withTransaction(callback, {
   *   allowFallback: true,
   *   onFallback: (err) => logger.warn('Running without transaction', err),
   * });
   * ```
   */
  async withTransaction<T>(
    callback: (session: ClientSession) => Promise<T>,
    options: WithTransactionOptions = {},
  ): Promise<T> {
    const session = await this.Model.db.startSession();
    try {
      const result = await session.withTransaction(
        () => callback(session),
        options.transactionOptions,
      );
      return result;
    } catch (error) {
      const err = error as Error;
      if (options.allowFallback && this._isTransactionUnsupported(err)) {
        options.onFallback?.(err);
        return await callback(session);
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  private _isTransactionUnsupported(error: Error): boolean {
    // Check MongoDB error codes first (more reliable than string matching)
    const code = (error as Error & { code?: number }).code;
    // 263: standalone server doesn't support transactions
    // 20: transaction not supported on this topology
    if (code === 263 || code === 20) return true;

    // Fallback to message matching for edge cases
    const message = (error.message || '').toLowerCase();
    return (
      message.includes('transaction numbers are only allowed on a replica set member') ||
      message.includes('transaction is not supported')
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
   * Build operation context and run before hooks (sorted by priority).
   *
   * Hook execution order is deterministic:
   * 1. POLICY (100) — tenant isolation, soft-delete filtering, validation
   * 2. CACHE  (200) — cache lookup (after policy filters are injected)
   * 3. OBSERVABILITY (300) — audit logging, metrics
   * 4. DEFAULT (500) — user-registered hooks
   */
  async _buildContext(
    operation: string,
    options: Record<string, unknown>,
  ): Promise<RepositoryContext> {
    const context: RepositoryContext = {
      operation,
      model: this.model,
      ...options,
    };
    const event = `before:${operation}`;
    const hooks = this._hooks.get(event) || [];

    // Hooks are already sorted by priority (maintained in on())
    for (const { listener } of hooks) {
      await listener(context);
    }

    return context;
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
