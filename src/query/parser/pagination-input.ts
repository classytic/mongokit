/**
 * Strict pagination-input parsing for `page` and `limit`.
 *
 * URL pagination inputs are the one place a permissive `parseInt()` silently
 * produced wrong-but-plausible results (`page=2garbage` → 2, `limit=abc` →
 * default, `page=-1` → NaN). Under the `invalidInput` policy those are now
 * fail-closed: only whole positive integers (or all-digit strings) are
 * accepted; anything else routes through `rt.reject()` (HTTP 400 in 'throw'
 * mode, warn + fall back in 'drop' mode). Limit CLAMPING to `maxLimit` stays
 * separate — exceeding the max is a valid request the parser caps, not
 * invalid input.
 */

import type { ParserRuntime } from './runtime.js';

/**
 * Parse a pagination input to a positive integer, or `undefined` when the
 * value is absent, empty, or rejected under `'drop'` mode. Rejects (per
 * policy) on non-integers, negatives, zero, decimals, and trailing garbage.
 */
export function parsePositiveInt(
  rt: ParserRuntime,
  raw: unknown,
  label: 'page' | 'limit',
): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;

  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else {
    const s = String(raw).trim();
    // Strict: all-digit only. Rejects `2garbage`, `-1`, `1.5`, `abc`, ` 1 `→ok.
    if (!/^\d+$/.test(s)) {
      rt.reject(`Invalid ${label} value: ${String(raw)} (expected a positive integer)`, {
        [label]: String(raw),
      });
      return undefined;
    }
    n = Number(s);
  }

  if (!Number.isInteger(n) || n < 1) {
    rt.reject(`Invalid ${label} value: ${String(raw)} (expected a positive integer)`, {
      [label]: String(raw),
    });
    return undefined;
  }

  return n;
}
