/**
 * `?search=` — length-checked through the shared grammar. Regex mode matches the term as LITERAL
 * text across `searchFields` (`c++` and `a.b` mean exactly those characters).
 */

import { escapeRegex, readSearch } from '@classytic/repo-core/query-parser';
import { guarded, type ParserRuntime } from './runtime.js';

export function sanitizeSearch(rt: ParserRuntime, search: unknown): string | undefined {
  return guarded(
    rt,
    () => readSearch(search, { maxSearchLength: rt.options.maxSearchLength }),
    undefined,
  );
}

export function buildRegexSearch(
  rt: ParserRuntime,
  searchTerm: string,
): Record<string, unknown>[] | null {
  const fields = rt.options.searchFields;
  if (!fields || fields.length === 0) return null;
  const pattern = new RegExp(escapeRegex(searchTerm), 'i');
  return fields.map((field) => ({ [field]: { $regex: pattern } }));
}
