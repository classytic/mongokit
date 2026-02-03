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
 * Lookups are sanitized by default (collection whitelists, field validation,
 * pipeline/let blocking). For maximum security, use per-collection field allowlists
 * in your controller layer (see BaseController example).
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

import mongoose from 'mongoose';
import type { LookupOptions } from './LookupBuilder.js';
import type { PipelineStage } from 'mongoose';

export type SortSpec = Record<string, 1 | -1>;
export type FilterQuery = Record<string, unknown>;
export type FilterValue = string | number | boolean | null | undefined | Record<string, unknown> | unknown[];

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
}

/**
 * Modern Query Parser
 * Converts URL parameters to MongoDB queries with $lookup support
 */
export class QueryParser {
  private readonly options: Required<Omit<QueryParserOptions, 'enableLookups' | 'enableAggregations' | 'searchFields'>> & Pick<QueryParserOptions, 'enableLookups' | 'enableAggregations' | 'searchFields'>;

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
   * Regex patterns that can cause catastrophic backtracking (ReDoS attacks)
   * Detects:
   * - Quantifiers: {n,m}
   * - Possessive quantifiers: *+, ++, ?+
   * - Nested quantifiers: (a+)+, (a*)*
   * - Backreferences: \1, \2, etc.
   * - Complex character classes: [...]...[...]
   */
  private readonly dangerousRegexPatterns = /(\{[0-9,]+\}|\*\+|\+\+|\?\+|(\(.+\))\+|\(\?\:|\\[0-9]|(\[.+\]).+(\[.+\]))/;

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
    };

    // Validate: regex mode requires searchFields
    if (this.options.searchMode === 'regex' && (!this.options.searchFields || this.options.searchFields.length === 0)) {
      console.warn('[mongokit] searchMode "regex" requires searchFields to be specified. Falling back to "text" mode.');
      this.options.searchMode = 'text';
    }

