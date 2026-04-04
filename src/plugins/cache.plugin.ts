/**
 * Cache Plugin
 *
 * Optional caching layer for MongoKit with automatic invalidation.
 * Bring-your-own cache adapter (Redis, Memcached, in-memory, etc.)
 *
 * Features:
 * - Cache-aside (read-through) pattern with configurable TTLs
 * - Automatic invalidation on create/update/delete
 * - Collection version tags for efficient list cache invalidation
 * - Manual invalidation methods for microservice scenarios
 * - Skip cache per-operation with `skipCache: true`
 *
 * @example
 * ```typescript
 * import { Repository, cachePlugin } from '@classytic/mongokit';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis();
 *
 * const userRepo = new Repository(UserModel, [
 *   cachePlugin({
 *     adapter: {
 *       async get(key) { return JSON.parse(await redis.get(key) || 'null'); },
 *       async set(key, value, ttl) { await redis.setex(key, ttl, JSON.stringify(value)); },
 *       async del(key) { await redis.del(key); },
 *       async clear(pattern) {
 *         const keys = await redis.keys(pattern || '*');
 *         if (keys.length) await redis.del(...keys);
 *       }
 *     },
 *     ttl: 60, // 1 minute default
 *   })
 * ]);
 *
 * // Reads check cache first
 * const user = await userRepo.getById(id); // cached
 *
 * // Skip cache for fresh data
 * const fresh = await userRepo.getById(id, { skipCache: true });
 *
 * // Mutations auto-invalidate
 * await userRepo.update(id, { name: 'New Name' }); // invalidates cache
 *
 * // Manual invalidation for microservice sync
 * await userRepo.invalidateCache(id); // invalidate single doc
 * await userRepo.invalidateAllCache(); // invalidate all for this model
 * ```
 */

import { HOOK_PRIORITY } from '../Repository.js';
import type {
  CacheAdapter,
  CacheOptions,
  CacheStats,
  Plugin,
  RepositoryContext,
  RepositoryInstance,
} from '../types.js';
import {
  byIdKey,
  byQueryKey,
  listQueryKey,
  modelPattern,
  versionKey,
} from '../utils/cache-keys.js';
import { debug as logDebug } from '../utils/logger.js';

/** Internal resolved options */
interface ResolvedCacheOptions {
  adapter: CacheAdapter;
  ttl: number;
  byIdTtl: number;
  queryTtl: number;
  prefix: string;
  debug: boolean;
  skipIfLargeLimit: number;
}

/**
 * Cache plugin factory
 *
 * @param options - Cache configuration
 * @returns Plugin instance
 */
