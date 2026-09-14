/**
 * Filter Utilities
 *
 * Build MongoDB filters for keyset pagination with proper cursor positioning.
 */

import type { AnyDocument, FilterQuery, ObjectId, SortSpec } from '../../types/core.js';

/**
 * Combine the caller's filters with the keyset position predicate.
 *
 * NEVER by spreading. `{ ...baseFilters, $or: position }` REPLACES a caller's own
 * `$or`, and `{ ...baseFilters, _id: { $lt } }` replaces a caller's `_id: { $in }` —
 * so page 1 honoured the filter and page 2 silently widened past it. Nothing threw;
 * the second page simply had rows the first page's filter excluded.
 *
 * `$and` composes without collision whatever keys either side uses. The spread is
 * kept only when no key is shared, because a flat filter is what every existing
 * test, index hint and explain plan was written against.
 */
function combine(
  baseFilters: FilterQuery<AnyDocument>,
  position: Record<string, unknown>,
): FilterQuery<AnyDocument> {
  const collides = Object.keys(position).some((key) => key in baseFilters);
  if (!collides) return { ...baseFilters, ...position } as FilterQuery<AnyDocument>;
  return { $and: [baseFilters, position] } as FilterQuery<AnyDocument>;
}

/**
 * The "strictly after this value" predicates for ONE field of the cascade,
 * with the null boundary handled on BOTH sides rather than emitted.
 *
 * BSON orders `null` (and a missing field, which sorts with it) below every
 * typed value, and `$gt`/`$lt` never cross that line: `{ $lt: 0 }` does not
 * match null, `{ $gt: null }` matches nothing. So a walk that reached the
 * boundary simply ended — `hasMore: false`, every null-valued row unread, and
 * no error. Four positions, four answers:
 *
 *   asc,  typed v → `{ $gt: v }`            nulls sorted BEFORE v; already passed
 *   asc,  null    → `{ $ne: null }`         every typed value comes after null
 *   desc, typed v → `{ $lt: v }` OR `null`  nulls sort AFTER every typed value
 *   desc, null    → nothing                 nulls are last; nothing follows
 *
 * A position can therefore need two branches (desc, typed) or none (desc,
 * null), which is why this returns a list and the cascade emits one `$or`
 * branch per entry. `{ field: null }` matches null AND missing — exactly the
 * set that sorts at that position.
 */
function afterValue(operator: '$gt' | '$lt', value: unknown): unknown[] {
  const isNull = value === null || value === undefined;
  if (operator === '$gt') return isNull ? [{ $ne: null }] : [{ $gt: value }];
  return isNull ? [] : [{ $lt: value }, null];
}

/**
 * Builds MongoDB filter for keyset pagination
 * Creates compound $or condition for proper cursor-based filtering
 *
 * Every field takes the operator from ITS OWN direction, so a mixed-direction
 * sort (`{ priority: 1, createdAt: -1 }`, the ESR-shaped index) paginates
 * correctly: "after (p, t)" is `p > p0 OR (p = p0 AND t < t0) OR (p = p0 AND
 * t = t0 AND _id < id0)`. The cascade is the tuple comparison; the directions
 * are per position in the tuple.
 *
 * @param baseFilters - Existing query filters
 * @param sort - Normalized sort specification (validated; `_id` present)
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
  const idOperator = (sort._id ?? sort[sortFields[0]] ?? -1) === 1 ? '$gt' : '$lt';

  // Single-field keyset — one sort field plus the `_id` tiebreaker.
  if (sortFields.length <= 1 && !cursorValues) {
    const primaryField = sortFields[0] || '_id';
    if (primaryField === '_id') {
      return combine(baseFilters, { _id: { [idOperator]: cursorId } });
    }
    const operator = sort[primaryField] === 1 ? '$gt' : '$lt';
    const ranges = afterValue(operator, cursorValue).map((r) => ({ [primaryField]: r }));
    const tie = { [primaryField]: cursorValue ?? null, _id: { [idOperator]: cursorId } };
    return combine(baseFilters, ranges.length ? { $or: [...ranges, tie] } : tie);
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
    const operator = field === '_id' ? idOperator : sort[field] === 1 ? '$gt' : '$lt';
    // Equality on all preceding fields (null here matches null AND missing,
    // which is the set that sorts at that position).
    const prefix: Record<string, unknown> = {};
    for (let j = 0; j < i; j++) {
      prefix[allFields[j]] = allValues[allFields[j]] ?? null;
    }
    // Zero, one or two branches — see `afterValue`. `_id` is never null, so it
    // gets the plain operator: a `{ _id: null }` branch would ride every
    // descending query and match nothing.
    const ranges =
      field === '_id' ? [{ [idOperator]: cursorId }] : afterValue(operator, allValues[field]);
    for (const range of ranges) {
      orConditions.push({ ...prefix, [field]: range });
    }
  }

  // Every branch dropped means the cursor sits past the last reachable row.
  // Match nothing — explicitly, rather than by returning the unfiltered base.
  if (orConditions.length === 0) return combine(baseFilters, { _id: { $in: [] } });
  return combine(baseFilters, { $or: orConditions });
}
