import mongoose from 'mongoose';
import { createError } from './utils/error.js';
import * as createActions from './actions/create.js';
import * as readActions from './actions/read.js';
import * as updateActions from './actions/update.js';
import * as deleteActions from './actions/delete.js';
import * as aggregateActions from './actions/aggregate.js';
import { PaginationEngine } from './pagination/PaginationEngine.js';

/**
 * @typedef {import('./types.js').OffsetPaginationResult} OffsetPaginationResult
 * @typedef {import('./types.js').KeysetPaginationResult} KeysetPaginationResult
 * @typedef {import('./types.js').AggregatePaginationResult} AggregatePaginationResult
 * @typedef {import('./types.js').ObjectId} ObjectId
 */

export class Repository {
  constructor(Model, plugins = [], paginationConfig = {}) {
    this.Model = Model;
    this.model = Model.modelName;
    this._hooks = new Map();
    this._pagination = new PaginationEngine(Model, paginationConfig);
    plugins.forEach(plugin => this.use(plugin));
  }

  use(plugin) {
    if (typeof plugin === 'function') {
      plugin(this);
    } else if (plugin && typeof plugin.apply === 'function') {
      plugin.apply(this);
    }
    return this;
  }

  on(event, listener) {
    if (!this._hooks.has(event)) {
      this._hooks.set(event, []);
    }
    this._hooks.get(event).push(listener);
    return this;
  }

  emit(event, data) {
    const listeners = this._hooks.get(event) || [];
    listeners.forEach(listener => listener(data));
  }

  async create(data, options = {}) {
    const context = await this._buildContext('create', { data, ...options });

    try {
      const result = await createActions.create(this.Model, context.data, options);
      this.emit('after:create', { context, result });
      return result;
    } catch (error) {
      this.emit('error:create', { context, error });
      throw this._handleError(error);
    }
  }

  async createMany(dataArray, options = {}) {
    const context = await this._buildContext('createMany', { dataArray, ...options });

    try {
      const result = await createActions.createMany(this.Model, context.dataArray || dataArray, options);
      this.emit('after:createMany', { context, result });
      return result;
    } catch (error) {
      this.emit('error:createMany', { context, error });
      throw this._handleError(error);
    }
  }

  async getById(id, options = {}) {
    const context = await this._buildContext('getById', { id, ...options });
    return readActions.getById(this.Model, id, context);
  }

  async getByQuery(query, options = {}) {
    const context = await this._buildContext('getByQuery', { query, ...options });
    return readActions.getByQuery(this.Model, query, context);
  }

  /**
   * Unified pagination - auto-detects offset vs keyset based on params
   *
   * Auto-detection logic:
   * - If params has 'cursor' or 'after' → uses keyset pagination (stream)
   * - If params has 'pagination' or 'page' → uses offset pagination (paginate)
   * - Else → defaults to offset pagination with page=1
   *
   * @param {Object} params - Query and pagination parameters
   * @param {Object} [params.filters] - MongoDB query filters
   * @param {string|Object} [params.sort] - Sort specification
   * @param {string} [params.cursor] - Cursor token for keyset pagination
   * @param {string} [params.after] - Alias for cursor
   * @param {number} [params.page] - Page number for offset pagination
   * @param {Object} [params.pagination] - Pagination config { page, limit }
   * @param {number} [params.limit] - Documents per page
   * @param {string} [params.search] - Full-text search query
   * @param {Object} [options] - Additional options (select, populate, lean, session)
   * @returns {Promise<OffsetPaginationResult|KeysetPaginationResult>} Discriminated union based on method
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
   */
  async getAll(params = {}, options = {}) {
    const context = await this._buildContext('getAll', { ...params, ...options });

    // Auto-detect pagination mode
    // Priority:
    // 1. If 'page' param → offset pagination
    // 2. If 'after' or 'cursor' param → keyset pagination
    // 3. If explicit 'sort' provided without 'page' → keyset pagination (first page)
    // 4. Otherwise → offset pagination (default, page=1)
    const hasPageParam = params.page !== undefined || params.pagination;
    const hasCursorParam = 'cursor' in params || 'after' in params;
    const hasExplicitSort = params.sort !== undefined;

    const useKeyset = !hasPageParam && (hasCursorParam || hasExplicitSort);

    // Extract common params
    const filters = params.filters || {};
    const search = params.search;
    const sort = params.sort || '-createdAt';
    const limit = params.limit || params.pagination?.limit || this._pagination.config.defaultLimit;

    // Build query with search support
    let query = { ...filters };
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

    if (useKeyset) {
      // Keyset pagination (cursor-based)
      return this._pagination.stream({
        ...paginationOptions,
        after: params.cursor || params.after,
      });
    } else {
      // Offset pagination (page-based) - default
      const page = params.pagination?.page || params.page || 1;
      return this._pagination.paginate({
        ...paginationOptions,
        page,
      });
    }
  }

