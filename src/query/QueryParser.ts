/**
 * Modern Query Parser - URL to MongoDB Query Transpiler
 *
 * Next-generation query parser that converts URL parameters to MongoDB aggregation pipelines.
 * Smarter than Prisma/tRPC for MongoDB with support for:
 * - Custom field lookups ($lookup)
 * - Complex filtering with operators
 * - Full-text search
 * - Aggregations via URL
 * - Security hardening
 *
 * @example
 * ```typescript
 * // Simple usage
 * const parser = new QueryParser();
 * const query = parser.parse(req.query);
 *
 * // URL: ?status=active&lookup[department]=slug&sort=-createdAt&page=1&limit=20
 * // Result: Complete MongoDB query with $lookup, filters, sort, pagination
 * ```
 *
 * ## SECURITY CONSIDERATIONS FOR PRODUCTION
 *
 * ### Aggregation Security (enableAggregations option)
 *
 * **IMPORTANT:** The `enableAggregations` option exposes powerful MongoDB aggregation
 * pipeline capabilities via URL parameters. While this feature includes sanitization
 * (blocks $where, $function, $accumulator), it should be used with caution:
 *
 * **Recommended security practices:**
 * 1. **Disable by default for public endpoints:**
 *    ```typescript
 *    const parser = new QueryParser({
 *      enableAggregations: false  // Default: disabled
 *    });
 *    ```
 *
 * 2. **Use per-route allowlists for trusted clients:**
 *    ```typescript
 *    // Admin/internal routes only
 *    if (req.user?.role === 'admin') {
 *      const allowedStages = ['$match', '$project', '$sort', '$limit'];
 *      // Validate aggregate parameter against allowlist
 *    }
 *    ```
 *
 * 3. **Validate stage structure:** Even with sanitization, complex pipelines can
 *    cause performance issues. Consider limiting:
 *    - Number of pipeline stages (e.g., max 5)
 *    - Specific allowed operators per stage
 *    - Allowed fields in $project/$match
 *
 * 4. **Monitor resource usage:** Aggregation pipelines can be expensive.
 *    Use MongoDB profiling to track slow operations.
 *
 * ### Lookup Security
 *
 * Lookup pipelines are sanitized by default:
 * - Dangerous stages blocked ($out, $merge, $unionWith, $collStats, $currentOp, $listSessions)
 * - Dangerous operators blocked inside $match/$addFields/$set ($where, $function, $accumulator, $expr)
 * - Optional collection whitelist via `allowedLookupCollections`
 * For maximum security, use per-collection field allowlists in your controller layer.
 *
 * ### Filter Security
 *
 * All filters are sanitized:
 * - Dangerous operators blocked ($where, $function, $accumulator, $expr)
 * - Regex patterns validated (ReDoS protection)
 * - Max filter depth enforced (prevents filter bombs)
 * - Max limit enforced (prevents resource exhaustion)
 *
 * @see {@link https://github.com/classytic/mongokit/blob/main/docs/SECURITY.md}
 */

import type { PipelineStage } from 'mongoose';
import { warn } from '../utils/logger.js';
import type { LookupOptions } from './LookupBuilder.js';
import {
  buildFieldTypeMap,
  coerceFieldValue,
  coerceHeuristic,
  type FieldType as PrimitiveFieldType,
  type SchemaPathsLike,
} from './primitives/coercion.js';
import { isGeoOperator, parseGeoFilter } from './primitives/geo.js';
import {
  extractSchemaIndexes,
  type IndexableSchema,
  type SchemaIndexes,
} from './primitives/indexes.js';

export type SortSpec = Record<string, 1 | -1>;
export type FilterQuery = Record<string, unknown>;
export type FilterValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, unknown>
  | unknown[];

/**
 * Mongoose-compatible populate option
 * Supports advanced populate with select, match, limit, sort, and nested populate
 *
 * @example
 * ```typescript
 * // URL: ?populate[author][select]=name,email&populate[author][match][active]=true
 * // Generates: { path: 'author', select: 'name email', match: { active: true } }
 * ```
 */
export interface PopulateOption {
  /** Field path to populate */
  path: string;
  /** Fields to select (space-separated) */
  select?: string;
  /** Filter conditions for populated documents */
  match?: Record<string, unknown>;
  /** Query options (limit, sort, skip) */
  options?: {
    limit?: number;
    sort?: SortSpec;
    skip?: number;
  };
  /** Nested populate configuration */
  populate?: PopulateOption;
}

/** Parsed query result with optional lookup configuration */
export interface ParsedQuery {
  /** MongoDB filter query */
  filters: FilterQuery;
  /** Sort specification */
  sort?: SortSpec;
  /** Fields to populate (simple comma-separated string) */
  populate?: string;
  /**
   * Advanced populate options (Mongoose-compatible)
   * When this is set, `populate` will be undefined
   * @example [{ path: 'author', select: 'name email' }]
   */
  populateOptions?: PopulateOption[];
  /** Page number for offset pagination */
  page?: number;
  /** Cursor for keyset pagination */
  after?: string;
  /** Limit */
  limit: number;
  /** Full-text search query */
  search?: string;
  /** Lookup configurations for custom field joins */
  lookups?: LookupOptions[];
  /** Aggregation pipeline stages (advanced) */
  aggregation?: PipelineStage[];
  /** Select/project fields */
  select?: Record<string, 0 | 1>;
}

/** Search mode for query parser */
export type SearchMode = 'text' | 'regex';

/**
 * Normalized field type used for schema-aware value coercion. Re-exported
 * from `primitives/coercion` so the public QueryParser API stays unchanged
 * while the actual logic lives in a single, unit-tested primitive module.
 */
export type FieldType = PrimitiveFieldType;

/**
 * Minimal structural type for a Mongoose schema. We only read `.paths` and
 * (optionally) `.indexes()`, so the parser stays decoupled from a specific
 * Mongoose major version and is easy to mock in tests. Re-exported from the
 * primitives module — the canonical definition lives there.
 */
export interface SchemaLike extends SchemaPathsLike {
  /** Optional — when present, schema indexes are introspected for geo/text fields */
  indexes?: () => Array<[Record<string, unknown>, Record<string, unknown>?]>;
}

