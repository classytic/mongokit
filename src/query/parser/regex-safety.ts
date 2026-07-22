/**
 * Regex safety — ReDoS protection for user-supplied patterns.
 *
 * Two independent detectors feed the decision:
 *  1. A heuristic pattern for classic catastrophic-backtracking shapes
 *     (nested quantifiers, possessive quantifiers, backreferences, …).
 *  2. A deterministic static complexity budget, so patterns that evade the
 *     heuristic still fail over when their unbounded-quantifier density is
 *     pathological.
 *
 * Unsafe input is never executed as a regex: depending on the caller's
 * intent it is either escaped to a literal match or rejected through the
 * `invalidInput` policy.
 */

import { warn } from '../../utils/logger.js';
import type { ParserRuntime } from './runtime.js';

/**
 * Regex patterns that can cause catastrophic backtracking (ReDoS attacks).
 * Detects common footguns:
 * - Quantifiers: {n,m}
 * - Possessive quantifiers: *+, ++, ?+
 * - Nested quantifiers: (a+)+, (a*)*
 * - Backreferences: \1, \2, etc.
 * - Complex character classes: [...]...[...]
 */
const DANGEROUS_REGEX_PATTERNS =
  /(\{[0-9,]+\}|\*\+|\+\+|\?\+|(\(.+\))\+|\(\?:|\\[0-9]|(\[.+\]).+(\[.+\]))/;

/**
 * Static complexity budget for user-supplied regex patterns.
 * Returns `true` if the pattern crosses a budget that empirically correlates
 * with ReDoS risk — independent of the heuristic regex detector.
 *
 * Budget components (any single threshold crossed → over budget):
 *   - unbounded quantifiers (`*`, `+`, `?`) — hard cap 20
 *   - nested groups `(` — hard cap 8
 *   - alternations `|` — hard cap 10
 *   - combined: (quantifiers * groups) — hard cap 40
 */
function regexComplexityExceedsBudget(patternStr: string): boolean {
  // Strip escaped meta-characters so `\*` isn't counted as a quantifier.
  const stripped = patternStr.replace(/\\[^\\]/g, '');

  const unboundedQuantifiers = (stripped.match(/[*+?]/g) ?? []).length;
  const groups = (stripped.match(/\(/g) ?? []).length;
  const alternations = (stripped.match(/\|/g) ?? []).length;

  if (unboundedQuantifiers > 20) return true;
  if (groups > 8) return true;
  if (alternations > 10) return true;
  if (unboundedQuantifiers * groups > 40) return true;

  return false;
}

/** Escape special regex characters (backslash first, then other metas). */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a safe RegExp from user input.
 *
 * `onUnsafe` selects what happens when the pattern is over-long,
 * pathological, or syntactically invalid:
 * - `'reject'`: route through the `invalidInput` policy — HTTP 400 in
 *   `'throw'` mode, warn + escape-to-literal in `'drop'` mode. Used for
 *   the explicit `regex` operator, where the caller claims to be sending
 *   a real regex.
 * - `'escape'`: always warn + escape-to-literal, never throw. Used for
 *   `search` terms and the `like`/`contains` operators, whose documented
 *   semantic is a literal substring match — `?search=c++` must not 400.
 */
export function createSafeRegex(
  rt: ParserRuntime,
  pattern: unknown,
  flags: string = 'i',
  onUnsafe: 'reject' | 'escape' = 'reject',
): RegExp | null {
  if (pattern === null || pattern === undefined) return null;

  const flag = (message: string, meta?: Record<string, unknown>): void => {
    if (onUnsafe === 'reject') {
      rt.reject(message, meta);
    } else {
      warn(`[mongokit] ${message}`);
    }
  };

  const patternStr = String(pattern);

  if (patternStr.length > rt.options.maxRegexLength) {
    flag(`Regex pattern too long, truncating`, {
      length: patternStr.length,
      maxRegexLength: rt.options.maxRegexLength,
    });
    return new RegExp(escapeRegex(patternStr.substring(0, rt.options.maxRegexLength)), flags);
  }

  if (DANGEROUS_REGEX_PATTERNS.test(patternStr)) {
    flag('Potentially dangerous regex pattern, escaping');
    return new RegExp(escapeRegex(patternStr), flags);
  }

  if (regexComplexityExceedsBudget(patternStr)) {
    flag('Regex complexity budget exceeded, escaping');
    return new RegExp(escapeRegex(patternStr), flags);
  }

  try {
    return new RegExp(patternStr, flags);
  } catch {
    flag('Invalid regex pattern syntax, escaping to literal match');
    return new RegExp(escapeRegex(patternStr), flags);
  }
}