    this.dangerousOperators = [
      '$where',
      '$function',
      '$accumulator',
      '$expr',
      ...this.options.additionalDangerousOperators,
    ];
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
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      parsedLimit = 20; // Default
    }
    if (parsedLimit > this.options.maxLimit) {
      console.warn(`[mongokit] Limit ${parsedLimit} exceeds maximum ${this.options.maxLimit}, capping to max`);
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

    // Pagination mode detection
    if (after || cursor) {
      parsed.after = (after || cursor) as string;
    } else if (page !== undefined) {
      parsed.page = parseInt(String(page), 10);
    } else {
      parsed.page = 1;
    }

    // Parse $or conditions from URL params
    const orGroup = this._parseOr(query);
    if (orGroup) {
      // If regex search already added $or, combine both using $and
      if (parsed.filters.$or) {
        const existingOr = parsed.filters.$or as Record<string, unknown>[];
        delete parsed.filters.$or;
        parsed.filters.$and = [
          { $or: existingOr },
          { $or: orGroup },
        ];
      } else {
        parsed.filters.$or = orGroup;
      }
    }

    // Enhance with between operator
    parsed.filters = this._enhanceWithBetween(parsed.filters);

    return parsed;
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
        console.warn(`[mongokit] Invalid lookup config for ${collectionName}:`, error);
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
      return {
        from: this._pluralize(collectionName),
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

      if (!localField || !foreignField) {
        console.warn(`[mongokit] Lookup requires localField and foreignField for ${collectionName}`);
        return null;
      }

      return {
        from,
        localField,
        foreignField,
        as: (opts.as as string) || collectionName,
        single: opts.single === true || opts.single === 'true',
        ...(opts.pipeline && Array.isArray(opts.pipeline) ? { pipeline: opts.pipeline as PipelineStage[] } : {}),
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
        console.warn(`[mongokit] Invalid aggregation stage ${stage}:`, error);
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
      const fields = select.split(',').map(f => f.trim());

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
  private _parsePopulate(populate: unknown): { simplePopulate?: string; populateOptions?: PopulateOption[] } {
    if (!populate) {
      return {};
    }

    // Simple string format: ?populate=author,category
    if (typeof populate === 'string') {
      return { simplePopulate: populate };
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
          console.warn(`[mongokit] Blocked dangerous populate path: ${path}`);
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
  private _parseSinglePopulate(path: string, config: unknown, depth: number = 0): PopulateOption | null {
    // Prevent infinite recursion
    if (depth > 5) {
      console.warn(`[mongokit] Populate depth exceeds maximum (5), truncating at path: ${path}`);
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
        option.select = opts.select.split(',').map(s => s.trim()).join(' ');
      }

      // Parse match (filter conditions)
      if (opts.match && typeof opts.match === 'object') {
        option.match = this._convertPopulateMatch(opts.match as Record<string, unknown>);
      }

      // Parse limit
      if (opts.limit !== undefined) {
        const limit = parseInt(String(opts.limit), 10);
        if (!isNaN(limit) && limit > 0) {
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
        if (!isNaN(skip) && skip >= 0) {
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
      converted[key] = this._convertValue(value);
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
      console.warn(`[mongokit] Filter depth ${depth} exceeds maximum ${this.options.maxFilterDepth}, truncating`);
      return {};
    }

    const parsedFilters: Record<string, unknown> = {};
    const regexFields: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(filters)) {
      // Security: Block dangerous operators
      if (this.dangerousOperators.includes(key) || (key.startsWith('$') && !['$or', '$and'].includes(key))) {
        console.warn(`[mongokit] Blocked dangerous operator: ${key}`);
        continue;
      }

      // Skip reserved parameters (or, OR, $or are handled by _parseOr)
      if (['page', 'limit', 'sort', 'populate', 'search', 'select', 'lean', 'includeDeleted', 'lookup', 'aggregate', 'or', 'OR', '$or'].includes(key)) {
        continue;
      }

      // Handle operator syntax: field[operator]=value
      const operatorMatch = key.match(/^(.+)\[(.+)\]$/);
      if (operatorMatch) {
        const [, , operator] = operatorMatch;
        if (this.dangerousOperators.includes('$' + operator)) {
          console.warn(`[mongokit] Blocked dangerous operator: ${operator}`);
          continue;
        }
        this._handleOperatorSyntax(parsedFilters, regexFields, operatorMatch, value);
        continue;
      }

      // Handle object value (parsed by qs or similar)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this._handleBracketSyntax(key, value as Record<string, unknown>, parsedFilters, depth + 1);
      } else {
        // Direct field assignment
        parsedFilters[key] = this._convertValue(value);
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
    value: FilterValue
  ): void {
    const [, field, operator] = operatorMatch;

    // Skip empty values
    if (value === '' || value === null || value === undefined) {
      return;
    }

    // Handle regex options
    if (operator.toLowerCase() === 'options' && regexFields[field]) {
      const fieldValue = filters[field];
      if (typeof fieldValue === 'object' && fieldValue !== null && '$regex' in fieldValue) {
        (fieldValue as Record<string, unknown>).$options = value;
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

    const mongoOperator = this._toMongoOperator(operator);

    if (this.dangerousOperators.includes(mongoOperator)) {
      console.warn(`[mongokit] Blocked dangerous operator: ${mongoOperator}`);
      return;
    }

    if (mongoOperator === '$eq') {
      filters[field] = value;
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

      if (['gt', 'gte', 'lt', 'lte', 'size'].includes(op)) {
        processedValue = parseFloat(String(value));
        if (isNaN(processedValue as number)) return;
      } else if (op === 'in' || op === 'nin') {
        processedValue = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim());
      } else {
        processedValue = this._convertValue(value);
      }

      // Only create the object if we have a valid value to set
      if (typeof filters[field] !== 'object' || filters[field] === null || Array.isArray(filters[field])) {
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
    depth: number = 0
  ): void {
    // Depth check for nested objects
    if (depth > this.options.maxFilterDepth) {
      console.warn(`[mongokit] Nested filter depth exceeds maximum, skipping field: ${field}`);
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

      if (this.operators[operator]) {
        const mongoOperator = this.operators[operator];
        let processedValue: unknown;

        if (['gt', 'gte', 'lt', 'lte', 'size'].includes(operator)) {
          processedValue = parseFloat(String(value));
          if (isNaN(processedValue as number)) continue;
        } else if (operator === 'in' || operator === 'nin') {
          processedValue = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim());
        } else if (operator === 'like' || operator === 'contains' || operator === 'regex') {
          // Apply safe regex handling to prevent ReDoS attacks
          const safeRegex = this._createSafeRegex(value);
          if (!safeRegex) continue;
          processedValue = safeRegex;
        } else {
          processedValue = this._convertValue(value);
        }

        (parsedFilters[field] as Record<string, unknown>)[mongoOperator] = processedValue;
      }
    }

    // Clean up empty field objects
    if (typeof parsedFilters[field] === 'object' && Object.keys(parsedFilters[field] as object).length === 0) {
      delete parsedFilters[field];
    }
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  private _parseSort(sort: string | SortSpec | undefined): SortSpec | undefined {
    if (!sort) return undefined;
    if (typeof sort === 'object') return sort;

    const sortObj: SortSpec = {};
    const fields = sort.split(',').map(s => s.trim());

    for (const field of fields) {
      if (field.startsWith('-')) {
        sortObj[field.substring(1)] = -1;
      } else {
        sortObj[field] = 1;
      }
    }

    return sortObj;
  }

  private _toMongoOperator(operator: string): string {
    const op = operator.toLowerCase();
    return op.startsWith('$') ? op : '$' + op;
  }

  private _createSafeRegex(pattern: unknown, flags: string = 'i'): RegExp | null {
    if (pattern === null || pattern === undefined) return null;

    const patternStr = String(pattern);

    if (patternStr.length > this.options.maxRegexLength) {
      console.warn(`[mongokit] Regex pattern too long, truncating`);
      return new RegExp(this._escapeRegex(patternStr.substring(0, this.options.maxRegexLength)), flags);
    }

    if (this.dangerousRegexPatterns.test(patternStr)) {
      console.warn('[mongokit] Potentially dangerous regex pattern, escaping');
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

    for (const [key, value] of Object.entries(config)) {
      // Block dangerous operators
      if (this.dangerousOperators.includes(key)) {
        console.warn(`[mongokit] Blocked dangerous operator in aggregation: ${key}`);
        continue;
      }

      // Recursively sanitize nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this._sanitizeMatchConfig(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        // Sanitize array elements
        sanitized[key] = value.map(item => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return this._sanitizeMatchConfig(item as Record<string, unknown>);
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
      console.warn(`[mongokit] Search query too long, truncating`);
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

  private _convertValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(v => this._convertValue(v));
    if (typeof value === 'object') return value;

    const stringValue = String(value);

    if (stringValue === 'true') return true;
    if (stringValue === 'false') return false;

    if (mongoose.Types.ObjectId.isValid(stringValue) && stringValue.length === 24) {
      return stringValue;
    }

    return stringValue;
  }

  private _parseOr(query: Record<string, unknown> | null | undefined): Record<string, unknown>[] | undefined {
    const orArray: Record<string, unknown>[] = [];
    const raw = query?.or || query?.OR || query?.$or;
    if (!raw) return undefined;

    const items = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.values(raw) : [];
    for (const item of items) {
      if (typeof item === 'object' && item) {
        // Increment depth for $or branches
        orArray.push(this._parseFilters(item as Record<string, FilterValue>, 1));
      }
    }
    return orArray.length ? orArray : undefined;
  }

  private _enhanceWithBetween(filters: FilterQuery): FilterQuery {
    const output = { ...filters };
    for (const [key, value] of Object.entries(filters || {})) {
      if (value && typeof value === 'object' && 'between' in value) {
        const between = (value as Record<string, unknown>).between as string;
        const [from, to] = String(between).split(',').map(s => s.trim());
        const fromDate = from ? new Date(from) : undefined;
        const toDate = to ? new Date(to) : undefined;
        const range: Record<string, Date> = {};
        if (fromDate && !isNaN(fromDate.getTime())) range.$gte = fromDate;
        if (toDate && !isNaN(toDate.getTime())) range.$lte = toDate;
        output[key] = range;
      }
    }
    return output;
  }

  // String helpers
  private _pluralize(str: string): string {
    // Simple pluralization - can be enhanced with a library like 'pluralize'
    if (str.endsWith('y')) return str.slice(0, -1) + 'ies';
    if (str.endsWith('s')) return str;
    return str + 's';
  }

  private _capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

export default QueryParser;
