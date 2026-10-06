/**
 * `?sort=-createdAt,name` and `?select=name,-password` — read through the shared grammar
 * (`readSort` / `readSelect`), so an invalid or disallowed field is refused like any filter.
 */

import { readSelect, readSort } from '@classytic/repo-core/query-parser';
import { guarded, type ParserRuntime } from './runtime.js';
import type { SortSpec } from './types.js';

/**
 * The sort applied when a request names none. Exported so `parse()` can ask whether it is
 * PERMITTED before applying it, rather than validating it like caller input.
 */
export const DEFAULT_PARSER_SORT = '-createdAt';

/** Is every field of `sort` inside `allowedSortFields`? Pure — never rejects. */
export function isSortFieldAllowed(rt: ParserRuntime, sort: string): boolean {
  const allowed = rt.options.allowedSortFields;
  if (!allowed || allowed.length === 0) return true;
  return sort
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .every((field) => allowed.includes(field.replace(/^[+-]/, '')));
}

export function parseSort(rt: ParserRuntime, sort: unknown): SortSpec | undefined {
  return readSort(sort, {
    allowedSortFields: rt.options.allowedSortFields,
    onInvalid: rt.options.invalidInput === 'drop' ? (error) => rt.reject(error.message) : undefined,
  });
}

export function parseSelect(rt: ParserRuntime, select: unknown): Record<string, 0 | 1> | undefined {
  return guarded(rt, () => readSelect(select), undefined);
}