export function cachePlugin(options: CacheOptions): Plugin {
  const config: ResolvedCacheOptions = {
    adapter: options.adapter,
    ttl: options.ttl ?? 60,
    byIdTtl: options.byIdTtl ?? options.ttl ?? 60,
    queryTtl: options.queryTtl ?? options.ttl ?? 60,
    prefix: options.prefix ?? 'mk',
    debug: options.debug ?? false,
    skipIfLargeLimit: options.skipIf?.largeLimit ?? 100,
  };

  // Stats for monitoring
  const stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    invalidations: 0,
    errors: 0,
  };

  const log = (msg: string, data?: unknown) => {
    if (config.debug) {
      logDebug(`[mongokit:cache] ${msg}`, data ?? '');
    }
  };

  return {
    name: 'cache',

    apply(repo: RepositoryInstance): void {
      const model = repo.model;

      // ─── Shape-variant key tracking ─────────────────────────────────
      // Tracks all byId cache keys per document ID (including shape variants).
      // On invalidation, every tracked key is deleted individually via del(),
      // so adapters without pattern-based clear() still get full invalidation.
      const byIdKeyRegistry = new Map<string, Set<string>>();

      function trackByIdKey(docId: string, cacheKey: string): void {
        let keys = byIdKeyRegistry.get(docId);
        if (!keys) {
          keys = new Set();
          byIdKeyRegistry.set(docId, keys);
        }
        keys.add(cacheKey);
      }

      // ─── Version helper ───────────────────────────────────────────────
      // collectionVersion is ALWAYS read from the adapter before use.
      // This ensures correctness across multiple pods/processes:
      // - Pod A bumps version → writes new timestamp to Redis
      // - Pod B reads version from Redis → gets fresh value, no stale cache
      // In-memory caching of version is intentionally avoided here.

      async function getVersion(): Promise<number> {
        try {
          const v = await config.adapter.get<number>(versionKey(config.prefix, model));
          return v ?? 0;
        } catch (e) {
          log(`Cache error in getVersion for ${model}:`, e);
          return 0;
        }
      }

      /**
       * Bump collection version in the adapter (invalidates all list caches).
       * Uses Date.now() so version always moves forward — safe after eviction or deploy.
       */
      async function bumpVersion(): Promise<void> {
        const newVersion = Date.now();
        try {
          await config.adapter.set(versionKey(config.prefix, model), newVersion, config.ttl * 10);
          stats.invalidations++;
          log(`Bumped version for ${model} to:`, newVersion);
        } catch (e) {
          log(`Failed to bump version for ${model}:`, e);
        }
      }

      /**
       * Invalidate a specific document by ID (all shape variants).
       * Deletes every tracked shape-variant key individually via del(),
       * so adapters without pattern-based clear() still get full invalidation.
       */
      async function invalidateById(id: string): Promise<void> {
        try {
          // Always delete the base key (default/no-options shape)
          const baseKey = byIdKey(config.prefix, model, id);
          await config.adapter.del(baseKey);

          // Delete all tracked shape-variant keys for this document
          const trackedKeys = byIdKeyRegistry.get(id);
          if (trackedKeys) {
            for (const key of trackedKeys) {
              if (key !== baseKey) {
                await config.adapter.del(key);
              }
            }
            byIdKeyRegistry.delete(id);
          }

          stats.invalidations++;
          log(`Invalidated byId cache for:`, id);
        } catch (e) {
          log(`Failed to invalidate byId cache:`, e);
        }
      }

      // ============================================================
      // READ HOOKS - Check cache before DB query
      // ============================================================

      /**
       * before:getById - Check cache for document
       * Runs at CACHE priority (200) — after policy hooks inject filters
       */
      repo.on(
        'before:getById',
        async (context: RepositoryContext) => {
          if (context.skipCache) {
            log(`Skipping cache for getById: ${context.id}`);
            return;
          }

          const id = String(context.id);
          const key = byIdKey(config.prefix, model, id, {
            select: context.select,
            populate: context.populate,
            lean: context.lean,
          });

          try {
            const cached = await config.adapter.get(key);
            if (cached !== null) {
              stats.hits++;
              log(`Cache HIT for getById:`, key);
              // Store in context for Repository to use
              context._cacheHit = true;
              context._cachedResult = cached;
            } else {
              stats.misses++;
              log(`Cache MISS for getById:`, key);
            }
          } catch (e) {
            log(`Cache error for getById:`, e);
            stats.errors++;
          }
        },
        { priority: HOOK_PRIORITY.CACHE },
      );

      /**
       * before:getByQuery - Check cache for single-doc query
       * Runs at CACHE priority (200) — after policy hooks inject filters
       */
      repo.on(
        'before:getByQuery',
        async (context: RepositoryContext) => {
          if (context.skipCache) {
            log(`Skipping cache for getByQuery`);
            return;
          }

          const collectionVersion = await getVersion();
          const query = (context.query || {}) as Record<string, unknown>;
          const key = byQueryKey(config.prefix, model, collectionVersion, query, {
            select: context.select,
            populate: context.populate,
          });

          try {
            const cached = await config.adapter.get(key);
            if (cached !== null) {
              stats.hits++;
              log(`Cache HIT for getByQuery:`, key);
              context._cacheHit = true;
              context._cachedResult = cached;
            } else {
              stats.misses++;
              log(`Cache MISS for getByQuery:`, key);
            }
          } catch (e) {
            log(`Cache error for getByQuery:`, e);
            stats.errors++;
          }
        },
        { priority: HOOK_PRIORITY.CACHE },
      );

      /**
       * before:getAll - Check cache for list query
       * Runs at CACHE priority (200) — after policy hooks inject filters
       */
      repo.on(
        'before:getAll',
        async (context: RepositoryContext) => {
          if (context.skipCache) {
            log(`Skipping cache for getAll`);
            return;
          }

          // Skip caching large result sets
          const limit = context.limit;
          if (limit && limit > config.skipIfLargeLimit) {
            log(`Skipping cache for large query (limit: ${limit})`);
            return;
          }

          // Always read version from adapter — ensures distributed correctness
          const collectionVersion = await getVersion();

          const params = {
            filters: context.filters,
            sort: context.sort,
            page: context.page,
            limit,
            after: context.after,
            select: context.select,
            populate: context.populate,
            search: context.search,
            mode: context.mode,
            lean: context.lean,
            readPreference: context.readPreference,
            hint: context.hint,
            maxTimeMS: context.maxTimeMS,
            countStrategy: context.countStrategy,
          };

          const key = listQueryKey(config.prefix, model, collectionVersion, params);

          try {
            const cached = await config.adapter.get(key);
            if (cached !== null) {
              stats.hits++;
              log(`Cache HIT for getAll:`, key);
              context._cacheHit = true;
              context._cachedResult = cached;
            } else {
              stats.misses++;
              log(`Cache MISS for getAll:`, key);
            }
          } catch (e) {
            log(`Cache error for getAll:`, e);
            stats.errors++;
          }
        },
        { priority: HOOK_PRIORITY.CACHE },
      );

      // ============================================================
      // AFTER HOOKS - Store results in cache
      // ============================================================

      /**
       * after:getById - Cache the result
       */
      repo.on('after:getById', async (payload: { context: RepositoryContext; result: unknown }) => {
        const { context, result } = payload;

        // Don't cache if we got a cache hit (result came from cache)
        if (context._cacheHit) return;
        if (context.skipCache) return;
        if (result === null) return; // Don't cache not-found

        const id = String(context.id);
        const key = byIdKey(config.prefix, model, id, {
          select: context.select,
          populate: context.populate,
          lean: context.lean,
        });
        const ttl = context.cacheTtl ?? config.byIdTtl;

        try {
          await config.adapter.set(key, result, ttl);
          trackByIdKey(id, key);
          stats.sets++;
          log(`Cached getById result:`, key);
        } catch (e) {
          log(`Failed to cache getById:`, e);
        }
      });

      /**
       * after:getByQuery - Cache the result
       */
      repo.on(
        'after:getByQuery',
        async (payload: { context: RepositoryContext; result: unknown }) => {
          const { context, result } = payload;

          if (context._cacheHit) return;
          if (context.skipCache) return;
          if (result === null) return;

          const collectionVersion = await getVersion();
          const query = (context.query || {}) as Record<string, unknown>;
          const key = byQueryKey(config.prefix, model, collectionVersion, query, {
            select: context.select,
            populate: context.populate,
          });
          const ttl = context.cacheTtl ?? config.queryTtl;

          try {
            await config.adapter.set(key, result, ttl);
            stats.sets++;
            log(`Cached getByQuery result:`, key);
          } catch (e) {
            log(`Failed to cache getByQuery:`, e);
          }
        },
      );

      /**
       * after:getAll - Cache the result
       */
      repo.on('after:getAll', async (payload: { context: RepositoryContext; result: unknown }) => {
        const { context, result } = payload;

        if (context._cacheHit) return;
        if (context.skipCache) return;

        const limit = context.limit;
        if (limit && limit > config.skipIfLargeLimit) return;

        // Always read fresh version for cache key — distributed correctness
        const collectionVersion = await getVersion();

        const params = {
          filters: context.filters,
          sort: context.sort,
          page: context.page,
          limit,
          after: context.after,
          select: context.select,
          populate: context.populate,
          search: context.search,
          mode: context.mode,
          lean: context.lean,
          readPreference: context.readPreference,
          hint: context.hint,
          maxTimeMS: context.maxTimeMS,
          countStrategy: context.countStrategy,
        };

        const key = listQueryKey(config.prefix, model, collectionVersion, params);
        const ttl = context.cacheTtl ?? config.queryTtl;

        try {
          await config.adapter.set(key, result, ttl);
          stats.sets++;
          log(`Cached getAll result:`, key);
        } catch (e) {
          log(`Failed to cache getAll:`, e);
        }
      });

      // ============================================================
      // WRITE HOOKS - Invalidate cache on mutations
      // ============================================================

      /**
       * after:create - Bump version to invalidate list caches
       */
      repo.on('after:create', async () => {
        await bumpVersion();
      });

      /**
       * after:createMany - Bump version to invalidate list caches
       */
      repo.on('after:createMany', async () => {
        await bumpVersion();
      });

      /**
       * after:update - Invalidate by ID and bump version
       */
      repo.on('after:update', async (payload: { context: RepositoryContext; result: unknown }) => {
        const { context } = payload;
        const id = String(context.id);

        await Promise.all([invalidateById(id), bumpVersion()]);
      });

      /**
       * after:updateMany - Bump version (can't track individual IDs efficiently)
       */
      repo.on('after:updateMany', async () => {
        await bumpVersion();
      });

      /**
       * after:delete - Invalidate by ID and bump version
       */
      repo.on('after:delete', async (payload: { context: RepositoryContext }) => {
        const { context } = payload;
        const id = String(context.id);

        await Promise.all([invalidateById(id), bumpVersion()]);
      });

      /**
       * after:deleteMany - Bump version
       */
      repo.on('after:deleteMany', async () => {
        await bumpVersion();
      });

      /**
       * after:bulkWrite - Bump version (bulk ops may insert/update/delete)
       */
      repo.on('after:bulkWrite', async () => {
        await bumpVersion();
      });

      // ============================================================
      // PUBLIC METHODS - Manual invalidation for microservices
      // ============================================================

      /**
       * Invalidate cache for a specific document
       * Use when document was updated outside this service
       *
       * @example
       * await userRepo.invalidateCache('507f1f77bcf86cd799439011');
       */
      repo.invalidateCache = async (id: string): Promise<void> => {
        await invalidateById(id);
        log(`Manual invalidation for ID:`, id);
      };

      /**
       * Invalidate all list caches for this model
       * Use when bulk changes happened outside this service
       *
       * @example
       * await userRepo.invalidateListCache();
       */
      repo.invalidateListCache = async (): Promise<void> => {
        await bumpVersion();
        log(`Manual list cache invalidation for ${model}`);
      };

      /**
       * Invalidate ALL cache entries for this model
       * Nuclear option - use sparingly
       *
       * @example
       * await userRepo.invalidateAllCache();
       */
      repo.invalidateAllCache = async (): Promise<void> => {
        if (config.adapter.clear) {
          try {
            await config.adapter.clear(modelPattern(config.prefix, model));
            stats.invalidations++;
            log(`Full cache invalidation for ${model}`);
          } catch (e) {
            log(`Failed full cache invalidation for ${model}:`, e);
          }
        } else {
          // Fallback: just bump version (invalidates lists)
          await bumpVersion();
          log(`Partial cache invalidation for ${model} (adapter.clear not available)`);
        }
      };

      /**
       * Get cache statistics for monitoring
       *
       * @example
       * const stats = userRepo.getCacheStats();
       * console.log(`Hit rate: ${stats.hits / (stats.hits + stats.misses) * 100}%`);
       */
      repo.getCacheStats = (): CacheStats => ({ ...stats });

      /**
       * Reset cache statistics
       */
      repo.resetCacheStats = (): void => {
        stats.hits = 0;
        stats.misses = 0;
        stats.sets = 0;
        stats.invalidations = 0;
        stats.errors = 0;
      };
    },
  };
}

