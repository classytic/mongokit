/**
 * Cache plugin tests (unified `@classytic/repo-core/cache` plugin).
 *
 * Mongokit 3.13+ delegates cache wiring to the unified plugin. These
 * tests exercise hit/miss, mutation invalidation (via version bump),
 * and manual invalidation through the `repo.cache` handle the plugin
 * attaches.
 */

import type { CacheAdapter } from '@classytic/repo-core/cache';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cachePlugin, createMemoryCache, Repository } from '../src/index.js';
import { clearDB, connectDB, createTestModel, disconnectDB } from './setup.js';

// Test user schema
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  status: { type: String, default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

interface User {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  status: string;
  createdAt: Date;
}

describe('Cache Plugin (unified)', () => {
  let UserModel: mongoose.Model<User>;
  let cache: CacheAdapter;
  let userRepo: Repository<User>;
  let getCalls: number;
  let setCalls: number;
  let delCalls: number;
  let hits: number;
  let misses: number;
  let writes: number;
  let invalidations: number;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel<User>('CacheUser', userSchema);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await clearDB();

    // Instrument the adapter so we can observe raw KV traffic.
    getCalls = 0;
    setCalls = 0;
    delCalls = 0;
    hits = 0;
    misses = 0;
    writes = 0;
    invalidations = 0;

    const innerCache = createMemoryCache();
    cache = {
      async get(key) {
        getCalls++;
        return innerCache.get(key);
      },
      async set(key, value, ttl) {
        setCalls++;
        return innerCache.set(key, value, ttl as number);
      },
      async delete(key) {
        delCalls++;
        return innerCache.delete(key);
      },
      async clear(pattern?: string) {
        return innerCache.clear?.(pattern);
      },
    };

    userRepo = new Repository(UserModel, [
      cachePlugin({
        adapter: cache,
        // Plugin-level defaults — applied to every read call where the
        // caller didn't override. `staleTime: 60` keeps results fresh for
        // 60s, `gcTime: 60` retains them another 60s after stale.
        defaults: { staleTime: 60, gcTime: 60 },
        log: {
          onHit: () => {
            hits++;
          },
          onMiss: () => {
            misses++;
          },
          onWrite: () => {
            writes++;
          },
          onInvalidate: () => {
            invalidations++;
          },
        },
      }),
    ]);
  });

  describe('Cache Hit/Miss', () => {
    it('should cache getById result on first call', async () => {
      const user = await userRepo.create({ name: 'John', email: 'john@test.com' });
      const id = user._id.toString();

      // First call - cache miss, queries DB and caches result.
      hits = 0;
      misses = 0;
      writes = 0;
      const result1 = await userRepo.getById(id);
      expect(result1?.name).toBe('John');
      expect(misses).toBe(1);
      expect(writes).toBe(1);

      // Second call - cache hit.
      hits = 0;
      misses = 0;
      writes = 0;
      const result2 = await userRepo.getById(id);
      expect(result2?.name).toBe('John');
      expect(hits).toBe(1);
      expect(misses).toBe(0);
      // SWR off + fresh hit → no fresh write.
      expect(writes).toBe(0);
    });

    it('should skip cache when per-call enabled is false', async () => {
      const user = await userRepo.create({ name: 'Jane', email: 'jane@test.com' });
      const id = user._id.toString();

      // First call - populate cache.
      await userRepo.getById(id);

      // Disabled call - cache plugin short-circuits, no read/write.
      hits = 0;
      misses = 0;
      writes = 0;
      const result = await userRepo.getById(id, { cache: { enabled: false } });
      expect(result?.name).toBe('Jane');
      expect(hits).toBe(0);
      expect(misses).toBe(0);
      expect(writes).toBe(0);
    });

    it('should cache getAll results', async () => {
      await userRepo.create({ name: 'User1', email: 'u1@test.com' });
      await userRepo.create({ name: 'User2', email: 'u2@test.com' });

      // First call - cache miss + write.
      hits = 0;
      misses = 0;
      writes = 0;
      const result1 = await userRepo.getAll({ filters: { status: 'active' } });
      expect(result1.data.length).toBe(2);
      expect(misses).toBe(1);
      expect(writes).toBe(1);

      // Second call - cache hit.
      hits = 0;
      misses = 0;
      writes = 0;
      const result2 = await userRepo.getAll({ filters: { status: 'active' } });
      expect(result2.data.length).toBe(2);
      expect(hits).toBe(1);
      expect(writes).toBe(0);
    });
  });

  describe('Cache Invalidation on Mutations', () => {
    it('should invalidate cache on update', async () => {
      const user = await userRepo.create({ name: 'Original', email: 'test@test.com' });
      const id = user._id.toString();

      // Populate cache.
      const cached = await userRepo.getById(id);
      expect(cached?.name).toBe('Original');

      invalidations = 0;
      await userRepo.update(id, { name: 'Updated' });
      expect(invalidations).toBeGreaterThan(0);

      // Next getById should fetch fresh data (cache version bumped).
      const fresh = await userRepo.getById(id);
      expect(fresh?.name).toBe('Updated');
    });

    it('should invalidate cache on delete', async () => {
      const user = await userRepo.create({ name: 'ToDelete', email: 'delete@test.com' });
      const id = user._id.toString();

      // Populate cache.
      await userRepo.getById(id);

      invalidations = 0;
      await userRepo.delete(id);
      expect(invalidations).toBeGreaterThan(0);
    });

    it('should invalidate list cache on create (version bump)', async () => {
      await userRepo.getAll({ filters: { status: 'active' } });

      // Create new user — this bumps the model version, orphaning every
      // cached read for the model.
      await userRepo.create({ name: 'NewUser', email: 'new@test.com' });

      // Next getAll fetches fresh data including the new user.
      const result = await userRepo.getAll({ filters: { status: 'active' } });
      expect(result.data.some((u) => u.name === 'NewUser')).toBe(true);
    });
  });

  describe('Manual Invalidation via repo.cache handle', () => {
    it('should expose `repo.cache.bumpModelVersion`', async () => {
      const user = await userRepo.create({ name: 'Manual', email: 'manual@test.com' });
      const id = user._id.toString();

      // Populate cache.
      await userRepo.getById(id);

      // Manual invalidation — bump the model version, every cached read
      // becomes unreachable on the next request.
      const handle = (
        userRepo as unknown as {
          cache?: import('@classytic/repo-core/cache').RepositoryCacheHandle;
        }
      ).cache;
      expect(handle).toBeDefined();
      const newVersion = await handle?.bumpModelVersion('CacheUser');
      expect(typeof newVersion).toBe('number');

      // Next read is a miss (cached entry is now under the old version key).
      hits = 0;
      misses = 0;
      await userRepo.getById(id);
      expect(misses).toBe(1);
    });

    it('should expose `repo.cache.invalidateByTags`', async () => {
      // Tag a getAll call so we can wipe it later.
      await userRepo.create({ name: 'Tagged', email: 'tagged@test.com' });
      await userRepo.getAll({ filters: { status: 'active' } }, {
        cache: { tags: ['user-list'] },
      } as never);

      const handle = (
        userRepo as unknown as {
          cache?: import('@classytic/repo-core/cache').RepositoryCacheHandle;
        }
      ).cache;
      const cleared = await handle?.invalidateByTags(['user-list']);
      // Returns the count of entries removed (>=0).
      expect(typeof cleared).toBe('number');
    });
  });

  describe('Cache Key Uniqueness', () => {
    it('should generate different keys for different queries', async () => {
      await userRepo.create({ name: 'User1', email: 'u1@test.com', status: 'active' });
      await userRepo.create({ name: 'User2', email: 'u2@test.com', status: 'inactive' });

      writes = 0;
      await userRepo.getAll({ filters: { status: 'active' } });
      await userRepo.getAll({ filters: { status: 'inactive' } });

      // Each query writes its own envelope.
      expect(writes).toBe(2);
    });

    it('should generate different keys for different pagination params', async () => {
      await userRepo.create({ name: 'User1', email: 'u1@test.com' });
      await userRepo.create({ name: 'User2', email: 'u2@test.com' });

      writes = 0;
      await userRepo.getAll({ mode: 'offset', page: 1, limit: 1 });
      await userRepo.getAll({ mode: 'offset', page: 2, limit: 1 });

      expect(writes).toBe(2);
    });
  });
});

describe('Memory Cache Adapter', () => {
  it('should expire entries after TTL', async () => {
    const cache = createMemoryCache();

    await cache.set('test', 'value', 0.1); // 100ms TTL

    // Should exist immediately.
    expect(await cache.get('test')).toBe('value');

    // Wait for expiration.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should be expired.
    expect(await cache.get('test')).toBeNull();
  });

  it('should clear entries by pattern', async () => {
    const cache = createMemoryCache();

    await cache.set('mk:id:User:1', 'user1', 60);
    await cache.set('mk:id:User:2', 'user2', 60);
    await cache.set('mk:id:Post:1', 'post1', 60);

    // Clear User entries only.
    await cache.clear?.('mk:id:User:*');

    expect(await cache.get('mk:id:User:1')).toBeNull();
    expect(await cache.get('mk:id:User:2')).toBeNull();
    expect(await cache.get('mk:id:Post:1')).toBe('post1');
  });
});