export interface QueryParserOptions {
  /** Maximum allowed regex pattern length (default: 500) */
  maxRegexLength?: number;
  /** Maximum allowed text search query length (default: 200) */
  maxSearchLength?: number;
  /** Maximum allowed filter depth (default: 10) */
  maxFilterDepth?: number;
  /** Maximum allowed limit value (default: 1000) */
  maxLimit?: number;
  /** Additional operators to block */
  additionalDangerousOperators?: string[];
  /** Enable lookup parsing (default: true) */
  enableLookups?: boolean;
  /** Enable aggregation parsing (default: false - requires explicit opt-in) */
  enableAggregations?: boolean;
  /**
   * Search mode (default: 'text')
   * - 'text': Uses MongoDB $text search (requires text index)
   * - 'regex': Uses $or with $regex across searchFields (no index required)
   */
  searchMode?: SearchMode;
  /**
   * Fields to search when searchMode is 'regex'
   * Required when searchMode is 'regex'
   * @example ['name', 'description', 'sku', 'tags']
   */
  searchFields?: string[];
  /**
   * Whitelist of collection names allowed in lookups.
   * When set, only these collections can be used in $lookup stages.
   * When undefined, all collection names are allowed.
   * @example ['departments', 'categories', 'users']
   */
  allowedLookupCollections?: string[];
  /** Allowed fields for filtering. If set, ignores unknown fields. */
  allowedFilterFields?: string[];
  /** Allowed fields for sorting. If set, ignores unknown fields. */
  allowedSortFields?: string[];
  /**
   * Whitelist of allowed filter operators.
   * When set, only these operators can be used in filters.
   * When undefined, all built-in operators are allowed.
   * Values are human-readable keys: 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin',
   * 'like', 'contains', 'regex', 'exists', 'size', 'type'
   * @example ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']
   */
  allowedOperators?: string[];
  /**
   * Mongoose schema (or schema-like object exposing `.paths`) used for
   * authoritative, schema-aware value coercion. When provided, filter values
   * are coerced to the declared field type instead of guessed from the
   * string shape — `?stock=50` becomes a number against a `Number` field but
   * `?name=12345` stays a string against a `String` field. Nested paths like
   * `address.zip` are looked up via dot-notation, matching Mongoose's
   * `schema.paths` reflection. Unknown fields fall through to the heuristic.
   */
  schema?: SchemaLike;
  /**
   * Plain field-type map used for authoritative coercion when no Mongoose
   * schema is available (raw MongoDB, Prisma, computed fields, upstream
   * models you don't own). Takes precedence over `schema` for paths declared
   * in both — useful for runtime overrides. Use dot-notation for nested
   * paths (`'address.zip': 'string'`).
   * @example { stock: 'number', active: 'boolean', releasedAt: 'date' }
   */
  fieldTypes?: Record<string, FieldType>;
}

/**
 * Modern Query Parser
 * Converts URL parameters to MongoDB queries with $lookup support
 */
export class QueryParser {
  // `schema` and `fieldTypes` are NOT stored on `options` — they are consumed
  // once at construction to build `_fieldTypes` and never read again. Keeping
  // them off `options` avoids carrying a reference to the user's Mongoose
  // schema for the lifetime of the parser.
  private readonly options: Required<
    Omit<
      QueryParserOptions,
      | 'enableLookups'
      | 'enableAggregations'
      | 'searchFields'
      | 'allowedLookupCollections'
      | 'allowedFilterFields'
      | 'allowedSortFields'
      | 'allowedOperators'
      | 'schema'
      | 'fieldTypes'
    >
  > &
    Pick<
      QueryParserOptions,
      | 'enableLookups'
      | 'enableAggregations'
      | 'searchFields'
      | 'allowedLookupCollections'
      | 'allowedFilterFields'
      | 'allowedSortFields'
      | 'allowedOperators'
    >;

  private readonly operators: Record<string, string> = {
    eq: '$eq',
    ne: '$ne',
    gt: '$gt',
    gte: '$gte',
    lt: '$lt',
    lte: '$lte',
    in: '$in',
    nin: '$nin',
    like: '$regex',
    contains: '$regex',
    regex: '$regex',
    exists: '$exists',
    size: '$size',
    type: '$type',
  };

