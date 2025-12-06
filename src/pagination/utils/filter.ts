/**
 * Filter Utilities
 * 
 * Build MongoDB filters for keyset pagination with proper cursor positioning.
 */

import type { SortSpec, FilterQuery, AnyDocument, ObjectId } from '../../types.js';

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
  cursorId: ObjectId | string
): FilterQuery<AnyDocument> {
  const primaryField = Object.keys(sort).find(k => k !== '_id') || '_id';
  const direction = sort[primaryField];
  const operator = direction === 1 ? '$gt' : '$lt';

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
