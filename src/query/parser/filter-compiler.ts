/**
 * Filter compiler — URL filter parameters → MongoDB filter query.
 *
 * Owns the three entry shapes (flat `field=value`, flat operator syntax
 * `field[gte]=10`, nested bracket objects from qs), the `$or` group router,
 * and the `between` range expander. Every invalid or disallowed fragment
 * routes through the runtime's `invalidInput` policy.
 */

import { isControlParam } from '@classytic/repo-core/query-parser';
import { warn } from '../../utils/logger.js';
import { coerceFieldValue } from '../primitives/coercion.js';
import { isGeoOperator, parseGeoFilter } from '../primitives/geo.js';
import { createSafeRegex } from './regex-safety.js';
import type { ParserRuntime } from './runtime.js';
import type { FilterQuery, FilterValue } from './types.js';

/**
 * Top-level query parameters that mongokit handles outside the filter
 * pipeline. Used by `handleBracketSyntax` to detect a common typo where a
 * caller wrote `?filters[limit]=5` instead of `?limit=5` and the qs parser
 * nested the key under a filter object — the value is silently dropped
 * without this guard. Kept as a Set for O(1) lookup; values mirror the
 * reserved-key list at the top of `parseFilters`.
 */
const RESERVED_PAGINATION_KEYS = new Set(['page', 'limit', 'sort', 'select']);

function toMongoOperator(operator: string): string {
  const op = operator.toLowerCase();
  return op.startsWith('$') ? op : `$${op}`;
}

/** Parse filter parameters into a MongoDB filter query. */
export function parseFilters(
  rt: ParserRuntime,
  filters: Record<string, FilterValue>,
  depth: number = 0,
): FilterQuery {
  // Enforce max filter depth to prevent deeply nested filter bombs
  if (depth > rt.options.maxFilterDepth) {
    rt.reject(`Filter depth ${depth} exceeds maximum ${rt.options.maxFilterDepth}, truncating`, {
      depth,
      maxFilterDepth: rt.options.maxFilterDepth,
    });
    return {};
  }

  const parsedFilters: Record<string, unknown> = {};
  const regexFields: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(filters)) {
    // Security: Block dangerous operators
    if (
      rt.dangerousOperators.includes(key) ||
      (key.startsWith('$') && !['$or', '$and'].includes(key))
    ) {
      rt.reject(`Blocked dangerous operator: ${key}`, { key });
      continue;
    }

    // Skip reserved parameters. Two layers:
    //   1. Cross-kit framework reserved set + `_*` dispatch namespace —
    //      delegated to repo-core's `isControlParam`. Catches `page`,
    //      `limit`, `after`, `sort`, `select`, `populate`, `search`,
    //      and any future `_count` / `_distinct` / `_exists` /
    //      `_pluck` / ... that arc-style frameworks add. New keys in
    //      the framework namespace land here without a kit patch.
    //   2. Mongokit-local extras (`lean`, `includeDeleted`, `lookup`,
    //      `aggregate`, `or`, `OR`, `$or`) — kit-specific control
    //      params and OR routing. Stay inline because they don't
    //      generalize to other backends.
    if (
      isControlParam(key) ||
      ['lean', 'includeDeleted', 'lookup', 'aggregate', 'or', 'OR', '$or'].includes(key)
    ) {
      continue;
    }

    // Handle operator syntax: field[operator]=value
    const operatorMatch = key.match(/^(.+)\[(.+)\]$/);
    const baseField = operatorMatch ? operatorMatch[1] : key;

    if (rt.options.allowedFilterFields && !rt.options.allowedFilterFields.includes(baseField)) {
      rt.reject(`Blocked filter field not in allowlist: ${baseField}`, { field: baseField });
      continue;
    }

    if (operatorMatch) {
      const [, , operator] = operatorMatch;
      if (rt.dangerousOperators.includes(`$${operator}`)) {
        rt.reject(`Blocked dangerous operator: ${operator}`, { operator });
        continue;
      }
      handleOperatorSyntax(rt, parsedFilters, regexFields, operatorMatch, value);
      continue;
    }

    // Handle object value (parsed by qs or similar)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      handleBracketSyntax(rt, key, value as Record<string, unknown>, parsedFilters, depth + 1);
    } else {
      // Direct field assignment — schema-aware when a type is configured,
      // heuristic coercion otherwise.
      parsedFilters[key] = coerceFieldValue(key, value, rt.fieldTypes);
    }
  }

  return parsedFilters;
}

