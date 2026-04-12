/**
 * Schema index compatibility check for keyset pagination.
 *
 * Keyset (cursor) pagination with filters + sort performs well only when a
 * compound index exists whose key ordering matches MongoDB's ESR rule:
 *
 *   Equality fields → Sort fields
 *
 * An index `{ a:1, b:1, c:-1 }` efficiently serves:
 *   - filter: { a, b }, sort: { c: -1 }
 *   - filter: { a, b }, sort: { c: 1 }   (index walked in reverse)
 *
 * The warning emitted by PaginationEngine.stream() is only useful when no
 * such index exists. This module inspects the schema's declared indexes and
 * answers the question cheaply.
 *
 * Caveat: schema.indexes() does NOT return indexes created directly on the
 * underlying collection (e.g. via migrations or db.collection.createIndex()).
 * Callers should phrase any warning as "no matching schema-declared index"
 * to avoid a second class of false positives.
 */

import type { Model } from 'mongoose';

/** Raw schema index tuple shape. */
export type SchemaIndexTuple = [Record<string, unknown>, Record<string, unknown>?];

/**
 * Read a Mongoose schema's declared indexes, defensively.
 * Returns an empty array on any introspection failure.
 */
export function readSchemaIndexes(
  Model: Model<unknown> | { schema?: unknown },
): SchemaIndexTuple[] {
  try {
    const schema = (Model as { schema?: { indexes?: () => SchemaIndexTuple[] } }).schema;
    if (!schema || typeof schema.indexes !== 'function') return [];
    const raw = schema.indexes();
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * Does any schema-declared compound index satisfy ESR for the given
 * equality filter fields + sort?
 *
 * Rules:
 *   1. The first N keys of the index (N = filterFields.length) must be
 *      exactly the equality filter fields in any order (set equality).
 *   2. The next M keys (M = sortKeys.length) must match the sort keys in
 *      exact declared order.
 *   3. Directions must all match OR all be inverse (MongoDB can walk an
 *      index in reverse, but only if every sort field flips together).
 *   4. Indexes with more total keys than needed are still accepted when
 *      the above prefix holds — Mongo just ignores trailing fields.
 *
 * Notes:
 *   - Hashed / text / 2dsphere indexes are skipped (not usable for sort).
 *   - Unique, partial, sparse options don't affect compatibility.
 *   - When `filterFields` is empty, a sort-only prefix match is sufficient.
 *
 * @param indexes      Raw `[spec, options?]` tuples from `schema.indexes()`.
 * @param filterFields Top-level equality filter keys (already stripped of `$*`).
 * @param sort         Normalized sort spec `{ field: 1 | -1 }`.
 */
export function hasCompatibleKeysetIndex(
  indexes: SchemaIndexTuple[],
  filterFields: string[],
  sort: Record<string, 1 | -1>,
): boolean {
  const sortKeys = Object.keys(sort);
  if (sortKeys.length === 0) return true; // degenerate — caller wouldn't warn

  const filterSet = new Set(filterFields);
  const prefixLen = filterFields.length;

  for (const [spec] of indexes) {
    if (!spec || typeof spec !== 'object') continue;

    const entries = Object.entries(spec);
    if (entries.length < prefixLen + sortKeys.length) continue;

    // Skip non-btree indexes — "text", "2dsphere", "hashed" directions can't
    // serve an ordered sort.
    const hasNonBtree = entries.some(([, dir]) => typeof dir !== 'number');
    if (hasNonBtree) continue;

    // 1. Equality prefix: first `prefixLen` keys must equal filterFields as a set.
    const equalityPrefix = entries.slice(0, prefixLen).map(([k]) => k);
    if (equalityPrefix.length !== prefixLen) continue;
    const prefixOk =
      equalityPrefix.every((k) => filterSet.has(k)) && new Set(equalityPrefix).size === prefixLen;
    if (!prefixOk) continue;

    // 2. Sort suffix: next `sortKeys.length` entries must match sort keys in order.
    const sortSuffix = entries.slice(prefixLen, prefixLen + sortKeys.length);
    if (sortSuffix.length !== sortKeys.length) continue;

    let namesMatch = true;
    for (let i = 0; i < sortKeys.length; i++) {
      if (sortSuffix[i][0] !== sortKeys[i]) {
        namesMatch = false;
        break;
      }
    }
    if (!namesMatch) continue;

    // 3. Direction: all match, or all inverse.
    const forward = sortKeys.every((k, i) => sortSuffix[i][1] === sort[k]);
    const reverse = sortKeys.every((k, i) => sortSuffix[i][1] === -sort[k]);
    if (forward || reverse) return true;
  }

  return false;
}
