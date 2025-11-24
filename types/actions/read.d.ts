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
export function getById(Model: Model, id: string, options?: {
    select?: string | string[];
    populate?: string | string[] | PopulateOptions | PopulateOptions[];
    lean?: boolean;
    session?: ClientSession;
    throwOnNotFound?: boolean;
}): Promise<any>;
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
export function getByQuery(Model: Model, query: Record<string, any>, options?: {
    select?: string | string[];
    populate?: string | string[] | PopulateOptions | PopulateOptions[];
    lean?: boolean;
    session?: ClientSession;
    throwOnNotFound?: boolean;
}): Promise<any>;
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
export function tryGetByQuery(Model: Model, query: Record<string, any>, options?: {
    select?: string | string[];
    populate?: string | string[] | PopulateOptions | PopulateOptions[];
    lean?: boolean;
    session?: ClientSession;
}): Promise<any | null>;
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
export function getAll(Model: Model, query?: Record<string, any>, options?: {
    select?: string | string[];
    populate?: string | string[] | PopulateOptions | PopulateOptions[];
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
    lean?: boolean;
    session?: ClientSession;
}): Promise<any[]>;
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
export function getOrCreate(Model: Model, query: Record<string, any>, createData: Record<string, any>, options?: {
    session?: ClientSession;
    updatePipeline?: boolean;
}): Promise<any>;
/**
 * Count documents matching query
 *
 * @param {Model} Model - Mongoose model
 * @param {Record<string, any>} [query={}] - MongoDB query
 * @param {Object} [options={}] - Query options
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<number>} Document count
 */
export function count(Model: Model, query?: Record<string, any>, options?: {
    session?: ClientSession;
}): Promise<number>;
/**
 * Check if document exists
 *
 * @param {Model} Model - Mongoose model
 * @param {Record<string, any>} query - MongoDB query
 * @param {Object} [options={}] - Query options
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<{_id: any} | null>} Document ID if exists, null otherwise
 */
export function exists(Model: Model, query: Record<string, any>, options?: {
    session?: ClientSession;
}): Promise<{
    _id: any;
} | null>;
export type Model = import("mongoose").Model<any, any, any, any, any, any, any>;
export type PopulateOptions = import("mongoose").PopulateOptions;
export type ClientSession = import("mongoose").ClientSession;
//# sourceMappingURL=read.d.ts.map