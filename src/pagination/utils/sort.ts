/**
 * Sort Utilities
 * 
 * Normalization and validation of sort specifications for pagination.
 */

import type { SortSpec, SortDirection } from '../../types.js';

/**
 * Normalizes sort object to ensure stable key order
 * Primary fields first, _id last (not alphabetical)
 *
 * @param sort - Sort specification
 * @returns Normalized sort with stable key order
 */
export function normalizeSort(sort: SortSpec): SortSpec {
  const normalized: SortSpec = {};

  Object.keys(sort).forEach(key => {
    if (key !== '_id') normalized[key] = sort[key];
  });

  if (sort._id !== undefined) {
    normalized._id = sort._id;
  }

  return normalized;
}

/**
 * Validates and normalizes sort for keyset pagination
 * Auto-adds _id tie-breaker if needed
 * Ensures _id direction matches primary field
 *
 * @param sort - Sort specification
 * @returns Validated and normalized sort
 * @throws Error if sort is invalid for keyset pagination
 */
export function validateKeysetSort(sort: SortSpec): SortSpec {
  const keys = Object.keys(sort);

  if (keys.length === 1 && keys[0] !== '_id') {
    const field = keys[0];
    const direction = sort[field];
    return normalizeSort({ [field]: direction, _id: direction });
  }

  if (keys.length === 1 && keys[0] === '_id') {
    return normalizeSort(sort);
  }

  if (keys.length === 2) {
    if (!keys.includes('_id')) {
      throw new Error('Keyset pagination requires _id as tie-breaker');
    }

    const primaryField = keys.find(k => k !== '_id')!;
    const primaryDirection = sort[primaryField];
    const idDirection = sort._id;

    if (primaryDirection !== idDirection) {
      throw new Error('_id direction must match primary field direction');
    }

    return normalizeSort(sort);
  }

  throw new Error('Keyset pagination only supports single field + _id');
}

/**
 * Inverts sort directions (1 becomes -1, -1 becomes 1)
 *
 * @param sort - Sort specification
 * @returns Inverted sort
 */
export function invertSort(sort: SortSpec): SortSpec {
  const inverted: SortSpec = {};

  Object.keys(sort).forEach(key => {
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
  return keys.find(k => k !== '_id') || '_id';
}

/**
 * Gets sort direction for a specific field
 *
 * @param sort - Sort specification
 * @param field - Field name
 * @returns Sort direction
 */
export function getDirection(sort: SortSpec, field: string): SortDirection | undefined {
  return sort[field];
}
