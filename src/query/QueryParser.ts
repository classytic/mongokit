/**
 * Modern Query Parser - URL to MongoDB Query Transpiler
 *
 * Converts URL parameters to MongoDB queries with support for custom field
 * lookups ($lookup), operator filtering, full-text search, URL aggregations,
 * and security hardening.
 *
 * This file is the public facade: options resolution, the `parse()`
 * orchestration, and the OpenAPI schema surface. The implementation lives in
 * focused modules under `./parser/`:
 *
 * - `parser/filter-compiler`    — filters (repo-core's shared grammar → Filter IR → Mongo), groups
 * - `parser/pipeline-sanitizer` — $match / $lookup-pipeline / expression sanitizing
 * - `parser/lookup`             — ?lookup[...] parsing + collection allowlist
 * - `parser/aggregation`        — ?aggregate[...] parsing (opt-in)
 * - `parser/populate`           — ?populate parsing (simple + nested)
 * - `parser/sort-select`        — ?sort / ?select parsing
 * - `parser/search`             — search sanitization + regex-mode $or builder
 * - `parser/schema-docs`        — OpenAPI query-schema generation
 * - `parser/runtime`            — shared runtime + invalidInput policy
 *
 * @example
 * ```typescript
 * const parser = new QueryParser();
 * const query = parser.parse(req.query);
 * // URL: ?status=active&lookup[department]=slug&sort=-createdAt&page=1&limit=20
 * // Result: Complete MongoDB query with $lookup, filters, sort, pagination
 * ```
 *
 * ## SECURITY
 *
 * - `invalidInput` defaults to `'throw'` (fail-closed): invalid or blocked
 *   query input raises HTTP 400 (`code: 'INVALID_QUERY_INPUT'`) instead of
 *   being silently dropped (which broadens the result set). Opt into
 *   `'drop'` only for trusted compat tooling.
 * - Dangerous operators blocked everywhere ($where, $function, $accumulator, $expr).
 * - Filters, paging, sort and select follow repo-core's shared query grammar — the same
 *   contract as arc's parser and `parseUrl` (`runQueryGrammarConformance` holds all three).
 * - Text operators and search are literal text; only `regex` is a pattern, checked for ReDoS.
 * - Lookup pipelines sanitized; `enableAggregations` is opt-in — keep it off
 *   for public endpoints or pair with per-route allowlists.
 *
 * @see {@link https://github.com/classytic/mongokit/blob/main/docs/SECURITY.md}
 */

import { readPageRequest, URL_OPERATORS } from '@classytic/repo-core/query-parser';
import { warn } from '../utils/logger.js';
import { parseAggregation } from './parser/aggregation.js';
import {
  compileGroups,
  compileUrlFilters,
  MONGOKIT_EXTENSION_OPERATORS,
  toGrammarFieldTypes,
} from './parser/filter-compiler.js';
import { parseLookups } from './parser/lookup.js';
import { parsePopulate } from './parser/populate.js';
import {
  BASE_DANGEROUS_OPERATORS,
  createReject,
  guarded,
  type ParserRuntime,
} from './parser/runtime.js';
import {
  buildOpenAPIQuerySchema,
  buildQuerySchema,
  type QuerySchema,
} from './parser/schema-docs.js';
import { buildRegexSearch, sanitizeSearch } from './parser/search.js';
import {
  DEFAULT_PARSER_SORT,
  isSortFieldAllowed,
  parseSelect,
  parseSort,
} from './parser/sort-select.js';
import type { ParsedQuery, QueryParserOptions } from './parser/types.js';
import { buildFieldTypeMap, type SchemaPathsLike } from './primitives/coercion.js';
import {
  extractSchemaIndexes,
  type IndexableSchema,
  type SchemaIndexes,
} from './primitives/indexes.js';

// `FilterValue` and the parser's own `SortSpec` are deliberately NOT re-exported
// here. The public `SortSpec` is `types/core.ts`'s (`Record<string, SortDirection>`),
// re-exported through `query/index.ts`; the parser's is the narrower
// `Record<string, 1 | -1>`. Surfacing both under one name from two paths gave the
// package two different public `SortSpec`s depending on where you imported from.
export type {
  FieldType,
  FilterQuery,
  ParsedQuery,
  PopulateOption,
  QueryParserOptions,
  SchemaLike,
  SearchMode,
} from './parser/types.js';

