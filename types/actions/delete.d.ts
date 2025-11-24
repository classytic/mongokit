/**
 * Delete by ID
 */
export function deleteById(Model: any, id: any, options?: {}): Promise<{
    success: boolean;
    message: string;
}>;
/**
 * Delete many documents
 */
export function deleteMany(Model: any, query: any, options?: {}): Promise<{
    success: boolean;
    count: any;
    message: string;
}>;
/**
 * Delete by query
 */
export function deleteByQuery(Model: any, query: any, options?: {}): Promise<{
    success: boolean;
    message: string;
}>;
/**
 * Soft delete (set deleted flag)
 */
export function softDelete(Model: any, id: any, options?: {}): Promise<{
    success: boolean;
    message: string;
}>;
/**
 * Restore soft deleted document
 */
export function restore(Model: any, id: any, options?: {}): Promise<{
    success: boolean;
    message: string;
}>;
//# sourceMappingURL=delete.d.ts.map