  private readonly dangerousOperators: string[];
  /**
   * Normalized dot-notation field-type map. Built once at construction from
   * `options.schema` (Mongoose) and `options.fieldTypes` (override map), with
   * `fieldTypes` taking precedence. An empty map means schema-aware coercion
   * is disabled and the heuristic in `_convertValue` runs unchanged — this
   * preserves backwards compatibility for callers that don't opt in.
   */
  private readonly _fieldTypes: Map<string, FieldType>;
  /**
   * Structured schema-index info (geo / text / other), built once from
   * `options.schema?.indexes()`. Used by the operator router to validate
   * geo operators against actual geo-indexed fields, and exposed publicly
   * via `parser.schemaIndexes` for downstream tools (Arc MCP, query planners).
   */
  private readonly _schemaIndexes: SchemaIndexes;
  /**
   * Regex patterns that can cause catastrophic backtracking (ReDoS attacks)
   * Detects:
   * - Quantifiers: {n,m}
   * - Possessive quantifiers: *+, ++, ?+
   * - Nested quantifiers: (a+)+, (a*)*
   * - Backreferences: \1, \2, etc.
   * - Complex character classes: [...]...[...]
   */
  private readonly dangerousRegexPatterns =
    /(\{[0-9,]+\}|\*\+|\+\+|\?\+|(\(.+\))\+|\(\?:|\\[0-9]|(\[.+\]).+(\[.+\]))/;

  constructor(options: QueryParserOptions = {}) {
    this.options = {
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
      this.options.searchMode === 'regex' &&
      (!this.options.searchFields || this.options.searchFields.length === 0)
    ) {
      warn(
        '[mongokit] searchMode "regex" requires searchFields to be specified. Falling back to "text" mode.',
      );
      this.options.searchMode = 'text';
    }

    this.dangerousOperators = [
      '$where',
      '$function',
      '$accumulator',
      '$expr',
      ...this.options.additionalDangerousOperators,
    ];

    // Build the schema-aware field-type map via the primitive. The primitive
    // handles both `[Type]` and `[{ type: Type }]` array forms across Mongoose
    // versions and is independently unit-tested in
    // `tests/query/primitives/coercion.test.ts`. The orchestrator just supplies
    // the schema and overrides; the primitive owns the normalization.
    this._fieldTypes = buildFieldTypeMap(
      options.schema as SchemaPathsLike | undefined,
      options.fieldTypes,
    );

    // Schema index introspection — always populated, empty when no schema.
    // Read once at construction so the operator router can detect geo-indexed
    // fields without re-running schema.indexes() per query.
    this._schemaIndexes = extractSchemaIndexes(options.schema as IndexableSchema | undefined);
  }

  /**
   * Structured view of the configured schema's indexes — geo fields, text
   * fields, and other compound indexes. Empty arrays when no schema was
   * provided. Stable across the parser's lifetime; mutating the returned
   * object does not affect parser behavior.
   *
   * Useful for downstream tooling (Arc MCP, query planners, doc generators)
   * that needs to know which fields support which query types.
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
    return this.options.allowedFilterFields;
  }

  /**
   * Get the configured allowed sort fields.
   * Returns `undefined` if no whitelist is set (all fields allowed).
   */
  get allowedSortFields(): string[] | undefined {
    return this.options.allowedSortFields;
  }

  /**
   * Get the configured allowed operators.
   * Returns `undefined` if no whitelist is set (all built-in operators allowed).
   */
  get allowedOperators(): string[] | undefined {
    return this.options.allowedOperators;
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

    // Parse and validate limit
    let parsedLimit = parseInt(String(limit), 10);
    if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
      parsedLimit = 20; // Default
    }
    if (parsedLimit > this.options.maxLimit) {
      warn(
        `[mongokit] Limit ${parsedLimit} exceeds maximum ${this.options.maxLimit}, capping to max`,
      );
      parsedLimit = this.options.maxLimit;
    }

    // Sanitize search query
    const sanitizedSearch = this._sanitizeSearch(search);

    // Parse populate (handles both simple string and advanced object format)
    const { simplePopulate, populateOptions } = this._parsePopulate(populate);

    // Build base parsed object
    const parsed: ParsedQuery = {
      filters: this._parseFilters(filters as Record<string, FilterValue>),
      limit: parsedLimit,
      sort: this._parseSort(sort as string | SortSpec | undefined),
      populate: simplePopulate,
      populateOptions,
      search: sanitizedSearch,
    };

    // Handle regex search mode - add $or with regex to filters
    if (sanitizedSearch && this.options.searchMode === 'regex' && this.options.searchFields) {
      const regexSearchFilters = this._buildRegexSearch(sanitizedSearch);
      if (regexSearchFilters) {
        // Merge with existing filters
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

    // Parse select/project fields
    if (select) {
      parsed.select = this._parseSelect(select);
    }

    // Parse lookups (custom field joins)
    if (this.options.enableLookups && lookup) {
      parsed.lookups = this._parseLookups(lookup);
    }

    // Parse aggregation pipeline (advanced - requires opt-in)
    if (this.options.enableAggregations && aggregate) {
      parsed.aggregation = this._parseAggregation(aggregate);
    }

    // Pagination parameters (pass through without forcing offset mode unless explicitly provided)
    if (after || cursor) {
      parsed.after = String(after || cursor);
    }
    if (page !== undefined) {
      parsed.page = parseInt(String(page), 10);
    }

    // Parse $or conditions from URL params
    const orGroup = this._parseOr(query);
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
    parsed.filters = this._enhanceWithBetween(parsed.filters);

    return parsed;
  }

  // ============================================================
  // OPENAPI SCHEMA GENERATION
  // ============================================================

  /**
   * Generate OpenAPI-compatible JSON Schema for query parameters.
   * Arc's defineResource() auto-detects this method and uses it
   * to document list endpoint query parameters in OpenAPI/Swagger.
   *
   * The schema respects parser configuration:
   * - `allowedOperators`: only documents allowed operators
   * - `allowedFilterFields`: generates explicit field[op] entries
   * - `enableLookups` / `enableAggregations`: includes/excludes lookup/aggregate params
   * - `maxLimit` / `maxSearchLength`: reflected in schema constraints
   */
  getQuerySchema(): {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  } {
    const properties: Record<string, unknown> = {
      page: {
        type: 'integer',
        description: 'Page number for offset pagination',
        default: 1,
        minimum: 1,
      },
      limit: {
        type: 'integer',
        description: 'Number of items per page',
        default: 20,
        minimum: 1,
        maximum: this.options.maxLimit,
      },
      sort: {
        type: 'string',
        description:
          'Sort fields (comma-separated). Prefix with - for descending. Example: -createdAt,name',
      },
      search: {
        type: 'string',
        description:
          this.options.searchMode === 'regex'
            ? `Search across fields${this.options.searchFields ? ` (${this.options.searchFields.join(', ')})` : ''} using case-insensitive regex`
            : 'Full-text search query (requires text index)',
        maxLength: this.options.maxSearchLength,
      },
      select: {
        type: 'string',
        description:
          'Fields to include/exclude (comma-separated). Prefix with - to exclude. Example: name,email,-password',
      },
      populate: {
        oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }],
        description:
          'Fields to populate/join. Simple: comma-separated string (author,category). Advanced: bracket-notation object (populate[author][select]=name,email)',
      },
      after: {
        type: 'string',
        description: 'Cursor value for keyset pagination',
      },
    };

    // Add lookup param docs when enabled
    if (this.options.enableLookups) {
      properties.lookup = {
        type: 'object',
        description:
          'Custom field lookups ($lookup). Example: lookup[department]=slug or lookup[department][localField]=deptId&lookup[department][foreignField]=_id',
      };
    }

    // Add aggregate param docs when enabled
    if (this.options.enableAggregations) {
      properties.aggregate = {
        type: 'object',
        description:
          'Aggregation pipeline stages. Supports: group, match, sort, project. Example: aggregate[group][_id]=$status',
      };
    }

    // Determine which operators to document
    const availableOperators = this.options.allowedOperators
      ? Object.entries(this.operators).filter(([key]) =>
          this.options.allowedOperators?.includes(key),
        )
      : Object.entries(this.operators);

    // When allowedFilterFields is set, generate explicit field[op] entries
    if (this.options.allowedFilterFields && this.options.allowedFilterFields.length > 0) {
      for (const field of this.options.allowedFilterFields) {
        // Direct equality filter
        properties[field] = {
          type: 'string',
          description: `Filter by ${field} (exact match)`,
        };
        // Operator-based filters
        for (const [op, mongoOp] of availableOperators) {
          if (op === 'eq') continue; // eq is the default (direct equality)
          properties[`${field}[${op}]`] = {
            type: this._getOperatorSchemaType(op),
            description: this._getOperatorDescription(op, field, mongoOp),
          };
        }
      }
    }

    return { type: 'object', properties };
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
    const schema = this.getQuerySchema();

    const availableOperators = this.options.allowedOperators
      ? Object.entries(this.operators).filter(([key]) =>
          this.options.allowedOperators?.includes(key),
        )
      : Object.entries(this.operators);

    schema.properties._filterOperators = {
      type: 'string',
      description: this._buildOperatorDescription(availableOperators),
      'x-internal': true,
    };

    return schema;
  }

