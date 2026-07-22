/**
 * OpenAPI query-schema generation — Arc's `defineResource()` auto-detects
 * `getQuerySchema()` on the parser and uses it to document list-endpoint
 * query parameters in OpenAPI/Swagger.
 */

import type { ParserRuntime } from './runtime.js';

export interface QuerySchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

function availableOperators(rt: ParserRuntime): [string, string][] {
  return rt.options.allowedOperators
    ? Object.entries(rt.operators).filter(([key]) => rt.options.allowedOperators?.includes(key))
    : Object.entries(rt.operators);
}

/** Get the JSON Schema type for a filter operator. */
function operatorSchemaType(op: string): string {
  if (['gt', 'gte', 'lt', 'lte', 'size'].includes(op)) return 'number';
  if (['exists'].includes(op)) return 'boolean';
  return 'string';
}

/** Get a human-readable description for a filter operator. */
function operatorDescription(op: string, field: string, mongoOp: string): string {
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

/** Build a summary description of all available filter operators. */
function buildOperatorSummary(operators: [string, string][]): string {
  const lines = ['Available filter operators (use as field[operator]=value):'];
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
  for (const [op, mongoOp] of operators) {
    lines.push(`  ${op} → ${mongoOp}: ${desc[op] || op}`);
  }
  return lines.join('\n');
}

/**
 * Generate OpenAPI-compatible JSON Schema for query parameters.
 *
 * The schema respects parser configuration:
 * - `allowedOperators`: only documents allowed operators
 * - `allowedFilterFields`: generates explicit field[op] entries
 * - `enableLookups` / `enableAggregations`: includes/excludes lookup/aggregate params
 * - `maxLimit` / `maxSearchLength`: reflected in schema constraints
 */
export function buildQuerySchema(rt: ParserRuntime): QuerySchema {
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
      maximum: rt.options.maxLimit,
    },
    sort: {
      type: 'string',
      description:
        'Sort fields (comma-separated). Prefix with - for descending. Example: -createdAt,name',
    },
    search: {
      type: 'string',
      description:
        rt.options.searchMode === 'regex'
          ? `Search across fields${rt.options.searchFields ? ` (${rt.options.searchFields.join(', ')})` : ''} using case-insensitive regex`
          : 'Full-text search query (requires text index)',
      maxLength: rt.options.maxSearchLength,
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
  if (rt.options.enableLookups) {
    properties.lookup = {
      type: 'object',
      description:
        'Custom field lookups ($lookup). Example: lookup[department]=slug or lookup[department][localField]=deptId&lookup[department][foreignField]=_id',
    };
  }

  // Add aggregate param docs when enabled
  if (rt.options.enableAggregations) {
    properties.aggregate = {
      type: 'object',
      description:
        'Aggregation pipeline stages. Supports: group, match, sort, project. Example: aggregate[group][_id]=$status',
    };
  }

  const operators = availableOperators(rt);

  // When allowedFilterFields is set, generate explicit field[op] entries
  if (rt.options.allowedFilterFields && rt.options.allowedFilterFields.length > 0) {
    for (const field of rt.options.allowedFilterFields) {
      // Direct equality filter
      properties[field] = {
        type: 'string',
        description: `Filter by ${field} (exact match)`,
      };
      // Operator-based filters
      for (const [op, mongoOp] of operators) {
        if (op === 'eq') continue; // eq is the default (direct equality)
        properties[`${field}[${op}]`] = {
          type: operatorSchemaType(op),
          description: operatorDescription(op, field, mongoOp),
        };
      }
    }
  }

  return { type: 'object', properties };
}

/**
 * Query schema with OpenAPI extensions — adds a documentary
 * `_filterOperators` property (marked `x-internal`) describing available
 * filter operators. For validation-only schemas use `buildQuerySchema`.
 */
export function buildOpenAPIQuerySchema(rt: ParserRuntime): {
  type: 'object';
  properties: Record<string, unknown>;
} {
  const schema = buildQuerySchema(rt);

  schema.properties._filterOperators = {
    type: 'string',
    description: buildOperatorSummary(availableOperators(rt)),
    'x-internal': true,
  };

  return schema;
}
