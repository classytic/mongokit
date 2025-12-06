/**
 * Cache Plugin Tests
 * 
 * Tests for cache hit/miss, invalidation on mutations, and manual invalidation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Repository, cachePlugin, createMemoryCache, CacheAdapter } from '../src/index.js';
import { connectDB, disconnectDB, clearDB, createTestModel } from './setup.js';

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

describe('Cache Plugin', () => {
  let UserModel: mongoose.Model<User>;
  let cache: CacheAdapter;
  let userRepo: Repository<User>;
  let getCalls: number;
  let setCalls: number;
  let delCalls: number;

  beforeAll(async () => {
    await connectDB();
    UserModel = createTestModel<User>('CacheUser', userSchema);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await clearDB();
    
    // Create instrumented cache for testing
    getCalls = 0;
    setCalls = 0;
    delCalls = 0;
    
    const innerCache = createMemoryCache();
    cache = {
      async get<T>(key: string): Promise<T | null> {
        getCalls++;
        return innerCache.get(key);
      },
      async set<T>(key: string, value: T, ttl: number): Promise<void> {
        setCalls++;
        return innerCache.set(key, value, ttl);
      },
      async del(key: string): Promise<void> {
        delCalls++;
        return innerCache.del(key);
      },
      async clear(pattern?: string): Promise<void> {
        return innerCache.clear?.(pattern);
      },
    };

    userRepo = new Repository(UserModel, [
      cachePlugin({
        adapter: cache,
        ttl: 60,
        debug: false, // Set to true for debugging
      }),
    ]);
  });

  describe('Cache Hit/Miss', () => {
    it('should cache getById result on first call', async () => {
      const user = await userRepo.create({ name: 'John', email: 'john@test.com' });
      const id = user._id.toString();

      // Reset counters after create (create also touches the cache for version)
      getCalls = 0;
      setCalls = 0;

      // First call - cache miss, should query DB and cache result
      const result1 = await userRepo.getById(id);
      expect(result1?.name).toBe('John');
      expect(getCalls).toBe(1); // Check cache
      expect(setCalls).toBe(1); // Set cache

      // Second call - cache hit
      const result2 = await userRepo.getById(id);
      expect(result2?.name).toBe('John');
      expect(getCalls).toBe(2); // Check cache again
      expect(setCalls).toBe(1); // No new set (cache hit)
    });

    it('should skip cache when skipCache option is true', async () => {
      const user = await userRepo.create({ name: 'Jane', email: 'jane@test.com' });
      const id = user._id.toString();

      // Reset counters after create
      getCalls = 0;
      setCalls = 0;

      // First call - populate cache
      await userRepo.getById(id);
      expect(setCalls).toBe(1);

      // Skip cache - should bypass
      const result = await userRepo.getById(id, { skipCache: true });
      expect(result?.name).toBe('Jane');
      // When skipping, we still try to get (to maintain hook consistency), but we ignore the result
    });

    it('should cache getAll results', async () => {
      await userRepo.create({ name: 'User1', email: 'u1@test.com' });
      await userRepo.create({ name: 'User2', email: 'u2@test.com' });

      // Reset counters after creates
      getCalls = 0;
      setCalls = 0;

      // First call - cache miss
      const result1 = await userRepo.getAll({ filters: { status: 'active' } });
      expect(result1.docs.length).toBe(2);
      expect(getCalls).toBe(1);
      expect(setCalls).toBe(1);

      // Second call - cache hit
      const result2 = await userRepo.getAll({ filters: { status: 'active' } });
      expect(result2.docs.length).toBe(2);
      expect(getCalls).toBe(2);
      expect(setCalls).toBe(1); // No new set
    });
  });

  describe('Cache Invalidation on Mutations', () => {
    it('should invalidate cache on update', async () => {
      const user = await userRepo.create({ name: 'Original', email: 'test@test.com' });
      const id = user._id.toString();

      // Populate cache
      const cached = await userRepo.getById(id);
      expect(cached?.name).toBe('Original');
      
      // Reset counters
      delCalls = 0;

      // Update should invalidate
      await userRepo.update(id, { name: 'Updated' });
      expect(delCalls).toBeGreaterThan(0);

      // Next getById should get fresh data
      const fresh = await userRepo.getById(id);
      expect(fresh?.name).toBe('Updated');
    });

    it('should invalidate cache on delete', async () => {
      const user = await userRepo.create({ name: 'ToDelete', email: 'delete@test.com' });
      const id = user._id.toString();

      // Populate cache
      await userRepo.getById(id);
      
      // Reset counters
      delCalls = 0;

      // Delete should invalidate
      await userRepo.delete(id);
      expect(delCalls).toBeGreaterThan(0);
    });

    it('should invalidate list cache on create', async () => {
      // First, populate list cache
      await userRepo.getAll({ filters: { status: 'active' } });
      
      // Store version before create
      const stats1 = (userRepo as any).getCacheStats();
      
      // Create new user
      await userRepo.create({ name: 'NewUser', email: 'new@test.com' });

      // List cache should be invalidated (via version bump)
      // Next getAll should get fresh data including new user
      const result = await userRepo.getAll({ filters: { status: 'active' } });
      expect(result.docs.some((u: any) => u.name === 'NewUser')).toBe(true);
    });
  });

  describe('Manual Invalidation', () => {
    it('should manually invalidate single document', async () => {
      const user = await userRepo.create({ name: 'Manual', email: 'manual@test.com' });
      const id = user._id.toString();

      // Populate cache
      await userRepo.getById(id);
      
      // Reset counters
      delCalls = 0;

      // Manual invalidation
      await (userRepo as any).invalidateCache(id);
      expect(delCalls).toBe(1);
    });

    it('should manually invalidate all list caches', async () => {
      // Populate list cache
      await userRepo.getAll({ filters: { status: 'active' } });

      // Manual list invalidation
      await (userRepo as any).invalidateListCache();

      // Stats should show invalidation
      const stats = (userRepo as any).getCacheStats();
      expect(stats.invalidations).toBeGreaterThan(0);
    });

    it('should track cache statistics', async () => {
      const user = await userRepo.create({ name: 'Stats', email: 'stats@test.com' });
      const id = user._id.toString();

      // Reset stats
      (userRepo as any).resetCacheStats();

      // Cache miss
      await userRepo.getById(id);
      
      // Cache hit
      await userRepo.getById(id);

      const stats = (userRepo as any).getCacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.sets).toBe(1);
    });
  });

  describe('Cache Key Uniqueness', () => {
    it('should generate different keys for different queries', async () => {
      await userRepo.create({ name: 'User1', email: 'u1@test.com', status: 'active' });
      await userRepo.create({ name: 'User2', email: 'u2@test.com', status: 'inactive' });

      // Reset counters
      setCalls = 0;

      // Two different queries should create two cache entries
      await userRepo.getAll({ filters: { status: 'active' } });
      await userRepo.getAll({ filters: { status: 'inactive' } });

      expect(setCalls).toBe(2);
    });

    it('should generate different keys for different pagination params', async () => {
      await userRepo.create({ name: 'User1', email: 'u1@test.com' });
      await userRepo.create({ name: 'User2', email: 'u2@test.com' });

      // Reset counters
      setCalls = 0;

      // Different pages should create different cache entries
      await userRepo.getAll({ page: 1, limit: 1 });
      await userRepo.getAll({ page: 2, limit: 1 });

      expect(setCalls).toBe(2);
    });
  });
});

describe('Memory Cache Adapter', () => {
  it('should expire entries after TTL', async () => {
    const cache = createMemoryCache();
    
    await cache.set('test', 'value', 0.1); // 100ms TTL
    
    // Should exist immediately
    expect(await cache.get('test')).toBe('value');
    
    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Should be expired
    expect(await cache.get('test')).toBeNull();
  });

  it('should clear entries by pattern', async () => {
    const cache = createMemoryCache();
    
    await cache.set('mk:id:User:1', 'user1', 60);
    await cache.set('mk:id:User:2', 'user2', 60);
    await cache.set('mk:id:Post:1', 'post1', 60);
    
    // Clear User entries only
    await cache.clear?.('mk:id:User:*');
    
    expect(await cache.get('mk:id:User:1')).toBeNull();
    expect(await cache.get('mk:id:User:2')).toBeNull();
    expect(await cache.get('mk:id:Post:1')).toBe('post1');
  });
});

