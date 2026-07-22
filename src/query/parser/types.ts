/**
 * Public types for the QueryParser facade.
 *
 * Canonical home for every type the parser exposes. `QueryParser.ts`
 * re-exports these so the package surface (`@classytic/mongokit`) is
 * unchanged; internal parser modules import them from here directly.
 */

import type { PipelineStage } from 'mongoose';
import type { LookupOptions } from '../LookupBuilder.js';
import type { FieldType as PrimitiveFieldType, SchemaPathsLike } from '../primitives/coercion.js';

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
 * from `primitives/coercion` — the canonical definition lives there.
 */
export type FieldType = PrimitiveFieldType;

/**
 * Minimal structural type for a Mongoose schema. We only read `.paths` and
 * (optionally) `.indexes()`, so the parser stays decoupled from a specific
 * Mongoose major version and is easy to mock in tests.
 */
export interface SchemaLike extends SchemaPathsLike {
  /** Optional — when present, schema indexes are introspected for geo/text fields */
  indexes?: () => Array<[Record<string, unknown>, Record<string, unknown>?]>;
}

export interface QueryParserOptions {
  /**
   * How the parser treats invalid or disallowed query input (default: 'throw').
   *
   * - `'throw'` (default — fail-closed): raise an HTTP 400 error
   *   (`createError(400, …, { code: 'INVALID_QUERY_INPUT' })`) at the first
   *   invalid fragment — blocked operators, disallowed filter/sort fields,
   *   over-deep filters, malformed operator values, blocked lookup
   *   collections/stages, dangerous populate paths, over-long or
   *   pathological regex/search input.
   * - `'drop'`: warn and remove the offending fragment, then keep parsing.
   *   Still safe against dangerous Mongo operators, but NOT fail-closed:
   *   when the only supplied filter is dropped, the resulting query matches
   *   every record in scope — a malformed filter silently *broadens* the
   *   result set instead of failing the request. Opt in only for trusted
   *   migration/compatibility tooling that must accept sloppy input.
   */
  invalidInput?: 'throw' | 'drop';
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
  /** Allowed fields for filtering. If set, unknown fields are rejected per `invalidInput`. */
  allowedFilterFields?: string[];
  /** Allowed fields for sorting. If set, unknown fields are rejected per `invalidInput`. */
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
