/**
 * Update by ID
 */
export function update(Model: any, id: any, data: any, options?: {}): Promise<any>;
/**
 * Update with query constraints (optimized)
 * Returns null if constraints not met (not an error)
 */
export function updateWithConstraints(Model: any, id: any, data: any, constraints?: {}, options?: {}): Promise<any>;
/**
 * Update with validation (smart optimization)
 * 1-query on success, 2-queries for detailed errors
 */
export function updateWithValidation(Model: any, id: any, data: any, validationOptions?: {}, options?: {}): Promise<{
    success: boolean;
    data: any;
    error?: undefined;
} | {
    success: boolean;
    error: {
        code: number;
        message: string;
        violations?: undefined;
    };
    data?: undefined;
} | {
    success: boolean;
    error: {
        code: number;
        message: any;
        violations: any;
    };
    data?: undefined;
}>;
/**
 * Update many documents
 */
export function updateMany(Model: any, query: any, data: any, options?: {}): Promise<{
    matchedCount: any;
    modifiedCount: any;
}>;
/**
 * Update by query
 */
export function updateByQuery(Model: any, query: any, data: any, options?: {}): Promise<any>;
/**
 * Increment field
 */
export function increment(Model: any, id: any, field: any, value?: number, options?: {}): Promise<any>;
/**
 * Push to array
 */
export function pushToArray(Model: any, id: any, field: any, value: any, options?: {}): Promise<any>;
/**
 * Pull from array
 */
export function pullFromArray(Model: any, id: any, field: any, value: any, options?: {}): Promise<any>;
//# sourceMappingURL=update.d.ts.map