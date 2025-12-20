/**
 * Query Parser
 *
 * Parses HTTP query parameters into MongoDB-compatible query objects.
 * Supports operators, pagination, sorting, and filtering.
 */

import mongoose from 'mongoose';
import type { ParsedQuery, SortSpec, FilterQuery, AnyDocument } from '../types.js';

/** Operator mapping from query syntax to MongoDB operators */
export type OperatorMap = Record<string, string>;

/** Possible values in filter parameters */
export type FilterValue = string | number | boolean | null | undefined | Record<string, unknown> | unknown[];

/** Configuration options for QueryParser */
export interface QueryParserOptions {
  /** Maximum allowed regex pattern length (default: 500) */
  maxRegexLength?: number;
  /** Maximum allowed text search query length (default: 200) */
  maxSearchLength?: number;
  /** Maximum allowed filter depth (default: 10) */
  maxFilterDepth?: number;
  /** Additional operators to block */
  additionalDangerousOperators?: string[];
}

/**
 * Query Parser Class
 *
 * Parses HTTP query parameters into MongoDB-compatible query objects.
 * Includes security measures against NoSQL injection and ReDoS attacks.
 *
 * @example
 * ```typescript
 * import { QueryParser } from '@classytic/mongokit';
 *
 * const parser = new QueryParser({ maxRegexLength: 100 });
 * const query = parser.parseQuery(req.query);
 * ```
 */
export class QueryParser {
  private readonly options: Required<QueryParserOptions>;

