/**
 * Search-term handling — length-capped sanitization plus the regex-mode
 * multi-field `$or` builder. Search terms are literal text, never regex
 * patterns: special characters are escaped, not rejected.
 */

import { createSafeRegex } from './regex-safety.js';
import type { ParserRuntime } from './runtime.js';

/** Trim + length-cap the raw search term (reject over-long input per policy). */
export function sanitizeSearch(rt: ParserRuntime, search: unknown): string | undefined {
  if (search === null || search === undefined || search === '') return undefined;

  let searchStr = String(search).trim();
  if (!searchStr) return undefined;

  if (searchStr.length > rt.options.maxSearchLength) {
    rt.reject(`Search query too long, truncating`, {
      length: searchStr.length,
      maxSearchLength: rt.options.maxSearchLength,
    });
    searchStr = searchStr.substring(0, rt.options.maxSearchLength);
  }

  return searchStr;
}

/**
 * Build regex-based multi-field search filters: an $or with case-insensitive
 * regex across all searchFields.
 *
 * @example
 * // searchFields: ['name', 'description', 'sku'], search: 'azure'
 * // Returns: [{ name: {$regex:/azure/i} }, { description: {...} }, { sku: {...} }]
 */
export function buildRegexSearch(
  rt: ParserRuntime,
  searchTerm: string,
): Record<string, unknown>[] | null {
  if (!rt.options.searchFields || rt.options.searchFields.length === 0) {
    return null;
  }

  // Create safe regex from search term (escapes special chars for literal
  // search — a term like "c++" must never reject, even in 'throw' mode)
  const safeRegex = createSafeRegex(rt, searchTerm, 'i', 'escape');
  if (!safeRegex) {
    return null;
  }

  const orConditions: Record<string, unknown>[] = [];
  for (const field of rt.options.searchFields) {
    orConditions.push({
      [field]: { $regex: safeRegex },
    });
  }

  return orConditions.length > 0 ? orConditions : null;
}
