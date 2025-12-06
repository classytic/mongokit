/**
 * Query Parser
 * 
 * Parses HTTP query parameters into MongoDB-compatible query objects.
 * Supports operators, pagination, sorting, and filtering.
 */

import mongoose from 'mongoose';
import type { ParsedQuery, SortSpec, FilterQuery, AnyDocument } from '../types.js';

type OperatorMap = Record<string, string>;
type FilterValue = string | number | boolean | null | undefined | Record<string, unknown> | unknown[];

class QueryParser {
  private operators: OperatorMap = {
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
  private dangerousOperators = ['$where', '$function', '$accumulator', '$expr'];

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
      search: search as string | undefined,
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
        this._handleOperatorSyntax(parsedFilters, {}, operatorMatch, value);
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
      filters[field] = { $regex: new RegExp(String(value), 'i') };
      regexFields[field] = true;
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
          // These operators require a RegExp.
          processedValue = (value !== undefined && value !== null) ? new RegExp(String(value), 'i') : /.*/;
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

export default new QueryParser();