  /**
   * Get the JSON Schema type for a filter operator
   */
  private _getOperatorSchemaType(op: string): string {
    if (['gt', 'gte', 'lt', 'lte', 'size'].includes(op)) return 'number';
    if (['exists'].includes(op)) return 'boolean';
    return 'string';
  }

  /**
   * Get a human-readable description for a filter operator
   */
  private _getOperatorDescription(op: string, field: string, mongoOp: string): string {
    const descriptions: Record<string, string> = {
      ne: `${field} not equal to value (${mongoOp})`,
      gt: `${field} greater than value (${mongoOp})`,
      gte: `${field} greater than or equal to value (${mongoOp})`,
      lt: `${field} less than value (${mongoOp})`,
      lte: `${field} less than or equal to value (${mongoOp})`,
      in: `${field} in comma-separated list (${mongoOp}). Example: value1,value2`,
      nin: `${field} not in comma-separated list (${mongoOp})`,
      like: `${field} matches pattern (case-insensitive regex)`,
      contains: `${field} contains substring (case-insensitive regex)`,
      regex: `${field} matches regex pattern (${mongoOp})`,
      exists: `Field ${field} exists (true/false)`,
      size: `Array field ${field} has exactly N elements (${mongoOp})`,
      type: `Field ${field} is of BSON type (${mongoOp})`,
    };
    return descriptions[op] || `Filter ${field} with ${mongoOp}`;
  }

  /**
   * Build a summary description of all available filter operators
   */
  private _buildOperatorDescription(operators: [string, string][]): string {
    const lines = ['Available filter operators (use as field[operator]=value):'];
    for (const [op, mongoOp] of operators) {
      const desc: Record<string, string> = {
        eq: 'Equal (default when no operator specified)',
        ne: 'Not equal',
        gt: 'Greater than',
        gte: 'Greater than or equal',
        lt: 'Less than',
        lte: 'Less than or equal',
        in: 'In list (comma-separated values)',
        nin: 'Not in list',
        like: 'Pattern match (case-insensitive)',
        contains: 'Contains substring (case-insensitive)',
        regex: 'Regex pattern',
        exists: 'Field exists (true/false)',
        size: 'Array size equals',
        type: 'BSON type check',
      };
      lines.push(`  ${op} → ${mongoOp}: ${desc[op] || op}`);
    }
    return lines.join('\n');
  }

  // ============================================================
  // LOOKUP PARSING (NEW)
  // ============================================================

  /**
   * Parse lookup configurations from URL parameters
   *
   * Supported formats:
   * 1. Simple: ?lookup[department]=slug
   *    → Join with 'departments' collection on slug field
   *
   * 2. Detailed: ?lookup[department][localField]=deptSlug&lookup[department][foreignField]=slug
   *    → Full control over join configuration
   *
   * 3. Multiple: ?lookup[department]=slug&lookup[category]=categorySlug
   *    → Multiple lookups
   *
   * @example
   * ```typescript
   * // URL: ?lookup[department][localField]=deptSlug&lookup[department][foreignField]=slug&lookup[department][single]=true
   * const lookups = parser._parseLookups({
   *   department: { localField: 'deptSlug', foreignField: 'slug', single: 'true' }
   * });
   * // Returns: [{ from: 'departments', localField: 'deptSlug', foreignField: 'slug', single: true }]
   * ```
   */
  private _parseLookups(lookup: unknown): LookupOptions[] {
    if (!lookup || typeof lookup !== 'object') return [];

    const lookups: LookupOptions[] = [];
    const lookupObj = lookup as Record<string, unknown>;

    for (const [collectionName, config] of Object.entries(lookupObj)) {
      try {
        const lookupConfig = this._parseSingleLookup(collectionName, config);
        if (lookupConfig) {
          lookups.push(lookupConfig);
        }
      } catch (error) {
        warn(`[mongokit] Invalid lookup config for ${collectionName}:`, error);
      }
    }

    return lookups;
  }

  /**
   * Parse a single lookup configuration
   */
  private _parseSingleLookup(collectionName: string, config: unknown): LookupOptions | null {
    if (!config) return null;

    // Simple format: lookup[department]=slug
    if (typeof config === 'string') {
      const from = this._pluralize(collectionName);
      if (
        this.options.allowedLookupCollections &&
        !this.options.allowedLookupCollections.includes(from)
      ) {
        warn(`[mongokit] Blocked lookup to disallowed collection: ${from}`);
        return null;
      }
      return {
        from,
        localField: `${collectionName}${this._capitalize(config)}`,
        foreignField: config,
        as: collectionName,
        single: true,
      };
    }

    // Detailed format: lookup[department][localField]=...&lookup[department][foreignField]=...
    if (typeof config === 'object' && config !== null) {
      const opts = config as Record<string, unknown>;

      const from = (opts.from as string) || this._pluralize(collectionName);
      const localField = opts.localField as string;
      const foreignField = opts.foreignField as string;

      // Enforce collection whitelist
      if (
        this.options.allowedLookupCollections &&
        !this.options.allowedLookupCollections.includes(from)
      ) {
        warn(`[mongokit] Blocked lookup to disallowed collection: ${from}`);
        return null;
      }

      if (!localField || !foreignField) {
        warn(`[mongokit] Lookup requires localField and foreignField for ${collectionName}`);
        return null;
      }

      return {
        from,
        localField,
        foreignField,
        as: (opts.as as string) || collectionName,
        single: opts.single === true || opts.single === 'true',
        ...(opts.select ? { select: String(opts.select) } : {}),
        ...(opts.pipeline && Array.isArray(opts.pipeline)
          ? { pipeline: this._sanitizePipeline(opts.pipeline) }
          : {}),
      };
    }

    return null;
  }

