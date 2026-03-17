/**
 * Cache Key Utilities
 * 
 * Generates deterministic, collision-free cache keys for MongoDB queries.
 * Key design inspired by Next.js cache tags and best practices from Stripe/Meta.
 */

import type { SortSpec, SelectSpec, PopulateSpec } from '../types.js';

/**
 * Simple hash function for query parameters
 * Using djb2 algorithm - fast and good distribution
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // Convert to positive hex string
  return (hash >>> 0).toString(16);
}

/**
 * Normalize and stringify an object for hashing
 * Ensures deterministic key generation regardless of property order
 */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  
  const sorted = Object.keys(obj as Record<string, unknown>)
    .sort()
    .map(key => `${key}:${stableStringify((obj as Record<string, unknown>)[key])}`);
  return '{' + sorted.join(',') + '}';
}

/**
 * Generate cache key for getById operations
 *
 * Includes select/populate/lean in the key so different query shapes
 * (e.g., plain vs populated, lean vs hydrated) never collide.
 *
 * Format: {prefix}:id:{model}:{documentId} (no options)
 * Format: {prefix}:id:{model}:{documentId}:{optionsHash} (with options)
 *
 * @example
 * byIdKey('mk', 'User', '507f1f77bcf86cd799439011')
 * // => 'mk:id:User:507f1f77bcf86cd799439011'
 * byIdKey('mk', 'User', '507f1f77bcf86cd799439011', { select: 'name email' })
 * // => 'mk:id:User:507f1f77bcf86cd799439011:a1b2c3d4'
 */
export function byIdKey(
  prefix: string,
  model: string,
  id: string,
  options?: { select?: SelectSpec; populate?: PopulateSpec; lean?: boolean },
): string {
  const base = `${prefix}:id:${model}:${id}`;
  // If no shape options, return simple key (backwards-compatible for default reads)
  if (!options || (options.select == null && options.populate == null && options.lean == null)) {
    return base;
  }
  const hashInput = stableStringify({ s: options.select, p: options.populate, l: options.lean });
  return `${base}:${hashString(hashInput)}`;
}

/**
 * Generate cache key for single-document queries
 * 
 * Format: {prefix}:one:{model}:{queryHash}
 * 
 * @example
 * byQueryKey('mk', 'User', { email: 'john@example.com' })
 * // => 'mk:one:User:a1b2c3d4'
 */
export function byQueryKey(
  prefix: string,
  model: string,
  version: number,
  query: Record<string, unknown>,
  options?: { select?: SelectSpec; populate?: PopulateSpec }
): string {
  const hashInput = stableStringify({ q: query, s: options?.select, p: options?.populate });
  return `${prefix}:one:${model}:${version}:${hashString(hashInput)}`;
}

/**
 * Generate cache key for paginated list queries
 * 
 * Format: {prefix}:list:{model}:{version}:{queryHash}
 * 
 * The version component enables efficient bulk invalidation:
 * - On any mutation, bump the version
 * - All list cache keys become invalid without scanning/deleting each
 * 
 * @example
 * listQueryKey('mk', 'User', 1, { filters: { status: 'active' }, page: 1, limit: 20 })
 * // => 'mk:list:User:1:e5f6g7h8'
 */
export function listQueryKey(
  prefix: string,
  model: string,
  version: number,
  params: {
    filters?: Record<string, unknown>;
    sort?: SortSpec;
    page?: number;
    limit?: number;
    after?: string;
    select?: SelectSpec;
    populate?: PopulateSpec;
    search?: string;
    mode?: string;
    lean?: boolean;
    readPreference?: string;
    hint?: string | Record<string, unknown>;
    maxTimeMS?: number;
    countStrategy?: string;
  }
): string {
  const hashInput = stableStringify({
    f: params.filters,
    s: params.sort,
    pg: params.page,
    lm: params.limit,
    af: params.after,
    sl: params.select,
    pp: params.populate,
    sr: params.search,
    md: params.mode,
    ln: params.lean,
    rp: params.readPreference,
    hn: params.hint,
    mt: params.maxTimeMS,
    cs: params.countStrategy,
  });
  return `${prefix}:list:${model}:${version}:${hashString(hashInput)}`;
}

/**
 * Generate cache key for collection version tag
 * 
 * Format: {prefix}:ver:{model}
 * 
 * Used to track mutation version for list invalidation
 */
export function versionKey(prefix: string, model: string): string {
  return `${prefix}:ver:${model}`;
}

/**
 * Generate pattern for clearing all cache keys for a model
 * 
 * Format: {prefix}:*:{model}:*
 * 
 * @example
 * modelPattern('mk', 'User')
 * // => 'mk:*:User:*'
 */
export function modelPattern(prefix: string, model: string): string {
  return `${prefix}:*:${model}:*`;
}

/**
 * Generate pattern for clearing all list cache keys for a model
 *
 * Format: {prefix}:list:{model}:*
 */
export function listPattern(prefix: string, model: string): string {
  return `${prefix}:list:${model}:*`;
}

/**
 * Generate pattern for clearing all byId cache keys for a specific document
 * (covers all select/populate/lean shape variants)
 *
 * Format: {prefix}:id:{model}:{id}*
 */
export function byIdPattern(prefix: string, model: string, id: string): string {
  return `${prefix}:id:${model}:${id}*`;
}

