/**
 * OpenAPI query-schema generation — Arc's `defineResource()` auto-detects
 * `getQuerySchema()` on the parser and uses it to document list-endpoint
 * query parameters in OpenAPI/Swagger.
 */

import { type BracketOperator, OPERATOR_DESCRIPTIONS } from '@classytic/repo-core/query-parser';
import type { ParserRuntime } from './runtime.js';

export interface QuerySchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** mongokit's own operators, described alongside the shared grammar's. */
const EXTENSION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  size: 'Array has exactly N elements',
  type: 'Field is of a BSON type (name or number)',
  near: 'Nearest to lng,lat[,maxDistanceMeters]',
  nearSphere: 'Nearest on a sphere to lng,lat[,maxDistanceMeters]',
  geoWithin: 'Inside the box minLng,minLat,maxLng,maxLat',
  withinRadius: 'Within lng,lat,radiusMeters',
};

function describeOperator(op: string): string {
  if (op in OPERATOR_DESCRIPTIONS) return OPERATOR_DESCRIPTIONS[op as BracketOperator];
  return EXTENSION_DESCRIPTIONS[op] ?? op;
}

function availableOperators(rt: ParserRuntime): readonly string[] {
  const allowed = rt.options.allowedOperators;
  return allowed ? rt.urlOperators.filter((op) => allowed.includes(op)) : rt.urlOperators;
}

/** JSON Schema type of an operator's value. */
function operatorSchemaType(op: string): string {
  if (op === 'size') return 'integer';
  if (op === 'exists') return 'boolean';
  return 'string';
}

function buildOperatorSummary(operators: readonly string[]): string {
  return [
    'Available filter operators (use as field[operator]=value):',
    ...operators.map((op) => `  ${op}: ${describeOperator(op)}`),
  ].join('\n');
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
      /**
       * The cap is DOCUMENTED, not enforced here — deliberately.
       *
       * `QueryParser.parse` clamps an over-large limit to `maxLimit` and says so in
       * its own comment: "Exceeding maxLimit is CLAMPED, not rejected — capping is not
       * invalid." Emitting `maximum` into the JSON Schema contradicted that: Fastify
       * validates the querystring BEFORE the parser runs, so the clamp was unreachable
       * and `?limit=200` became a hard 400.
       *
       * That combination is worse than either policy alone. A caller asking for more
       * rows than allowed is a benign over-ask with an obvious correct answer (give
       * them the maximum); turning it into a validation failure meant a UI that passed
       * a generous page size got NOTHING, and — because the two components doing so
       * never read the query error — rendered it as an empty list rather than a
       * failure. A 400 disguised as "no results" is the hardest kind to find.
       *
       * If a deployment genuinely wants rejection rather than clamping, that belongs
       * in the parser's fail-closed policy where both halves can agree, not in a schema
       * that silently outranks it.
       */
      description: `Number of items per page (values above ${rt.options.maxLimit} are capped to ${rt.options.maxLimit})`,
      default: 20,
      minimum: 1,
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
      for (const op of operators) {
        if (op === 'eq') continue; // eq is the default (direct equality)
        properties[`${field}[${op}]`] = {
          type: operatorSchemaType(op),
          description: `${field}: ${describeOperator(op)}`,
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
