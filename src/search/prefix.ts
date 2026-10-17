/**
 * Indexed search-as-you-type (`searchMode: 'prefix'`): the stored keys, the
 * query filter, and the index/schema declarations. Pure: no mongoose import.
 *
 * ## Storage choice: word tokens + anchored regex (not edge n-grams)
 *
 * Each document stores the DISTINCT normalised word tokens of its search fields
 * in one array field (`_searchKeys` by default), covered by a multikey index. A
 * query token `moh` becomes `{ _searchKeys: { $regex: '^moh' } }`: a
 * case-sensitive regex with a literal prefix, which the planner turns into the
 * index range `["moh", "moi")` (IXSCAN, keys examined ≈ matches). Several query
 * tokens AND together, one `$and` arm each; the planner bounds one arm and
 * filters the rest on the fetched documents.
 *
 * The alternative, edge n-grams (`m, mo, moh, ..., mohammed` stored, matched by
 * an exact `$all`), gives the SAME index-range query plan, only with point
 * bounds, while storing one key per prefix length instead of one per word.
 * Measured on 2,000 two-to-three-word names (mongod 8, WiredTiger; see
 * `tests/integration/prefix-search.test.ts`): tokens 6,000 keys / 60 KiB index,
 * edge n-grams (N=20) 34,140 keys / 256 KiB index, ~5.7x the keys and ~4x the
 * index bytes. N-grams also cost a write amplification on every
 * rename, and an arbitrary cut-off N past which longer prefixes stop matching.
 * Tokens keep the index small, have no length cliff, and make the backfill a
 * pure function of the source fields. So tokens are the standard here.
 */

import { tokenizeSearchText } from './normalize.js';

/** Default name of the field that stores the search keys. */
export const DEFAULT_SEARCH_KEYS_FIELD = '_searchKeys';

/** Query tokens beyond this many are ignored (each one is an `$and` arm). */
export const MAX_PREFIX_SEARCH_TERMS = 8;

/** Every value at a dotted `path` of `doc`, arrays flattened (`contacts.name` over an array of contacts). */
export function valuesAtPath(doc: unknown, path: string): unknown[] {
  const parts = path.split('.');
  const out: unknown[] = [];
  const walk = (value: unknown, i: number): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, i);
      return;
    }
    if (i === parts.length) {
      out.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    walk((value as Record<string, unknown>)[parts[i] as string], i + 1);
  };
  walk(doc, 0);
  return out;
}

/**
 * Distinct tokens of `values` (arrays flattened, nested arrays too; strings and
 * numbers tokenised, every other value ignored), in first-seen order.
 */
export function collectSearchTokens(values: readonly unknown[]): string[] {
  const keys = new Set<string>();
  const add = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) add(item);
      return;
    }
    const text =
      typeof v === 'string'
        ? v
        : typeof v === 'number' || typeof v === 'bigint'
          ? String(v)
          : undefined;
    if (text === undefined) return;
    for (const token of tokenizeSearchText(text)) keys.add(token);
  };
  for (const v of values) add(v);
  return [...keys];
}

/**
 * The search keys of `doc`: the distinct normalised tokens of every value at
 * every `fields` path (strings and numbers; arrays flattened; other values
 * ignored), in first-seen order. This is exactly what the write paths store.
 *
 * @example buildSearchKeys({ name: 'Ahmed bin Ali', email: 'a.ali@x.io' }, ['name'])
 *          // ['ahmed', 'bin', 'ali']
 */
export function buildSearchKeys(doc: unknown, fields: readonly string[]): string[] {
  return collectSearchTokens(fields.map((f) => valuesAtPath(doc, f)));
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface PrefixSearchFilterOptions {
  /** Field holding the keys. Default {@link DEFAULT_SEARCH_KEYS_FIELD}. */
  keysField?: string;
  /** Cap on query tokens. Default {@link MAX_PREFIX_SEARCH_TERMS}. */
  maxTerms?: number;
}

/**
 * The MongoDB filter for a prefix search: every query token must be the start of
 * some stored key (AND across words, any order). `null` when `query` has no
 * tokens (blank or punctuation only): the caller decides whether that means "no
 * search" (the repository's choice) or "match nothing".
 *
 * Uses `{ $regex: '^…' }` strings, never RegExp objects, so the filter survives
 * JSON (cache keys, logs, wire) unchanged.
 *
 * @example prefixSearchFilter('Moh Ali')
 *          // { $and: [{ _searchKeys: { $regex: '^moh' } }, { _searchKeys: { $regex: '^ali' } }] }
 */
export function prefixSearchFilter(
  query: string,
  options: PrefixSearchFilterOptions = {},
): Record<string, unknown> | null {
  const field = options.keysField ?? DEFAULT_SEARCH_KEYS_FIELD;
  const max = options.maxTerms ?? MAX_PREFIX_SEARCH_TERMS;
  const terms = [...new Set(tokenizeSearchText(query))].slice(0, Math.max(1, max));
  if (terms.length === 0) return null;
  const arms = terms.map((t) => ({ [field]: { $regex: `^${escapeRegex(t)}` } }));
  return arms.length === 1 ? (arms[0] as Record<string, unknown>) : { $and: arms };
}

/**
 * Mongoose schema path for the keys field: an array of strings, never selected
 * by default (`select: false`), absent until written (so a backfill can find
 * rows without it).
 *
 * @example schema.add({ _searchKeys: searchKeysPath() });
 */
export function searchKeysPath(): { type: [StringConstructor]; select: false; default: undefined } {
  return { type: [String], select: false, default: undefined };
}

/**
 * Index declaration for the keys field (multikey), in the
 * `{ fields, options }` shape `schema.index(fields, options)` and the Better
 * Auth overlay's `indexes` take. Name defaults to `<field>_1`.
 *
 * @example
 * // Serves getAll({ search }) prefix search (searchMode: 'prefix').
 * const idx = searchKeysIndex();
 * schema.index(idx.fields, idx.options);
 */
export function searchKeysIndex(
  field: string = DEFAULT_SEARCH_KEYS_FIELD,
  options: { name?: string } = {},
): { fields: Record<string, 1>; options: { name: string } } {
  return { fields: { [field]: 1 }, options: { name: options.name ?? `${field}_1` } };
}
