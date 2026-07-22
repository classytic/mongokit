/**
 * Lookup parsing — `?lookup[department]=slug` (simple) and
 * `?lookup[department][localField]=...&lookup[department][foreignField]=...`
 * (detailed) → LookupBuilder configs, with collection allowlisting and
 * sub-pipeline sanitization.
 */

import type { LookupOptions } from '../LookupBuilder.js';
import { sanitizePipeline } from './pipeline-sanitizer.js';
import type { ParserRuntime } from './runtime.js';

function pluralize(str: string): string {
  // Simple pluralization - can be enhanced with a library like 'pluralize'
  if (str.endsWith('y')) return `${str.slice(0, -1)}ies`;
  if (str.endsWith('s')) return str;
  return `${str}s`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Parse lookup configurations from URL parameters.
 *
 * Supported formats:
 * 1. Simple: ?lookup[department]=slug
 *    → Join with 'departments' collection on slug field
 * 2. Detailed: ?lookup[department][localField]=deptSlug&lookup[department][foreignField]=slug
 *    → Full control over join configuration
 * 3. Multiple: ?lookup[department]=slug&lookup[category]=categorySlug
 */
export function parseLookups(rt: ParserRuntime, lookup: unknown): LookupOptions[] {
  if (!lookup || typeof lookup !== 'object') return [];

  const lookups: LookupOptions[] = [];
  const lookupObj = lookup as Record<string, unknown>;

  for (const [collectionName, config] of Object.entries(lookupObj)) {
    try {
      const lookupConfig = parseSingleLookup(rt, collectionName, config);
      if (lookupConfig) {
        lookups.push(lookupConfig);
      }
    } catch (error) {
      // A 400 raised by the invalidInput policy inside parseSingleLookup /
      // sanitizePipeline must propagate, not be downgraded to a warn.
      if ((error as { code?: unknown }).code === 'INVALID_QUERY_INPUT') throw error;
      rt.reject(
        `Invalid lookup config for ${collectionName}: ${error instanceof Error ? error.message : String(error)}`,
        { collection: collectionName },
      );
    }
  }

  return lookups;
}

/** Parse a single lookup configuration. */
function parseSingleLookup(
  rt: ParserRuntime,
  collectionName: string,
  config: unknown,
): LookupOptions | null {
  if (!config) return null;

  // Simple format: lookup[department]=slug
  if (typeof config === 'string') {
    const from = pluralize(collectionName);
    if (
      rt.options.allowedLookupCollections &&
      !rt.options.allowedLookupCollections.includes(from)
    ) {
      rt.reject(`Blocked lookup to disallowed collection: ${from}`, { collection: from });
      return null;
    }
    return {
      from,
      localField: `${collectionName}${capitalize(config)}`,
      foreignField: config,
      as: collectionName,
      single: true,
    };
  }

  // Detailed format: lookup[department][localField]=...&lookup[department][foreignField]=...
  if (typeof config === 'object' && config !== null) {
    const opts = config as Record<string, unknown>;

    const from = (opts.from as string) || pluralize(collectionName);
    const localField = opts.localField as string;
    const foreignField = opts.foreignField as string;

    // Enforce collection whitelist
    if (
      rt.options.allowedLookupCollections &&
      !rt.options.allowedLookupCollections.includes(from)
    ) {
      rt.reject(`Blocked lookup to disallowed collection: ${from}`, { collection: from });
      return null;
    }

    if (!localField || !foreignField) {
      rt.reject(`Lookup requires localField and foreignField for ${collectionName}`, {
        collection: collectionName,
      });
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
        ? { pipeline: sanitizePipeline(rt, opts.pipeline) }
        : {}),
    };
  }

  return null;
}