/** Handle flat operator syntax: field[operator]=value */
function handleOperatorSyntax(
  rt: ParserRuntime,
  filters: Record<string, unknown>,
  regexFields: Record<string, boolean>,
  operatorMatch: RegExpMatchArray,
  value: FilterValue,
): void {
  const [, field, operator] = operatorMatch;

  // Skip empty values
  if (value === '' || value === null || value === undefined) {
    return;
  }

  // Check operator allowlist
  if (
    rt.options.allowedOperators &&
    !rt.options.allowedOperators.includes(operator.toLowerCase())
  ) {
    rt.reject(`Operator not in allowlist: ${operator}`, { field, operator });
    return;
  }

  // Handle regex options — only allow safe MongoDB regex flags (i, m, s, x)
  if (operator.toLowerCase() === 'options' && regexFields[field]) {
    const fieldValue = filters[field];
    if (typeof fieldValue === 'object' && fieldValue !== null && '$regex' in fieldValue) {
      if (typeof value === 'string' && /^[imsx]+$/.test(value)) {
        (fieldValue as Record<string, unknown>).$options = value;
      } else {
        rt.reject(
          `Blocked invalid regex $options value: ${String(value)}. Allowed flags: i, m, s, x`,
          { field, value: String(value) },
        );
      }
    }
    return;
  }

  // Handle between — stored as a marker for enhanceWithBetween, mirroring
  // the nested bracket-syntax path. Without this, a flat `field[between]=a,b`
  // key fell through to the generic branch and shipped a bogus `$between`
  // operator to MongoDB.
  if (operator.toLowerCase() === 'between') {
    if (
      typeof filters[field] !== 'object' ||
      filters[field] === null ||
      Array.isArray(filters[field])
    ) {
      filters[field] = {};
    }
    (filters[field] as Record<string, unknown>).between = value;
    return;
  }

  // Handle like/contains — literal substring semantics, so unsafe input is
  // escaped rather than rejected even in `invalidInput: 'throw'` mode.
  if (operator.toLowerCase() === 'contains' || operator.toLowerCase() === 'like') {
    const safeRegex = createSafeRegex(rt, value, 'i', 'escape');
    if (safeRegex) {
      filters[field] = { $regex: safeRegex };
      regexFields[field] = true;
    }
    return;
  }

  // Handle geo operators (near / nearSphere / geoWithin) before falling
  // through to numeric/eq handling. Delegated entirely to the geo primitive
  // module — this branch is just routing. parseGeoFilter returns null when
  // the operator isn't a geo operator (fall through) or the input is invalid.
  if (isGeoOperator(operator)) {
    const geoFilter = parseGeoFilter(operator, value);
    if (geoFilter) {
      filters[field] = geoFilter;
    } else {
      rt.reject(`Invalid geo operator value for ${field}[${operator}]; dropping filter`, {
        field,
        operator,
      });
    }
    return;
  }

  const mongoOperator = toMongoOperator(operator);

  if (rt.dangerousOperators.includes(mongoOperator)) {
    rt.reject(`Blocked dangerous operator: ${mongoOperator}`, { operator: mongoOperator });
    return;
  }

  if (mongoOperator === '$eq') {
    // Coerce equality value through the schema-aware path so direct equality
    // and bracketed [eq] behave identically: `?stock=50` and `?stock[eq]=50`
    // both produce the number 50 against a Number field, and both preserve
    // "12345" as a string against a String field.
    filters[field] = coerceFieldValue(field, value, rt.fieldTypes);
  } else if (mongoOperator === '$regex') {
    // Explicit `regex` operator — the caller claims real regex input, so
    // unsafe patterns route through the invalidInput policy.
    const safeRegex = createSafeRegex(rt, value);
    if (safeRegex) {
      filters[field] = { $regex: safeRegex };
      regexFields[field] = true;
    }
  } else {
    let processedValue: unknown;
    const op = operator.toLowerCase();

    if (op === 'size') {
      // $size always takes a non-negative integer regardless of field type
      processedValue = parseFloat(String(value));
      if (Number.isNaN(processedValue as number)) {
        rt.reject(`Non-numeric value for ${field}[${op}]: ${String(value)}`, { field, op });
        return;
      }
    } else if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
      // Range operators: use schema-aware coercion when a type is declared
      // (so Date / ObjectId / Number fields all work correctly), and fall
      // back to numeric parseFloat when no schema entry exists (preserves
      // pre-3.5.5 behavior for ad-hoc filters and rejects garbage values
      // like `?score[gte]=foo`).
      if (rt.fieldTypes.has(field)) {
        processedValue = coerceFieldValue(field, value, rt.fieldTypes);
        if (typeof processedValue === 'number' && Number.isNaN(processedValue)) {
          rt.reject(`Invalid value for ${field}[${op}]: ${String(value)}`, { field, op });
          return;
        }
      } else {
        processedValue = parseFloat(String(value));
        if (Number.isNaN(processedValue as number)) {
          rt.reject(`Non-numeric value for ${field}[${op}]: ${String(value)}`, { field, op });
          return;
        }
      }
    } else if (op === 'in' || op === 'nin') {
      const rawList = Array.isArray(value)
        ? value
        : String(value)
            .split(',')
            .map((v) => v.trim());
      // Per-element coercion: `?ratings[in]=1,2,3` against a [Number] field
      // becomes `[1, 2, 3]`, while `?tags[in]=01234,sale` against a [String]
      // field stays `['01234', 'sale']`.
      processedValue = rawList.map((elem) => coerceFieldValue(field, elem, rt.fieldTypes));
    } else {
      processedValue = coerceFieldValue(field, value, rt.fieldTypes);
    }

    // Only create the object if we have a valid value to set
    if (
      typeof filters[field] !== 'object' ||
      filters[field] === null ||
      Array.isArray(filters[field])
    ) {
      filters[field] = {};
    }
    (filters[field] as Record<string, unknown>)[mongoOperator] = processedValue;
  }
}