/**
 * Modern Query Parser
 * Converts URL parameters to MongoDB queries with $lookup support
 */
export class QueryParser {
  /**
   * Shared runtime handed to every parser module. `schema` and `fieldTypes`
   * are consumed once at construction to build the coercion map and are not
   * retained — the parser never holds a reference to the user's Mongoose
   * schema.
   */
  private readonly rt: ParserRuntime;
  /**
   * Structured schema-index info (geo / text / other), built once from
   * `options.schema?.indexes()`. Exposed via `parser.schemaIndexes` for
   * downstream tools (Arc MCP, query planners).
   */
  private readonly _schemaIndexes: SchemaIndexes;

  constructor(options: QueryParserOptions = {}) {
    const resolved = {
      invalidInput: options.invalidInput ?? 'throw',
      maxRegexLength: options.maxRegexLength ?? 500,
      maxSearchLength: options.maxSearchLength ?? 200,
      maxFilterDepth: options.maxFilterDepth ?? 10,
      maxLimit: options.maxLimit ?? 1000,
      additionalDangerousOperators: options.additionalDangerousOperators ?? [],
      enableLookups: options.enableLookups ?? true,
      enableAggregations: options.enableAggregations ?? false,
      searchMode: options.searchMode ?? 'text',
      searchFields: options.searchFields,
      allowedLookupCollections: options.allowedLookupCollections,
      allowedFilterFields: options.allowedFilterFields,
      allowedSortFields: options.allowedSortFields,
      allowedOperators: options.allowedOperators,
    };

    // Validate: regex mode requires searchFields
    if (
      resolved.searchMode === 'regex' &&
      (!resolved.searchFields || resolved.searchFields.length === 0)
    ) {
      warn(
        '[mongokit] searchMode "regex" requires searchFields to be specified. Falling back to "text" mode.',
      );
      resolved.searchMode = 'text';
    }

    const fieldTypes = buildFieldTypeMap(
      options.schema as SchemaPathsLike | undefined,
      options.fieldTypes,
    );
    this.rt = {
      options: resolved,
      urlOperators: [...URL_OPERATORS, ...MONGOKIT_EXTENSION_OPERATORS],
      dangerousOperators: [...BASE_DANGEROUS_OPERATORS, ...resolved.additionalDangerousOperators],
      fieldTypes,
      grammarFieldTypes: toGrammarFieldTypes(fieldTypes),
      reject: createReject(resolved.invalidInput),
    };

    // Schema index introspection — always populated, empty when no schema.
    this._schemaIndexes = extractSchemaIndexes(options.schema as IndexableSchema | undefined);
  }

  /**
   * Structured view of the configured schema's indexes — geo fields, text
   * fields, and other compound indexes. Empty arrays when no schema was
   * provided. Stable across the parser's lifetime.
   */
  get schemaIndexes(): SchemaIndexes {
    return this._schemaIndexes;
  }

  /**
   * Get the configured allowed filter fields.
   * Returns `undefined` if no whitelist is set (all fields allowed).
   *
   * Used by Arc's MCP integration to auto-derive `filterableFields`
   * from the QueryParser when `schemaOptions.filterableFields` is not set.
   */
  get allowedFilterFields(): string[] | undefined {
    return this.rt.options.allowedFilterFields;
  }

  /**
   * Get the configured allowed sort fields.
   * Returns `undefined` if no whitelist is set (all fields allowed).
   */
  get allowedSortFields(): string[] | undefined {
    return this.rt.options.allowedSortFields;
  }

  /**
   * The configured page-size cap — EXPOSED so a caller does not apply a second one.
   *
   * A resource that constructs `new QueryParser({ maxLimit: 1000 })` has answered the
   * question "how large may a page be?". Without a way to read it back, every layer
   * downstream applies its own default and the LOWEST silently wins — which is exactly
   * what happened: a resource asked for 1000, a repository was configured for 1000, and
   * arc's `QueryResolver` capped at its own default of 100. Three caps, one winner, no
   * signal, and an account picker that showed 100 of 696 rows.
   *
   * Read this instead of defaulting when a parser is supplied.
   */
  get maxLimit(): number {
    return this.rt.options.maxLimit;
  }

