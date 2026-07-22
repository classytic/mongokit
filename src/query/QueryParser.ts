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
 * - `parser/filter-compiler`    — filters, operator syntax, $or, between
 * - `parser/regex-safety`       — ReDoS protection (escape/reject)
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
 * - Regex patterns validated (ReDoS protection); search/like/contains are
 *   literal text (escaped, never rejected).
 * - Max filter depth + max limit enforced.
 * - Lookup pipelines sanitized; `enableAggregations` is opt-in — keep it off
 *   for public endpoints or pair with per-route allowlists.
 *
 * @see {@link https://github.com/classytic/mongokit/blob/main/docs/SECURITY.md}
 */

import { warn } from '../utils/logger.js';
import { parseAggregation } from './parser/aggregation.js';
import { enhanceWithBetween, parseFilters, parseOr } from './parser/filter-compiler.js';
import { parseLookups } from './parser/lookup.js';
import { parsePositiveInt } from './parser/pagination-input.js';
import { parsePopulate } from './parser/populate.js';
import {
  BASE_DANGEROUS_OPERATORS,
  createReject,
  OPERATOR_MAP,
  type ParserRuntime,
} from './parser/runtime.js';
import {
  buildOpenAPIQuerySchema,
  buildQuerySchema,
  type QuerySchema,
} from './parser/schema-docs.js';
import { buildRegexSearch, sanitizeSearch } from './parser/search.js';
import { parseSelect, parseSort } from './parser/sort-select.js';
import type { FilterValue, ParsedQuery, QueryParserOptions, SortSpec } from './parser/types.js';
import { buildFieldTypeMap, type SchemaPathsLike } from './primitives/coercion.js';
import {
  extractSchemaIndexes,
  type IndexableSchema,
  type SchemaIndexes,
} from './primitives/indexes.js';

export type {
  FieldType,
  FilterQuery,
  FilterValue,
  ParsedQuery,
  PopulateOption,
  QueryParserOptions,
  SchemaLike,
  SearchMode,
  SortSpec,
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

    this.rt = {
      options: resolved,
      operators: OPERATOR_MAP,
      dangerousOperators: [...BASE_DANGEROUS_OPERATORS, ...resolved.additionalDangerousOperators],
      fieldTypes: buildFieldTypeMap(
        options.schema as SchemaPathsLike | undefined,
        options.fieldTypes,
      ),
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
    const {
      page,
      limit = 20,
      sort = '-createdAt',
      populate,
      search,
      after,
      cursor,
      select,
      lookup,
      aggregate,
      ...filters
    } = query || {};

    // Parse + validate limit. Invalid input (non-integer, negative) is
    // fail-closed via the policy; absence falls back to the default 20.
    // Exceeding maxLimit is CLAMPED, not rejected — capping is not invalid.
    let parsedLimit = parsePositiveInt(rt, limit, 'limit') ?? 20;
    if (parsedLimit > rt.options.maxLimit) {
      warn(
        `[mongokit] Limit ${parsedLimit} exceeds maximum ${rt.options.maxLimit}, capping to max`,
      );
      parsedLimit = rt.options.maxLimit;
    }

    const sanitizedSearch = sanitizeSearch(rt, search);
    const { simplePopulate, populateOptions } = parsePopulate(rt, populate);

    const parsed: ParsedQuery = {
      filters: parseFilters(rt, filters as Record<string, FilterValue>),
      limit: parsedLimit,
      sort: parseSort(rt, sort as string | SortSpec | undefined),
      populate: simplePopulate,
      populateOptions,
      search: sanitizedSearch,
    };

    // Handle regex search mode - add $or with regex to filters
    if (sanitizedSearch && rt.options.searchMode === 'regex' && rt.options.searchFields) {
      const regexSearchFilters = buildRegexSearch(rt, sanitizedSearch);
      if (regexSearchFilters) {
        if (parsed.filters.$or) {
          // If there's already an $or, wrap both in $and
          parsed.filters = {
            ...parsed.filters,
            $and: [
              { $or: parsed.filters.$or as Record<string, unknown>[] },
              { $or: regexSearchFilters },
            ],
          };
          delete parsed.filters.$or;
        } else {
          parsed.filters.$or = regexSearchFilters;
        }
        // Clear search so Repository doesn't also add $text
        parsed.search = undefined;
      }
    }

    if (select) {
      parsed.select = parseSelect(select);
    }

    if (rt.options.enableLookups && lookup) {
      parsed.lookups = parseLookups(rt, lookup);
    }

    if (rt.options.enableAggregations && aggregate) {
      parsed.aggregation = parseAggregation(rt, aggregate);
    }

    // Pagination parameters (pass through without forcing offset mode unless explicitly provided)
    if (after || cursor) {
      parsed.after = String(after || cursor);
    }
    const parsedPage = parsePositiveInt(rt, page, 'page');
    if (parsedPage !== undefined) {
      parsed.page = parsedPage;
    }

    // Parse $or conditions from URL params
    const orGroup = parseOr(rt, query);
    if (orGroup) {
      // If regex search already added $or, combine both using $and
      if (parsed.filters.$or) {
        const existingOr = parsed.filters.$or as Record<string, unknown>[];
        delete parsed.filters.$or;
        parsed.filters.$and = [{ $or: existingOr }, { $or: orGroup }];
      } else {
        parsed.filters.$or = orGroup;
      }
    }

    // Enhance with between operator
    parsed.filters = enhanceWithBetween(rt, parsed.filters);

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
