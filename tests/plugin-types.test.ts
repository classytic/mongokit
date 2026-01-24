/**
 * Plugin Type Safety Tests
 *
 * Tests that plugin method types work correctly when users opt-in to type safety
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  softDeletePlugin,
  cachePlugin,
  createMemoryCache,
} from '../src/index.js';
import type {
  MongoOperationsMethods,
  SoftDeleteMethods,
  CacheMethods,
  WithPlugins,
  AllPluginMethods,
} from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

describe('Plugin Type Safety', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  describe('MongoOperationsMethods - Type Safety', () => {
    interface IProduct {
      _id: Types.ObjectId;
      name: string;
      sku: string;
      price: number;
      stock: number;
      views: number;
      tags: string[];
      featured?: boolean;
      createdAt?: Date;
      updatedAt?: Date;
    }

    const ProductSchema = new Schema<IProduct>({
      name: { type: String, required: true },
      sku: { type: String, required: true, unique: true },
      price: { type: Number, required: true },
      stock: { type: Number, default: 0 },
      views: { type: Number, default: 0 },
      tags: [String],
      featured: Boolean,
      createdAt: Date,
      updatedAt: Date,
    });

    let ProductModel: mongoose.Model<IProduct>;

    // Repository without type safety (flexible, base usage)
    class FlexibleProductRepo extends Repository<IProduct> {
      // Can add any custom methods - fully flexible
      async findBySku(sku: string) {
        return this.getByQuery({ sku });
      }
    }

    // Repository WITH type safety for plugin methods (opt-in)
    // Use type assertion to get autocomplete for plugin methods
    class TypedProductRepo extends Repository<IProduct> {
      // Can still add custom methods
      async findBySku(sku: string) {
        return this.getByQuery({ sku });
      }
    }

    // Type helper to add plugin method types
    type ProductRepoWithPlugins = TypedProductRepo & MongoOperationsMethods<IProduct>;

    let flexibleRepo: FlexibleProductRepo;
    let typedRepo: ProductRepoWithPlugins;

    beforeAll(async () => {
      ProductModel = await createTestModel('ProductTypeTest', ProductSchema);

      // Create flexible repo
      flexibleRepo = new FlexibleProductRepo(ProductModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
      ]);

      // Create typed repo with type assertion to get plugin methods
      typedRepo = new TypedProductRepo(ProductModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
      ]) as ProductRepoWithPlugins;
    });

    beforeEach(async () => {
      await ProductModel.deleteMany({});
    });

    afterAll(async () => {
      await ProductModel.deleteMany({});
    });

    it('should work with flexible repository (no type annotations)', async () => {
      // Base repository is flexible - can add anything
      const product = await flexibleRepo.create({
        name: 'Test Product',
        sku: 'TEST-001',
        price: 99.99,
      });

      // Plugin methods work at runtime even without type annotations
      const incremented = await (flexibleRepo as any).increment(product._id.toString(), 'views', 5);
      expect(incremented.views).toBe(5);

      const pushed = await (flexibleRepo as any).pushToArray(product._id.toString(), 'tags', 'new');
      expect(pushed.tags).toContain('new');
    });

    it('should provide type safety with typed repository', async () => {
      // With type annotations, TypeScript provides autocomplete and type checking
      const product = await typedRepo.create({
        name: 'Test Product',
        sku: 'TEST-002',
        price: 99.99,
      });

      // TypeScript knows about these methods
      const incremented = await typedRepo.increment(product._id.toString(), 'views', 10);
      expect(incremented.views).toBe(10);

      const decremented = await typedRepo.decrement(product._id.toString(), 'views', 3);
      expect(decremented.views).toBe(7);
    });

    it('should support upsert with type safety', async () => {
      const query = { sku: 'TEST-UPSERT' };
      const data = {
        name: 'Upserted Product',
        price: 49.99,
        stock: 100,
      };

      // First upsert creates
      const created = await typedRepo.upsert(query, data);
      expect(created).toBeDefined();
      expect(created!.name).toBe('Upserted Product');
      expect(created!.price).toBe(49.99);

      // Second upsert finds existing (upsert uses $setOnInsert, so only sets on first insert)
      const found = await typedRepo.upsert(query, { ...data, price: 59.99 });
      expect(found).toBeDefined();
      expect(found!._id.toString()).toBe(created!._id.toString());
      // Price stays same because $setOnInsert only applies on insert
      expect(found!.price).toBe(49.99);
    });

    it('should support array operations with type safety', async () => {
      const product = await typedRepo.create({
        name: 'Test Product',
        sku: 'TEST-003',
        price: 99.99,
        tags: ['electronics', 'gadget'],
      });

      // Push to array
      const pushed = await typedRepo.pushToArray(product._id.toString(), 'tags', 'featured');
      expect(pushed.tags).toHaveLength(3);
      expect(pushed.tags).toContain('featured');

      // Add to set (won't add duplicate)
      const addedToSet1 = await typedRepo.addToSet(product._id.toString(), 'tags', 'featured');
      expect(addedToSet1.tags).toHaveLength(3); // Still 3, no duplicate

      // Add to set (new value)
      const addedToSet2 = await typedRepo.addToSet(product._id.toString(), 'tags', 'new-tag');
      expect(addedToSet2.tags).toHaveLength(4);

      // Pull from array
      const pulled = await typedRepo.pullFromArray(product._id.toString(), 'tags', 'gadget');
      expect(pulled.tags).toHaveLength(3);
      expect(pulled.tags).not.toContain('gadget');
    });

    it('should support field operations with type safety', async () => {
      const product = await typedRepo.create({
        name: 'Test Product',
        sku: 'TEST-004',
        price: 99.99,
        featured: false,
      });

      // Set field
      const setResult = await typedRepo.setField(product._id.toString(), 'featured', true);
      expect(setResult.featured).toBe(true);

      // Unset field
      const unsetResult = await typedRepo.unsetField(product._id.toString(), 'featured');
      expect(unsetResult.featured).toBeUndefined();

      // Rename field would typically be used for schema migrations
      // We'll test it works but not verify the rename since featured is back
      const product2 = await typedRepo.create({
        name: 'Test Product 2',
        sku: 'TEST-005',
        price: 99.99,
      });
      const renamed = await typedRepo.renameField(product2._id.toString(), 'name', 'productName');
      expect(renamed).toBeDefined();
    });

    it('should support numeric operations with type safety', async () => {
      const product = await typedRepo.create({
        name: 'Test Product',
        sku: 'TEST-006',
        price: 100,
        stock: 50,
      });

      // Increment
      const incremented = await typedRepo.increment(product._id.toString(), 'stock', 10);
      expect(incremented.stock).toBe(60);

      // Decrement
      const decremented = await typedRepo.decrement(product._id.toString(), 'stock', 5);
      expect(decremented.stock).toBe(55);

      // Multiply
      const multiplied = await typedRepo.multiplyField(product._id.toString(), 'price', 2);
      expect(multiplied.price).toBe(200);

      // Set min (only updates if current value is greater)
      const minResult = await typedRepo.setMin(product._id.toString(), 'stock', 30);
      expect(minResult.stock).toBe(30); // Updated because 55 > 30

      const minResult2 = await typedRepo.setMin(product._id.toString(), 'stock', 100);
      expect(minResult2.stock).toBe(30); // Not updated because 30 < 100

      // Set max (only updates if current value is less)
      const maxResult = await typedRepo.setMax(product._id.toString(), 'stock', 50);
      expect(maxResult.stock).toBe(50); // Updated because 30 < 50

      const maxResult2 = await typedRepo.setMax(product._id.toString(), 'stock', 10);
      expect(maxResult2.stock).toBe(50); // Not updated because 50 > 10
    });

    it('should support custom methods alongside plugin methods', async () => {
      const product = await typedRepo.create({
        name: 'Test Product',
        sku: 'CUSTOM-001',
        price: 99.99,
      });

      // Custom method works
      const found = await typedRepo.findBySku('CUSTOM-001');
      expect(found?._id.toString()).toBe(product._id.toString());

      // Plugin method works
      const incremented = await typedRepo.increment(product._id.toString(), 'views', 1);
      expect(incremented.views).toBe(1);
    });

    it('should allow multiple field unset', async () => {
      const product = await typedRepo.create({
        name: 'Test Product',
        sku: 'TEST-007',
        price: 99.99,
        featured: true,
      });

      // Unset multiple fields
      const result = await typedRepo.unsetField(product._id.toString(), ['featured']);
      expect(result.featured).toBeUndefined();
    });
  });

  describe('Type Safety Documentation Examples', () => {
    interface IDocument {
      _id: Types.ObjectId;
      name: string;
      count: number;
    }

    const DocSchema = new Schema<IDocument>({
      name: String,
      count: { type: Number, default: 0 },
    });

    let DocModel: mongoose.Model<IDocument>;

    beforeAll(async () => {
      DocModel = await createTestModel('DocTypeTest', DocSchema);
    });

    beforeEach(async () => {
      await DocModel.deleteMany({});
    });

    afterAll(async () => {
      await DocModel.deleteMany({});
    });

    it('should demonstrate the pattern from the issue', async () => {
      // Pattern 1: Flexible - can add anything
      class FlexibleRepo extends Repository<IDocument> {
        // Flexible - can add custom methods
      }

      // Pattern 2: With type safety for plugin methods (recommended when using plugins)
      class TypedRepo extends Repository<IDocument> {}

      // Type helper for autocomplete
      type TypedRepoWithPlugins = TypedRepo & MongoOperationsMethods<IDocument>;

      const flexibleRepo = new FlexibleRepo(DocModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
      ]);

      const typedRepo = new TypedRepo(DocModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
      ]) as TypedRepoWithPlugins;

      // Both work at runtime
      const doc1 = await flexibleRepo.create({ name: 'Flexible' });
      await (flexibleRepo as any).increment(doc1._id.toString(), 'count', 1);

      const doc2 = await typedRepo.create({ name: 'Typed' });
      await typedRepo.increment(doc2._id.toString(), 'count', 1); // TypeScript autocomplete works!

      // Verify both worked
      const result1 = await flexibleRepo.getById(doc1._id.toString());
      const result2 = await typedRepo.getById(doc2._id.toString());

      expect(result1?.count).toBe(1);
      expect(result2?.count).toBe(1);
    });
  });

  describe('SoftDeleteMethods - Type Safety', () => {
    interface IUser {
      _id: Types.ObjectId;
      name: string;
      email: string;
      deletedAt?: Date | null;
      deletedBy?: string | null;
    }

    const UserSchema = new Schema<IUser>({
      name: { type: String, required: true },
      email: { type: String, required: true },
      deletedAt: { type: Date, default: null },
      deletedBy: { type: String, default: null },
    });

    let UserModel: mongoose.Model<IUser>;

    class UserRepo extends Repository<IUser> {
      async findByEmail(email: string) {
        return this.getByQuery({ email });
      }
    }

    type UserRepoWithSoftDelete = UserRepo & SoftDeleteMethods<IUser>;

    let typedRepo: UserRepoWithSoftDelete;

    beforeAll(async () => {
      UserModel = await createTestModel('UserSoftDeleteTypeTest', UserSchema);

      typedRepo = new UserRepo(UserModel, [
        methodRegistryPlugin(),
        softDeletePlugin({ deletedField: 'deletedAt' }),
      ]) as UserRepoWithSoftDelete;
    });

    beforeEach(async () => {
      await UserModel.deleteMany({});
    });

    afterAll(async () => {
      await UserModel.deleteMany({});
    });

    it('should provide type safety for restore method', async () => {
      const user = await typedRepo.create({
        name: 'John Doe',
        email: 'john@example.com',
      });

      // Soft delete
      await typedRepo.delete(user._id.toString());

      // Restore with type safety
      const restored = await typedRepo.restore(user._id.toString());
      expect(restored._id.toString()).toBe(user._id.toString());
      expect(restored.deletedAt).toBeNull();
    });

    it('should provide type safety for getDeleted method', async () => {
      // Create and delete users
      const user1 = await typedRepo.create({
        name: 'User 1',
        email: 'user1@example.com',
      });
      const user2 = await typedRepo.create({
        name: 'User 2',
        email: 'user2@example.com',
      });

      await typedRepo.delete(user1._id.toString());
      await typedRepo.delete(user2._id.toString());

      // Get deleted with type safety
      const deleted = await typedRepo.getDeleted({ page: 1, limit: 10 });
      expect(deleted.docs).toHaveLength(2);
      expect(deleted.total).toBe(2);
      expect(deleted.method).toBe('offset');
    });

    it('should support custom methods alongside soft delete methods', async () => {
      const user = await typedRepo.create({
        name: 'Test User',
        email: 'test@example.com',
      });

      // Custom method works
      const found = await typedRepo.findByEmail('test@example.com');
      expect(found?._id.toString()).toBe(user._id.toString());

      // Soft delete method works
      await typedRepo.delete(user._id.toString());
      const restored = await typedRepo.restore(user._id.toString());
      expect(restored._id.toString()).toBe(user._id.toString());
    });
  });

  describe('CacheMethods - Type Safety', () => {
    interface IPost {
      _id: Types.ObjectId;
      title: string;
      content: string;
      views: number;
    }

    const PostSchema = new Schema<IPost>({
      title: { type: String, required: true },
      content: { type: String, required: true },
      views: { type: Number, default: 0 },
    });

    let PostModel: mongoose.Model<IPost>;

    class PostRepo extends Repository<IPost> {
      async findByTitle(title: string) {
        return this.getByQuery({ title });
      }
    }

    type PostRepoWithCache = PostRepo & CacheMethods;

    let typedRepo: PostRepoWithCache;
    const cacheAdapter = createMemoryCache();

    beforeAll(async () => {
      PostModel = await createTestModel('PostCacheTypeTest', PostSchema);

      typedRepo = new PostRepo(PostModel, [
        methodRegistryPlugin(),
        cachePlugin({ adapter: cacheAdapter, ttl: 60 }),
      ]) as PostRepoWithCache;
    });

    beforeEach(async () => {
      await PostModel.deleteMany({});
      typedRepo.resetCacheStats();
    });

    afterAll(async () => {
      await PostModel.deleteMany({});
    });

    it('should provide type safety for cache invalidation methods', async () => {
      const post = await typedRepo.create({
        title: 'Test Post',
        content: 'Content',
        views: 0,
      });

      // Cache the post
      await typedRepo.getById(post._id.toString());

      // Invalidate cache with type safety
      await typedRepo.invalidateCache(post._id.toString());

      // Should work without errors
      expect(true).toBe(true);
    });

    it('should provide type safety for invalidateListCache method', async () => {
      await typedRepo.create({
        title: 'Post 1',
        content: 'Content 1',
        views: 0,
      });

      // Cache list
      await typedRepo.getAll({ page: 1, limit: 10 });

      // Invalidate list cache with type safety
      await typedRepo.invalidateListCache();

      // Should work without errors
      expect(true).toBe(true);
    });

    it('should provide type safety for invalidateAllCache method', async () => {
      const post = await typedRepo.create({
        title: 'Test Post',
        content: 'Content',
        views: 0,
      });

      await typedRepo.getById(post._id.toString());

      // Invalidate all cache with type safety
      await typedRepo.invalidateAllCache();

      // Should work without errors
      expect(true).toBe(true);
    });

    it('should provide type safety for getCacheStats method', async () => {
      // Get cache stats with type safety
      const stats = typedRepo.getCacheStats();

      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('sets');
      expect(stats).toHaveProperty('invalidations');
      expect(typeof stats.hits).toBe('number');
    });

    it('should provide type safety for resetCacheStats method', async () => {
      const post = await typedRepo.create({
        title: 'Test Post',
        content: 'Content',
        views: 0,
      });

      // Generate some cache stats
      await typedRepo.getById(post._id.toString());

      const beforeReset = typedRepo.getCacheStats();
      expect(beforeReset.sets).toBeGreaterThan(0);

      // Reset stats with type safety
      typedRepo.resetCacheStats();

      const afterReset = typedRepo.getCacheStats();
      expect(afterReset.hits).toBe(0);
      expect(afterReset.misses).toBe(0);
      expect(afterReset.sets).toBe(0);
      expect(afterReset.invalidations).toBe(0);
    });

    it('should support custom methods alongside cache methods', async () => {
      const post = await typedRepo.create({
        title: 'Cache Test',
        content: 'Content',
        views: 0,
      });

      // Custom method works
      const found = await typedRepo.findByTitle('Cache Test');
      expect(found?._id.toString()).toBe(post._id.toString());

      // Cache method works
      const stats = typedRepo.getCacheStats();
      expect(stats).toBeDefined();
    });
  });

  describe('Helper Types - WithPlugins and AllPluginMethods', () => {
    interface IExample {
      _id: Types.ObjectId;
      name: string;
      count: number;
      deletedAt?: Date | null;
    }

    const ExampleSchema = new Schema<IExample>({
      name: { type: String, required: true },
      count: { type: Number, default: 0 },
      deletedAt: { type: Date, default: null },
    });

    let ExampleModel: mongoose.Model<IExample>;

    class ExampleRepo extends Repository<IExample> {
      async findByName(name: string) {
        return this.getByQuery({ name });
      }
    }

    beforeAll(async () => {
      ExampleModel = await createTestModel('ExampleHelperTypeTest', ExampleSchema);
    });

    beforeEach(async () => {
      await ExampleModel.deleteMany({});
    });

    afterAll(async () => {
      await ExampleModel.deleteMany({});
    });

    it('should work with WithPlugins helper type', async () => {
      const cacheAdapter = createMemoryCache();

      // ✨ Clean syntax - no need to manually list all plugin types
      const repo = new ExampleRepo(ExampleModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
        softDeletePlugin(),
        cachePlugin({ adapter: cacheAdapter, ttl: 60 }),
      ]) as WithPlugins<IExample, ExampleRepo>;

      const doc = await repo.create({ name: 'Test', count: 0 });

      // Custom method works
      const found = await repo.findByName('Test');
      expect(found?._id.toString()).toBe(doc._id.toString());

      // All plugin methods work with type safety
      await repo.increment(doc._id.toString(), 'count', 5);
      await repo.delete(doc._id.toString());
      await repo.restore(doc._id.toString());
      await repo.invalidateCache(doc._id.toString());

      const restored = await repo.getById(doc._id.toString());
      expect(restored?.count).toBe(5);
    });

    it('should work with AllPluginMethods when extending Repository', async () => {
      const cacheAdapter = createMemoryCache();

      // Alternative: Use AllPluginMethods directly
      const repo = new ExampleRepo(ExampleModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
        softDeletePlugin(),
        cachePlugin({ adapter: cacheAdapter, ttl: 60 }),
      ]) as ExampleRepo & AllPluginMethods<IExample>;

      const doc = await repo.create({ name: 'Alternative', count: 10 });

      // Custom method + plugin methods
      const found = await repo.findByName('Alternative');
      expect(found?.count).toBe(10);

      await repo.increment(doc._id.toString(), 'count', 2);
      const updated = await repo.getById(doc._id.toString());
      expect(updated?.count).toBe(12);
    });

    it('should demonstrate cleaner syntax compared to manual type definition', async () => {
      const cacheAdapter = createMemoryCache();

      // Old way (still works, but verbose)
      type ManualType = ExampleRepo &
        MongoOperationsMethods<IExample> &
        SoftDeleteMethods<IExample> &
        CacheMethods;

      const manualRepo = new ExampleRepo(ExampleModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
        softDeletePlugin(),
        cachePlugin({ adapter: cacheAdapter, ttl: 60 }),
      ]) as ManualType;

      // New way (much cleaner)
      const cleanRepo = new ExampleRepo(ExampleModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
        softDeletePlugin(),
        cachePlugin({ adapter: cacheAdapter, ttl: 60 }),
      ]) as WithPlugins<IExample, ExampleRepo>;

      // Both work identically at runtime
      const doc1 = await manualRepo.create({ name: 'Manual' });
      const doc2 = await cleanRepo.create({ name: 'Clean' });

      await manualRepo.increment(doc1._id.toString(), 'count', 1);
      await cleanRepo.increment(doc2._id.toString(), 'count', 1);

      const result1 = await manualRepo.getById(doc1._id.toString());
      const result2 = await cleanRepo.getById(doc2._id.toString());

      expect(result1?.count).toBe(1);
      expect(result2?.count).toBe(1);
    });
  });
});
