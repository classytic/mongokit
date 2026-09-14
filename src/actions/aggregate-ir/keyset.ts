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
  encodeAggCursor as encodeAggCursorShared,
  isKeysetMode,
} from '@classytic/repo-core/aggregate';
import type { PipelineStage } from 'mongoose';
import {
  attachSignature,
  type CursorSecret,
  resolveCursorSecrets,
  verifySignature,
} from '../../pagination/utils/cursor-signing.js';

export { type DecodedCursor, isKeysetMode };

/**
 * The aggregate cursor is signed by the SAME key as the find-based one.
 *
 * Two cursor codecs are exposed on the wire, and a deployment that signed only
 * the one on `getAll` would still hand out a tamperable position on every
 * aggregate keyset endpoint. A guarantee with an unsigned second door is not a
 * guarantee — it is a guarantee-shaped thing that reviewers stop checking.
 *
 * The signature wraps repo-core's kit-neutral codec rather than living inside
 * it: repo-core's codec is browser-safe by contract and `node:crypto` is not.
 */
export function encodeAggCursor(
  row: Record<string, unknown>,
  sort: Record<string, 1 | -1>,
  secret?: CursorSecret,
): string {
  return attachSignature(encodeAggCursorShared(row, sort), resolveCursorSecrets(secret));
}

export function decodeAggCursor(cursor: string, secret?: CursorSecret): DecodedCursor {
  // Verify BEFORE decoding — a payload that failed integrity must never reach
  // the parser, however well-formed it looks.
  return decodeAggCursorShared(verifySignature(cursor, resolveCursorSecrets(secret)), 'mongokit');
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
