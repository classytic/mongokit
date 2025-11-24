/**
 * @typedef {import('./types.js').OffsetPaginationResult} OffsetPaginationResult
 * @typedef {import('./types.js').KeysetPaginationResult} KeysetPaginationResult
 * @typedef {import('./types.js').AggregatePaginationResult} AggregatePaginationResult
 * @typedef {import('./types.js').ObjectId} ObjectId
 */
export class Repository {
    constructor(Model: any, plugins?: any[], paginationConfig?: {});
    Model: any;
    model: any;
    _hooks: Map<any, any>;
    _pagination: PaginationEngine;
    use(plugin: any): this;
    on(event: any, listener: any): this;
    emit(event: any, data: any): void;
    create(data: any, options?: {}): Promise<any>;
    createMany(dataArray: any, options?: {}): Promise<any>;
    getById(id: any, options?: {}): Promise<any>;
    getByQuery(query: any, options?: {}): Promise<any>;
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
    getAll(params?: {
        filters?: any;
        sort?: string | any;
        cursor?: string;
        after?: string;
        page?: number;
        pagination?: any;
        limit?: number;
        search?: string;
    }, options?: any): Promise<OffsetPaginationResult | KeysetPaginationResult>;
    getOrCreate(query: any, createData: any, options?: {}): Promise<any>;
    count(query?: {}, options?: {}): Promise<number>;
    exists(query: any, options?: {}): Promise<{
        _id: any;
    }>;
    update(id: any, data: any, options?: {}): Promise<any>;
    delete(id: any, options?: {}): Promise<{
        success: boolean;
        message: string;
    }>;
    aggregate(pipeline: any, options?: {}): Promise<any[]>;
    /**
     * Aggregate pipeline with pagination
     * Best for: Complex queries, grouping, joins
     *
     * @param {Object} options - Aggregate pagination options
     * @returns {Promise<AggregatePaginationResult>}
     */
    aggregatePaginate(options?: any): Promise<AggregatePaginationResult>;
    distinct(field: any, query?: {}, options?: {}): Promise<any>;
    withTransaction(callback: any): Promise<any>;
    _executeQuery(buildQuery: any): Promise<any>;
    _buildContext(operation: any, options: any): Promise<any>;
    _parseSort(sort: any): any;
    _parsePopulate(populate: any): any[];
    _handleError(error: any): any;
}
export default Repository;
export type OffsetPaginationResult = import("./types.js").OffsetPaginationResult;
export type KeysetPaginationResult = import("./types.js").KeysetPaginationResult;
export type AggregatePaginationResult = import("./types.js").AggregatePaginationResult;
export type ObjectId = import("./types.js").ObjectId;
import { PaginationEngine } from './pagination/PaginationEngine.js';
//# sourceMappingURL=Repository.d.ts.map