/**
 * TypeScript interface for cache plugin methods
 *
 * @example
 * ```typescript
 * import type { CacheMethods } from '@classytic/mongokit';
 *
 * type ProductRepoWithCache = ProductRepo & CacheMethods;
 *
 * const productRepo = new ProductRepo(ProductModel, [
 *   methodRegistryPlugin(),
 *   cachePlugin({ adapter: redisAdapter, ttl: 60 }),
 * ]) as ProductRepoWithCache;
 *
 * // TypeScript autocomplete for cache methods
 * await productRepo.invalidateCache(productId);
 * await productRepo.invalidateListCache();
 * await productRepo.invalidateAllCache();
 * const stats = productRepo.getCacheStats();
 * productRepo.resetCacheStats();
 * ```
 */
export interface CacheMethods {
  /**
   * Invalidate cache for a specific document
   * Use when document was updated outside this service
   * @param id - Document ID to invalidate
   */
  invalidateCache(id: string): Promise<void>;

  /**
   * Invalidate all list caches for this model
   * Use when bulk changes happened outside this service
   */
  invalidateListCache(): Promise<void>;

  /**
   * Invalidate ALL cache entries for this model
   * Nuclear option - use sparingly
   */
  invalidateAllCache(): Promise<void>;

  /**
   * Get cache statistics for monitoring
   * @returns Cache statistics (hits, misses, sets, invalidations)
   */
  getCacheStats(): CacheStats;

  /**
   * Reset cache statistics
   */
  resetCacheStats(): void;
}
