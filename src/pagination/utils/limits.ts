/**
 * Limit Utilities
 *
 * Validation and calculation helpers for pagination limits and pages.
 */

import type { PaginationConfig } from '../../types/pagination.js';
import { createError } from '../../utils/error.js';

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
    return config.defaultLimit ?? 10;
  }

  // maxLimit: 0 means unlimited — no cap applied
  const max = config.maxLimit ?? 100;
  if (max === 0) return Math.floor(parsed);
  return Math.min(Math.floor(parsed), max);
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

  const max = config.maxPage || 10000;
  if (sanitized > max) {
    /**
     * 400, not a bare `Error`.
     *
     * The page number comes from the querystring, so this is the caller's
     * mistake — a crawler walking past the end, a fuzzer, a stale deep link.
     * A bare `Error` carries no status, so every framework above maps it to
     * `internal_error` 500: the request is refused either way, but one of them
     * pages an on-call engineer and burns an error budget over `?page=999999`.
     *
     * It matters more the lower `maxPage` is set, and a deployment that has
     * tuned it down for the skip cost is exactly the one getting this traffic.
     */
    throw createError(400, `Page ${sanitized} exceeds maximum ${max}`, {
      code: 'PAGE_OUT_OF_RANGE',
      meta: { page: sanitized, maxPage: max },
    });
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
