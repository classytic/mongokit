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
): FilterQuery<AnyDocument> {
  const primaryField = Object.keys(sort).find((k) => k !== '_id') || '_id';
  const direction = sort[primaryField];
  const operator = direction === 1 ? '$gt' : '$lt';

  // Handle null/undefined cursor values
  // MongoDB sorts nulls before all other values in ascending order, after all in descending
  if (cursorValue === null || cursorValue === undefined) {
    if (direction === 1) {
      // Ascending: null is first → get nulls with greater _id, OR any non-null value
      return {
        ...baseFilters,
        $or: [{ [primaryField]: null, _id: { $gt: cursorId } }, { [primaryField]: { $ne: null } }],
      } as FilterQuery<AnyDocument>;
    } else {
      // Descending: null is last → get nulls with lesser _id only (nothing comes after null desc)
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
      {
        [primaryField]: cursorValue,
        _id: { [operator]: cursorId },
      },
    ],
  } as FilterQuery<AnyDocument>;
}
