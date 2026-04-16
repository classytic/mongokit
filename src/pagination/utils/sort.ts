/**
 * Sort Utilities
 *
 * Normalization and validation of sort specifications for pagination.
 */

import type { SortDirection, SortSpec } from '../../types.js';

/**
 * Normalizes sort object to ensure stable key order
 * Primary fields first, _id last (not alphabetical)
 *
 * @param sort - Sort specification
 * @returns Normalized sort with stable key order
 */
export function normalizeSort(sort: SortSpec): SortSpec {
  const normalized: SortSpec = {};

  Object.keys(sort).forEach((key) => {
    if (key !== '_id') normalized[key] = sort[key];
  });

  if (sort._id !== undefined) {
    normalized._id = sort._id;
  }

  return normalized;
}

/**
 * Validates and normalizes sort for keyset pagination.
 * Auto-adds `_id` tie-breaker if needed; ensures `_id` direction matches the
 * primary field.
 *
 * **Known limitation (MongoDB mixed-type sort):** keyset pagination across a
 * field that can hold both typed values (Date, Number) and `null`/`undefined`
 * is lossy — `$lt/$gt` don't cross the type boundary in BSON comparison, so
 * some docs at the null/non-null boundary are unreachable. If your sort field
 * is nullable, either:
 *   - sort by `_id` alone (always safe), or
 *   - use `allowedPrimaryFields` to lock keyset sort to fields your schema
 *     guarantees non-null (see `PaginationConfig.strictKeysetSortFields`).
 *
 * @param sort - Sort specification
 * @param allowedPrimaryFields - Optional allowlist of primary (non-_id) sort
 *   field names. When set, rejects sorts whose primary field isn't listed.
 *   `_id` is always allowed.
 * @returns Validated and normalized sort
 * @throws Error if sort is invalid for keyset pagination
 */
export function validateKeysetSort(sort: SortSpec, allowedPrimaryFields?: string[]): SortSpec {
  const keys = Object.keys(sort);

  if (keys.length === 0) {
    throw new Error('Keyset pagination requires at least one sort field');
  }

  // Single _id only
  if (keys.length === 1 && keys[0] === '_id') {
    return normalizeSort(sort);
  }

  // Validate all direction values are strictly 1 or -1
  for (const key of keys) {
    if (sort[key] !== 1 && sort[key] !== -1) {
      throw new Error(`Invalid sort direction for "${key}": must be 1 or -1, got ${sort[key]}`);
    }
  }

  // Determine the direction from the first non-_id field
  const nonIdKeys = keys.filter((k) => k !== '_id');
  const primaryDirection = sort[nonIdKeys[0]];

  // Allowlist gate — if configured, the primary field must be on the list.
  // Rejects at validation time rather than silently returning partial results
  // when the sort field turns out to be null for some docs.
  if (allowedPrimaryFields && allowedPrimaryFields.length > 0) {
    for (const key of nonIdKeys) {
      if (!allowedPrimaryFields.includes(key)) {
        throw new Error(
          `Keyset sort field "${key}" is not in the strictKeysetSortFields allowlist. ` +
            `Allowed: ${allowedPrimaryFields.join(', ')}. ` +
            `(See PaginationConfig.strictKeysetSortFields — protects against lossy ` +
            `null/non-null keyset boundaries.)`,
        );
      }
    }
  }

  // All non-_id fields must share the same direction
  for (const key of nonIdKeys) {
    if (sort[key] !== primaryDirection) {
      throw new Error('All sort fields must share the same direction for keyset pagination');
    }
  }

  // If _id is present, it must match the direction
  if (keys.includes('_id') && sort._id !== primaryDirection) {
    throw new Error('_id direction must match primary field direction');
  }

  // Auto-add _id as tie-breaker if not present
  if (!keys.includes('_id')) {
    return normalizeSort({ ...sort, _id: primaryDirection });
  }

  return normalizeSort(sort);
}

/**
 * Inverts sort directions (1 becomes -1, -1 becomes 1)
 *
 * @param sort - Sort specification
 * @returns Inverted sort
 */
export function invertSort(sort: SortSpec): SortSpec {
  const inverted: SortSpec = {};

  Object.keys(sort).forEach((key) => {
    inverted[key] = (sort[key] === 1 ? -1 : 1) as SortDirection;
  });

  return inverted;
}

/**
 * Extracts primary sort field (first non-_id field)
 *
 * @param sort - Sort specification
 * @returns Primary field name
 */
export function getPrimaryField(sort: SortSpec): string {
  const keys = Object.keys(sort);
  return keys.find((k) => k !== '_id') || '_id';
}
