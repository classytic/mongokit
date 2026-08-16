/**
 * Filter IR → MongoDB **aggregation expression** compiler.
 *
 * Companion to `compileFilterToMongo` (which emits `$match`-shape
 * query objects). This one emits the EXPRESSION form needed inside
 * aggregation pipeline operators — `$cond`, `$expr`, `$switch`,
 * `$filter`, etc. The two forms aren't interchangeable:
 *
 *   - `compileFilterToMongo`     → `{ status: 'paid' }`
 *     (query: keys are field names, RHS is a value or operator doc)
 *   - `compileFilterToMongoExpr` → `{ $eq: ['$status', 'paid'] }`
 *     (expression: operator at the root, args reference fields with `$` prefix)
 *
 * Used by the AggMeasure compiler to wrap `where`-filtered measures
 * in `$cond` so `{ op: 'sum', field: 'amount', where: eq('status', 'paid') }`
 * compiles to `{ $sum: { $cond: [<expr>, '$amount', 0] } }` —
 * SQL's `SUM(amount) FILTER (WHERE status = 'paid')` equivalent.
 *
 * Operator coverage matches `compileFilterToMongo` (eq/ne/gt/gte/
 * lt/lte/in/nin/exists/like/regex/and/or/not/true/false). `raw` is
 * SQL-only and throws here too.
 */

import type { Filter } from '@classytic/repo-core/filter';
import { isFilter } from '@classytic/repo-core/filter';

/**
 * Compile a Filter IR node (or already-built expression) to a MongoDB
 * aggregation expression. Returns the literal `true` for empty `and`
 * / `true` nodes so callers can use the result as a `$cond`
 * predicate without special-casing — `$cond: [true, X, Y]` short-
 * circuits to `X` at planning time.
 *
 * The `input` is typed as `unknown` so callers can pass either a
 * Filter IR node or an already-built expression and we dispatch
 * appropriately. This mirrors `compileFilterToMongo`'s ergonomic
 * dispatch.
 */
export function compileFilterToMongoExpr(input: unknown): unknown {
  if (input === undefined || input === null) return true;
  if (!isFilter(input)) {
    // Already an expression — pass through unchanged.
    return input;
  }
  return compile(input);
}

function compile(filter: Filter): unknown {
  switch (filter.op) {
    case 'true':
      return true;
    case 'false':
      return false;

    case 'eq':
      return { $eq: [`$${filter.field}`, filter.value] };
    case 'ne':
      // Same SQL-parity tightening as `compileFilterToMongo`'s `ne`:
      // exclude null rows so `ne(field, 'x')` doesn't accidentally
      // include nulls. Inside an expression, that's
      // `(field != value) AND (field != null)`.
      return filter.value === null
        ? { $ne: [`$${filter.field}`, null] }
        : {
            $and: [
              { $ne: [`$${filter.field}`, filter.value] },
              { $ne: [`$${filter.field}`, null] },
            ],
          };
    case 'gt':
      return { $gt: [`$${filter.field}`, filter.value] };
    case 'gte':
      return { $gte: [`$${filter.field}`, filter.value] };
    case 'lt':
      return { $lt: [`$${filter.field}`, filter.value] };
    case 'lte':
      return { $lte: [`$${filter.field}`, filter.value] };

    case 'in':
      if (filter.values.length === 0) return false;
      return { $in: [`$${filter.field}`, [...filter.values]] };
    case 'nin':
      if (filter.values.length === 0) return true;
      return { $not: [{ $in: [`$${filter.field}`, [...filter.values]] }] };

    case 'exists':
      // SQL parity: `exists: false` ↔ `IS NULL` (matches both null +
      // missing); `exists: true` ↔ `IS NOT NULL`. In expression form
      // there's no `$exists`; we use `$eq null` / `$ne null` which
      // mongo treats the same way for missing fields ($getField on a
      // missing path yields null at expression evaluation time).
      return filter.exists
        ? { $ne: [`$${filter.field}`, null] }
        : { $eq: [`$${filter.field}`, null] };

    case 'like':
      // Compile to `$regexMatch` — the expression-form companion of
      // the query-form `$regex` operator. Reuses the same SQL-LIKE →
      // regex translation logic the query compiler uses, kept in sync
      // by inlining the same algorithm.
      return {
        $regexMatch: {
          input: `$${filter.field}`,
          regex: likeToRegexPattern(filter.pattern),
          ...(filter.caseSensitivity === 'sensitive' ? {} : { options: 'i' }),
        },
      };

    case 'regex':
      // Same rule as the query compiler: `flags` is IR state, so it has to
      // reach `$regexMatch.options`. `like` above already honours its
      // case-sensitivity — a `regex` node that dropped its flags made the two
      // forms disagree about the SAME filter depending on which compiler ran.
      return {
        $regexMatch: {
          input: `$${filter.field}`,
          regex: filter.pattern,
          ...(filter.flags ? { options: filter.flags } : {}),
        },
      };

    case 'and': {
      if (filter.children.length === 0) return true;
      const parts = filter.children.map(compile);
      if (parts.length === 1) return parts[0];
      return { $and: parts };
    }
    case 'or': {
      if (filter.children.length === 0) return false;
      const parts = filter.children.map(compile);
      if (parts.length === 1) return parts[0];
      return { $or: parts };
    }
    case 'not': {
      return { $not: [compile(filter.child)] };
    }

    case 'raw':
      throw new Error(
        'mongokit/filter: `raw` is a SQL escape hatch and has no safe MongoDB expression translation. ' +
          'Pass an aggregation expression directly instead.',
      );
  }
}

/**
 * Translate a SQL LIKE pattern to a regex pattern string (without
 * the `^$` anchors and `$options` field — those layer on top per
 * call site). Mirrors `likeToRegex` in the query compiler.
 */
function likeToRegexPattern(pattern: string): string {
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
  return out;
}

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
