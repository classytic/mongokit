/**
 * Limit Utilities
 * 
 * Validation and calculation helpers for pagination limits and pages.
 */

import type { PaginationConfig } from '../../types.js';

/**
 * Validates and sanitizes limit value
 * Parses strings to numbers and prevents NaN bugs
 *
 * @param limit - Requested limit
 * @param config - Pagination configuration
 * @returns Sanitized limit between 1 and maxLimit
 */
export function validateLimit(limit: number | string, config: PaginationConfig): number {
  const parsed = Number(limit);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return config.defaultLimit || 10;
  }

  return Math.min(Math.floor(parsed), config.maxLimit || 100);
}

/**
 * Validates and sanitizes page number
 * Parses strings to numbers and prevents NaN bugs
 *
 * @param page - Requested page (1-indexed)
 * @param config - Pagination configuration
 * @returns Sanitized page number >= 1
 * @throws Error if page exceeds maxPage
 */
export function validatePage(page: number | string, config: PaginationConfig): number {
  const parsed = Number(page);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  const sanitized = Math.floor(parsed);

  if (sanitized > (config.maxPage || 10000)) {
    throw new Error(`Page ${sanitized} exceeds maximum ${config.maxPage || 10000}`);
  }

  return sanitized;
}

/**
 * Checks if page number should trigger deep pagination warning
 *
 * @param page - Current page number
 * @param threshold - Warning threshold
 * @returns True if warning should be shown
 */
export function shouldWarnDeepPagination(page: number, threshold: number): boolean {
  return page > threshold;
}

/**
 * Calculates number of documents to skip for offset pagination
 *
 * @param page - Page number (1-indexed)
 * @param limit - Documents per page
 * @returns Number of documents to skip
 */
export function calculateSkip(page: number, limit: number): number {
  return (page - 1) * limit;
}

/**
 * Calculates total number of pages
 *
 * @param total - Total document count
 * @param limit - Documents per page
 * @returns Total number of pages
 */
export function calculateTotalPages(total: number, limit: number): number {
  return Math.ceil(total / limit);
}