  async getOrCreate(query, createData, options = {}) {
    return readActions.getOrCreate(this.Model, query, createData, options);
  }

  async count(query = {}, options = {}) {
    return readActions.count(this.Model, query, options);
  }

  async exists(query, options = {}) {
    return readActions.exists(this.Model, query, options);
  }

  async update(id, data, options = {}) {
    const context = await this._buildContext('update', { id, data, ...options });

    try {
      const result = await updateActions.update(this.Model, id, context.data, context);
      this.emit('after:update', { context, result });
      return result;
    } catch (error) {
      this.emit('error:update', { context, error });
      throw this._handleError(error);
    }
  }

  async delete(id, options = {}) {
    const context = await this._buildContext('delete', { id, ...options });

    try {
      const result = await deleteActions.deleteById(this.Model, id, options);
      this.emit('after:delete', { context, result });
      return result;
    } catch (error) {
      this.emit('error:delete', { context, error });
      throw this._handleError(error);
    }
  }

  async aggregate(pipeline, options = {}) {
    return aggregateActions.aggregate(this.Model, pipeline, options);
  }

  /**
   * Aggregate pipeline with pagination
   * Best for: Complex queries, grouping, joins
   *
   * @param {Object} options - Aggregate pagination options
   * @returns {Promise<AggregatePaginationResult>}
   */
  async aggregatePaginate(options = {}) {
    const context = await this._buildContext('aggregatePaginate', options);
    return this._pagination.aggregatePaginate(context);
  }

  async distinct(field, query = {}, options = {}) {
    return aggregateActions.distinct(this.Model, field, query, options);
  }

  async withTransaction(callback) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await callback(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async _executeQuery(buildQuery) {
    const operation = buildQuery.name || 'custom';
    const context = await this._buildContext(operation, {});

    try {
      const result = await buildQuery(this.Model);
      this.emit(`after:${operation}`, { context, result });
      return result;
    } catch (error) {
      this.emit(`error:${operation}`, { context, error });
      throw this._handleError(error);
    }
  }

  async _buildContext(operation, options) {
    const context = { operation, model: this.model, ...options };
    const event = `before:${operation}`;
    const hooks = this._hooks.get(event) || [];

    for (const hook of hooks) {
      await hook(context);
    }

    return context;
  }

  _parseSort(sort) {
    if (!sort) return { createdAt: -1 };
    if (typeof sort === 'object') return sort;

    const sortOrder = sort.startsWith('-') ? -1 : 1;
    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
    return { [sortField]: sortOrder };
  }

  _parsePopulate(populate) {
    if (!populate) return [];
    if (typeof populate === 'string') return populate.split(',').map(p => p.trim());
    if (Array.isArray(populate)) return populate.map(p => (typeof p === 'string' ? p.trim() : p));
    return [populate];
  }

  _handleError(error) {
    if (error instanceof mongoose.Error.ValidationError) {
      const messages = Object.values(error.errors).map(err => /** @type {any} */(err).message);
      return createError(400, `Validation Error: ${messages.join(', ')}`);
    }
    if (error instanceof mongoose.Error.CastError) {
      return createError(400, `Invalid ${error.path}: ${error.value}`);
    }
    if (error.status && error.message) return error;
    return createError(500, error.message || 'Internal Server Error');
  }
}

export default Repository;
