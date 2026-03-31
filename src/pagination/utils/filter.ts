/**
 * Filter Utilities
 *
 * Build MongoDB filters for keyset pagination with proper cursor positioning.
 */

import type { AnyDocument, FilterQuery, ObjectId, SortSpec } from '../../types.js';

/**
 * Builds MongoDB filter for keyset pagination
 * Creates compound $or condition for proper cursor-based filtering
 *
 * @param baseFilters - Existing query filters
 * @param sort - Normalized sort specification
 * @param cursorValue - Primary field value from cursor
 * @param cursorId - _id value from cursor
 * @returns MongoDB filter with keyset condition
 *
 * @example
 * buildKeysetFilter(
 *   { status: 'active' },
 *   { createdAt: -1, _id: -1 },
 *   new Date('2024-01-01'),
 *   new ObjectId('...')
 * )
 * // Returns:
 * // {
 * //   status: 'active',
 * //   $or: [
 * //     { createdAt: { $lt: Date('2024-01-01') } },
 * //     { createdAt: Date('2024-01-01'), _id: { $lt: ObjectId('...') } }
 * //   ]
 * // }
 */
export function buildKeysetFilter(
  baseFilters: FilterQuery<AnyDocument>,
  sort: SortSpec,
  cursorValue: unknown,
  cursorId: ObjectId | string,
  /** Compound sort values for multi-field keyset (field → rehydrated value) */
  cursorValues?: Record<string, unknown>,
): FilterQuery<AnyDocument> {
  const sortFields = Object.keys(sort).filter((k) => k !== '_id');

  // Single-field keyset (legacy path)
  if (sortFields.length <= 1 && !cursorValues) {
    const primaryField = sortFields[0] || '_id';
    const direction = sort[primaryField];
    const operator = direction === 1 ? '$gt' : '$lt';

    if (cursorValue === null || cursorValue === undefined) {
      if (direction === 1) {
        return {
          ...baseFilters,
          $or: [
            { [primaryField]: null, _id: { $gt: cursorId } },
            { [primaryField]: { $ne: null } },
          ],
        } as FilterQuery<AnyDocument>;
      } else {
        return {
          ...baseFilters,
          [primaryField]: null,
          _id: { $lt: cursorId },
        } as FilterQuery<AnyDocument>;
      }
    }

    return {
      ...baseFilters,
      $or: [
        { [primaryField]: { [operator]: cursorValue } },
        { [primaryField]: cursorValue, _id: { [operator]: cursorId } },
      ],
    } as FilterQuery<AnyDocument>;
  }

  // Compound keyset: build cascading $or for N sort fields + _id tie-breaker
  // For { a: -1, b: -1, _id: -1 } with cursor {a: 5, b: date, _id: id}:
  // $or: [
  //   { a: { $lt: 5 } },
  //   { a: 5, b: { $lt: date } },
  //   { a: 5, b: date, _id: { $lt: id } }
  // ]
  const values = cursorValues || { [sortFields[0]]: cursorValue };
  const allFields = [...sortFields, '_id'];
  const allValues: Record<string, unknown> = { ...values, _id: cursorId };
  const orConditions: Record<string, unknown>[] = [];

  for (let i = 0; i < allFields.length; i++) {
    const field = allFields[i];
    // _id inherits direction from first sort field (validated by validateKeysetSort)
    const direction = sort[field] ?? sort[sortFields[0]];
    const operator = direction === 1 ? '$gt' : '$lt';
    const condition: Record<string, unknown> = {};

    // Equality on all preceding fields
    for (let j = 0; j < i; j++) {
      condition[allFields[j]] = allValues[allFields[j]];
    }

    // Range on current field
    condition[field] = { [operator]: allValues[field] };
    orConditions.push(condition);
  }

  return { ...baseFilters, $or: orConditions } as FilterQuery<AnyDocument>;
}
