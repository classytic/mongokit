/**
 * `@classytic/mongokit/search` — the prefix-search text rules, mongoose-free.
 *
 * Servers use them through `searchMode: 'prefix'` (the repository writes and
 * queries the keys). Clients import them directly to normalise or highlight
 * with the same rules: `findSearchMatches(name, query)` returns the ranges to
 * wrap in `<mark>`.
 */

export { SEARCH_KEYS_ERROR_CODES, SearchKeysWriteError } from './derive.js';
export {
  findSearchMatches,
  normalizeSearchText,
  type SearchMatchRange,
  tokenizeSearchText,
} from './normalize.js';
export {
  buildSearchKeys,
  DEFAULT_SEARCH_KEYS_FIELD,
  MAX_PREFIX_SEARCH_TERMS,
  type PrefixSearchFilterOptions,
  prefixSearchFilter,
  searchKeysIndex,
  searchKeysPath,
} from './prefix.js';
