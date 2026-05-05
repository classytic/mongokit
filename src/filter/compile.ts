/**
 * Filter IR → MongoDB query compiler.
 *
 * Mirrors sqlitekit's `compileFilterToDrizzle`: takes a repo-core
 * `Filter` tree and emits a MongoDB query object. Used by `groupBy` /
 * `groupByPaginate` to translate the portable AggRequest's `filter`
 * + `having` into `$match` stages.
 *
 * Scope: the same operator set sqlitekit supports (`eq`, `ne`, `gt`,
 * `gte`, `lt`, `lte`, `in`, `nin`, `exists`, `like`, `regex`, `and`,
 * `or`, `not`, `raw`). Anything else throws so we fail loud instead
 * of silently dropping predicates.
 *
 * Why only this op set here and not everywhere in mongokit? Historic
 * reason: mongokit pre-dates repo-core's Filter IR, so its existing
 * policy plugins (multi-tenant, soft-delete) speak MongoDB query
 * language directly. Converting mongokit's entire filter pipeline
 * to Filter IR is out-of-scope for this change — we introduce the
 * compiler only where the new portable `groupBy` IR needs it.
 */

import type { Filter } from '@classytic/repo-core/filter';
import { isFilter } from '@classytic/repo-core/filter';

/**
 * Compile a Filter IR node to a MongoDB query object. Returns `{}`
 * when the node is `TRUE` (or an empty `and`) so callers can merge
 * with other scopes without special-casing.
 *
 * The `input` is typed as `unknown` so callers can pass either a
 * Filter IR node or an already-built Mongo query and we dispatch
 * appropriately. This keeps the portable API ergonomic for apps that
 * write Mongo queries directly today.
 */
/**
 * Operator shorthands arc propagates from bracket-syntax URL params.
 * Fastify parses `?createdAt[gte]=...&createdAt[lte]=...` into
 * `{ createdAt: { gte: '...', lte: '...' } }` — without `$` prefixes.
 * Arc intentionally forwards these as-is ("the kit's filter compiler
 * handles them"). This set covers every operator the arc aggregation
 * guard accepts in `parseDateRange` and `hasFilterOnField`.
 */
const SHORTHAND_OPS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'exists',
  'regex',
  'mod',
]);

/** Range operators whose string values should be coerced to Date. */
const RANGE_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

/** ISO-8601 date-only or datetime string pattern. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Coerce a string value to a Date when it looks like an ISO-8601 date.
 * Needed because MongoDB won't match a BSON Date field against a string
 * value even when using range operators — BSON type comparison treats
 * Date (type 9) and String (type 2) as distinct, so `{ createdAt: {
 * $gte: "2026-05-01" } }` never matches a Date-typed field.
 */
function tryCoerceDate(value: unknown): unknown {
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d;
  }
  return value;
}

/**
 * Expand operator shorthand values in a plain Mongo-style query object.
 * Only expands nested objects whose keys are ALL in `SHORTHAND_OPS` — so
 * real nested documents (e.g. `address: { city: 'Dhaka' }`) pass through
 * unchanged, while `createdAt: { gte: '2026-04-01', lte: '2026-05-01' }`
 * becomes `createdAt: { $gte: Date(2026-04-01), $lte: Date(2026-05-01) }`.
 * String values on range operators are coerced to Date when they match the
 * ISO-8601 pattern, so BSON Date fields in MongoDB are compared correctly.
 */
