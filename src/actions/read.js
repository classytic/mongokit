/**
 * Read Actions
 * Pure functions for document retrieval
 */

import { createError } from '../utils/error.js';

/**
 * @typedef {import('mongoose').Model} Model
 * @typedef {import('mongoose').PopulateOptions} PopulateOptions
 * @typedef {import('mongoose').ClientSession} ClientSession
 */

/**
 * Get document by ID
 *
 * @param {Model} Model - Mongoose model
 * @param {string} id - Document ID
 * @param {Object} [options={}] - Query options
 * @param {string|string[]} [options.select] - Fields to select
 * @param {string|string[]|PopulateOptions|PopulateOptions[]} [options.populate] - Fields to populate
 * @param {boolean} [options.lean] - Return plain JavaScript object
 * @param {ClientSession} [options.session] - MongoDB session
 * @param {boolean} [options.throwOnNotFound=true] - Throw error if not found
 * @returns {Promise<any>} Document or null
 * @throws {Error} If document not found and throwOnNotFound is true
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
 * Get document by query
 *
 * @param {Model} Model - Mongoose model
 * @param {Record<string, any>} query - MongoDB query
 * @param {Object} [options={}] - Query options
 * @param {string|string[]} [options.select] - Fields to select
 * @param {string|string[]|PopulateOptions|PopulateOptions[]} [options.populate] - Fields to populate
 * @param {boolean} [options.lean] - Return plain JavaScript object
 * @param {ClientSession} [options.session] - MongoDB session
 * @param {boolean} [options.throwOnNotFound=true] - Throw error if not found
 * @returns {Promise<any>} Document or null
 * @throws {Error} If document not found and throwOnNotFound is true
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
 * Get document by query without throwing (returns null if not found)
 *
 * @param {Model} Model - Mongoose model
 * @param {Record<string, any>} query - MongoDB query
 * @param {Object} [options={}] - Query options
 * @param {string|string[]} [options.select] - Fields to select
 * @param {string|string[]|PopulateOptions|PopulateOptions[]} [options.populate] - Fields to populate
 * @param {boolean} [options.lean] - Return plain JavaScript object
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<any|null>} Document or null
 */
export async function tryGetByQuery(Model, query, options = {}) {
  return getByQuery(Model, query, { ...options, throwOnNotFound: false });
}

/**
 * Get all documents (basic query without pagination)
 * For pagination, use Repository.paginate() or Repository.stream()
 *
 * @param {Model} Model - Mongoose model
 * @param {Record<string, any>} [query={}] - MongoDB query
 * @param {Object} [options={}] - Query options
 * @param {string|string[]} [options.select] - Fields to select
 * @param {string|string[]|PopulateOptions|PopulateOptions[]} [options.populate] - Fields to populate
 * @param {Record<string, 1|-1>} [options.sort] - Sort specification
 * @param {number} [options.limit] - Maximum documents to return
 * @param {number} [options.skip] - Documents to skip
 * @param {boolean} [options.lean=true] - Return plain JavaScript objects
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<any[]>} Array of documents
 */
export async function getAll(Model, query = {}, options = {}) {
  let mongoQuery = Model.find(query);

  if (options.select) mongoQuery = mongoQuery.select(options.select);
  if (options.populate) mongoQuery = mongoQuery.populate(parsePopulate(options.populate));
  if (options.sort) mongoQuery = mongoQuery.sort(options.sort);
  if (options.limit) mongoQuery = mongoQuery.limit(options.limit);
  if (options.skip) mongoQuery = mongoQuery.skip(options.skip);

  mongoQuery = mongoQuery.lean(options.lean !== false);
  if (options.session) mongoQuery = mongoQuery.session(options.session);

  return mongoQuery.exec();
}

/**
 * Get or create document (upsert)
 *
 * @param {Model} Model - Mongoose model
 * @param {Record<string, any>} query - Query to find document
 * @param {Record<string, any>} createData - Data to insert if not found
 * @param {Object} [options={}] - Query options
 * @param {ClientSession} [options.session] - MongoDB session
 * @param {boolean} [options.updatePipeline] - Use update pipeline
 * @returns {Promise<any>} Created or found document
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
      ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
    }
  );
}

/**
 * Count documents matching query
 *
 * @param {Model} Model - Mongoose model
 * @param {Record<string, any>} [query={}] - MongoDB query
 * @param {Object} [options={}] - Query options
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<number>} Document count
 */
export async function count(Model, query = {}, options = {}) {
  return Model.countDocuments(query).session(options.session);
}

/**
 * Check if document exists
 *
 * @param {Model} Model - Mongoose model
 * @param {Record<string, any>} query - MongoDB query
 * @param {Object} [options={}] - Query options
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<{_id: any} | null>} Document ID if exists, null otherwise
 */
export async function exists(Model, query, options = {}) {
  return Model.exists(query).session(options.session);
}

/**
 * Parses populate parameter into Mongoose-compatible format
 *
 * @param {string|string[]|PopulateOptions|PopulateOptions[]} populate - Populate specification
 * @returns {(string|PopulateOptions)[]} Normalized populate array
 */
function parsePopulate(populate) {
  if (!populate) return [];
  if (typeof populate === 'string') {
    return populate.split(',').map(/** @param {string} p */ (p) => p.trim());
  }
  if (Array.isArray(populate)) {
    return populate.map(/** @param {string|PopulateOptions} p */ (p) => typeof p === 'string' ? p.trim() : p);
  }
  return [populate];
}

