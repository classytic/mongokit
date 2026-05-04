/**
 * Keyset (cursor) pagination helpers — mongokit binding.
 *
 * The kit-neutral half (cursor encode/decode + mode detection) lives
 * in `@classytic/repo-core/aggregate`. This file re-exports those bits
 * with the mongokit error prefix pre-bound, then layers on the
 * mongo-specific `buildKeysetPredicate` (emits a `$match` PipelineStage)
 * which has no SQL counterpart.
 *
 * **Sort keys reference OUTPUT columns** — `groupBy` field names,
 * `dateBuckets` aliases, and `measures` aliases all qualify. The
 * keyset predicate runs AFTER the post-group `$project` stage, which
 * is when the output column names exist.
 */

import {
  type DecodedCursor,
  decodeAggCursor as decodeAggCursorShared,
  encodeAggCursor,
  isKeysetMode,
} from '@classytic/repo-core/aggregate';
import type { PipelineStage } from 'mongoose';

export { type DecodedCursor, encodeAggCursor, isKeysetMode };

export function decodeAggCursor(cursor: string): DecodedCursor {
  return decodeAggCursorShared(cursor, 'mongokit');
}

/**
 * Build a `$match` stage that selects rows AFTER the cursor row given
 * the sort spec. Encodes the row-tuple comparison as a left-leaning
 * `$or` of progressively-deeper equality + tail inequality:
 *
 *   sort: { a: 1, b: -1, c: 1 }, after: { a, b, c }
 *   →  a > $a
 *      OR (a == $a AND b < $b)
 *      OR (a == $a AND b == $b AND c > $c)
 *
 * Returns `undefined` when the sort spec is empty or every cursor key
 * is missing — caller should reject those upstream rather than ship a
 * no-op stage.
 */
export function buildKeysetPredicate(
  sort: Record<string, 1 | -1>,
  cursor: DecodedCursor,
): PipelineStage.Match | undefined {
  const sortKeys = Object.keys(sort);
  if (sortKeys.length === 0) return undefined;

  const branches: Record<string, unknown>[] = [];
  for (let i = 0; i < sortKeys.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by sortKeys.length
    const tailKey = sortKeys[i]!;
    const tailDir = sort[tailKey];
    const tailOp = tailDir === 1 ? '$gt' : '$lt';

    const branch: Record<string, unknown> = {};
    // Equality on every key BEFORE the tail
    for (let j = 0; j < i; j++) {
      // biome-ignore lint/style/noNonNullAssertion: j is bounded by i
      const eqKey = sortKeys[j]!;
      branch[eqKey] = cursor[eqKey] ?? null;
    }
    // Strict comparison on the tail
    branch[tailKey] = { [tailOp]: cursor[tailKey] ?? null };
    branches.push(branch);
  }

  return {
    $match: branches.length === 1 ? (branches[0] as Record<string, unknown>) : { $or: branches },
  };
}
