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

import mongoose from 'mongoose';
import type { Model, ClientSession, PipelineStage, PopulateOptions } from 'mongoose';
import { createError } from './utils/error.js';
import * as createActions from './actions/create.js';
import * as readActions from './actions/read.js';
import * as updateActions from './actions/update.js';
import * as deleteActions from './actions/delete.js';
import * as aggregateActions from './actions/aggregate.js';
import { PaginationEngine } from './pagination/PaginationEngine.js';
import { LookupBuilder, type LookupOptions } from './query/LookupBuilder.js';
import { AggregationBuilder } from './query/AggregationBuilder.js';
import type {
  PaginationConfig,
  PluginType,
  Plugin,
  RepositoryContext,
  OffsetPaginationResult,
  KeysetPaginationResult,
  AggregatePaginationResult,
  SortSpec,
  PopulateSpec,
  SelectSpec,
  AnyDocument,
  HttpError,
  UpdateOptions,
  HookMode,
  RepositoryOptions,
  ObjectId,
  WithTransactionOptions,
} from './types.js';

type HookListener = (data: any) => void | Promise<void>;

/**
 * Production-grade repository for MongoDB
 * Event-driven, plugin-based, with smart pagination
 */
export class Repository<TDoc = AnyDocument> {
  public readonly Model: Model<TDoc>;
  public readonly model: string;
  public readonly _hooks: Map<string, HookListener[]>;
  public readonly _pagination: PaginationEngine<TDoc>;
  private readonly _hookMode: HookMode;
  [key: string]: unknown;

