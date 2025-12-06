/**
 * Caching with Redis Example
 * 
 * Shows how to add caching to your repository using the cache plugin.
 * Works with Redis, Memcached, or any key-value store.
 */

import { Repository, cachePlugin, createMemoryCache, CacheAdapter } from '@classytic/mongokit';
import mongoose from 'mongoose';
// import Redis from 'ioredis'; // Uncomment for Redis

// --- Schema ---
const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  status: { type: String, default: 'active' },
});

const User = mongoose.model('User', UserSchema);

// --- Cache Adapters ---

// Option 1: In-memory (for development/testing only)
const memoryAdapter = createMemoryCache();

// Option 2: Redis (recommended for production)
// const redis = new Redis();
// const redisAdapter: CacheAdapter = {
//   async get(key) { 
//     const val = await redis.get(key);
//     return val ? JSON.parse(val) : null;
//   },
//   async set(key, value, ttl) { 
//     await redis.setex(key, ttl, JSON.stringify(value));
//   },
//   async del(key) { 
//     await redis.del(key);
//   },
//   async clear(pattern) {
//     const keys = await redis.keys(pattern || '*');
//     if (keys.length) await redis.del(...keys);
//   }
// };

// --- Repository with Cache ---
const userRepo = new Repository(User, [
  cachePlugin({
    adapter: memoryAdapter, // Use redisAdapter for production
    ttl: 60,        // Default: 60 seconds
    byIdTtl: 300,   // Cache getById for 5 minutes
    queryTtl: 30,   // Cache lists for 30 seconds
    debug: false,   // Set true to see cache hits/misses
    skipIf: {
      largeLimit: 100, // Skip caching queries with limit > 100
    },
  })
]);

// --- Usage Examples ---
async function main() {
  await mongoose.connect('mongodb://localhost:27017/cache-demo');

  // Create a user
  const user = await userRepo.create({ 
    name: 'John Doe', 
    email: 'john@example.com' 
  });
  console.log('Created:', user._id);

  // First read - cache MISS, fetches from DB
  const read1 = await userRepo.getById(user._id.toString());
  console.log('First read:', read1?.name);

  // Second read - cache HIT, instant response
  const read2 = await userRepo.getById(user._id.toString());
  console.log('Second read (cached):', read2?.name);

  // Skip cache for fresh data
  const fresh = await userRepo.getById(user._id.toString(), { skipCache: true });
  console.log('Fresh read:', fresh?.name);

  // List queries are also cached
  const list1 = await userRepo.getAll({ filters: { status: 'active' } });
  console.log('List:', list1.docs.length, 'users');

  // Update automatically invalidates cache
  await userRepo.update(user._id.toString(), { name: 'Jane Doe' });
  
  // Next read gets fresh data
  const afterUpdate = await userRepo.getById(user._id.toString());
  console.log('After update:', afterUpdate?.name);

  // --- Manual Invalidation (for microservices) ---
  
  // When another service updates a document
  await (userRepo as any).invalidateCache(user._id.toString());

  // When bulk data changes happen
  await (userRepo as any).invalidateListCache();

  // Nuclear option: clear all cache for this model
  await (userRepo as any).invalidateAllCache();

  // --- Monitoring ---
  const stats = (userRepo as any).getCacheStats();
  console.log('Cache stats:', {
    hits: stats.hits,
    misses: stats.misses,
    hitRate: `${(stats.hits / (stats.hits + stats.misses) * 100).toFixed(1)}%`
  });

  // Cleanup
  await User.deleteMany({});
  await mongoose.disconnect();
}

main().catch(console.error);

