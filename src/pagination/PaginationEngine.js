import { encodeCursor, decodeCursor, validateCursorSort, validateCursorVersion } from './utils/cursor.js';
import { validateKeysetSort, getPrimaryField } from './utils/sort.js';
import { buildKeysetFilter } from './utils/filter.js';
import {
  validateLimit,
  validatePage,
  shouldWarnDeepPagination,
  calculateSkip,
  calculateTotalPages
} from './utils/limits.js';
import { createError } from '../utils/error.js';

/**
 * @typedef {import('mongoose').Model} Model
 * @typedef {import('mongoose').PopulateOptions} PopulateOptions
 * @typedef {import('mongoose').ClientSession} ClientSession
 */

/**
 * @typedef {Object} PaginationConfig
 * @property {number} [defaultLimit=10] - Default number of documents per page
 * @property {number} [maxLimit=100] - Maximum allowed limit
 * @property {number} [maxPage=10000] - Maximum allowed page number
 * @property {number} [deepPageThreshold=100] - Page number that triggers performance warning
 * @property {number} [cursorVersion=1] - Cursor version for forward compatibility
 * @property {boolean} [useEstimatedCount=false] - Use estimatedDocumentCount for faster counts on large collections
 */

/**
 * @typedef {Object} OffsetPaginationOptions
 * @property {Record<string, any>} [filters={}] - MongoDB query filters
 * @property {Record<string, 1|-1>} [sort] - Sort specification
 * @property {number} [page=1] - Page number (1-indexed)
 * @property {number} [limit] - Number of documents per page
 * @property {string|string[]} [select] - Fields to select
 * @property {string|string[]|PopulateOptions|PopulateOptions[]} [populate] - Fields to populate
 * @property {boolean} [lean=true] - Return plain JavaScript objects
 * @property {ClientSession} [session] - MongoDB session for transactions
 */

/**
 * @typedef {Object} KeysetPaginationOptions
 * @property {Record<string, any>} [filters={}] - MongoDB query filters
 * @property {Record<string, 1|-1>} [sort] - Sort specification (required at runtime)
 * @property {string} [after] - Cursor token for next page
 * @property {number} [limit] - Number of documents per page
 * @property {string|string[]} [select] - Fields to select
 * @property {string|string[]|PopulateOptions|PopulateOptions[]} [populate] - Fields to populate
 * @property {boolean} [lean=true] - Return plain JavaScript objects
 * @property {ClientSession} [session] - MongoDB session for transactions
 */

/**
 * @typedef {Object} AggregatePaginationOptions
 * @property {any[]} [pipeline=[]] - Aggregation pipeline stages
 * @property {number} [page=1] - Page number (1-indexed)
 * @property {number} [limit] - Number of documents per page
 * @property {ClientSession} [session] - MongoDB session for transactions
 */

/**
 * @typedef {Object} OffsetPaginationResult
 * @property {'offset'} method - Pagination method used
 * @property {any[]} docs - Array of documents
 * @property {number} page - Current page number
 * @property {number} limit - Documents per page
 * @property {number} total - Total document count
 * @property {number} pages - Total page count
 * @property {boolean} hasNext - Whether next page exists
 * @property {boolean} hasPrev - Whether previous page exists
 * @property {string} [warning] - Performance warning for deep pagination
 */

/**
 * @typedef {Object} KeysetPaginationResult
 * @property {'keyset'} method - Pagination method used
 * @property {any[]} docs - Array of documents
 * @property {number} limit - Documents per page
 * @property {boolean} hasMore - Whether more documents exist
 * @property {string|null} next - Cursor token for next page
 */

/**
 * @typedef {Object} AggregatePaginationResult
 * @property {'aggregate'} method - Pagination method used
 * @property {any[]} docs - Array of documents
 * @property {number} page - Current page number
 * @property {number} limit - Documents per page
 * @property {number} total - Total document count
 * @property {number} pages - Total page count
 * @property {boolean} hasNext - Whether next page exists
 * @property {boolean} hasPrev - Whether previous page exists
 * @property {string} [warning] - Performance warning for deep pagination
 */