  // ============================================================
  // AGGREGATION PARSING (ADVANCED)
  // ============================================================

  /**
   * Parse aggregation pipeline from URL (advanced feature)
   *
   * @example
   * ```typescript
   * // URL: ?aggregate[group][_id]=$status&aggregate[group][count]=$sum:1
   * const pipeline = parser._parseAggregation({
   *   group: { _id: '$status', count: '$sum:1' }
   * });
   * ```
   */
  private _parseAggregation(aggregate: unknown): PipelineStage[] | undefined {
    if (!aggregate || typeof aggregate !== 'object') return undefined;

    const pipeline: PipelineStage[] = [];
    const aggObj = aggregate as Record<string, unknown>;

    for (const [stage, config] of Object.entries(aggObj)) {
      try {
        if (stage === 'group' && typeof config === 'object') {
          pipeline.push({ $group: config as any });
        } else if (stage === 'match' && typeof config === 'object') {
          // Sanitize $match config to prevent dangerous operators like $where
          const sanitizedMatch = this._sanitizeMatchConfig(config as Record<string, unknown>);
          if (Object.keys(sanitizedMatch).length > 0) {
            pipeline.push({ $match: sanitizedMatch });
          }
        } else if (stage === 'sort' && typeof config === 'object') {
          pipeline.push({ $sort: config as SortSpec });
        } else if (stage === 'project' && typeof config === 'object') {
          pipeline.push({ $project: config as Record<string, unknown> });
        }
        // Add more stages as needed
      } catch (error) {
        warn(`[mongokit] Invalid aggregation stage ${stage}:`, error);
      }
    }

    return pipeline.length > 0 ? pipeline : undefined;
  }

  // ============================================================
  // SELECT/PROJECT PARSING
  // ============================================================

  /**
   * Parse select/project fields
   *
   * @example
   * ```typescript
   * // URL: ?select=name,email,-password
   * // Returns: { name: 1, email: 1, password: 0 }
   * ```
   */
  private _parseSelect(select: unknown): Record<string, 0 | 1> | undefined {
    if (!select) return undefined;

    if (typeof select === 'string') {
      const projection: Record<string, 0 | 1> = {};
      const fields = select.split(',').map((f) => f.trim());

      for (const field of fields) {
        if (field.startsWith('-')) {
          projection[field.substring(1)] = 0;
        } else {
          projection[field] = 1;
        }
      }

      return projection;
    }

    if (typeof select === 'object' && select !== null) {
      return select as Record<string, 0 | 1>;
    }

    return undefined;
  }

  // ============================================================
  // POPULATE PARSING
  // ============================================================

  /**
   * Parse populate parameter - handles both simple string and advanced object format
   *
   * @example
   * ```typescript
   * // Simple: ?populate=author,category
   * // Returns: { simplePopulate: 'author,category', populateOptions: undefined }
   *
   * // Advanced: ?populate[author][select]=name,email
   * // Returns: { simplePopulate: undefined, populateOptions: [{ path: 'author', select: 'name email' }] }
   * ```
   */
  private _parsePopulate(populate: unknown): {
    simplePopulate?: string;
    populateOptions?: PopulateOption[];
  } {
    if (!populate) {
      return {};
    }

    // Simple string format: ?populate=author,category
    // Normalize to populateOptions for consistent output format (Bug fix #1)
    // Also keep simplePopulate for backward compatibility
    if (typeof populate === 'string') {
      const paths = populate
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (paths.length > 0) {
        return {
          simplePopulate: populate,
          populateOptions: paths.map((path) => ({ path })),
        };
      }
      return {};
    }

    // Advanced object format: ?populate[author][select]=name,email
    if (typeof populate === 'object' && populate !== null) {
      const populateObj = populate as Record<string, unknown>;

      // Check if it's an empty object
      if (Object.keys(populateObj).length === 0) {
        return {};
      }

      const populateOptions: PopulateOption[] = [];

      for (const [path, config] of Object.entries(populateObj)) {
        // Security: Skip dangerous paths
        if (path.startsWith('$') || this.dangerousOperators.includes(path)) {
          warn(`[mongokit] Blocked dangerous populate path: ${path}`);
          continue;
        }

        const option = this._parseSinglePopulate(path, config);
        if (option) {
          populateOptions.push(option);
        }
      }

      return populateOptions.length > 0 ? { populateOptions } : {};
    }

    return {};
  }

  /**
   * Parse a single populate configuration
   */
  private _parseSinglePopulate(
    path: string,
    config: unknown,
    depth: number = 0,
  ): PopulateOption | null {
    // Prevent infinite recursion
    if (depth > 5) {
      warn(`[mongokit] Populate depth exceeds maximum (5), truncating at path: ${path}`);
      return { path };
    }

    // Shorthand: populate[author]=true (just populate the path)
    if (typeof config === 'string') {
      if (config === 'true' || config === '1') {
        return { path };
      }
      // Could be a select shorthand: populate[author]=name,email
      return { path, select: config.split(',').join(' ') };
    }

    // Full object format
    if (typeof config === 'object' && config !== null) {
      const opts = config as Record<string, unknown>;
      const option: PopulateOption = { path };

      // Parse select (comma-separated → space-separated)
      if (opts.select && typeof opts.select === 'string') {
        option.select = opts.select
          .split(',')
          .map((s) => s.trim())
          .join(' ');
      }

      // Parse match (filter conditions)
      if (opts.match && typeof opts.match === 'object') {
        option.match = this._convertPopulateMatch(opts.match as Record<string, unknown>);
      }

      // Parse limit
      if (opts.limit !== undefined) {
        const limit = parseInt(String(opts.limit), 10);
        if (!Number.isNaN(limit) && limit > 0) {
          option.options = option.options || {};
          option.options.limit = limit;
        }
      }

      // Parse sort
      if (opts.sort && typeof opts.sort === 'string') {
        const sortSpec = this._parseSort(opts.sort);
        if (sortSpec) {
          option.options = option.options || {};
          option.options.sort = sortSpec;
        }
      }

      // Parse skip
      if (opts.skip !== undefined) {
        const skip = parseInt(String(opts.skip), 10);
        if (!Number.isNaN(skip) && skip >= 0) {
          option.options = option.options || {};
          option.options.skip = skip;
        }
      }

      // Parse nested populate
      if (opts.populate && typeof opts.populate === 'object') {
        const nestedPopulate = opts.populate as Record<string, unknown>;
        // Get the first (and typically only) nested path
        const nestedEntries = Object.entries(nestedPopulate);
        if (nestedEntries.length > 0) {
          const [nestedPath, nestedConfig] = nestedEntries[0];
          const nestedOption = this._parseSinglePopulate(nestedPath, nestedConfig, depth + 1);
          if (nestedOption) {
            option.populate = nestedOption;
          }
        }
      }

      // Only return if we have more than just the path (or path is all we need)
      return option;
    }

    return null;
  }