  /**
   * Get the configured allowed operators.
   * Returns `undefined` if no whitelist is set (all built-in operators allowed).
   */
  get allowedOperators(): string[] | undefined {
    return this.rt.options.allowedOperators;
  }

  /**
   * Parse URL query parameters into MongoDB query format
   *
   * @example
   * ```typescript
   * // URL: ?status=active&lookup[department][foreignField]=slug&sort=-createdAt&page=1
   * const query = parser.parse(req.query);
   * // Returns: { filters: {...}, lookups: [...], sort: {...}, page: 1 }
   * ```
   */
  parse(query: Record<string, unknown> | null | undefined): ParsedQuery {
    const rt = this.rt;
    const q = query ?? {};
    const { page, limit, sort, populate, search, after, cursor, select, lookup, aggregate } = q;

    const pageRequest = guarded(
      rt,
      () => readPageRequest({ page, limit, after, cursor }, { maxLimit: rt.options.maxLimit }),
      readPageRequest({}, { maxLimit: rt.options.maxLimit }),
    );

    // The default sort applies only when the allowlist permits it — a default the resource
    // forbade is not a caller error, so it is simply not applied.
    const effectiveSort =
      sort === undefined && isSortFieldAllowed(rt, DEFAULT_PARSER_SORT)
        ? DEFAULT_PARSER_SORT
        : sort;

    const sanitizedSearch = sanitizeSearch(rt, search);
    const { simplePopulate, populateOptions } = parsePopulate(rt, populate);

    const parsed: ParsedQuery = {
      filters: compileUrlFilters(rt, q),
      limit: pageRequest.limit,
      sort: parseSort(rt, effectiveSort),
      populate: simplePopulate,
      populateOptions,
      search: sanitizedSearch,
    };

    if (sanitizedSearch && rt.options.searchMode === 'regex' && rt.options.searchFields) {
      const regexSearch = buildRegexSearch(rt, sanitizedSearch);
      if (regexSearch) {
        parsed.filters = attachCondition(parsed.filters, { $or: regexSearch });
        // Repository must not also add $text.
        parsed.search = undefined;
      }
    }
    const groups = compileGroups(rt, q);
    if (groups.$or) parsed.filters = attachCondition(parsed.filters, { $or: groups.$or });
    if (groups.$and) parsed.filters = attachCondition(parsed.filters, { $and: groups.$and });

    const projection = parseSelect(rt, select);
    if (projection) parsed.select = projection;

    if (rt.options.enableLookups && lookup) {
      parsed.lookups = parseLookups(rt, lookup);
    }
    if (rt.options.enableAggregations && aggregate) {
      parsed.aggregation = parseAggregation(rt, aggregate);
    }

    if (pageRequest.after !== undefined) parsed.after = pageRequest.after;
    if (pageRequest.page !== undefined) parsed.page = pageRequest.page;

    return parsed;
  }

  /**
   * Generate OpenAPI-compatible JSON Schema for query parameters.
   * Arc's defineResource() auto-detects this method and uses it
   * to document list endpoint query parameters in OpenAPI/Swagger.
   */
  getQuerySchema(): QuerySchema {
    return buildQuerySchema(this.rt);
  }

  /**
   * Get the query schema with OpenAPI extensions (x-internal metadata).
   * Use this when generating OpenAPI/Swagger docs — it includes a documentary
   * `_filterOperators` property describing available filter operators.
   * For validation-only schemas, use `getQuerySchema()` instead.
   */
  getOpenAPIQuerySchema(): {
    type: 'object';
    properties: Record<string, unknown>;
  } {
    return buildOpenAPIQuerySchema(this.rt);
  }
}

/**
 * AND a top-level condition (`{ $or }` / `{ $and }`) into `filters`: alongside when its key is
 * free, otherwise both go under one `$and` so neither overwrites the other.
 */
function attachCondition(
  filters: Record<string, unknown>,
  condition: Record<string, unknown>,
): Record<string, unknown> {
  const [key] = Object.keys(condition) as [string];
  if (!(key in filters)) return { ...filters, ...condition };
  const { [key]: existing, ...rest } = filters;
  const prior = key === '$and' ? (existing as unknown[]) : [{ [key]: existing }];
  const next = key === '$and' ? (condition.$and as unknown[]) : [condition];
  const and = rest.$and ? [...(rest.$and as unknown[]), ...prior, ...next] : [...prior, ...next];
  return { ...rest, $and: and };
}