/** Handle bracket syntax with object value (qs-parsed nested operators). */
function handleBracketSyntax(
  rt: ParserRuntime,
  field: string,
  operators: Record<string, unknown>,
  parsedFilters: Record<string, unknown>,
  depth: number = 0,
): void {
  // Depth check for nested objects
  if (depth > rt.options.maxFilterDepth) {
    rt.reject(`Nested filter depth exceeds maximum, skipping field: ${field}`, {
      field,
      maxFilterDepth: rt.options.maxFilterDepth,
    });
    return;
  }

  // Reserved-key typo guard. Common mistake: writing `?filters[limit]=5`
  // instead of `?limit=5`. The qs parser nests it under `filters`, so it
  // never reaches the top-level reserved-key skip in `parseFilters` and
  // gets silently dropped by the operator router below (no `limit`
  // operator exists). Warn so the caller sees the typo instead of
  // wondering why their pagination/sort/select isn't taking effect.
  // Scoped to control-plane keys only — `in`, `nin`, `gt`, etc. remain
  // valid operators inside bracket syntax.
  for (const op of Object.keys(operators)) {
    if (RESERVED_PAGINATION_KEYS.has(op)) {
      warn(
        `[mongokit] Nested filter contains reserved key '${op}' at '${field}.${op}' — ` +
          `did you mean ?${op}=... at the top level? The nested value is ignored.`,
      );
    }
  }

  if (!parsedFilters[field]) {
    parsedFilters[field] = {};
  }

  for (const [operator, value] of Object.entries(operators)) {
    // Skip empty strings
    if (value === '' || value === null || value === undefined) continue;

    if (operator === 'between') {
      (parsedFilters[field] as Record<string, unknown>).between = value;
      continue;
    }

    // Geo operators short-circuit BEFORE the generic numeric handling.
    // Same contract as handleOperatorSyntax — see comments there.
    if (isGeoOperator(operator)) {
      const geoFilter = parseGeoFilter(operator, value);
      if (geoFilter) {
        parsedFilters[field] = geoFilter;
      } else {
        rt.reject(`Invalid geo operator value for ${field}[${operator}]; dropping filter`, {
          field,
          operator,
        });
        delete parsedFilters[field];
      }
      continue;
    }

    // Check operator allowlist
    if (rt.options.allowedOperators && !rt.options.allowedOperators.includes(operator)) {
      rt.reject(`Operator not in allowlist: ${operator}`, { field, operator });
      continue;
    }

    if (rt.operators[operator]) {
      const mongoOperator = rt.operators[operator];
      let processedValue: unknown;

      if (operator === 'size') {
        // $size always takes a non-negative integer
        processedValue = parseFloat(String(value));
        if (Number.isNaN(processedValue as number)) {
          rt.reject(`Non-numeric value for ${field}[${operator}]: ${String(value)}`, {
            field,
            operator,
          });
          continue;
        }
      } else if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
        // Schema-aware coercion when a type is declared, parseFloat fallback
        // otherwise. Mirrors handleOperatorSyntax — see comments there.
        if (rt.fieldTypes.has(field)) {
          processedValue = coerceFieldValue(field, value, rt.fieldTypes);
          if (typeof processedValue === 'number' && Number.isNaN(processedValue)) {
            rt.reject(`Invalid value for ${field}[${operator}]: ${String(value)}`, {
              field,
              operator,
            });
            continue;
          }
        } else {
          processedValue = parseFloat(String(value));
          if (Number.isNaN(processedValue as number)) {
            rt.reject(`Non-numeric value for ${field}[${operator}]: ${String(value)}`, {
              field,
              operator,
            });
            continue;
          }
        }
      } else if (operator === 'in' || operator === 'nin') {
        const rawList = Array.isArray(value)
          ? value
          : String(value)
              .split(',')
              .map((v) => v.trim());
        // Per-element coercion via the schema-aware path
        processedValue = rawList.map((elem) => coerceFieldValue(field, elem, rt.fieldTypes));
      } else if (operator === 'like' || operator === 'contains' || operator === 'regex') {
        // Apply safe regex handling to prevent ReDoS attacks. like/contains
        // carry literal substring semantics (escape, never reject); only the
        // explicit `regex` operator claims real regex input and routes
        // through the invalidInput policy.
        const safeRegex = createSafeRegex(
          rt,
          value,
          'i',
          operator === 'regex' ? 'reject' : 'escape',
        );
        if (!safeRegex) continue;
        processedValue = safeRegex;
      } else {
        processedValue = coerceFieldValue(field, value, rt.fieldTypes);
      }

      (parsedFilters[field] as Record<string, unknown>)[mongoOperator] = processedValue;
    }
  }

  // Clean up empty field objects
  if (
    typeof parsedFilters[field] === 'object' &&
    Object.keys(parsedFilters[field] as object).length === 0
  ) {
    delete parsedFilters[field];
  }
}

