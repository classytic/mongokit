/**
 * AggRequest → input normalization.
 *
 * Tiny helpers shared by every stage of the aggregate-IR compiler. They
 * don't know about MongoDB or pipelines — they only normalize the
 * portable repo-core IR inputs into a stable shape the downstream
 * modules consume. Same split as sqlitekit's aggregate module so
 * anyone reading both kits sees identical structure.
 */

import type { AggRequest } from '@classytic/repo-core/repository';

/**
 * Normalize `AggRequest['groupBy']` into a readonly string array.
 * Returns `[]` for scalar aggregation (no groupBy). Downstream
 * compilers treat `[]` uniformly — one `$group: { _id: null, ... }`
 * stage, no per-key projection.
 */
export function normalizeGroupBy(groupBy: AggRequest['groupBy']): readonly string[] {
  if (!groupBy) return [];
  if (typeof groupBy === 'string') return [groupBy];
  return groupBy;
}

/**
 * Fail loud on an empty measures bag — there's nothing to compute and
 * the caller's code path is almost certainly a wiring bug (conditional
 * collapsed, key renamed, etc.). Silently returning `{ rows: [] }`
 * would mask it.
 */
export function validateMeasures(measures: AggRequest['measures']): void {
  if (!measures || Object.keys(measures).length === 0) {
    throw new Error(
      'mongokit/aggregate: AggRequest requires at least one measure — empty measures bag is a wiring bug',
    );
  }
}