function expandShorthands(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      const keys = Object.keys(nested);
      if (keys.length > 0 && keys.every((k) => !k.startsWith('$') && SHORTHAND_OPS.has(k))) {
        const expanded: Record<string, unknown> = {};
        for (const [op, opVal] of Object.entries(nested)) {
          expanded[`$${op}`] = RANGE_OPS.has(op) ? tryCoerceDate(opVal) : opVal;
        }
        out[key] = expanded;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

export function compileFilterToMongo(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (!isFilter(input)) {
    // Plain Mongo query — expand bracket-syntax operator shorthands (gte/lte/…)
    // that arc forwards from URL params before passing to a $match stage.
    // Also coerces ISO date strings to Date objects for range operators so
    // BSON Date fields compare correctly (Date ≠ String in BSON type ordering).
    return expandShorthands(input as Record<string, unknown>);
  }
  return compile(input);
}

function compile(filter: Filter): Record<string, unknown> {
  switch (filter.op) {
    case 'true':
      return {};
    case 'false':
      // `$expr: false` — matches nothing, portable across read paths.
      return { $expr: false };

    case 'eq':
      // `eq(field, null)` — SQL parity means "field is null". MongoDB's
      // `{ field: null }` already matches both null + missing, which
      // aligns with the SQL `IS NULL` semantic the IR carries.
      return { [filter.field]: filter.value };
    case 'ne':
      // SQL's `field <> 'x'` (3-valued logic) excludes null rows; the
      // conformance suite locks this parity in. MongoDB's bare
      // `{ $ne: 'x' }` includes null + missing, so we tighten to also
      // require the field be non-null.
      return filter.value === null
        ? { [filter.field]: { $ne: null } }
        : {
            $and: [{ [filter.field]: { $ne: filter.value } }, { [filter.field]: { $ne: null } }],
          };
    case 'gt':
      return { [filter.field]: { $gt: filter.value } };
    case 'gte':
      return { [filter.field]: { $gte: filter.value } };
    case 'lt':
      return { [filter.field]: { $lt: filter.value } };
    case 'lte':
      return { [filter.field]: { $lte: filter.value } };

    case 'in':
      if (filter.values.length === 0) return { $expr: false };
      return { [filter.field]: { $in: [...filter.values] } };
    case 'nin':
      if (filter.values.length === 0) return {};
      return { [filter.field]: { $nin: [...filter.values] } };

    case 'exists':
      // SQL parity: `isNull(field)` (= `exists: false`) means the column
      // is null. MongoDB's `{ field: null }` matches both null + missing,
      // which is what every backend would produce for an `IS NULL`
      // predicate. `exists: true` is the symmetric `$ne: null`. Using
      // raw `$exists` would diverge from sqlitekit on rows whose value
      // is explicitly null but stored.
      return filter.exists ? { [filter.field]: { $ne: null } } : { [filter.field]: null };

    case 'like':
      return {
        [filter.field]: likeToRegex(filter.pattern, filter.caseSensitivity),
      };

    case 'regex':
      return { [filter.field]: { $regex: filter.pattern } };

    case 'and': {
      if (filter.children.length === 0) return {};
      const parts = filter.children.map(compile);
      if (parts.length === 1) return parts[0] as Record<string, unknown>;
      return { $and: parts };
    }
    case 'or': {
      if (filter.children.length === 0) return { $expr: false };
      const parts = filter.children.map(compile);
      if (parts.length === 1) return parts[0] as Record<string, unknown>;
      return { $or: parts };
    }
    case 'not': {
      // MongoDB's $not applies to a field operator, not an arbitrary
      // subdocument — use $nor wrapping a single element for the
      // general case. That works uniformly for compound children.
      return { $nor: [compile(filter.child)] };
    }

    case 'raw':
      throw new Error(
        'mongokit/filter: `raw` is a SQL escape hatch and has no safe MongoDB translation. ' +
          'Pass a Mongo query object directly to the filter slot instead.',
      );
  }
}

/**
 * Translate a SQL-style LIKE pattern to a MongoDB regex.
 *
 * SQL semantics:
 *   - `%`  → match zero or more characters (`.*`)
 *   - `_`  → match exactly one character   (`.`)
 *   - `\%` → literal percent  (escape via backslash)
 *   - `\_` → literal underscore
 *   - `\\` → literal backslash
 *   - everything else is literal — regex metacharacters get escaped.
 *
 * The naive implementation `pattern.replace(/%/g, '.*')` is wrong:
 * it also expands escaped `\%` into a wildcard. We walk the pattern
 * char-by-char, honoring backslash escapes, so `like('notes', '50\\% off')`
 * matches the literal string `50% off` instead of `50<anything> off`.
 *
 * Anchored with `^` / `$` so LIKE matches the whole field value, the
 * same way sqlitekit's `LIKE` semantically does.
 */
function likeToRegex(
  pattern: string,
  caseSensitivity: 'sensitive' | 'insensitive' | undefined,
): { $regex: string; $options?: string } {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1] as string;
      if (next === '%' || next === '_' || next === '\\') {
        out += escapeRegexChar(next);
        i++;
        continue;
      }
    }
    if (ch === '%') {
      out += '.*';
    } else if (ch === '_') {
      out += '.';
    } else {
      out += escapeRegexChar(ch);
    }
  }
  out += '$';
  return caseSensitivity === 'sensitive' ? { $regex: out } : { $regex: out, $options: 'i' };
}

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
