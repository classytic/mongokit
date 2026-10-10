/**
 * Pagination guards shared by every paged read: the deep-offset refusal, the unique `_id`
 * tiebreaker that makes a sort a total order, and the cursor SCOPE fingerprint — a hash of
 * (collection, post-policy filter, collation) carried in every cursor, so a cursor replayed
 * against another collection, tenant, filter or collation is refused, never re-anchored.
 */

import { createHash } from 'node:crypto';
import type { HttpError } from '@classytic/repo-core/errors';
import type { SortSpec } from '../../types/core.js';
import { createError } from '../../utils/error.js';

export const PAGINATION_ERROR_CODES = {
  OFFSET_TOO_DEEP: 'mongokit.pagination.offset_too_deep',
  CURSOR_INVALID: 'mongokit.cursor.invalid',
  CURSOR_SCOPE_MISMATCH: 'mongokit.cursor.scope_mismatch',
} as const;

/** Refuse an offset page whose skip exceeds the cap: the scan cost grows with the skip. */
export function assertOffsetWithinCap(skip: number, maxOffset: number): void {
  if (skip > maxOffset) {
    throw createError(
      400,
      `Offset ${skip} exceeds the deepest allowed offset (${maxOffset}); page with keyset (sort + after) instead`,
      { code: PAGINATION_ERROR_CODES.OFFSET_TOO_DEEP, meta: { skip, maxOffset } },
    );
  }
}

/** Append `_id` (in the last key's direction) unless the sort already ends on it. */
export function withIdTiebreak(sort: SortSpec): SortSpec {
  const keys = Object.keys(sort);
  if (keys.length === 0 || keys.includes('_id')) return sort;
  return { ...sort, _id: sort[keys[keys.length - 1] as string] ?? 1 };
}

/** Append each group key (ascending) that the sort does not already name: IR rows are unique per group. */
export function withGroupTiebreak(
  sort: Record<string, 1 | -1>,
  groupKeys: readonly string[],
): Record<string, 1 | -1> {
  const out = { ...sort };
  for (const key of groupKeys) if (!(key in out)) out[key] = 1;
  return out;
}

export function invalidCursor(message: string): HttpError {
  return createError(400, `Invalid cursor: ${message}`, {
    code: PAGINATION_ERROR_CODES.CURSOR_INVALID,
  });
}

export function cursorScopeMismatch(): HttpError {
  return createError(
    400,
    'Invalid cursor: it was issued for a different collection, tenant, filter or collation',
    { code: PAGINATION_ERROR_CODES.CURSOR_SCOPE_MISMATCH },
  );
}

function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof RegExp) return { $regex: value.toString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const hex = (value as { toHexString?: () => string }).toHexString;
    if (typeof hex === 'function') return { $oid: hex.call(value) };
    const bsontype = (value as { _bsontype?: string })._bsontype;
    if (bsontype) return { [`$${bsontype}`]: String(value) };
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** 16-hex fingerprint of what a cursor's position is relative to. */
export function cursorScope(collection: string, filters: unknown, collation: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([collection, canonical(filters), canonical(collation)]))
    .digest('hex')
    .slice(0, 16);
}
