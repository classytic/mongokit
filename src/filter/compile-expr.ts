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
import { createError } from '../utils/error.js';
import { SHORTHAND_OPS } from './compile.js';

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
  if (isFilter(input)) return compile(input);
  // A boolean literal is a valid condition on its own.
  if (typeof input === 'boolean') return input;

  /**
   * Anything else must be an aggregation EXPRESSION, and an aggregation
   * expression's operator keys are `$`-prefixed (`$eq`, `$and`, `$gt`).
   *
   * This used to `return input` for everything that was not Filter IR,
   * described as "already an expression — pass through unchanged". A plain
   * query object is not an expression: `{ status: { eq: 'paid' } }` reaches
   * `$cond` as a non-empty object, which MongoDB evaluates as TRUTHY. So a
   * measure's `where` written in query syntax silently matched every row and
   * the filtered aggregate came back equal to the unfiltered one, with nothing
   * raised.
   *
   * That syntax is not imaginary — it is exactly what `AggRequest.filter`
   * accepts, because `compileFilterToMongo` runs `expandShorthands` over it.
   * Two filter surfaces on one request object, one of which honoured the
   * syntax and the other quietly ignored it.
   *
   * Refused rather than translated: a partial query-to-expression translator
   * would get the common operators right and fail the same silent way on the
   * rest, which is the failure being fixed.
   */
  if (typeof input === 'object') {
    const keys = Object.keys(input as Record<string, unknown>);
    /**
     * Normalization is attempted FIRST, before the "all `$` keys means it is
     * already an expression" fallback — because `{ $and: [...] }` satisfies
     * both readings. As a query it is a conjunction of query objects; as an
     * expression `$and` is a real operator whose operands would be those same
     * objects, evaluated as TRUTHY. Taking the expression reading first made
     * every `$and`/`$or` filter match all rows.
     *
     * Trying the query reading first disambiguates correctly: a genuine
     * expression (`{ $eq: ['$a', 1] }`, or `$and` over expressions) fails to
     * normalize — its operands are not field/operator objects — and falls
     * through unchanged.
     */
    const normalized = queryToFilterIr(input as Record<string, unknown>);
    if (normalized) return compile(normalized);
    if (keys.length > 0 && keys.every((k) => k.startsWith('$'))) return input;
    throw createError(
      400,
      `mongokit/filter: could not express this \`where\` as an aggregation condition. ` +
        `Accepted: query syntax (\`{ field: { gte: 1 } }\`, the same language \`filter\` and ` +
        `\`lookup.where\` take), Filter IR (\`{ op, field, value }\`), or a MongoDB expression ` +
        `(\`{ $eq: ['$field', value] }\`). Got ` +
        `${keys.length === 0 ? 'an empty object' : `an object keyed by ${keys.map((k) => `'${k}'`).join(', ')}`}. ` +
        `\`mod\` and \`$where\` have no expression form and are refused by name. Refused rather ` +
        `than passed through: evaluated as an expression a plain object is always TRUE, so the ` +
        `filter would silently match every row.`,
    );
  }
  return input;
}

/**
 * Operators a query object may use, mapped to their Filter IR op.
 *
 * Exactly the set `compileFilterToMongo`'s `expandShorthands` accepts, minus
 * the ones the IR cannot express — so this is COMPLETE over its input, not a
 * best-effort subset. Anything outside it reaches the refusal below rather
 * than being quietly dropped.
 *
 * `mod` is the one shorthand with no IR node. It is refused by name, because
 * "translated everything except the operator you used" is the failure this
 * whole function exists to stop.
 */
/**
 * Query operators this translates, and the Filter IR node each becomes.
 *
 * Exactly the set `compileFilterToMongo`'s `expandShorthands` accepts, minus
 * the ones the IR cannot express — so the translation is COMPLETE over its
 * input rather than a best-effort subset. Anything outside reaches the refusal
 * below instead of being quietly dropped.
 *
 * Each node is BUILT, not spread from a common shape: the IR is not uniform —
 * `in`/`nin` carry `values`, `exists` carries `exists`, `regex` carries
 * `pattern`/`flags`. Emitting `value` for all of them compiled without
 * complaint and then matched nothing, which the parity suite caught and a
 * hand-written expectation would not have.
 */
const QUERY_OPS: Record<string, (field: string, operand: unknown) => Filter> = {
  eq: (field, value) => ({ op: 'eq', field, value }),
  ne: (field, value) => ({ op: 'ne', field, value }),
  gt: (field, value) => ({ op: 'gt', field, value }),
  gte: (field, value) => ({ op: 'gte', field, value }),
  lt: (field, value) => ({ op: 'lt', field, value }),
  lte: (field, value) => ({ op: 'lte', field, value }),
  in: (field, operand) => ({ op: 'in', field, values: toArray(operand) }),
  nin: (field, operand) => ({ op: 'nin', field, values: toArray(operand) }),
  exists: (field, operand) => ({ op: 'exists', field, exists: operand !== false }),
  regex: (field, operand) => buildRegex(field, operand),
};
// `$`-prefixed spellings map to the same builders.
for (const name of Object.keys(QUERY_OPS)) {
  // biome-ignore lint/style/noNonNullAssertion: iterating its own keys
  QUERY_OPS[`$${name}`] = QUERY_OPS[name]!;
}

