/**
 * Builds MongoDB filter for keyset pagination
 * Creates compound $or condition for proper cursor-based filtering
 *
 * @param {Record<string, any>} baseFilters - Existing query filters
 * @param {Record<string, 1|-1>} sort - Normalized sort specification
 * @param {any} cursorValue - Primary field value from cursor
 * @param {any} cursorId - _id value from cursor
 * @returns {Record<string, any>} MongoDB filter with keyset condition
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
export function buildKeysetFilter(baseFilters, sort, cursorValue, cursorId) {
  const primaryField = Object.keys(sort).find(k => k !== '_id') || '_id';
  const direction = sort[primaryField];
  const operator = direction === 1 ? '$gt' : '$lt';

  return {
    ...baseFilters,
    $or: [
      { [primaryField]: { [operator]: cursorValue } },
      {
        [primaryField]: cursorValue,
        _id: { [operator]: cursorId }
      }
    ]
  };
}
