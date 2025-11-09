import mongoose from 'mongoose';
import createError from 'http-errors';
import * as createActions from './actions/create.js';
import * as readActions from './actions/read.js';
import * as updateActions from './actions/update.js';
import * as deleteActions from './actions/delete.js';
import * as aggregateActions from './actions/aggregate.js';

export class Repository {
  constructor(Model, plugins = []) {
    this.Model = Model;
    this.model = Model.modelName;
    this._hooks = new Map();
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

  async getAll(queryParams = {}, options = {}) {
    const context = await this._buildContext('getAll', { queryParams, ...options });

    const {
      pagination = { page: 1, limit: 10 },
      search,
      sort = '-createdAt',
      filters = {},
    } = context.queryParams || queryParams;

    let query = { ...filters };
    if (search) query.$text = { $search: search };

    const paginateOptions = {
      page: parseInt(pagination.page, 10),
      limit: parseInt(pagination.limit, 10),
      sort: this._parseSort(sort),
      populate: this._parsePopulate(context.populate || options.populate),
      select: context.select || options.select,
      lean: context.lean ?? options.lean ?? true,
      session: options.session,
    };

    if (!this.Model.paginate) {
      throw createError(500, `Model ${this.model} missing paginate plugin`);
    }

    return this.Model.paginate(query, paginateOptions);
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

  async aggregatePaginate(pipeline, options = {}) {
    return aggregateActions.aggregatePaginate(this.Model, pipeline, options);
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
      const messages = Object.values(error.errors).map(err => err.message);
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
