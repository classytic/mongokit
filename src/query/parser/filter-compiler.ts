/**
 * URL filters → a MongoDB filter. The grammar (keys, operators, value coercion, refusals) is
 * repo-core's `readFilterClauses`; its clauses compile through the Filter IR compiler every
 * repository query uses, so URL and programmatic filters mean the same thing. Only mongokit's own
 * operators (`size`, `type`, geo) are emitted here, natively.
 */

import {
  clausesToFilter,
  type ExtensionClause,
  type QueryFieldType,
  QueryGrammarError,
  type QueryGrammarOptions,
  readFilterClauses,
} from '@classytic/repo-core/query-parser';
import { compileFilterToMongo } from '../../filter/compile.js';
import { GEO_OPERATORS, parseGeoFilter } from '../primitives/geo.js';
import type { ParserRuntime } from './runtime.js';
import type { FilterQuery } from './types.js';

/** mongokit-native operators, beyond the shared grammar. */
export const MONGOKIT_EXTENSION_OPERATORS: readonly string[] = ['size', 'type', ...GEO_OPERATORS];

/** Group params — `or[0][status]=a&or[1][qty][gte]=5` — compiled branch by branch. */
const GROUP_PARAMS = ['or', 'OR', '$or', '$and'] as const;

/** mongokit control params that are not filters. */
const MONGOKIT_RESERVED_PARAMS: readonly string[] = [
  'lean',
  'includeDeleted',
  'lookup',
  'aggregate',
  'cursor',
  ...GROUP_PARAMS,
];

const BSON_TYPE_RE = /^(?:[a-zA-Z]+|\d{1,3})$/;

/** Compile every filter in `query` (group params excluded — see {@link compileGroups}). */
export function compileUrlFilters(rt: ParserRuntime, query: Record<string, unknown>): FilterQuery {
  const { clauses, extensions } = readFilterClauses(query, grammarOptions(rt));
  const base = compileFilterToMongo(clausesToFilter(clauses));
  const extra = extensions
    .map((clause) => compileExtension(rt, clause))
    .filter((part): part is Record<string, unknown> => part !== undefined);
  return conjoin([base, ...extra]);
}

/**
 * `or` / `$or` and `$and` groups. Each branch is a full filter through the same grammar. An empty
 * branch is refused — inside an OR it would match every document — and groups do not nest.
 */
export function compileGroups(
  rt: ParserRuntime,
  query: Record<string, unknown> | null | undefined,
): FilterQuery {
  const out: FilterQuery = {};
  const orRaw = query?.or ?? query?.OR ?? query?.$or;
  const orBranches = orRaw === undefined ? [] : compileBranches(rt, 'or', orRaw);
  if (orBranches.length > 0) out.$or = orBranches;
  const andBranches = query?.$and === undefined ? [] : compileBranches(rt, '$and', query.$and);
  if (andBranches.length > 0) out.$and = andBranches;
  return out;
}

function compileBranches(
  rt: ParserRuntime,
  param: string,
  raw: unknown,
): Record<string, unknown>[] {
  const items = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : undefined;
  if (!items) {
    rt.reject(`${param} takes branches: ${param}[0][field]=value`, { param });
    return [];
  }
  const branches: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      rt.reject(`each ${param} branch is a set of filters`, { param });
      continue;
    }
    if (GROUP_PARAMS.some((group) => group in item)) {
      rt.reject(`${param} groups do not nest`, { param });
      continue;
    }
    const branch = compileUrlFilters(rt, item);
    if (Object.keys(branch).length === 0) {
      rt.reject(`an empty ${param} branch would match every document`, { param });
      continue;
    }
    branches.push(branch);
  }
  return branches;
}

function grammarOptions(rt: ParserRuntime): QueryGrammarOptions {
  return {
    allowedFilterFields: rt.options.allowedFilterFields,
    allowedOperators: rt.options.allowedOperators,
    fieldTypes: rt.grammarFieldTypes,
    extensionOperators: MONGOKIT_EXTENSION_OPERATORS,
    reservedParams: MONGOKIT_RESERVED_PARAMS,
    maxTextLength: rt.options.maxRegexLength,
    onInvalid: rt.options.invalidInput === 'drop' ? (error) => rt.reject(error.message) : undefined,
  };
}

function compileExtension(
  rt: ParserRuntime,
  clause: ExtensionClause,
): Record<string, unknown> | undefined {
  const param = `${clause.field}[${clause.op}]`;
  try {
    switch (clause.op) {
      case 'size': {
        if (!/^\d+$/.test(clause.raw))
          throw new QueryGrammarError(param, 'size takes a whole number');
        return { [clause.field]: { $size: Number(clause.raw) } };
      }
      case 'type': {
        if (!BSON_TYPE_RE.test(clause.raw)) throw new QueryGrammarError(param, 'not a BSON type');
        const code = Number(clause.raw);
        return { [clause.field]: { $type: Number.isInteger(code) ? code : clause.raw } };
      }
      default: {
        const geo = parseGeoFilter(clause.op, clause.raw);
        if (!geo) throw new QueryGrammarError(param, `invalid ${clause.op} coordinates`);
        return { [clause.field]: geo };
      }
    }
  } catch (error) {
    if (!(error instanceof QueryGrammarError) || rt.options.invalidInput !== 'drop') throw error;
    rt.reject(error.message);
    return undefined;
  }
}

/** AND compiled parts: one object when fields don't collide, `$and` when they do. */
function conjoin(parts: readonly Record<string, unknown>[]): FilterQuery {
  const nonEmpty = parts.filter((part) => Object.keys(part).length > 0);
  if (nonEmpty.length <= 1) return { ...(nonEmpty[0] ?? {}) };
  const merged: Record<string, unknown> = {};
  for (const part of nonEmpty) {
    for (const key of Object.keys(part)) {
      if (key in merged) return { $and: nonEmpty };
    }
    Object.assign(merged, part);
  }
  return merged;
}

/** mongokit's schema-derived field types, narrowed to the grammar's portable set. */
export function toGrammarFieldTypes(
  types: ReadonlyMap<string, string>,
): Readonly<Record<string, QueryFieldType>> {
  const out: Record<string, QueryFieldType> = {};
  for (const [path, type] of types) {
    if (type === 'string' || type === 'objectid') out[path] = 'string';
    else if (type === 'number' || type === 'boolean' || type === 'date') out[path] = type;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