/** Parse `?or=[...]` / `?OR=[...]` / `?$or=[...]` groups into an $or array. */
export function parseOr(
  rt: ParserRuntime,
  query: Record<string, unknown> | null | undefined,
): Record<string, unknown>[] | undefined {
  const orArray: Record<string, unknown>[] = [];
  const raw = query?.or || query?.OR || query?.$or;
  if (!raw) return undefined;

  const items = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.values(raw) : [];
  for (const item of items) {
    if (typeof item === 'object' && item) {
      // Increment depth for $or branches
      const parsedBranch = parseFilters(rt, item as Record<string, FilterValue>, 1);
      // Drop empty branches: a `{}` inside $or matches every document and would
      // silently widen the query. This is critical when a branch contained ONLY
      // dangerous operators (e.g. `{ $where: '...' }`) — parseFilters strips them
      // and returns `{}`. Without this filter, `or=[{$where:...}, {status:'active'}]`
      // would degrade to `[{}, { status: 'active' }]` ≡ match-all instead of safely
      // collapsing to `[{ status: 'active' }]`. See tests/queryParser.review-gaps.test.ts.
      if (Object.keys(parsedBranch).length > 0) {
        orArray.push(parsedBranch);
      }
    }
  }
  return orArray.length ? orArray : undefined;
}

/** Expand `{ field: { between: 'a,b' } }` markers into `$gte`/`$lte` date ranges. */
export function enhanceWithBetween(rt: ParserRuntime, filters: FilterQuery): FilterQuery {
  const output = { ...filters };
  for (const [key, value] of Object.entries(filters || {})) {
    if (value && typeof value === 'object' && 'between' in value) {
      const between = (value as Record<string, unknown>).between as string;
      const [from, to] = String(between)
        .split(',')
        .map((s) => s.trim());
      const fromDate = from ? new Date(from) : undefined;
      const toDate = to ? new Date(to) : undefined;
      const range: Record<string, Date> = {};
      if (fromDate && !Number.isNaN(fromDate.getTime())) range.$gte = fromDate;
      if (toDate && !Number.isNaN(toDate.getTime())) range.$lte = toDate;
      if (Object.keys(range).length === 0) {
        // Neither bound parsed as a date. Reject (400 in 'throw' mode) and
        // drop the filter in 'drop' mode — emitting `{ field: {} }` would be
        // an equality match against the literal empty object.
        rt.reject(`Invalid 'between' value for ${key}: ${String(between)}`, {
          field: key,
          value: String(between),
        });
        delete output[key];
      } else {
        output[key] = range;
      }
    }
  }
  return output;
}
