/**
 * Read Actions
 * Pure functions for document retrieval
 */

import createError from 'http-errors';

/**
 * Get by ID
 */
export async function getById(Model, id, options = {}) {
  const query = Model.findById(id);
  
  if (options.select) query.select(options.select);
  if (options.populate) query.populate(parsePopulate(options.populate));
  if (options.lean) query.lean();
  if (options.session) query.session(options.session);
  
  const document = await query.exec();
  if (!document && options.throwOnNotFound !== false) {
    throw createError(404, 'Document not found');
  }
  
  return document;
}

/**
 * Get by query
 */
export async function getByQuery(Model, query, options = {}) {
  const mongoQuery = Model.findOne(query);
  
  if (options.select) mongoQuery.select(options.select);
  if (options.populate) mongoQuery.populate(parsePopulate(options.populate));
  if (options.lean) mongoQuery.lean();
  if (options.session) mongoQuery.session(options.session);
  
  const document = await mongoQuery.exec();
  if (!document && options.throwOnNotFound !== false) {
    throw createError(404, 'Document not found');
  }
  
  return document;
}

/**
 * Get all with pagination
 */
export async function getAll(Model, queryParams, options = {}) {
  const {
    pagination = { page: 1, limit: 10 },
    search,
    sort = '-createdAt',
    filters = {},
  } = queryParams;

  let query = {};
  
  if (search) {
    query.$text = { $search: search };
  }
  
  if (filters) {
    query = { ...query, ...parseFilters(filters) };
  }

  const paginateOptions = {
    page: parseInt(pagination.page, 10),
    limit: parseInt(pagination.limit, 10),
    sort: parseSort(sort),
    populate: parsePopulate(options.populate),
    select: options.select,
    lean: options.lean !== false,
    session: options.session,
  };

  return Model.paginate(query, paginateOptions);
}

/**
 * Get or create
 */
export async function getOrCreate(Model, query, createData, options = {}) {
  return Model.findOneAndUpdate(
    query,
    { $setOnInsert: createData },
    {
      upsert: true,
      new: true,
      runValidators: true,
      session: options.session,
    }
  );
}

/**
 * Count documents
 */
export async function count(Model, query = {}, options = {}) {
  return Model.countDocuments(query).session(options.session);
}

/**
 * Check existence
 */
export async function exists(Model, query, options = {}) {
  return Model.exists(query).session(options.session);
}

// Utilities
function parsePopulate(populate) {
  if (!populate) return [];
  if (typeof populate === 'string') {
    return populate.split(',').map(p => p.trim());
  }
  if (Array.isArray(populate)) {
    return populate.map(p => typeof p === 'string' ? p.trim() : p);
  }
  return [populate];
}

function parseSort(sort) {
  if (!sort) return { createdAt: -1 };
  const sortOrder = sort.startsWith('-') ? -1 : 1;
  const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
  return { [sortField]: sortOrder };
}

function parseFilters(filters) {
  const parsed = {};
  for (const [key, value] of Object.entries(filters)) {
    parsed[key] = parseFilterValue(value);
  }
  return parsed;
}

function parseFilterValue(value) {
  if (typeof value === 'string') return value;
  
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const processed = {};
    for (const [operator, operatorValue] of Object.entries(value)) {
      if (operator === 'contains' || operator === 'like') {
        processed.$regex = operatorValue;
        processed.$options = 'i';
      } else {
        processed[operator.startsWith('$') ? operator : `$${operator}`] = operatorValue;
      }
    }
    return processed;
  }
  
  return value;
}

