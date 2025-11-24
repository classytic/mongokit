/**
 * Encodes document values and sort metadata into a base64 cursor token
 *
 * @param {any} doc - Document to extract cursor values from
 * @param {string} primaryField - Primary sort field name
 * @param {Record<string, 1|-1>} sort - Normalized sort specification
 * @param {number} [version=1] - Cursor version for forward compatibility
 * @returns {string} Base64-encoded cursor token
 */
export function encodeCursor(doc: any, primaryField: string, sort: Record<string, 1 | -1>, version?: number): string;
/**
 * Decodes a cursor token back into document values and sort metadata
 *
 * @param {string} token - Base64-encoded cursor token
 * @returns {{value: any, id: any, sort: Record<string, 1|-1>, version: number}} Decoded cursor data
 * @throws {Error} If token is invalid or malformed
 */
export function decodeCursor(token: string): {
    value: any;
    id: any;
    sort: Record<string, 1 | -1>;
    version: number;
};
/**
 * Validates that cursor sort matches current query sort
 *
 * @param {Record<string, 1|-1>} cursorSort - Sort specification from cursor
 * @param {Record<string, 1|-1>} currentSort - Sort specification from query
 * @throws {Error} If sorts don't match
 */
export function validateCursorSort(cursorSort: Record<string, 1 | -1>, currentSort: Record<string, 1 | -1>): void;
/**
 * Validates cursor version matches expected version
 *
 * @param {number} cursorVersion - Version from cursor
 * @param {number} expectedVersion - Expected version from config
 * @throws {Error} If versions don't match
 */
export function validateCursorVersion(cursorVersion: number, expectedVersion: number): void;
//# sourceMappingURL=cursor.d.ts.map