  /**
   * Convert populate match values (handles boolean strings, etc.)
   */
  private _convertPopulateMatch(match: Record<string, unknown>): Record<string, unknown> {
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(match)) {
      converted[key] = coerceHeuristic(value);
    }
    return converted;
  }

  // ============================================================
  // FILTER PARSING (Enhanced from original)
  // ============================================================

  /**
   * Parse filter parameters
   */
  private _parseFilters(filters: Record<string, FilterValue>, depth: number = 0): FilterQuery {
    // Enforce max filter depth to prevent deeply nested filter bombs
    if (depth > this.options.maxFilterDepth) {
      warn(
        `[mongokit] Filter depth ${depth} exceeds maximum ${this.options.maxFilterDepth}, truncating`,
      );
      return {};
    }

    const parsedFilters: Record<string, unknown> = {};
    const regexFields: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(filters)) {
      // Security: Block dangerous operators
      if (
        this.dangerousOperators.includes(key) ||
        (key.startsWith('$') && !['$or', '$and'].includes(key))
      ) {
        warn(`[mongokit] Blocked dangerous operator: ${key}`);
        continue;
      }

      // Skip reserved parameters (or, OR, $or are handled by _parseOr)
      if (
        [
          'page',
          'limit',
          'sort',
          'populate',
          'search',
          'select',
          'lean',
          'includeDeleted',
          'lookup',
          'aggregate',
          'or',
          'OR',
          '$or',
        ].includes(key)
      ) {
        continue;
      }

      // Handle operator syntax: field[operator]=value
      const operatorMatch = key.match(/^(.+)\[(.+)\]$/);
      const baseField = operatorMatch ? operatorMatch[1] : key;

      if (
        this.options.allowedFilterFields &&
        !this.options.allowedFilterFields.includes(baseField)
      ) {
        warn(`[mongokit] Blocked filter field not in allowlist: ${baseField}`);
        continue;
      }

      if (operatorMatch) {
        const [, , operator] = operatorMatch;
        if (this.dangerousOperators.includes(`$${operator}`)) {
          warn(`[mongokit] Blocked dangerous operator: ${operator}`);
          continue;
        }
        this._handleOperatorSyntax(parsedFilters, regexFields, operatorMatch, value);
        continue;
      }

      // Handle object value (parsed by qs or similar)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this._handleBracketSyntax(key, value as Record<string, unknown>, parsedFilters, depth + 1);
      } else {
        // Direct field assignment — schema-aware when a type is configured,
        // falls back to the legacy heuristic in _convertValue when not.
        parsedFilters[key] = coerceFieldValue(key, value, this._fieldTypes);
      }
    }

    return parsedFilters;
  }

  /**
   * Handle operator syntax: field[operator]=value
   */
  private _handleOperatorSyntax(
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
      this.options.allowedOperators &&
      !this.options.allowedOperators.includes(operator.toLowerCase())
    ) {
      warn(`[mongokit] Operator not in allowlist: ${operator}`);
      return;
    }

    // Handle regex options — only allow safe MongoDB regex flags (i, m, s, x)
    if (operator.toLowerCase() === 'options' && regexFields[field]) {
      const fieldValue = filters[field];
      if (typeof fieldValue === 'object' && fieldValue !== null && '$regex' in fieldValue) {
        if (typeof value === 'string' && /^[imsx]+$/.test(value)) {
          (fieldValue as Record<string, unknown>).$options = value;
        } else {
          warn(
            `[mongokit] Blocked invalid regex $options value: ${String(value)}. Allowed flags: i, m, s, x`,
          );
        }
      }
      return;
    }

    // Handle like/contains
    if (operator.toLowerCase() === 'contains' || operator.toLowerCase() === 'like') {
      const safeRegex = this._createSafeRegex(value);
      if (safeRegex) {
        filters[field] = { $regex: safeRegex };
        regexFields[field] = true;
      }
      return;
    }

    // Handle geo operators (near / nearSphere / geoWithin) before falling
    // through to numeric/eq handling. Delegated entirely to the geo primitive
    // module — this branch is just routing. parseGeoFilter returns null when
    // the operator isn't a geo operator (fall through) or the input is invalid
    // (drop the filter rather than emit a malformed query).
    if (isGeoOperator(operator)) {
      const geoFilter = parseGeoFilter(operator, value);
      if (geoFilter) {
        filters[field] = geoFilter;
      } else {
        warn(`[mongokit] Invalid geo operator value for ${field}[${operator}]; dropping filter`);
      }
      return;
    }

    const mongoOperator = this._toMongoOperator(operator);

    if (this.dangerousOperators.includes(mongoOperator)) {
      warn(`[mongokit] Blocked dangerous operator: ${mongoOperator}`);
      return;
    }

    if (mongoOperator === '$eq') {
      // Coerce equality value through the schema-aware path so direct equality
      // and bracketed [eq] behave identically: `?stock=50` and `?stock[eq]=50`
      // both produce the number 50 against a Number field, and both preserve
      // "12345" as a string against a String field.
      filters[field] = coerceFieldValue(field, value, this._fieldTypes);
    } else if (mongoOperator === '$regex') {
      // Apply safe regex handling to prevent ReDoS attacks
      const safeRegex = this._createSafeRegex(value);
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
        if (Number.isNaN(processedValue as number)) return;
      } else if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
        // Range operators: use schema-aware coercion when a type is declared
        // (so Date / ObjectId / Number fields all work correctly), and fall
        // back to numeric parseFloat when no schema entry exists (preserves
        // pre-3.5.5 behavior for ad-hoc filters and rejects garbage values
        // like `?score[gte]=foo`).
        if (this._fieldTypes.has(field)) {
          processedValue = coerceFieldValue(field, value, this._fieldTypes);
          if (typeof processedValue === 'number' && Number.isNaN(processedValue)) return;
        } else {
          processedValue = parseFloat(String(value));
          if (Number.isNaN(processedValue as number)) return;
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
        processedValue = rawList.map((elem) => coerceFieldValue(field, elem, this._fieldTypes));
      } else {
        processedValue = coerceFieldValue(field, value, this._fieldTypes);
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

  /**
   * Handle bracket syntax with object value
   */
  private _handleBracketSyntax(
    field: string,
    operators: Record<string, unknown>,
    parsedFilters: Record<string, unknown>,
    depth: number = 0,
  ): void {
    // Depth check for nested objects
    if (depth > this.options.maxFilterDepth) {
      warn(`[mongokit] Nested filter depth exceeds maximum, skipping field: ${field}`);
      return;
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
      // Same contract as _handleOperatorSyntax — see comments there.
      if (isGeoOperator(operator)) {
        const geoFilter = parseGeoFilter(operator, value);
        if (geoFilter) {
          parsedFilters[field] = geoFilter;
        } else {
          warn(`[mongokit] Invalid geo operator value for ${field}[${operator}]; dropping filter`);
          delete parsedFilters[field];
        }
        continue;
      }

      // Check operator allowlist
      if (this.options.allowedOperators && !this.options.allowedOperators.includes(operator)) {
        warn(`[mongokit] Operator not in allowlist: ${operator}`);
        continue;
      }

      if (this.operators[operator]) {
        const mongoOperator = this.operators[operator];
        let processedValue: unknown;

        if (operator === 'size') {
          // $size always takes a non-negative integer
          processedValue = parseFloat(String(value));
          if (Number.isNaN(processedValue as number)) continue;
        } else if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
          // Schema-aware coercion when a type is declared, parseFloat fallback
          // otherwise. Mirrors _handleOperatorSyntax — see comments there.
          if (this._fieldTypes.has(field)) {
            processedValue = coerceFieldValue(field, value, this._fieldTypes);
            if (typeof processedValue === 'number' && Number.isNaN(processedValue)) continue;
          } else {
            processedValue = parseFloat(String(value));
            if (Number.isNaN(processedValue as number)) continue;
          }
        } else if (operator === 'in' || operator === 'nin') {
          const rawList = Array.isArray(value)
            ? value
            : String(value)
                .split(',')
                .map((v) => v.trim());
          // Per-element coercion via the schema-aware path
          processedValue = rawList.map((elem) => coerceFieldValue(field, elem, this._fieldTypes));
        } else if (operator === 'like' || operator === 'contains' || operator === 'regex') {
          // Apply safe regex handling to prevent ReDoS attacks
          const safeRegex = this._createSafeRegex(value);
          if (!safeRegex) continue;
          processedValue = safeRegex;
        } else {
          processedValue = coerceFieldValue(field, value, this._fieldTypes);
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

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  private _parseSort(sort: string | SortSpec | undefined): SortSpec | undefined {
    if (!sort) return undefined;
    if (typeof sort === 'object') {
      const sortObj: SortSpec = {};
      for (const [key, value] of Object.entries(sort)) {
        if (this.options.allowedSortFields && !this.options.allowedSortFields.includes(key)) {
          warn(`[mongokit] Blocked sort field not in allowlist: ${key}`);
          continue;
        }

        // Normalize "asc", "desc", "1", "-1" to 1 or -1
        const strVal = String(value).toLowerCase();
        sortObj[key] = strVal === 'desc' || strVal === '-1' || value === -1 ? -1 : 1;
      }
      return Object.keys(sortObj).length > 0 ? sortObj : undefined;
    }

    const sortObj: SortSpec = {};
    const fields = sort.split(',').map((s) => s.trim());

    for (const field of fields) {
      if (!field) continue;
      const cleanField = field.startsWith('-') ? field.substring(1) : field;

      if (this.options.allowedSortFields && !this.options.allowedSortFields.includes(cleanField)) {
        warn(`[mongokit] Blocked sort field not in allowlist: ${cleanField}`);
        continue;
      }

      if (field.startsWith('-')) {
        sortObj[field.substring(1)] = -1;
      } else {
        sortObj[field] = 1;
      }
    }

    return Object.keys(sortObj).length > 0 ? sortObj : undefined;
  }

  private _toMongoOperator(operator: string): string {
    const op = operator.toLowerCase();
    return op.startsWith('$') ? op : `$${op}`;
  }

  private _createSafeRegex(pattern: unknown, flags: string = 'i'): RegExp | null {
    if (pattern === null || pattern === undefined) return null;

    const patternStr = String(pattern);

    if (patternStr.length > this.options.maxRegexLength) {
      warn(`[mongokit] Regex pattern too long, truncating`);
      return new RegExp(
        this._escapeRegex(patternStr.substring(0, this.options.maxRegexLength)),
        flags,
      );
    }

    if (this.dangerousRegexPatterns.test(patternStr)) {
      warn('[mongokit] Potentially dangerous regex pattern, escaping');
      return new RegExp(this._escapeRegex(patternStr), flags);
    }

    try {
      return new RegExp(patternStr, flags);
    } catch {
      return new RegExp(this._escapeRegex(patternStr), flags);
    }
  }

  private _escapeRegex(str: string): string {
    // Escape special regex characters
    // Note: backslash must be escaped first, then other special chars
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Sanitize $match configuration to prevent dangerous operators
   * Recursively filters out operators like $where, $function, $accumulator
   */
  private _sanitizeMatchConfig(config: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    // Logical array operators whose branches must be filtered for empty `{}`
    // results — an empty branch matches every document and silently widens the
    // surrounding query. See _parseOr for the URL-side analogue.
    const logicalArrayOps = new Set(['$or', '$and', '$nor']);

    for (const [key, value] of Object.entries(config)) {
      // Block dangerous operators
      if (this.dangerousOperators.includes(key)) {
        warn(`[mongokit] Blocked dangerous operator in aggregation: ${key}`);
        continue;
      }

      // Recursively sanitize nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this._sanitizeMatchConfig(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        // Sanitize array elements
        const sanitizedArray = value.map((item) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return this._sanitizeMatchConfig(item as Record<string, unknown>);
          }
          return item;
        });

        if (logicalArrayOps.has(key)) {
          // Drop branches that became empty `{}` after sanitization. Critical:
          // `$or: [{ $where: '...' }, { status: 'active' }]` would otherwise
          // degrade to `$or: [{}, { status: 'active' }]` ≡ match-all. We keep
          // primitive items (not objects) untouched — those are not branches.
          const filtered = sanitizedArray.filter(
            (item) =>
              !(
                item &&
                typeof item === 'object' &&
                !Array.isArray(item) &&
                Object.keys(item as Record<string, unknown>).length === 0
              ),
          );
          // If every branch was dropped, omit the operator entirely — emitting
          // an empty `$or: []` is invalid MongoDB and silently degrading to
          // match-all is exactly the bug we're closing.
          if (filtered.length === 0) {
            warn(
              `[mongokit] All branches of ${key} were blocked by sanitization; dropping the operator`,
            );
            continue;
          }
          sanitized[key] = filtered;
        } else {
          sanitized[key] = sanitizedArray;
        }
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Sanitize pipeline stages for use in $lookup.
   * Blocks dangerous stages ($out, $merge, etc.) and recursively sanitizes
   * operator expressions within $match, $addFields, and $set stages.
   */
  private _sanitizePipeline(stages: unknown[]): PipelineStage[] {
    const blockedStages = [
      '$out',
      '$merge',
      '$unionWith',
      '$collStats',
      '$currentOp',
      '$listSessions',
    ];
    const sanitized: PipelineStage[] = [];

    for (const stage of stages) {
      if (!stage || typeof stage !== 'object') continue;

      const entries = Object.entries(stage as Record<string, unknown>);
      if (entries.length !== 1) continue;

      const [op, config] = entries[0];

      if (blockedStages.includes(op)) {
        warn(`[mongokit] Blocked dangerous pipeline stage in lookup: ${op}`);
        continue;
      }

      if (op === '$match' && typeof config === 'object' && config !== null) {
        sanitized.push({
          $match: this._sanitizeMatchConfig(config as Record<string, unknown>),
        } as unknown as PipelineStage);
      } else if (
        (op === '$addFields' || op === '$set') &&
        typeof config === 'object' &&
        config !== null
      ) {
        sanitized.push({
          [op]: this._sanitizeExpressions(config as Record<string, unknown>),
        } as unknown as PipelineStage);
      } else {
        sanitized.push(stage as PipelineStage);
      }
    }

    return sanitized;
  }

  /**
   * Recursively sanitize expression objects, blocking dangerous operators
   * like $where, $function, $accumulator inside $addFields/$set stages.
   */
  private _sanitizeExpressions(config: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(config)) {
      if (this.dangerousOperators.includes(key)) {
        warn(`[mongokit] Blocked dangerous operator in pipeline expression: ${key}`);
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this._sanitizeExpressions(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((item) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return this._sanitizeExpressions(item as Record<string, unknown>);
          }
          return item;
        });
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private _sanitizeSearch(search: unknown): string | undefined {
    if (search === null || search === undefined || search === '') return undefined;

    let searchStr = String(search).trim();
    if (!searchStr) return undefined;

    if (searchStr.length > this.options.maxSearchLength) {
      warn(`[mongokit] Search query too long, truncating`);
      searchStr = searchStr.substring(0, this.options.maxSearchLength);
    }

    return searchStr;
  }

  /**
   * Build regex-based multi-field search filters
   * Creates an $or query with case-insensitive regex across all searchFields
   *
   * @example
   * // searchFields: ['name', 'description', 'sku']
   * // search: 'azure'
   * // Returns: [
   * //   { name: { $regex: /azure/i } },
   * //   { description: { $regex: /azure/i } },
   * //   { sku: { $regex: /azure/i } }
   * // ]
   */
  private _buildRegexSearch(searchTerm: string): Record<string, unknown>[] | null {
    if (!this.options.searchFields || this.options.searchFields.length === 0) {
      return null;
    }

    // Create safe regex from search term (escapes special chars for literal search)
    const safeRegex = this._createSafeRegex(searchTerm, 'i');
    if (!safeRegex) {
      return null;
    }

    // Build $or array with regex for each searchable field
    const orConditions: Record<string, unknown>[] = [];
    for (const field of this.options.searchFields) {
      orConditions.push({
        [field]: { $regex: safeRegex },
      });
    }

    return orConditions.length > 0 ? orConditions : null;
  }

  private _parseOr(
    query: Record<string, unknown> | null | undefined,
  ): Record<string, unknown>[] | undefined {
    const orArray: Record<string, unknown>[] = [];
    const raw = query?.or || query?.OR || query?.$or;
    if (!raw) return undefined;

    const items = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.values(raw) : [];
    for (const item of items) {
      if (typeof item === 'object' && item) {
        // Increment depth for $or branches
        const parsedBranch = this._parseFilters(item as Record<string, FilterValue>, 1);
        // Drop empty branches: a `{}` inside $or matches every document and would
        // silently widen the query. This is critical when a branch contained ONLY
        // dangerous operators (e.g. `{ $where: '...' }`) — _parseFilters strips them
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

  private _enhanceWithBetween(filters: FilterQuery): FilterQuery {
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
        output[key] = range;
      }
    }
    return output;
  }

  // String helpers
  private _pluralize(str: string): string {
    // Simple pluralization - can be enhanced with a library like 'pluralize'
    if (str.endsWith('y')) return `${str.slice(0, -1)}ies`;
    if (str.endsWith('s')) return str;
    return `${str}s`;
  }

  private _capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
