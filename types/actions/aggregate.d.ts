/**
 * Aggregate Actions
 * MongoDB aggregation pipeline operations
 */
/**
 * @typedef {import('mongoose').Model} Model
 * @typedef {import('mongoose').ClientSession} ClientSession
 */
/**
 * Execute aggregation pipeline
 *
 * @param {Model} Model - Mongoose model
 * @param {any[]} pipeline - Aggregation pipeline stages
 * @param {Object} [options={}] - Aggregation options
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<any[]>} Aggregation results
 */
export function aggregate(Model: Model, pipeline: any[], options?: {
    session?: ClientSession;
}): Promise<any[]>;
/**
 * Aggregate with pagination using native MongoDB $facet
 * WARNING: $facet results must be <16MB. For larger results (limit >1000),
 * consider using Repository.aggregatePaginate() or splitting into separate queries.
 *
 * @param {Model} Model - Mongoose model
 * @param {any[]} pipeline - Aggregation pipeline stages (before pagination)
 * @param {Object} [options={}] - Pagination options
 * @param {number} [options.page=1] - Page number (1-indexed)
 * @param {number} [options.limit=10] - Documents per page
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<{docs: any[], total: number, page: number, limit: number, pages: number, hasNext: boolean, hasPrev: boolean}>} Paginated results
 *
 * @example
 * const result = await aggregatePaginate(UserModel, [
 *   { $match: { status: 'active' } },
 *   { $group: { _id: '$category', count: { $sum: 1 } } }
 * ], { page: 1, limit: 20 });
 */
export function aggregatePaginate(Model: Model, pipeline: any[], options?: {
    page?: number;
    limit?: number;
    session?: ClientSession;
}): Promise<{
    docs: any[];
    total: number;
    page: number;
    limit: number;
    pages: number;
    hasNext: boolean;
    hasPrev: boolean;
}>;
/**
 * Group documents by field value
 *
 * @param {Model} Model - Mongoose model
 * @param {string} field - Field name to group by
 * @param {Object} [options={}] - Options
 * @param {number} [options.limit] - Maximum groups to return
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<Array<{_id: any, count: number}>>} Grouped results
 */
export function groupBy(Model: Model, field: string, options?: {
    limit?: number;
    session?: ClientSession;
}): Promise<Array<{
    _id: any;
    count: number;
}>>;
/**
 * Count by field values
 */
export function countBy(Model: any, field: any, query?: {}, options?: {}): Promise<any[]>;
/**
 * Lookup (join) with another collection
 */
export function lookup(Model: any, { from, localField, foreignField, as, pipeline, query, options }: {
    from: any;
    localField: any;
    foreignField: any;
    as: any;
    pipeline?: any[];
    query?: {};
    options?: {};
}): Promise<any[]>;
/**
 * Unwind array field
 */
export function unwind(Model: any, field: any, options?: {}): Promise<any[]>;
/**
 * Facet search (multiple aggregations in one query)
 */
export function facet(Model: any, facets: any, options?: {}): Promise<any[]>;
/**
 * Get distinct values
 */
export function distinct(Model: any, field: any, query?: {}, options?: {}): Promise<any>;
/**
 * Calculate sum
 */
export function sum(Model: any, field: any, query?: {}, options?: {}): Promise<any>;
/**
 * Calculate average
 */
export function average(Model: any, field: any, query?: {}, options?: {}): Promise<any>;
/**
 * Min/Max
 */
export function minMax(Model: any, field: any, query?: {}, options?: {}): Promise<any>;
export type Model = import("mongoose").Model<any, any, any, any, any, any, any>;
export type ClientSession = import("mongoose").ClientSession;
//# sourceMappingURL=aggregate.d.ts.map