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

import type {
  Plugin,
  RepositoryContext,
  RepositoryInstance,
  CacheAdapter,
  CacheOptions,
  CacheStats,
  SortSpec,
} from '../types.js';
import {
  byIdKey,
  byQueryKey,
  listQueryKey,
  versionKey,
  modelPattern,
} from '../utils/cache-keys.js';

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
  };

  // Collection version for list invalidation (in-memory, synced to cache)
  let collectionVersion = 0;

  const log = (msg: string, data?: unknown) => {
    if (config.debug) {
      console.log(`[mongokit:cache] ${msg}`, data ?? '');
    }
  };

  return {
    name: 'cache',

    apply(repo: RepositoryInstance): void {
      const model = repo.model;

      // Initialize version from cache on startup
      (async () => {
        try {
          const cached = await config.adapter.get<number>(versionKey(config.prefix, model));
          if (cached !== null) {
            collectionVersion = cached;
            log(`Initialized version for ${model}:`, collectionVersion);
          }
        } catch (e) {
          log(`Failed to initialize version for ${model}:`, e);
        }
      })();

      /**
       * Helper to bump collection version (invalidates all list caches)
       */
      async function bumpVersion(): Promise<void> {
        collectionVersion++;
        try {
          await config.adapter.set(versionKey(config.prefix, model), collectionVersion, config.ttl * 10);
          stats.invalidations++;
          log(`Bumped version for ${model} to:`, collectionVersion);
        } catch (e) {
          log(`Failed to bump version for ${model}:`, e);
        }
      }

      /**
       * Helper to invalidate a specific document by ID
       */
      async function invalidateById(id: string): Promise<void> {
        const key = byIdKey(config.prefix, model, id);
        try {
          await config.adapter.del(key);
          stats.invalidations++;
          log(`Invalidated byId cache:`, key);
        } catch (e) {
          log(`Failed to invalidate byId cache:`, e);
        }
      }

      // ============================================================
      // READ HOOKS - Check cache before DB query
      // ============================================================

      /**
       * before:getById - Check cache for document
       */
      repo.on('before:getById', async (context: RepositoryContext) => {
        if ((context as Record<string, unknown>).skipCache) {
          log(`Skipping cache for getById: ${context.id}`);
          return;
        }

        const id = String(context.id);
        const key = byIdKey(config.prefix, model, id);

        try {
          const cached = await config.adapter.get(key);
          if (cached !== null) {
            stats.hits++;
            log(`Cache HIT for getById:`, key);
            // Store in context for Repository to use
            (context as Record<string, unknown>)._cacheHit = true;
            (context as Record<string, unknown>)._cachedResult = cached;
          } else {
            stats.misses++;
            log(`Cache MISS for getById:`, key);
          }
        } catch (e) {
          log(`Cache error for getById:`, e);
          stats.misses++;
        }
      });

      /**
       * before:getByQuery - Check cache for single-doc query
       */
      repo.on('before:getByQuery', async (context: RepositoryContext) => {
        if ((context as Record<string, unknown>).skipCache) {
          log(`Skipping cache for getByQuery`);
          return;
        }

        const query = (context.query || {}) as Record<string, unknown>;
        const key = byQueryKey(config.prefix, model, query, {
          select: context.select,
          populate: context.populate,
        });

        try {
          const cached = await config.adapter.get(key);
          if (cached !== null) {
            stats.hits++;
            log(`Cache HIT for getByQuery:`, key);
            (context as Record<string, unknown>)._cacheHit = true;
            (context as Record<string, unknown>)._cachedResult = cached;
          } else {
            stats.misses++;
            log(`Cache MISS for getByQuery:`, key);
          }
        } catch (e) {
          log(`Cache error for getByQuery:`, e);
          stats.misses++;
        }
      });

      /**
       * before:getAll - Check cache for list query
       */
      repo.on('before:getAll', async (context: RepositoryContext) => {
        if ((context as Record<string, unknown>).skipCache) {
          log(`Skipping cache for getAll`);
          return;
        }

        // Skip caching large result sets
        const limit = (context as Record<string, unknown>).limit as number | undefined;
        if (limit && limit > config.skipIfLargeLimit) {
          log(`Skipping cache for large query (limit: ${limit})`);
          return;
        }

        const params = {
          filters: (context as Record<string, unknown>).filters as Record<string, unknown> | undefined,
          sort: (context as Record<string, unknown>).sort as SortSpec | undefined,
          page: (context as Record<string, unknown>).page as number | undefined,
          limit,
          after: (context as Record<string, unknown>).after as string | undefined,
          select: context.select,
          populate: context.populate,
        };

        const key = listQueryKey(config.prefix, model, collectionVersion, params);

        try {
          const cached = await config.adapter.get(key);
          if (cached !== null) {
            stats.hits++;
            log(`Cache HIT for getAll:`, key);
            (context as Record<string, unknown>)._cacheHit = true;
            (context as Record<string, unknown>)._cachedResult = cached;
          } else {
            stats.misses++;
            log(`Cache MISS for getAll:`, key);
          }
        } catch (e) {
          log(`Cache error for getAll:`, e);
          stats.misses++;
        }
      });

      // ============================================================
      // AFTER HOOKS - Store results in cache
      // ============================================================

      /**
       * after:getById - Cache the result
       */
      repo.on('after:getById', async (payload: { context: RepositoryContext; result: unknown }) => {
        const { context, result } = payload;
        
        // Don't cache if we got a cache hit (result came from cache)
        if ((context as Record<string, unknown>)._cacheHit) return;
        if ((context as Record<string, unknown>).skipCache) return;
        if (result === null) return; // Don't cache not-found

        const id = String(context.id);
        const key = byIdKey(config.prefix, model, id);
        const ttl = ((context as Record<string, unknown>).cacheTtl as number) ?? config.byIdTtl;

        try {
          await config.adapter.set(key, result, ttl);
          stats.sets++;
          log(`Cached getById result:`, key);
        } catch (e) {
          log(`Failed to cache getById:`, e);
        }
      });

      /**
       * after:getByQuery - Cache the result
       */
      repo.on('after:getByQuery', async (payload: { context: RepositoryContext; result: unknown }) => {
        const { context, result } = payload;
        
        if ((context as Record<string, unknown>)._cacheHit) return;
        if ((context as Record<string, unknown>).skipCache) return;
        if (result === null) return;

        const query = (context.query || {}) as Record<string, unknown>;
        const key = byQueryKey(config.prefix, model, query, {
          select: context.select,
          populate: context.populate,
        });
        const ttl = ((context as Record<string, unknown>).cacheTtl as number) ?? config.queryTtl;

        try {
          await config.adapter.set(key, result, ttl);
          stats.sets++;
          log(`Cached getByQuery result:`, key);
        } catch (e) {
          log(`Failed to cache getByQuery:`, e);
        }
      });

      /**
       * after:getAll - Cache the result
       */
      repo.on('after:getAll', async (payload: { context: RepositoryContext; result: unknown }) => {
        const { context, result } = payload;
        
        if ((context as Record<string, unknown>)._cacheHit) return;
        if ((context as Record<string, unknown>).skipCache) return;

        const limit = (context as Record<string, unknown>).limit as number | undefined;
        if (limit && limit > config.skipIfLargeLimit) return;

        const params = {
          filters: (context as Record<string, unknown>).filters as Record<string, unknown> | undefined,
          sort: (context as Record<string, unknown>).sort as SortSpec | undefined,
          page: (context as Record<string, unknown>).page as number | undefined,
          limit,
          after: (context as Record<string, unknown>).after as string | undefined,
          select: context.select,
          populate: context.populate,
        };

        const key = listQueryKey(config.prefix, model, collectionVersion, params);
        const ttl = ((context as Record<string, unknown>).cacheTtl as number) ?? config.queryTtl;

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
        
        await Promise.all([
          invalidateById(id),
          bumpVersion(),
        ]);
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
        
        await Promise.all([
          invalidateById(id),
          bumpVersion(),
        ]);
      });

      /**
       * after:deleteMany - Bump version
       */
      repo.on('after:deleteMany', async () => {
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
      };
    },
  };
}

export default cachePlugin;

