/**
 * Normalizes sort object to ensure stable key order
 * Primary fields first, _id last (not alphabetical)
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @returns {Record<string, 1|-1>} Normalized sort with stable key order
 */
export function normalizeSort(sort: Record<string, 1 | -1>): Record<string, 1 | -1>;
/**
 * Validates and normalizes sort for keyset pagination
 * Auto-adds _id tie-breaker if needed
 * Ensures _id direction matches primary field
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @returns {Record<string, 1|-1>} Validated and normalized sort
 * @throws {Error} If sort is invalid for keyset pagination
 */
export function validateKeysetSort(sort: Record<string, 1 | -1>): Record<string, 1 | -1>;
/**
 * Inverts sort directions (1 becomes -1, -1 becomes 1)
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @returns {Record<string, 1|-1>} Inverted sort
 */
export function invertSort(sort: Record<string, 1 | -1>): Record<string, 1 | -1>;
/**
 * Extracts primary sort field (first non-_id field)
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @returns {string} Primary field name
 */
export function getPrimaryField(sort: Record<string, 1 | -1>): string;
/**
 * Gets sort direction for a specific field
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @param {string} field - Field name
 * @returns {1|-1|undefined} Sort direction
 */
export function getDirection(sort: Record<string, 1 | -1>, field: string): 1 | -1 | undefined;
//# sourceMappingURL=sort.d.ts.map