  constructor(
    // Accept Mongoose models with methods/statics/virtuals: Model<TDoc, QueryHelpers, Methods, Virtuals>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Model: Model<TDoc, any, any, any>,
    plugins: PluginType[] = [],
    paginationConfig: PaginationConfig = {},
    options: RepositoryOptions = {}
  ) {
    this.Model = Model as Model<TDoc>;
    this.model = Model.modelName;
    this._hooks = new Map();
    this._pagination = new PaginationEngine(Model, paginationConfig);
    this._hookMode = options.hooks ?? 'async';
    plugins.forEach(plugin => this.use(plugin));
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
   * Register event listener
   */
  on(event: string, listener: HookListener): this {
    if (!this._hooks.has(event)) {
      this._hooks.set(event, []);
    }
    this._hooks.get(event)!.push(listener);
    return this;
  }

  /**
   * Emit event (sync - for backwards compatibility)
   */
  emit(event: string, data: unknown): void {
    const listeners = this._hooks.get(event) || [];
    for (const listener of listeners) {
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
   * Emit event and await all async handlers
   */
  async emitAsync(event: string, data: unknown): Promise<void> {
    const listeners = this._hooks.get(event) || [];
    for (const listener of listeners) {
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
    } catch {
      // Error hooks should never block or override the original error flow.
    }
  }

  /**
   * Create single document
   */
  async create(data: Record<string, unknown>, options: { session?: ClientSession } = {}): Promise<TDoc> {
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
    options: { session?: ClientSession; ordered?: boolean } = {}
  ): Promise<TDoc[]> {
    const context = await this._buildContext('createMany', { dataArray, ...options });

    try {
      const result = await createActions.createMany(this.Model, context.dataArray || dataArray, options);
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
    options: { select?: SelectSpec; populate?: PopulateSpec; lean?: boolean; session?: ClientSession; throwOnNotFound?: boolean; skipCache?: boolean; cacheTtl?: number } = {}
  ): Promise<TDoc | null> {
    const context = await this._buildContext('getById', { id, ...options });
    
    // Check if cache plugin returned a cached result
    if ((context as Record<string, unknown>)._cacheHit) {
      return (context as Record<string, unknown>)._cachedResult as TDoc | null;
    }
    
    const result = await readActions.getById(this.Model, id, context);
    await this._emitHook('after:getById', { context, result });
    return result;
  }

  /**
   * Get single document by query
   */
  async getByQuery(
    query: Record<string, unknown>,
    options: { select?: SelectSpec; populate?: PopulateSpec; lean?: boolean; session?: ClientSession; throwOnNotFound?: boolean; skipCache?: boolean; cacheTtl?: number } = {}
  ): Promise<TDoc | null> {
    const context = await this._buildContext('getByQuery', { query, ...options });
    
    // Check if cache plugin returned a cached result
    if ((context as Record<string, unknown>)._cacheHit) {
      return (context as Record<string, unknown>)._cachedResult as TDoc | null;
    }
    
    const result = await readActions.getByQuery(this.Model, query, context);
    await this._emitHook('after:getByQuery', { context, result });
    return result;
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
    } = {},
    options: { select?: SelectSpec; populate?: PopulateSpec; lean?: boolean; session?: ClientSession; skipCache?: boolean; cacheTtl?: number } = {}
  ): Promise<OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc>> {
    const context = await this._buildContext('getAll', { ...params, ...options });

    // Check if cache plugin returned a cached result
    if ((context as Record<string, unknown>)._cacheHit) {
      return (context as Record<string, unknown>)._cachedResult as OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc>;
    }

    // Auto-detect pagination mode
    // Per README: sort without page → keyset mode (for infinite scroll)
    // page parameter → offset mode (for page-based navigation)
    // after/cursor parameter → keyset mode (for cursor-based navigation)
    const hasPageParam = params.page !== undefined || params.pagination;
    const hasCursorParam = 'cursor' in params || 'after' in params;
    const hasSortParam = params.sort !== undefined;

    // Use keyset pagination when:
    // 1. Cursor/after is provided (continuation of keyset pagination), OR
    // 2. Sort is provided without page (first page of keyset pagination)
    const useKeyset = !hasPageParam && (hasCursorParam || hasSortParam);

    // Extract common params - use context to allow plugins to modify filters
    const filters = (context as Record<string, unknown>).filters as Record<string, unknown> || params.filters || {};
    const search = params.search;
    const sort = params.sort || '-createdAt';
    const limit = params.limit || params.pagination?.limit || this._pagination.config.defaultLimit;

    // Build query with search support
    let query: Record<string, unknown> = { ...filters };
    if (search) query.$text = { $search: search };

    // Common options
    const paginationOptions = {
      filters: query,
      sort: this._parseSort(sort),
      limit,
      populate: this._parsePopulate(context.populate || options.populate),
      select: context.select || options.select,
      lean: context.lean ?? options.lean ?? true,
      session: options.session,
    };

    let result: OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc>;
    
    if (useKeyset) {
      // Keyset pagination (cursor-based)
      result = await this._pagination.stream({
        ...paginationOptions,
        sort: paginationOptions.sort, // Required for keyset
        after: params.cursor || params.after,
      });
    } else {
      // Offset pagination (page-based) - default
      const page = params.pagination?.page || params.page || 1;
      result = await this._pagination.paginate({
        ...paginationOptions,
        page,
      });
    }
    
    await this._emitHook('after:getAll', { context, result });
    return result;
  }

  /**
   * Get or create document
   */
  async getOrCreate(
    query: Record<string, unknown>,
    createData: Record<string, unknown>,
    options: { session?: ClientSession } = {}
  ): Promise<TDoc | null> {
    return readActions.getOrCreate(this.Model, query, createData, options);
  }

  /**
   * Count documents
   */
  async count(query: Record<string, unknown> = {}, options: { session?: ClientSession } = {}): Promise<number> {
    return readActions.count(this.Model, query, options);
  }

  /**
   * Check if document exists
   */
  async exists(query: Record<string, unknown>, options: { session?: ClientSession } = {}): Promise<{ _id: unknown } | null> {
    return readActions.exists(this.Model, query, options);
  }

  /**
   * Update document by ID
   */
  async update(
    id: string | ObjectId,
    data: Record<string, unknown>,
    options: UpdateOptions = {}
  ): Promise<TDoc> {
    const context = await this._buildContext('update', { id, data, ...options });

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
  async delete(id: string | ObjectId, options: { session?: ClientSession } = {}): Promise<{ success: boolean; message: string }> {
    const context = await this._buildContext('delete', { id, ...options });

    try {
      // Check if soft delete was performed by plugin
      if ((context as any).softDeleted) {
        const result = { success: true, message: 'Soft deleted successfully' };
        await this._emitHook('after:delete', { context, result });
        return result;
      }

      const result = await deleteActions.deleteById(this.Model, id, options);
      await this._emitHook('after:delete', { context, result });
      return result;
    } catch (error) {
      await this._emitErrorHook('error:delete', { context, error });
      throw this._handleError(error as Error);
    }
  }

  /**
   * Execute aggregation pipeline
   */
  async aggregate<TResult = unknown>(
    pipeline: PipelineStage[],
    options: { session?: ClientSession } = {}
  ): Promise<TResult[]> {
    return aggregateActions.aggregate(this.Model, pipeline, options);
  }

  /**
   * Aggregate pipeline with pagination
   * Best for: Complex queries, grouping, joins
   */
  async aggregatePaginate(
    options: { pipeline?: PipelineStage[]; page?: number; limit?: number; session?: ClientSession } = {}
  ): Promise<AggregatePaginationResult<TDoc>> {
    const context = await this._buildContext('aggregatePaginate', options);
    return this._pagination.aggregatePaginate(context);
  }

  /**
   * Get distinct values
   */
  async distinct<T = unknown>(
    field: string,
    query: Record<string, unknown> = {},
    options: { session?: ClientSession } = {}
  ): Promise<T[]> {
    return aggregateActions.distinct(this.Model, field, query, options);
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
  async lookupPopulate(
    options: {
      filters?: Record<string, unknown>;
      lookups: LookupOptions[];
      sort?: SortSpec | string;
      page?: number;
      limit?: number;
      select?: SelectSpec;
      session?: ClientSession;
    }
  ): Promise<{ data: TDoc[]; total?: number; page?: number; limit?: number }> {
    const context = await this._buildContext('lookupPopulate', options);

    try {
      // Build aggregation pipeline
      const builder = new AggregationBuilder();

      // 1. Match filters first (performance optimization)
      if (options.filters && Object.keys(options.filters).length > 0) {
        builder.match(options.filters);
      }

      // 2. Add lookups
      builder.multiLookup(options.lookups);

      // 3. Sort
      if (options.sort) {
        builder.sort(this._parseSort(options.sort));
      }

      // 4. Pagination with facet (get count and data in one query)
      const page = options.page || 1;
      const limit = options.limit || this._pagination.config.defaultLimit || 20;
      const skip = (page - 1) * limit;

      // MongoDB $facet results must be <16MB - warn for large offsets or limits
      const SAFE_LIMIT = 1000;
      const SAFE_MAX_OFFSET = 10000;

      if (limit > SAFE_LIMIT) {
        console.warn(
          `[mongokit] Large limit (${limit}) in lookupPopulate. $facet results must be <16MB. ` +
          `Consider using smaller limits or stream-based pagination for large datasets.`
        );
      }

      if (skip > SAFE_MAX_OFFSET) {
        console.warn(
          `[mongokit] Large offset (${skip}) in lookupPopulate. $facet with high offsets can exceed 16MB. ` +
          `For deep pagination, consider using keyset/cursor-based pagination instead.`
        );
      }

      // Build data pipeline stages
      const dataStages: PipelineStage[] = [
        { $skip: skip },
        { $limit: limit },
      ];

      // Add projection if select is provided
      if (options.select) {
        let projection: Record<string, 0 | 1>;
        if (typeof options.select === 'string') {
          // Convert string to projection object
          projection = {};
          const fields = options.select.split(',').map(f => f.trim());
          for (const field of fields) {
            if (field.startsWith('-')) {
              projection[field.substring(1)] = 0;
            } else {
              projection[field] = 1;
            }
          }
        } else if (Array.isArray(options.select)) {
          // Convert array to projection object
          projection = {};
          for (const field of options.select) {
            if (field.startsWith('-')) {
              projection[field.substring(1)] = 0;
            } else {
              projection[field] = 1;
            }
          }
        } else {
          projection = options.select;
        }
        dataStages.push({ $project: projection });
      }

      builder.facet({
        metadata: [{ $count: 'total' }],
        data: dataStages,
      });

      // Execute aggregation
      const pipeline = builder.build();
      const results = await this.Model.aggregate(pipeline).session(options.session || null);

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
   * Execute callback within a transaction
   */
  async withTransaction<T>(
    callback: (session: ClientSession | null) => Promise<T>,
    options: WithTransactionOptions = {}
  ): Promise<T> {
    const session = await mongoose.startSession();
    let started = false;
    try {
      session.startTransaction();
      started = true;
      const result = await callback(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      const err = error as Error;
      if (options.allowFallback && this._isTransactionUnsupported(err)) {
        if (typeof options.onFallback === 'function') {
          options.onFallback(err);
        }
        if (started && session.inTransaction()) {
          try {
            await session.abortTransaction();
          } catch {
            // Ignore abort failures during fallback
          }
        }
        return await callback(null);
      }
      if (started && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      session.endSession();
    }
  }

  private _isTransactionUnsupported(error: Error): boolean {
    const message = (error.message || '').toLowerCase();
    return (
      message.includes('transaction numbers are only allowed on a replica set member') ||
      message.includes('replica set') ||
      message.includes('mongos')
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
   * Build operation context and run before hooks
   */
  async _buildContext(operation: string, options: Record<string, unknown>): Promise<RepositoryContext> {
    const context: RepositoryContext = { operation, model: this.model, ...options };
    const event = `before:${operation}`;
    const hooks = this._hooks.get(event) || [];

    for (const hook of hooks) {
      await hook(context);
    }

    return context;
  }

  /**
   * Parse sort string or object
   */
  _parseSort(sort: SortSpec | string | undefined): SortSpec {
    if (!sort) return { createdAt: -1 };
    if (typeof sort === 'object') return sort;

    const sortOrder = sort.startsWith('-') ? -1 : 1;
    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
    return { [sortField]: sortOrder };
  }

  /**
   * Parse populate specification
   */
  _parsePopulate(populate: PopulateSpec | undefined): string[] | PopulateOptions[] {
    if (!populate) return [];
    if (typeof populate === 'string') return populate.split(',').map(p => p.trim());
    if (Array.isArray(populate)) return populate.map(p => (typeof p === 'string' ? p.trim() : p)) as string[] | PopulateOptions[];
    return [populate];
  }

  /**
   * Handle errors with proper HTTP status codes
   */
  _handleError(error: Error): HttpError {
    if (error instanceof mongoose.Error.ValidationError) {
      const messages = Object.values(error.errors).map(err => (err as Error).message);
      return createError(400, `Validation Error: ${messages.join(', ')}`);
    }
    if (error instanceof mongoose.Error.CastError) {
      return createError(400, `Invalid ${error.path}: ${error.value}`);
    }
    if ((error as HttpError).status && error.message) return error as HttpError;
    return createError(500, error.message || 'Internal Server Error');
  }
}

export default Repository;
