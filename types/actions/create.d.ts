/**
 * Create Actions
 * Pure functions for document creation
 */
/**
 * Create single document
 */
export function create(Model: any, data: any, options?: {}): Promise<any>;
/**
 * Create multiple documents
 */
export function createMany(Model: any, dataArray: any, options?: {}): Promise<any>;
/**
 * Create with defaults (useful for initialization)
 */
export function createDefault(Model: any, overrides?: {}, options?: {}): Promise<any>;
/**
 * Upsert (create or update)
 */
export function upsert(Model: any, query: any, data: any, options?: {}): Promise<any>;
//# sourceMappingURL=create.d.ts.map