/**
 * Production-grade pagination engine for MongoDB
 * Supports offset, keyset (cursor), and aggregate pagination
 *
 * @example
 * const engine = new PaginationEngine(UserModel, {
 *   defaultLimit: 20,
 *   maxLimit: 100,
 *   useEstimatedCount: true
 * });
 *
 * // Offset pagination
 * const page1 = await engine.paginate({ page: 1, limit: 20 });
 *
 * // Keyset pagination (better for large datasets)
 * const stream1 = await engine.stream({ sort: { createdAt: -1 }, limit: 20 });
 * const stream2 = await engine.stream({ sort: { createdAt: -1 }, after: stream1.next });
 */
export class PaginationEngine {
  /**
   * Create a new pagination engine
   *
   * @param {Model} Model - Mongoose model to paginate
   * @param {PaginationConfig} [config={}] - Pagination configuration
   */
  constructor(Model, config = {}) {
    this.Model = Model;
    this.config = {
      defaultLimit: config.defaultLimit || 10,
      maxLimit: config.maxLimit || 100,
      maxPage: config.maxPage || 10000,
      deepPageThreshold: config.deepPageThreshold || 100,
      cursorVersion: config.cursorVersion || 1,
      useEstimatedCount: config.useEstimatedCount || false
    };
  }

  /**
   * Offset-based pagination using skip/limit
   * Best for small datasets and when users need random page access
   * O(n) performance - slower for deep pages
   *
   * @param {OffsetPaginationOptions} [options={}] - Pagination options
   * @returns {Promise<OffsetPaginationResult>} Pagination result with total count
   *
   * @example
   * const result = await engine.paginate({
   *   filters: { status: 'active' },
   *   sort: { createdAt: -1 },
   *   page: 1,
   *   limit: 20
   * });
   * console.log(result.docs, result.total, result.hasNext);
   */
  async paginate(options = {}) {
    const {
      filters = {},
      sort = { _id: -1 },
      page = 1,
      limit = this.config.defaultLimit,
      select,
      populate = [],
      lean = true,
      session
    } = options;

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);

    let query = this.Model.find(filters);
    if (select) query = query.select(select);
    if (populate && (Array.isArray(populate) ? populate.length : populate)) query = query.populate(populate);
    query = query.sort(sort).skip(skip).limit(sanitizedLimit).lean(lean);
    if (session) query = query.session(session);

    const hasFilters = Object.keys(filters).length > 0;
    const useEstimated = this.config.useEstimatedCount && !hasFilters;

    // Note: estimatedDocumentCount() doesn't support sessions or filters
    // It reads collection metadata (O(1) instant), not actual documents
    // Falls back to countDocuments() when filters are present
    const [docs, total] = await Promise.all([
      query,
      useEstimated
        ? this.Model.estimatedDocumentCount()
        : this.Model.countDocuments(filters).session(session)
    ]);

    const totalPages = calculateTotalPages(total, sanitizedLimit);
    const warning = shouldWarnDeepPagination(sanitizedPage, this.config.deepPageThreshold)
      ? `Deep pagination (page ${sanitizedPage}). Consider getAll({ after, sort, limit }) for better performance.`
      : undefined;

