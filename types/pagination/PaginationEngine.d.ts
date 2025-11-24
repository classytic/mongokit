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
    constructor(Model: Model, config?: PaginationConfig);
    Model: import("mongoose").Model<any, any, any, any, any, any, any>;
    config: {
        defaultLimit: number;
        maxLimit: number;
        maxPage: number;
        deepPageThreshold: number;
        cursorVersion: number;
        useEstimatedCount: boolean;
    };
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
    paginate(options?: OffsetPaginationOptions): Promise<OffsetPaginationResult>;
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
    stream(options?: KeysetPaginationOptions): Promise<KeysetPaginationResult>;
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
    aggregatePaginate(options?: AggregatePaginationOptions): Promise<AggregatePaginationResult>;
}
export type Model = import("mongoose").Model<any, any, any, any, any, any, any>;
export type PopulateOptions = import("mongoose").PopulateOptions;
export type ClientSession = import("mongoose").ClientSession;
export type PaginationConfig = {
    /**
     * - Default number of documents per page
     */
    defaultLimit?: number;
    /**
     * - Maximum allowed limit
     */
    maxLimit?: number;
    /**
     * - Maximum allowed page number
     */
    maxPage?: number;
    /**
     * - Page number that triggers performance warning
     */
    deepPageThreshold?: number;
    /**
     * - Cursor version for forward compatibility
     */
    cursorVersion?: number;
    /**
     * - Use estimatedDocumentCount for faster counts on large collections
     */
    useEstimatedCount?: boolean;
};
export type OffsetPaginationOptions = {
    /**
     * - MongoDB query filters
     */
    filters?: Record<string, any>;
    /**
     * - Sort specification
     */
    sort?: Record<string, 1 | -1>;
    /**
     * - Page number (1-indexed)
     */
    page?: number;
    /**
     * - Number of documents per page
     */
    limit?: number;
    /**
     * - Fields to select
     */
    select?: string | string[];
    /**
     * - Fields to populate
     */
    populate?: string | string[] | PopulateOptions | PopulateOptions[];
    /**
     * - Return plain JavaScript objects
     */
    lean?: boolean;
    /**
     * - MongoDB session for transactions
     */
    session?: ClientSession;
};
export type KeysetPaginationOptions = {
    /**
     * - MongoDB query filters
     */
    filters?: Record<string, any>;
    /**
     * - Sort specification (required at runtime)
     */
    sort?: Record<string, 1 | -1>;
    /**
     * - Cursor token for next page
     */
    after?: string;
    /**
     * - Number of documents per page
     */
    limit?: number;
    /**
     * - Fields to select
     */
    select?: string | string[];
    /**
     * - Fields to populate
     */
    populate?: string | string[] | PopulateOptions | PopulateOptions[];
    /**
     * - Return plain JavaScript objects
     */
    lean?: boolean;
    /**
     * - MongoDB session for transactions
     */
    session?: ClientSession;
};
export type AggregatePaginationOptions = {
    /**
     * - Aggregation pipeline stages
     */
    pipeline?: any[];
    /**
     * - Page number (1-indexed)
     */
    page?: number;
    /**
     * - Number of documents per page
     */
    limit?: number;
    /**
     * - MongoDB session for transactions
     */
    session?: ClientSession;
};
export type OffsetPaginationResult = {
    /**
     * - Pagination method used
     */
    method: "offset";
    /**
     * - Array of documents
     */
    docs: any[];
    /**
     * - Current page number
     */
    page: number;
    /**
     * - Documents per page
     */
    limit: number;
    /**
     * - Total document count
     */
    total: number;
    /**
     * - Total page count
     */
    pages: number;
    /**
     * - Whether next page exists
     */
    hasNext: boolean;
    /**
     * - Whether previous page exists
     */
    hasPrev: boolean;
    /**
     * - Performance warning for deep pagination
     */
    warning?: string;
};
export type KeysetPaginationResult = {
    /**
     * - Pagination method used
     */
    method: "keyset";
    /**
     * - Array of documents
     */
    docs: any[];
    /**
     * - Documents per page
     */
    limit: number;
    /**
     * - Whether more documents exist
     */
    hasMore: boolean;
    /**
     * - Cursor token for next page
     */
    next: string | null;
};
export type AggregatePaginationResult = {
    /**
     * - Pagination method used
     */
    method: "aggregate";
    /**
     * - Array of documents
     */
    docs: any[];
    /**
     * - Current page number
     */
    page: number;
    /**
     * - Documents per page
     */
    limit: number;
    /**
     * - Total document count
     */
    total: number;
    /**
     * - Total page count
     */
    pages: number;
    /**
     * - Whether next page exists
     */
    hasNext: boolean;
    /**
     * - Whether previous page exists
     */
    hasPrev: boolean;
    /**
     * - Performance warning for deep pagination
     */
    warning?: string;
};
//# sourceMappingURL=PaginationEngine.d.ts.map