/**
 * @typedef {Object} PaginationConfig
 * @property {number} defaultLimit - Default limit value
 * @property {number} maxLimit - Maximum allowed limit
 * @property {number} maxPage - Maximum allowed page number
 */

/**
 * Validates and sanitizes limit value
 * Parses strings to numbers and prevents NaN bugs
 *
 * @param {number|string} limit - Requested limit
 * @param {PaginationConfig} config - Pagination configuration
 * @returns {number} Sanitized limit between 1 and maxLimit
 */
export function validateLimit(limit, config) {
  const parsed = Number(limit);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return config.defaultLimit || 10;
  }

  return Math.min(Math.floor(parsed), config.maxLimit);
}

/**
 * Validates and sanitizes page number
 * Parses strings to numbers and prevents NaN bugs
 *
 * @param {number|string} page - Requested page (1-indexed)
 * @param {PaginationConfig} config - Pagination configuration
 * @returns {number} Sanitized page number >= 1
 * @throws {Error} If page exceeds maxPage
 */
export function validatePage(page, config) {
  const parsed = Number(page);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  const sanitized = Math.floor(parsed);

  if (sanitized > config.maxPage) {
    throw new Error(`Page ${sanitized} exceeds maximum ${config.maxPage}`);
  }

  return sanitized;
}

/**
 * Checks if page number should trigger deep pagination warning
 *
 * @param {number} page - Current page number
 * @param {number} threshold - Warning threshold
 * @returns {boolean} True if warning should be shown
 */
export function shouldWarnDeepPagination(page, threshold) {
  return page > threshold;
}

/**
 * Calculates number of documents to skip for offset pagination
 *
 * @param {number} page - Page number (1-indexed)
 * @param {number} limit - Documents per page
 * @returns {number} Number of documents to skip
 */
export function calculateSkip(page, limit) {
  return (page - 1) * limit;
}

/**
 * Calculates total number of pages
 *
 * @param {number} total - Total document count
 * @param {number} limit - Documents per page
 * @returns {number} Total number of pages
 */
export function calculateTotalPages(total, limit) {
  return Math.ceil(total / limit);
}