    return /** @type {const} */ ({
      method: 'offset',
      docs,
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      pages: totalPages,
      hasNext: sanitizedPage < totalPages,
      hasPrev: sanitizedPage > 1,
      ...(warning && { warning })
    });
  }

  /**
   * Keyset (cursor-based) pagination for high-performance streaming
   * Best for large datasets, infinite scroll, real-time feeds
   * O(1) performance - consistent speed regardless of position
   *
   * @param {KeysetPaginationOptions} options - Pagination options (sort is required)
   * @returns {Promise<KeysetPaginationResult>} Pagination result with next cursor
   *
   * @example
   * // First page
   * const page1 = await engine.stream({
   *   sort: { createdAt: -1 },
   *   limit: 20
   * });
   *
   * // Next page using cursor
   * const page2 = await engine.stream({
   *   sort: { createdAt: -1 },
   *   after: page1.next,
   *   limit: 20
   * });
   */
  async stream(options = {}) {
    const {
      filters = {},
      sort,
      after,
      limit = this.config.defaultLimit,
      select,
      populate = [],
      lean = true,
      session
    } = options;

    if (!sort) {
      throw createError(400, 'sort is required for keyset pagination');
    }

    const sanitizedLimit = validateLimit(limit, this.config);
    const normalizedSort = validateKeysetSort(sort);

    let query = { ...filters };

    if (after) {
      const cursor = decodeCursor(after);
      validateCursorVersion(cursor.version, this.config.cursorVersion);
      validateCursorSort(cursor.sort, normalizedSort);
      query = buildKeysetFilter(query, normalizedSort, cursor.value, cursor.id);
    }

    let mongoQuery = this.Model.find(query);
    if (select) mongoQuery = mongoQuery.select(select);
    if (populate && (Array.isArray(populate) ? populate.length : populate)) mongoQuery = mongoQuery.populate(populate);
    mongoQuery = mongoQuery.sort(normalizedSort).limit(sanitizedLimit + 1).lean(lean);
    if (session) mongoQuery = mongoQuery.session(session);

    const docs = await mongoQuery;

    const hasMore = docs.length > sanitizedLimit;
    if (hasMore) docs.pop();

    const primaryField = getPrimaryField(normalizedSort);
    const nextCursor = hasMore && docs.length > 0
      ? encodeCursor(docs[docs.length - 1], primaryField, normalizedSort, this.config.cursorVersion)
      : null;

    return /** @type {const} */ ({
      method: 'keyset',
      docs,
      limit: sanitizedLimit,
      hasMore,
      next: nextCursor
    });
  }

  /**
   * Aggregate pipeline with pagination
   * Best for complex queries requiring aggregation stages
   * Uses $facet to combine results and count in single query
   *
   * @param {AggregatePaginationOptions} [options={}] - Aggregation options
   * @returns {Promise<AggregatePaginationResult>} Pagination result with total count
   *
   * @example
   * const result = await engine.aggregatePaginate({
   *   pipeline: [
   *     { $match: { status: 'active' } },
   *     { $group: { _id: '$category', count: { $sum: 1 } } },
   *     { $sort: { count: -1 } }
   *   ],
   *   page: 1,
   *   limit: 20
   * });
   */
  async aggregatePaginate(options = {}) {
    const {
      pipeline = [],
      page = 1,
      limit = this.config.defaultLimit,
      session
    } = options;

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);

    const facetPipeline = [
      ...pipeline,
      {
        $facet: {
          docs: [
            { $skip: skip },
            { $limit: sanitizedLimit }
          ],
          total: [
            { $count: 'count' }
          ]
        }
      }
    ];

    const aggregation = this.Model.aggregate(facetPipeline);
    if (session) aggregation.session(session);

    const [result] = await aggregation.exec();
    const docs = result.docs;
    const total = result.total[0]?.count || 0;
    const totalPages = calculateTotalPages(total, sanitizedLimit);

    const warning = shouldWarnDeepPagination(sanitizedPage, this.config.deepPageThreshold)
      ? `Deep pagination in aggregate (page ${sanitizedPage}). Uses $skip internally.`
      : undefined;

    return /** @type {const} */ ({
      method: 'aggregate',
      docs,
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      pages: totalPages,
      hasNext: sanitizedPage < totalPages,
      hasPrev: sanitizedPage > 1,
      ...(warning && { warning })
    });
  }
}
