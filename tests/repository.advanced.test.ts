/**
 * Repository Advanced Integration Tests
 *
 * Covers gaps in Repository method coverage:
 * - distinct()
 * - Session passthrough on read methods
 * - Populate + pagination combo (getAll with populate/populateOptions)
 * - lookupPopulate() integration with real MongoDB
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  category: string;
  price: number;
  status: 'active' | 'discontinued';
  tags: string[];
  createdAt: Date;
}

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number, required: true },
  status: { type: String, enum: ['active', 'discontinued'], default: 'active' },
  tags: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

interface ICategory {
  _id: Types.ObjectId;
  slug: string;
  label: string;
}

const CategorySchema = new Schema<ICategory>({
  slug: { type: String, required: true, unique: true },
  label: { type: String, required: true },
});

interface IOrder {
  _id: Types.ObjectId;
  product: Types.ObjectId;
  quantity: number;
  createdAt: Date;
}

const OrderSchema = new Schema<IOrder>({
  product: { type: Schema.Types.ObjectId, ref: 'AdvProduct', required: true },
  quantity: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Repository - Advanced', () => {
  let ProductModel: mongoose.Model<IProduct>;
  let CategoryModel: mongoose.Model<ICategory>;
  let OrderModel: mongoose.Model<IOrder>;
  let productRepo: Repository<IProduct>;
  let orderRepo: Repository<IOrder>;

  beforeAll(async () => {
    await connectDB();
    ProductModel = await createTestModel('AdvProduct', ProductSchema);
    CategoryModel = await createTestModel('AdvCategory', CategorySchema);
    OrderModel = await createTestModel('AdvOrder', OrderSchema);
    productRepo = new Repository(ProductModel);
    orderRepo = new Repository(OrderModel);
  });

  afterAll(async () => {
    await ProductModel.deleteMany({});
    await CategoryModel.deleteMany({});
    await OrderModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
    await CategoryModel.deleteMany({});
    await OrderModel.deleteMany({});
  });

  // =========================================================================
  // distinct()
  // =========================================================================

  describe('distinct()', () => {
    beforeEach(async () => {
      await productRepo.createMany([
        { name: 'Widget A', category: 'tools', price: 10, status: 'active', tags: ['sale'] },
        { name: 'Widget B', category: 'tools', price: 20, status: 'active', tags: ['new'] },
        { name: 'Gadget C', category: 'electronics', price: 50, status: 'discontinued', tags: ['sale'] },
        { name: 'Gadget D', category: 'electronics', price: 75, status: 'active', tags: ['new', 'sale'] },
      ]);
    });

    it('should return distinct values for a field', async () => {
      const categories = await productRepo.distinct<string>('category');

      expect(categories).toHaveLength(2);
      expect(categories.sort()).toEqual(['electronics', 'tools']);
    });

    it('should return distinct values with a query filter', async () => {
      const categories = await productRepo.distinct<string>('category', { status: 'active' });

      expect(categories).toHaveLength(2);
      expect(categories.sort()).toEqual(['electronics', 'tools']);

      const discontinuedCategories = await productRepo.distinct<string>(
        'category',
        { status: 'discontinued' },
      );
      expect(discontinuedCategories).toEqual(['electronics']);
    });

    it('should return empty array on empty collection', async () => {
      await ProductModel.deleteMany({});

      const values = await productRepo.distinct<string>('category');
      expect(values).toEqual([]);
    });

    it('should accept a session option', async () => {
      const session = await mongoose.startSession();
      try {
        const categories = await productRepo.distinct<string>('category', {}, { session });
        // Just verify it executes without error and returns correct data
        expect(categories.sort()).toEqual(['electronics', 'tools']);
      } finally {
        await session.endSession();
      }
    });
  });

  // =========================================================================
  // Session passthrough on reads
  // =========================================================================

  describe('Session passthrough on reads', () => {
    let session: mongoose.ClientSession;

    beforeEach(async () => {
      await productRepo.createMany([
        { name: 'Alpha', category: 'x', price: 1, status: 'active', tags: [] },
        { name: 'Beta', category: 'y', price: 2, status: 'discontinued', tags: [] },
      ]);
      session = await mongoose.startSession();
    });

    afterAll(async () => {
      // session may already be ended; ignore errors
    });

    it('getById should accept session', async () => {
      const created = await ProductModel.findOne({ name: 'Alpha' }).lean();
      const doc = await productRepo.getById(created!._id.toString(), { session });

      expect(doc).toBeDefined();
      expect(doc!.name).toBe('Alpha');
      await session.endSession();
    });

    it('getByQuery should accept session', async () => {
      const doc = await productRepo.getByQuery({ name: 'Alpha' }, { session });

      expect(doc).toBeDefined();
      expect(doc!.name).toBe('Alpha');
      await session.endSession();
    });

    it('getAll should accept session', async () => {
      const result = await productRepo.getAll(
        { filters: { category: 'x' } },
        { session },
      );

      expect(result.docs).toHaveLength(1);
      expect(result.docs[0].name).toBe('Alpha');
      await session.endSession();
    });

    it('count should accept session', async () => {
      const total = await productRepo.count({}, { session });
      expect(total).toBe(2);
      await session.endSession();
    });

    it('exists should accept session', async () => {
      const found = await productRepo.exists({ name: 'Alpha' }, { session });
      expect(found).toBeDefined();
      expect(found!._id).toBeDefined();

      const missing = await productRepo.exists({ name: 'Nonexistent' }, { session });
      expect(missing).toBeNull();
      await session.endSession();
    });
  });

  // =========================================================================
  // Populate + pagination combo (getAll)
  // =========================================================================

  describe('Populate + pagination combo', () => {
    let productA: IProduct;
    let productB: IProduct;

    beforeEach(async () => {
      productA = await ProductModel.create({ name: 'Prod A', category: 'cat1', price: 10, status: 'active' });
      productB = await ProductModel.create({ name: 'Prod B', category: 'cat2', price: 20, status: 'active' });

      await OrderModel.create([
        { product: productA._id, quantity: 1 },
        { product: productB._id, quantity: 3 },
        { product: productA._id, quantity: 5 },
      ]);
    });

    it('getAll should populate with simple populate string', async () => {
      const result = await orderRepo.getAll(
        {},
        { populate: 'product' },
      );

      expect(result.docs).toHaveLength(3);
      // Populated product should be an object with name
      const first = result.docs[0];
      const populated = first.product as unknown as IProduct;
      expect(populated).toBeDefined();
      expect(typeof populated.name).toBe('string');
    });

    it('getAll should populate with advanced populateOptions', async () => {
      const result = await orderRepo.getAll(
        {},
        {
          populateOptions: [
            { path: 'product', select: 'name price' },
          ],
        },
      );

      expect(result.docs).toHaveLength(3);
      const populated = result.docs[0].product as unknown as Record<string, unknown>;
      expect(populated.name).toBeDefined();
      expect(populated.price).toBeDefined();
      // category should not be present because it was not selected
      expect(populated.category).toBeUndefined();
    });
  });

  // =========================================================================
  // lookupPopulate()
  // =========================================================================

  describe('lookupPopulate()', () => {
    beforeEach(async () => {
      // Categories (joined by slug, not ObjectId)
      await CategoryModel.create([
        { slug: 'tools', label: 'Tools & Hardware' },
        { slug: 'electronics', label: 'Electronics' },
      ]);

      await productRepo.createMany([
        { name: 'Hammer', category: 'tools', price: 15, status: 'active', tags: [] },
        { name: 'Drill', category: 'tools', price: 80, status: 'active', tags: [] },
        { name: 'Phone', category: 'electronics', price: 500, status: 'active', tags: [] },
        { name: 'Tablet', category: 'electronics', price: 300, status: 'discontinued', tags: [] },
      ]);
    });

    it('should perform a basic lookup populate', async () => {
      const result = await productRepo.lookupPopulate({
        lookups: [
          {
            from: 'advcategories',  // mongoose collection name (lowercase + plural)
            localField: 'category',
            foreignField: 'slug',
            as: 'categoryInfo',
            single: true,
          },
        ],
      });

      expect(result.docs).toHaveLength(4);
      // Each product should have the joined category
      const hammer = result.docs.find((p: any) => p.name === 'Hammer') as any;
      expect(hammer.categoryInfo).toBeDefined();
      expect(hammer.categoryInfo.label).toBe('Tools & Hardware');
    });

    it('should support filters with lookup populate', async () => {
      const result = await productRepo.lookupPopulate({
        filters: { status: 'active' },
        lookups: [
          {
            from: 'advcategories',
            localField: 'category',
            foreignField: 'slug',
            as: 'categoryInfo',
            single: true,
          },
        ],
      });

      expect(result.docs).toHaveLength(3);
      // Discontinued tablet should not appear
      const names = result.docs.map((p: any) => p.name);
      expect(names).not.toContain('Tablet');
    });

    it('should return pagination metadata', async () => {
      const result = await productRepo.lookupPopulate({
        lookups: [
          {
            from: 'advcategories',
            localField: 'category',
            foreignField: 'slug',
            as: 'categoryInfo',
            single: true,
          },
        ],
        page: 1,
        limit: 2,
      });

      expect(result.docs).toHaveLength(2);
      expect(result.total).toBe(4);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });

    it('should support multiple lookups', async () => {
      // Create a second reference collection for a second lookup
      // We'll reuse CategoryModel but lookup the same collection twice
      // with different field mappings for a realistic scenario

      const result = await productRepo.lookupPopulate({
        filters: { status: 'active' },
        lookups: [
          {
            from: 'advcategories',
            localField: 'category',
            foreignField: 'slug',
            as: 'categoryInfo',
            single: true,
          },
          {
            // Second lookup: same collection, different alias
            // This simulates a "related categories" or secondary join
            from: 'advcategories',
            localField: 'category',
            foreignField: 'slug',
            as: 'categoryDuplicate',
            single: true,
          },
        ],
      });

      expect(result.docs).toHaveLength(3);
      const phone = result.docs.find((p: any) => p.name === 'Phone') as any;
      expect(phone.categoryInfo).toBeDefined();
      expect(phone.categoryInfo.label).toBe('Electronics');
      expect(phone.categoryDuplicate).toBeDefined();
      expect(phone.categoryDuplicate.label).toBe('Electronics');
    });

    it('should return empty data for no matches', async () => {
      const result = await productRepo.lookupPopulate({
        filters: { status: 'nonexistent' as any },
        lookups: [
          {
            from: 'advcategories',
            localField: 'category',
            foreignField: 'slug',
            as: 'categoryInfo',
            single: true,
          },
        ],
      });

      expect(result.docs).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should support sort option', async () => {
      const result = await productRepo.lookupPopulate({
        lookups: [
          {
            from: 'advcategories',
            localField: 'category',
            foreignField: 'slug',
            as: 'categoryInfo',
            single: true,
          },
        ],
        sort: 'price',
        limit: 4,
      });

      const prices = result.docs.map((p: any) => p.price);
      // Ascending order
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
      }
    });
  });
});
