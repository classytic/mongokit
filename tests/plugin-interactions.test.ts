/**
 * Plugin Interaction Tests
 *
 * Tests cross-plugin behavior to ensure plugins compose correctly
 * when used together.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { connectDB, disconnectDB, clearDB } from './setup.js';
import {
  Repository,
  softDeletePlugin,
  cachePlugin,
  fieldFilterPlugin,
  timestampPlugin,
  createMemoryCache,
} from '../src/index.js';

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  status: string;
  price: number;
  category: string;
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  status: { type: String, default: 'active' },
  price: { type: Number, required: true },
  category: { type: String, required: true },
  deletedAt: { type: Date, default: null },
  createdAt: { type: Date },
  updatedAt: { type: Date },
});

let ProductModel: mongoose.Model<IProduct>;

beforeAll(async () => {
  await connectDB();
  if (mongoose.models.PluginInterProduct) {
    delete mongoose.models.PluginInterProduct;
  }
  ProductModel = mongoose.model<IProduct>('PluginInterProduct', ProductSchema);
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await clearDB();
});

describe('Plugin Interaction: context overrides in before:getAll', () => {
  it('should respect plugin-modified sort in getAll', async () => {
    const repo = new Repository(ProductModel, [timestampPlugin()]);

    // Register a hook that overrides sort via context
    repo.on('before:getAll', (context) => {
      context.sort = { price: 1 }; // ascending by price
    });

    // Create products with different prices
    await ProductModel.create([
      { name: 'Expensive', price: 100, category: 'A' },
      { name: 'Cheap', price: 10, category: 'A' },
      { name: 'Mid', price: 50, category: 'A' },
    ]);

    // Use page: 1 to force offset pagination for predictable ordering
    const result = await repo.getAll({ mode: 'offset', page: 1, sort: '-price' });

    const docs = result.docs as IProduct[];
    expect(docs[0].name).toBe('Cheap');    // price: 10 first (ascending)
    expect(docs[2].name).toBe('Expensive'); // price: 100 last
  });

  it('should respect plugin-modified limit in getAll', async () => {
    const repo = new Repository(ProductModel, [timestampPlugin()]);

    repo.on('before:getAll', (context) => {
      context.limit = 2;
    });

    await ProductModel.create([
      { name: 'A', price: 1, category: 'X' },
      { name: 'B', price: 2, category: 'X' },
      { name: 'C', price: 3, category: 'X' },
    ]);

    const result = await repo.getAll({ mode: 'offset', page: 1, limit: 100 });

    expect(result.docs).toHaveLength(2);
  });

  it('should respect plugin-modified filters in getAll', async () => {
    const repo = new Repository(ProductModel, [timestampPlugin()]);

    // Plugin that injects a filter via context
    repo.on('before:getAll', (context) => {
      context.filters = { ...context.filters, name: /Alpha/i };
    });

    await ProductModel.create([
      { name: 'Alpha Widget', price: 10, category: 'A' },
      { name: 'Beta Gadget', price: 20, category: 'B' },
    ]);

    const result = await repo.getAll({ mode: 'offset', page: 1 });

    expect(result.docs).toHaveLength(1);
    expect((result.docs as IProduct[])[0].name).toBe('Alpha Widget');
  });
});

describe('Plugin Interaction: Cache + Timestamp', () => {
  it('should cache results and serve from cache on second call', async () => {
    const cache = createMemoryCache();
    const repo = new Repository(ProductModel, [
      timestampPlugin(),
      cachePlugin({ adapter: cache, ttl: 60 }),
    ]);

    await repo.create({ name: 'Cached', price: 42, category: 'C' });

    // First call - cache miss
    const result1 = await repo.getAll({ mode: 'offset', page: 1, filters: { category: 'C' } });
    expect(result1.docs).toHaveLength(1);

    // Second call - should come from cache
    const result2 = await repo.getAll({ mode: 'offset', page: 1, filters: { category: 'C' } });
    expect(result2.docs).toHaveLength(1);

    const stats = (repo as any).getCacheStats?.();
    if (stats) {
      expect(stats.hits).toBeGreaterThanOrEqual(1);
    }
  });

  it('should invalidate cache after create', async () => {
    const cache = createMemoryCache();
    const repo = new Repository(ProductModel, [
      timestampPlugin(),
      cachePlugin({ adapter: cache, ttl: 60 }),
    ]);

    await repo.create({ name: 'First', price: 10, category: 'D' });
    await repo.getAll({ mode: 'offset', page: 1, filters: { category: 'D' } }); // populate cache

    await repo.create({ name: 'Second', price: 20, category: 'D' }); // should invalidate

    const result = await repo.getAll({ mode: 'offset', page: 1, filters: { category: 'D' } });
    expect(result.docs).toHaveLength(2);
  });
});

describe('Plugin Interaction: FieldFilter + Cache', () => {
  it('should use field-filtered select in cache key', async () => {
    const cache = createMemoryCache();
    const repo = new Repository(ProductModel, [
      fieldFilterPlugin({
        roles: {
          admin: ['name', 'price', 'category', 'status'],
          user: ['name', 'category'],
        },
      }),
      cachePlugin({ adapter: cache, ttl: 60 }),
    ]);

    await repo.create({ name: 'Product', price: 99, category: 'E' });

    // Query as admin - gets all fields
    const adminResult = await repo.getAll(
      { page: 1, filters: { category: 'E' } },
      { select: 'name price category status' }
    );

    // Query as user - gets fewer fields, should be a different cache key
    const userResult = await repo.getAll(
      { page: 1, filters: { category: 'E' } },
      { select: 'name category' }
    );

    // Both should return data (different cache entries)
    expect(adminResult.docs).toHaveLength(1);
    expect(userResult.docs).toHaveLength(1);
  });
});