  private readonly operators: OperatorMap = {
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

  /**
   * Dangerous MongoDB operators that should never be accepted from user input
   * Security: Prevent NoSQL injection attacks
   */
  private readonly dangerousOperators: string[];

  /**
   * Regex pattern characters that can cause catastrophic backtracking (ReDoS)
   */
  private readonly dangerousRegexPatterns = /(\{[0-9,]+\}|\*\+|\+\+|\?\+|(\([^)]*\))\1|\(\?[^)]*\)|[\[\]].*[\[\]])/;

  constructor(options: QueryParserOptions = {}) {
    this.options = {
      maxRegexLength: options.maxRegexLength ?? 500,
      maxSearchLength: options.maxSearchLength ?? 200,
      maxFilterDepth: options.maxFilterDepth ?? 10,
      additionalDangerousOperators: options.additionalDangerousOperators ?? [],
    };

    this.dangerousOperators = [
      '$where',
      '$function',
      '$accumulator',
      '$expr',
      ...this.options.additionalDangerousOperators,
    ];
  }

  /**
   * Parse query parameters into MongoDB query format
   */
  parseQuery(query: Record<string, unknown> | null | undefined): ParsedQuery {
    const {
      page,
      limit = 20,
      sort = '-createdAt',
      populate,
      search,
      after,
      cursor,
      ...filters
    } = query || {};

    // Build base parsed object
    const parsed: ParsedQuery = {
      filters: this._parseFilters(filters as Record<string, FilterValue>),
      limit: parseInt(String(limit), 10),
      sort: this._parseSort(sort as string | SortSpec | undefined),
      populate: populate as string | undefined,
      search: this._sanitizeSearch(search),
    };

    // MongoKit pagination mode detection:
    // 1. If 'page' is provided → offset mode
    // 2. If 'after' or 'cursor' is provided → keyset mode
    // 3. If neither, default to offset mode (page 1)

    if (after || cursor) {
      // Keyset (cursor-based) pagination
      parsed.after = (after || cursor) as string;
    } else if (page !== undefined) {
      // Offset (page-based) pagination
      parsed.page = parseInt(String(page), 10);
    } else {
      // Default to offset mode, page 1
      parsed.page = 1;
    }

    const orGroup = this._parseOr(query);
    if (orGroup) {
      parsed.filters = { ...parsed.filters, $or: orGroup } as FilterQuery<AnyDocument>;
    }

    parsed.filters = this._enhanceWithBetween(parsed.filters);

    return parsed;
  }

  /**
   * Parse sort parameter
   * Converts string like '-createdAt' to { createdAt: -1 }
   * Handles multiple sorts: '-createdAt,name' → { createdAt: -1, name: 1 }
   */
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

  /**
   * Parse standard filter parameter (filter[field]=value)
   */
  private _parseFilters(filters: Record<string, FilterValue>): FilterQuery<AnyDocument> {
    const parsedFilters: Record<string, unknown> = {};
    // Track which fields have regex values for proper options handling
    const regexFields: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(filters)) {
      // SECURITY: Block dangerous MongoDB operators
      if (this.dangerousOperators.includes(key) || (key.startsWith('$') && !['$or', '$and'].includes(key))) {
        console.warn(`[mongokit] Blocked dangerous operator: ${key}`);
        continue;
      }

      // Skip non-filter parameters that are handled separately
      if (['page', 'limit', 'sort', 'populate', 'search', 'select', 'lean', 'includeDeleted'].includes(key)) {
        continue;
      }

      // Handle bracket syntax both shapes:
      // 1) field[operator]=value (Express default keeps key as string)
      const operatorMatch = key.match(/^(.+)\[(.+)\]$/);
      if (operatorMatch) {
        const [, , operator] = operatorMatch;
        // Block dangerous operators in bracket syntax
        if (this.dangerousOperators.includes('$' + operator)) {
          console.warn(`[mongokit] Blocked dangerous operator: ${operator}`);
          continue;
        }
        this._handleOperatorSyntax(parsedFilters, regexFields, operatorMatch, value);
        continue;
      }

      // 2) field[operator]=value parsed as object (qs or similar)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this._handleBracketSyntax(key, value as Record<string, unknown>, parsedFilters);
      } else {
        // Handle direct field assignment (e.g., upc=123)
        parsedFilters[key] = this._convertValue(value);
      }
    }

    return parsedFilters as FilterQuery<AnyDocument>;
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

    // Handle regex options separately
    if (operator.toLowerCase() === 'options' && regexFields[field]) {
      const fieldValue = filters[field];
      if (typeof fieldValue === 'object' && fieldValue !== null && '$regex' in (fieldValue as Record<string, unknown>)) {
        (fieldValue as Record<string, unknown>).$options = value;
      }
      return;
    }

    // Handle like/contains - convert to $regex for MongoDB
    if (operator.toLowerCase() === 'contains' || operator.toLowerCase() === 'like') {
      const safeRegex = this._createSafeRegex(value);
      if (safeRegex) {
        filters[field] = { $regex: safeRegex };
        regexFields[field] = true;
      }
      return;
    }

    // Convert to MongoDB operator for standard operators
    const mongoOperator = this._toMongoOperator(operator);

    // SECURITY: Block dangerous MongoDB operators
    if (this.dangerousOperators.includes(mongoOperator)) {
      console.warn(`[mongokit] Blocked dangerous operator in field[${operator}]: ${mongoOperator}`);
      return;
    }

    if (mongoOperator === '$eq') {
      filters[field] = value; // Direct value for equality
    } else if (mongoOperator === '$regex') {
      filters[field] = { $regex: value };
      regexFields[field] = true;
    } else {
      // Handle other operators
      if (typeof filters[field] !== 'object' || filters[field] === null || Array.isArray(filters[field])) {
        filters[field] = {};
      }

      // Process value based on operator type
      let processedValue: unknown;
      const op = operator.toLowerCase();

      if (['gt', 'gte', 'lt', 'lte', 'size'].includes(op)) {
        // These operators require a numeric value
        processedValue = parseFloat(String(value));
        if (isNaN(processedValue as number)) return;
      } else if (op === 'in' || op === 'nin') {
        // These operators require an array
        processedValue = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim());
      } else {
        // Default processing for other operators
        processedValue = this._convertValue(value);
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
    parsedFilters: Record<string, unknown>
  ): void {
    if (!parsedFilters[field]) {
      parsedFilters[field] = {};
    }

    for (const [operator, value] of Object.entries(operators)) {
      // Special handling for 'between' operator (processed later in _enhanceWithBetween)
      if (operator === 'between') {
        (parsedFilters[field] as Record<string, unknown>).between = value;
        continue;
      }

      if (this.operators[operator]) {
        const mongoOperator = this.operators[operator];
        let processedValue: unknown;

        // Operator-specific value processing is crucial for correctness.
        if (['gt', 'gte', 'lt', 'lte', 'size'].includes(operator)) {
          // These operators require a numeric value.
          processedValue = parseFloat(String(value));
          if (isNaN(processedValue as number)) continue;
        } else if (operator === 'in' || operator === 'nin') {
          // These operators require an array.
          processedValue = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim());
        } else if (operator === 'like' || operator === 'contains') {
          // These operators require a RegExp - use safe regex creation
          const safeRegex = this._createSafeRegex(value);
          if (!safeRegex) continue;
          processedValue = safeRegex;
        } else {
          // Default processing for other operators like 'eq', 'ne'.
          processedValue = this._convertValue(value);
        }

        (parsedFilters[field] as Record<string, unknown>)[mongoOperator] = processedValue;
      }
    }
  }

  /**
   * Convert operator to MongoDB format
   */
  private _toMongoOperator(operator: string): string {
    const op = operator.toLowerCase();
    return op.startsWith('$') ? op : '$' + op;
  }

  /**
   * Create a safe regex pattern with protection against ReDoS attacks
   * @param pattern - The pattern string from user input
   * @param flags - Regex flags (default: 'i' for case-insensitive)
   * @returns A safe RegExp or null if pattern is invalid/dangerous
   */
  private _createSafeRegex(pattern: unknown, flags: string = 'i'): RegExp | null {
    if (pattern === null || pattern === undefined) {
      return null;
    }

    const patternStr = String(pattern);

    // Check pattern length to prevent very long regex
    if (patternStr.length > this.options.maxRegexLength) {
      console.warn(`[mongokit] Regex pattern too long (${patternStr.length} > ${this.options.maxRegexLength}), truncating`);
      return new RegExp(this._escapeRegex(patternStr.substring(0, this.options.maxRegexLength)), flags);
    }

    // Check for dangerous patterns that could cause ReDoS
    if (this.dangerousRegexPatterns.test(patternStr)) {
      console.warn('[mongokit] Potentially dangerous regex pattern detected, escaping');
      return new RegExp(this._escapeRegex(patternStr), flags);
    }

    try {
      return new RegExp(patternStr, flags);
    } catch {
      // Invalid regex pattern - escape it for literal match
      return new RegExp(this._escapeRegex(patternStr), flags);
    }
  }

  /**
   * Escape special regex characters for literal matching
   */
  private _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Sanitize text search query for MongoDB $text search
   * @param search - Raw search input from user
   * @returns Sanitized search string or undefined
   */
  private _sanitizeSearch(search: unknown): string | undefined {
    if (search === null || search === undefined || search === '') {
      return undefined;
    }

    let searchStr = String(search).trim();

    // Return undefined for empty/whitespace-only strings
    if (!searchStr) {
      return undefined;
    }

    // Enforce length limit to prevent excessive memory usage
    if (searchStr.length > this.options.maxSearchLength) {
      console.warn(`[mongokit] Search query too long (${searchStr.length} > ${this.options.maxSearchLength}), truncating`);
      searchStr = searchStr.substring(0, this.options.maxSearchLength);
    }

    // MongoDB $text search operators that should be preserved: - (negation), "" (phrase)
    // But we should escape characters that could cause issues
    // Note: MongoDB $text is generally safe, but we sanitize for consistency

    return searchStr;
  }

  /**
   * Convert values based on operator type
   */
  private _convertValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(v => this._convertValue(v));
    if (typeof value === 'object') return value;

    const stringValue = String(value);

    // Only convert specific known values
    if (stringValue === 'true') return true;
    if (stringValue === 'false') return false;

    // Convert ObjectIds only if they are valid 24-character hex strings
    // Use string representation instead of ObjectId object to avoid serialization issues
    if (mongoose.Types.ObjectId.isValid(stringValue) && stringValue.length === 24) {
      return stringValue; // Return as string, let Mongoose handle the conversion
    }

    // Return as string - this preserves UPCs, styleIds, and other string fields
    return stringValue;
  }

  /**
   * Parse $or conditions
   */
  private _parseOr(query: Record<string, unknown> | null | undefined): Record<string, unknown>[] | undefined {
    const orArray: Record<string, unknown>[] = [];
    const raw = query?.or || query?.OR || query?.$or;
    if (!raw) return undefined;

    const items = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.values(raw as Record<string, unknown>) : [];
    for (const item of items) {
      if (typeof item === 'object' && item) {
        orArray.push(this._parseFilters(item as Record<string, FilterValue>));
      }
    }
    return orArray.length ? orArray : undefined;
  }

  /**
   * Enhance filters with between operator
   */
  private _enhanceWithBetween(filters: FilterQuery<AnyDocument>): FilterQuery<AnyDocument> {
    const output = { ...filters } as Record<string, unknown>;
    for (const [key, value] of Object.entries(filters || {})) {
      if (value && typeof value === 'object' && 'between' in (value as Record<string, unknown>)) {
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
    return output as FilterQuery<AnyDocument>;
  }
}

/** Default query parser instance with standard options */
const defaultQueryParser = new QueryParser();

export default defaultQueryParser;
