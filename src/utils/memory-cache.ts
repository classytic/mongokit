/**
 * In-Memory Cache Adapter
 *
 * Simple cache adapter for development and testing.
 * NOT recommended for production - use Redis or similar.
 *
 * @example
 * ```typescript
 * import { cachePlugin, createMemoryCache } from '@classytic/mongokit';
 *
 * const repo = new Repository(UserModel, [
 *   cachePlugin({
 *     adapter: createMemoryCache(),
 *     ttl: 60,
 *   })
 * ]);
 * ```
 */

import type { CacheAdapter } from '../types.js';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Creates an in-memory cache adapter
 *
 * Features:
 * - Automatic TTL expiration
 * - Pattern-based clearing (simple glob with *)
 * - Max entries limit to prevent memory leaks
 *
 * @param maxEntries - Maximum cache entries before oldest are evicted (default: 1000)
 */
export function createMemoryCache(maxEntries: number = 1000): CacheAdapter {
  const cache = new Map<string, CacheEntry>();
  let lastCleanup = Date.now();
  // Run full cleanup at most every 60s, triggered lazily on set
  const CLEANUP_INTERVAL_MS = 60_000;

  function cleanupIfNeeded(): void {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = now;
    for (const [key, entry] of cache) {
      if (entry.expiresAt < now) cache.delete(key);
    }
  }

  function evictOldest(): void {
    while (cache.size >= maxEntries) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
      else break;
    }
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const entry = cache.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
      }
      // Move to end for LRU behavior (re-insert refreshes position)
      cache.delete(key);
      cache.set(key, entry);
      return entry.value as T;
    },

    async set<T>(key: string, value: T, ttl: number): Promise<void> {
      // Delete first so re-insert goes to end (LRU)
      cache.delete(key);
      if (cache.size >= maxEntries) {
        cleanupIfNeeded();
        evictOldest();
      }
      cache.set(key, {
        value,
        expiresAt: Date.now() + ttl * 1000,
      });
    },

    async del(key: string): Promise<void> {
      cache.delete(key);
    },

    async clear(pattern?: string): Promise<void> {
      if (!pattern) {
        cache.clear();
        return;
      }

      // Simple glob pattern matching (supports * and ? wildcards)
      // Escape regex-special chars first, then convert glob wildcards
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(`^${escaped}$`);

      for (const key of cache.keys()) {
        if (regex.test(key)) {
          cache.delete(key);
        }
      }
    },
  };
}

export default createMemoryCache;
