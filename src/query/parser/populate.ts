/**
 * Populate parsing — simple string form (`?populate=author,category`) and
 * qs-nested advanced form (`?populate[author][select]=name,email`), with
 * nested populate, match conditions, and per-path options.
 */

import { coerceHeuristic } from '../primitives/coercion.js';
import type { ParserRuntime } from './runtime.js';
import { parseSort } from './sort-select.js';
import type { PopulateOption } from './types.js';

/**
 * Parse populate parameter - handles both simple string and advanced object format
 *
 * @example
 * ```typescript
 * // Simple: ?populate=author,category
 * // Returns: { simplePopulate: 'author,category', populateOptions: [{path:'author'},{path:'category'}] }
 *
 * // Advanced: ?populate[author][select]=name,email
 * // Returns: { simplePopulate: undefined, populateOptions: [{ path: 'author', select: 'name email' }] }
 * ```
 */
export function parsePopulate(
  rt: ParserRuntime,
  populate: unknown,
): {
  simplePopulate?: string;
  populateOptions?: PopulateOption[];
} {
  if (!populate) {
    return {};
  }

  // Simple string format: ?populate=author,category
  // Normalized to populateOptions for consistent output format;
  // simplePopulate is also kept — Repository's populate path consumes it.
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

    if (Object.keys(populateObj).length === 0) {
      return {};
    }

    const populateOptions: PopulateOption[] = [];

    for (const [path, config] of Object.entries(populateObj)) {
      // Security: Skip dangerous paths
      if (path.startsWith('$') || rt.dangerousOperators.includes(path)) {
        rt.reject(`Blocked dangerous populate path: ${path}`, { path });
        continue;
      }

      const option = parseSinglePopulate(rt, path, config);
      if (option) {
        populateOptions.push(option);
      }
    }

    return populateOptions.length > 0 ? { populateOptions } : {};
  }

  return {};
}

/** Parse a single populate configuration (recursive for nested populate). */
function parseSinglePopulate(
  rt: ParserRuntime,
  path: string,
  config: unknown,
  depth: number = 0,
): PopulateOption | null {
  // Prevent infinite recursion
  if (depth > 5) {
    rt.reject(`Populate depth exceeds maximum (5), truncating at path: ${path}`, { path });
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
      option.match = convertPopulateMatch(opts.match as Record<string, unknown>);
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
      const sortSpec = parseSort(rt, opts.sort);
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
        const nestedOption = parseSinglePopulate(rt, nestedPath, nestedConfig, depth + 1);
        if (nestedOption) {
          option.populate = nestedOption;
        }
      }
    }

    return option;
  }

  return null;
}

/** Convert populate match values (handles boolean strings, etc.) */
function convertPopulateMatch(match: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(match)) {
    converted[key] = coerceHeuristic(value);
  }
  return converted;
}