function toArray(operand: unknown): unknown[] {
  return Array.isArray(operand) ? [...operand] : [operand];
}

/** `regex` accepts a string, `{ $regex, $options }`, or a real RegExp. */
function buildRegex(field: string, operand: unknown): Filter {
  if (operand instanceof RegExp) {
    return operand.flags
      ? { op: 'regex', field, pattern: operand.source, flags: operand.flags }
      : { op: 'regex', field, pattern: operand.source };
  }
  if (operand !== null && typeof operand === 'object') {
    const o = operand as { $regex?: unknown; $options?: unknown };
    const flags = typeof o.$options === 'string' ? o.$options : undefined;
    return flags
      ? { op: 'regex', field, pattern: String(o.$regex ?? ''), flags }
      : { op: 'regex', field, pattern: String(o.$regex ?? '') };
  }
  return { op: 'regex', field, pattern: String(operand) };
}

const LOGICAL: Record<string, 'and' | 'or'> = { $and: 'and', $or: 'or' };

/** `{ field: { gte: 1, lte: 9 } }` and `{ a: 1, b: 2 }` are both conjunctions. */
function allOf(children: Filter[]): Filter | null {
  if (children.length === 0) return { op: 'true' } as Filter;
  if (children.length === 1) return children[0];
  return { op: 'and', children } as Filter;
}

/**
 * Translate a plain query object into Filter IR, or return `null` when it uses
 * anything outside {@link QUERY_OPS}.
 *
 * `null` rather than a throw so the caller owns the error message — it has the
 * context (which surface, what was passed) that makes the refusal actionable.
 */
function queryToFilterIr(query: Record<string, unknown>): Filter | null {
  const children: Filter[] = [];

  for (const [key, value] of Object.entries(query)) {
    const logical = LOGICAL[key];
    if (logical) {
      if (!Array.isArray(value)) return null;
      const subs: Filter[] = [];
      for (const entry of value) {
        if (entry === null || typeof entry !== 'object') return null;
        const sub = queryToFilterIr(entry as Record<string, unknown>);
        if (!sub) return null;
        subs.push(sub);
      }
      children.push({ op: logical, children: subs } as Filter);
      continue;
    }
    if (key.startsWith('$')) return null; // an operator we do not translate

    // `{ field: { <op>: v, ... } }` — every key must be a known operator, or
    // this is a nested-document equality match (`address: { city: 'Dhaka' }`).
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const ops = Object.keys(value as Record<string, unknown>);
      /**
       * Is this an OPERATOR object or a nested document?
       *
       * Decided against the shared vocabulary, not against what this file can
       * translate. `{ qty: { mod: [2, 0] } }` is unmistakably an operator
       * object — `mod` is a shorthand operator — and it simply has no
       * expression form. Judging by translatability instead would have read it
       * as an equality against the literal `{ mod: [2, 0] }`, which matches
       * nothing and raises nothing: the silent-widening failure this function
       * exists to stop, reintroduced one level down.
       */
      const looksLikeOperators =
        ops.length > 0 && ops.some((o) => o.startsWith('$') || SHORTHAND_OPS.has(o));
      if (looksLikeOperators) {
        if (!ops.every((o) => o in QUERY_OPS)) return null; // refuse, never drop
        for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
          // biome-ignore lint/style/noNonNullAssertion: guarded above
          children.push(QUERY_OPS[op]!(key, operand));
        }
        continue;
      }
    }
    children.push({ op: 'eq', field: key, value } as Filter);
  }

  return allOf(children);
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

    case 'exists': {
      /**
       * SQL parity: `exists: false` matches NULL and MISSING alike (`IS
       * NULL`); `exists: true` matches neither (`IS NOT NULL`).
       *
       * This was `$ne: [field, null]` / `$eq: [field, null]`, on the stated
       * grounds that "mongo treats [null and missing] the same way for missing
       * fields". It does not: a missing path in an expression is MISSING, not
       * null, and `$ne: ['$absent', null]` is TRUE. So `exists: true` matched
       * every document including the ones without the field, and
       * `exists: false` matched none — the predicate inverted on exactly the
       * documents it was asked about.
       *
       * `$type` is the only operator that distinguishes the three states, and
       * it names both of the ones SQL folds together.
       */
      const nullish = { $in: [{ $type: `$${filter.field}` }, ['missing', 'null']] };
      return filter.exists ? { $not: [nullish] } : nullish;
    }

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
