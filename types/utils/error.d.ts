/**
 * Creates an error with HTTP status code
 *
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @returns {Error & {status: number}} Error with status property
 */
export function createError(status: number, message: string): Error & {
    status: number;
};
//# sourceMappingURL=error.d.ts.map