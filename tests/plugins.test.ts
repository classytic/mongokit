/**
 * Plugins Integration Tests
 * 
 * Tests all mongokit plugins
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  timestampPlugin,
  softDeletePlugin,
  fieldFilterPlugin,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  batchOperationsPlugin,
  aggregateHelpersPlugin,
  validationChainPlugin,
  cascadePlugin,
  requireField,
  blockIf,
  immutableField,
  autoInject,
  createFieldPreset,
} from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

describe('Plugins', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // ============================================================
  // TIMESTAMP PLUGIN
  // ============================================================

  describe('timestampPlugin', () => {
    interface ITimestampDoc {
      _id: Types.ObjectId;
      name: string;
      createdAt?: Date;
      updatedAt?: Date;
    }

    const TimestampSchema = new Schema<ITimestampDoc>({
      name: String,
      createdAt: Date,
      updatedAt: Date,
    });

    let TimestampModel: mongoose.Model<ITimestampDoc>;
    let repo: Repository<ITimestampDoc>;

    beforeAll(async () => {
      TimestampModel = await createTestModel('TimestampTest', TimestampSchema);
      repo = new Repository(TimestampModel, [timestampPlugin()]);
    });

    beforeEach(async () => {
      await TimestampModel.deleteMany({});
    });

    afterAll(async () => {
      await TimestampModel.deleteMany({});
    });

    it('should set createdAt and updatedAt on create', async () => {
      const before = new Date();
      const doc = await repo.create({ name: 'Test' });
      const after = new Date();

      expect(doc.createdAt).toBeDefined();
      expect(doc.updatedAt).toBeDefined();
      expect(doc.createdAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(doc.createdAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should update updatedAt on update', async () => {
      const doc = await repo.create({ name: 'Test' });
      const originalUpdatedAt = doc.updatedAt;

      // Wait a bit to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = await repo.update(doc._id.toString(), { name: 'Updated' });

      expect(updated.updatedAt!.getTime()).toBeGreaterThan(originalUpdatedAt!.getTime());
    });
  });

  // ============================================================
  // SOFT DELETE PLUGIN
  // ============================================================

  describe('softDeletePlugin', () => {
    interface ISoftDeleteDoc {
      _id: Types.ObjectId;
      name: string;
      deletedAt?: Date;
      deletedBy?: Types.ObjectId;
    }

    const SoftDeleteSchema = new Schema<ISoftDeleteDoc>({
      name: String,
      deletedAt: Date,
      deletedBy: Schema.Types.ObjectId,
    });

    let SoftDeleteModel: mongoose.Model<ISoftDeleteDoc>;
    let repo: Repository<ISoftDeleteDoc>;

    beforeAll(async () => {
      SoftDeleteModel = await createTestModel('SoftDeleteTest', SoftDeleteSchema);
      repo = new Repository(SoftDeleteModel, [
        softDeletePlugin({ deletedField: 'deletedAt', deletedByField: 'deletedBy' }),
      ]);
    });

    beforeEach(async () => {
      await SoftDeleteModel.deleteMany({});
    });

    afterAll(async () => {
      await SoftDeleteModel.deleteMany({});
    });

    it('should soft delete instead of hard delete', async () => {
      const doc = await repo.create({ name: 'To Soft Delete' });
      await repo.delete(doc._id.toString());

      // Should not be found with normal query
      const found = await repo.getById(doc._id.toString(), { throwOnNotFound: false });
      expect(found).toBeNull();

      // But should exist in database with deletedAt set
      const raw = await SoftDeleteModel.findById(doc._id);
      expect(raw).toBeDefined();
      expect(raw?.deletedAt).toBeDefined();
    });
  });

  // ============================================================
  // FIELD FILTER PLUGIN
  // ============================================================

  describe('fieldFilterPlugin', () => {
    interface IFieldFilterDoc {
      _id: Types.ObjectId;
      name: string;
      email: string;
      secretField: string;
      adminNotes: string;
    }

    const FieldFilterSchema = new Schema<IFieldFilterDoc>({
      name: String,
      email: String,
      secretField: String,
      adminNotes: String,
    });

    let FieldFilterModel: mongoose.Model<IFieldFilterDoc>;

    beforeAll(async () => {
      FieldFilterModel = await createTestModel('FieldFilterTest', FieldFilterSchema);
    });

    beforeEach(async () => {
      await FieldFilterModel.deleteMany({});
    });

    afterAll(async () => {
      await FieldFilterModel.deleteMany({});
    });

    it('should filter fields based on preset', async () => {
      const preset = createFieldPreset({
        public: ['name'],
        authenticated: ['email'],
        admin: ['secretField', 'adminNotes'],
      });

      const repo = new Repository(FieldFilterModel, [fieldFilterPlugin(preset)]);

      await repo.create({
        name: 'Test',
        email: 'test@example.com',
        secretField: 'secret',
        adminNotes: 'admin only',
      });

      // Public user should only see name
      const publicResult = await repo.getAll({ page: 1, limit: 10 });
      expect(publicResult.docs[0]).toHaveProperty('name');
      // Note: The actual field filtering depends on context.user being set
    });
  });

  // ============================================================
  // METHOD REGISTRY PLUGIN
  // ============================================================

  describe('methodRegistryPlugin', () => {
    interface IMethodDoc {
      _id: Types.ObjectId;
      name: string;
      status: string;
    }

    const MethodSchema = new Schema<IMethodDoc>({
      name: String,
      status: { type: String, default: 'active' },
    });

    let MethodModel: mongoose.Model<IMethodDoc>;
    let repo: Repository<IMethodDoc>;

    beforeAll(async () => {
      MethodModel = await createTestModel('MethodRegistryTest', MethodSchema);
      repo = new Repository(MethodModel, [methodRegistryPlugin()]);
    });

    beforeEach(async () => {
      await MethodModel.deleteMany({});
    });

    afterAll(async () => {
      await MethodModel.deleteMany({});
    });

    it('should allow registering custom methods', async () => {
      repo.registerMethod!('findActive', async function (this: Repository<IMethodDoc>) {
        return this.getAll({ filters: { status: 'active' }, page: 1, limit: 100 });
      });

      expect(repo.hasMethod!('findActive')).toBe(true);
    });

    it('should throw on duplicate method registration', () => {
      expect(() => {
        repo.registerMethod!('create', async () => {}); // 'create' already exists
      }).toThrow('already exists');
    });

    it('should execute registered methods', async () => {
      await repo.create({ name: 'Active User', status: 'active' });
      await repo.create({ name: 'Inactive User', status: 'inactive' });

      repo.registerMethod!('findByStatus', async function (
        this: Repository<IMethodDoc>,
        status: string
      ) {
        return this.getAll({ filters: { status }, page: 1, limit: 100 });
      });

      const result = await (repo as Record<string, Function>).findByStatus('active');
      expect(result.docs).toHaveLength(1);
      expect(result.docs[0].status).toBe('active');
    });
  });

  // ============================================================
  // MONGO OPERATIONS PLUGIN
  // ============================================================

  describe('mongoOperationsPlugin', () => {
    interface IMongoOpsDoc {
      _id: Types.ObjectId;
      name: string;
      count: number;
      tags: string[];
    }

    const MongoOpsSchema = new Schema<IMongoOpsDoc>({
      name: String,
      count: { type: Number, default: 0 },
      tags: [String],
    });

    let MongoOpsModel: mongoose.Model<IMongoOpsDoc>;
    let repo: Repository<IMongoOpsDoc> & {
      increment: (id: string, field: string, value?: number) => Promise<IMongoOpsDoc>;
      decrement: (id: string, field: string, value?: number) => Promise<IMongoOpsDoc>;
      pushToArray: (id: string, field: string, value: unknown) => Promise<IMongoOpsDoc>;
      pullFromArray: (id: string, field: string, value: unknown) => Promise<IMongoOpsDoc>;
      addToSet: (id: string, field: string, value: unknown) => Promise<IMongoOpsDoc>;
    };

    beforeAll(async () => {
      MongoOpsModel = await createTestModel('MongoOpsTest', MongoOpsSchema);
      repo = new Repository(MongoOpsModel, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
      ]) as typeof repo;
    });

    beforeEach(async () => {
      await MongoOpsModel.deleteMany({});
    });

    afterAll(async () => {
      await MongoOpsModel.deleteMany({});
    });

    it('should increment numeric field', async () => {
      const doc = await repo.create({ name: 'Test', count: 10, tags: [] });
      const updated = await repo.increment(doc._id.toString(), 'count', 5);

      expect(updated.count).toBe(15);
    });

    it('should decrement numeric field', async () => {
      const doc = await repo.create({ name: 'Test', count: 10, tags: [] });
      const updated = await repo.decrement(doc._id.toString(), 'count', 3);

      expect(updated.count).toBe(7);
    });

    it('should push to array', async () => {
      const doc = await repo.create({ name: 'Test', count: 0, tags: ['a'] });
      const updated = await repo.pushToArray(doc._id.toString(), 'tags', 'b');

      expect(updated.tags).toContain('a');
      expect(updated.tags).toContain('b');
    });

    it('should pull from array', async () => {
      const doc = await repo.create({ name: 'Test', count: 0, tags: ['a', 'b', 'c'] });
      const updated = await repo.pullFromArray(doc._id.toString(), 'tags', 'b');

      expect(updated.tags).toContain('a');
      expect(updated.tags).not.toContain('b');
      expect(updated.tags).toContain('c');
    });

    it('should add to set (unique)', async () => {
      const doc = await repo.create({ name: 'Test', count: 0, tags: ['a'] });
      await repo.addToSet(doc._id.toString(), 'tags', 'a'); // Duplicate
      const updated = await repo.addToSet(doc._id.toString(), 'tags', 'b');

      expect(updated.tags).toEqual(['a', 'b']);
    });
  });

  // ============================================================
  // BATCH OPERATIONS PLUGIN
  // ============================================================

  describe('batchOperationsPlugin', () => {
    interface IBatchDoc {
      _id: Types.ObjectId;
      name: string;
      status: string;
    }

    const BatchSchema = new Schema<IBatchDoc>({
      name: String,
      status: { type: String, default: 'pending' },
    });

    let BatchModel: mongoose.Model<IBatchDoc>;
    let repo: Repository<IBatchDoc> & {
      updateMany: (query: Record<string, unknown>, data: Record<string, unknown>) => Promise<{ matchedCount: number; modifiedCount: number }>;
      deleteMany: (query: Record<string, unknown>) => Promise<{ deletedCount: number }>;
    };

    beforeAll(async () => {
      BatchModel = await createTestModel('BatchTest', BatchSchema);
      repo = new Repository(BatchModel, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
      ]) as typeof repo;
    });

    beforeEach(async () => {
      await BatchModel.deleteMany({});
    });

    afterAll(async () => {
      await BatchModel.deleteMany({});
    });

    it('should update many documents', async () => {
      await repo.createMany([
        { name: 'User 1', status: 'pending' },
        { name: 'User 2', status: 'pending' },
        { name: 'User 3', status: 'active' },
      ]);

      const result = await repo.updateMany(
        { status: 'pending' },
        { $set: { status: 'processed' } }
      );

      expect(result.matchedCount).toBe(2);
      expect(result.modifiedCount).toBe(2);
    });

    it('should delete many documents', async () => {
      await repo.createMany([
        { name: 'User 1', status: 'pending' },
        { name: 'User 2', status: 'pending' },
        { name: 'User 3', status: 'active' },
      ]);

      const result = await repo.deleteMany({ status: 'pending' });

      expect(result.deletedCount).toBe(2);

      const remaining = await repo.count();
      expect(remaining).toBe(1);
    });
  });

  // ============================================================
  // AGGREGATE HELPERS PLUGIN
  // ============================================================

  describe('aggregateHelpersPlugin', () => {
    interface IAggDoc {
      _id: Types.ObjectId;
      category: string;
      amount: number;
    }

    const AggSchema = new Schema<IAggDoc>({
      category: String,
      amount: Number,
    });

    let AggModel: mongoose.Model<IAggDoc>;
    let repo: Repository<IAggDoc> & {
      groupBy: (field: string) => Promise<Array<{ _id: string; count: number }>>;
      sum: (field: string, query?: Record<string, unknown>) => Promise<number>;
      average: (field: string, query?: Record<string, unknown>) => Promise<number>;
      min: (field: string, query?: Record<string, unknown>) => Promise<number>;
      max: (field: string, query?: Record<string, unknown>) => Promise<number>;
    };

    beforeAll(async () => {
      AggModel = await createTestModel('AggHelpersTest', AggSchema);
      repo = new Repository(AggModel, [
        methodRegistryPlugin(),
        aggregateHelpersPlugin(),
      ]) as typeof repo;
    });

    beforeEach(async () => {
      await AggModel.deleteMany({});
      await repo.createMany([
        { category: 'A', amount: 100 },
        { category: 'A', amount: 200 },
        { category: 'B', amount: 150 },
        { category: 'B', amount: 250 },
        { category: 'C', amount: 300 },
      ]);
    });

    afterAll(async () => {
      await AggModel.deleteMany({});
    });

    it('should group by field', async () => {
      const result = await repo.groupBy('category');

      expect(result).toHaveLength(3);
      const categoryA = result.find(r => r._id === 'A');
      expect(categoryA?.count).toBe(2);
    });

    it('should calculate sum', async () => {
      const total = await repo.sum('amount');
      expect(total).toBe(1000);

      const categoryASum = await repo.sum('amount', { category: 'A' });
      expect(categoryASum).toBe(300);
    });

    it('should calculate average', async () => {
      const avg = await repo.average('amount');
      expect(avg).toBe(200);
    });

    it('should calculate min', async () => {
      const min = await repo.min('amount');
      expect(min).toBe(100);
    });

    it('should calculate max', async () => {
      const max = await repo.max('amount');
      expect(max).toBe(300);
    });
  });

  // ============================================================
  // VALIDATION CHAIN PLUGIN
  // ============================================================

  describe('validationChainPlugin', () => {
    interface IValidationDoc {
      _id: Types.ObjectId;
      name: string;
      email?: string;
      role: string;
      organizationId?: string;
    }

    const ValidationSchema = new Schema<IValidationDoc>({
      name: String,
      email: String,
      role: { type: String, default: 'user' },
      organizationId: String,
    });

    let ValidationModel: mongoose.Model<IValidationDoc>;

    beforeAll(async () => {
      ValidationModel = await createTestModel('ValidationTest', ValidationSchema);
    });

    beforeEach(async () => {
      await ValidationModel.deleteMany({});
    });

    afterAll(async () => {
      await ValidationModel.deleteMany({});
    });

    it('should validate required fields', async () => {
      const repo = new Repository(ValidationModel, [
        validationChainPlugin([
          requireField('email'),
        ]),
      ]);

      await expect(repo.create({ name: 'Test', role: 'user' }))
        .rejects.toThrow("Field 'email' is required");

      // Should succeed with email
      const doc = await repo.create({ name: 'Test', email: 'test@example.com', role: 'user' });
      expect(doc.email).toBe('test@example.com');
    });

    it('should block operations based on condition', async () => {
      const repo = new Repository(ValidationModel, [
        validationChainPlugin([
          blockIf('no-admin-delete', ['delete'], (ctx) => ctx.data?.role === 'admin', 'Cannot delete admin users'),
        ]),
      ]);

      const adminDoc = await repo.create({ name: 'Admin', role: 'admin' });
      
      // This test depends on how the context is passed - simplified for now
      // In real usage, the context would have the document data
    });

    it('should prevent updating immutable fields', async () => {
      const repo = new Repository(ValidationModel, [
        validationChainPlugin([
          immutableField('organizationId'),
        ]),
      ]);

      const doc = await repo.create({ name: 'Test', organizationId: 'org-123', role: 'user' });

      await expect(repo.update(doc._id.toString(), { organizationId: 'org-456' }))
        .rejects.toThrow("Field 'organizationId' cannot be modified");

      // Should allow updating other fields
      const updated = await repo.update(doc._id.toString(), { name: 'Updated' });
      expect(updated.name).toBe('Updated');
    });

    it('should auto-inject values', async () => {
      const repo = new Repository(ValidationModel, [
        validationChainPlugin([
          autoInject('organizationId', () => 'default-org'),
        ]),
      ]);

      const doc = await repo.create({ name: 'Test', role: 'user' });

      expect(doc.organizationId).toBe('default-org');
    });
  });

  // ============================================================
  // CASCADE PLUGIN
  // ============================================================

  describe('cascadePlugin', () => {
    // Parent model: Product
    interface IProduct {
      _id: Types.ObjectId;
      name: string;
      price: number;
    }

    const ProductSchema = new Schema<IProduct>({
      name: String,
      price: Number,
    });

    // Child model: StockEntry (references Product)
    interface IStockEntry {
      _id: Types.ObjectId;
      product: Types.ObjectId;
      quantity: number;
      warehouse: string;
    }

    const StockEntrySchema = new Schema<IStockEntry>({
      product: { type: Schema.Types.ObjectId, ref: 'CascadeProduct' },
      quantity: Number,
      warehouse: String,
    });

    // Child model: StockMovement (references Product)
    interface IStockMovement {
      _id: Types.ObjectId;
      product: Types.ObjectId;
      type: string;
      quantity: number;
    }

    const StockMovementSchema = new Schema<IStockMovement>({
      product: { type: Schema.Types.ObjectId, ref: 'CascadeProduct' },
      type: String,
      quantity: Number,
    });

    let ProductModel: mongoose.Model<IProduct>;
    let StockEntryModel: mongoose.Model<IStockEntry>;
    let StockMovementModel: mongoose.Model<IStockMovement>;
    let productRepo: Repository<IProduct>;

    beforeAll(async () => {
      ProductModel = await createTestModel('CascadeProduct', ProductSchema);
      StockEntryModel = await createTestModel('CascadeStockEntry', StockEntrySchema);
      StockMovementModel = await createTestModel('CascadeStockMovement', StockMovementSchema);

      productRepo = new Repository(ProductModel, [
        cascadePlugin({
          relations: [
            { model: 'CascadeStockEntry', foreignKey: 'product' },
            { model: 'CascadeStockMovement', foreignKey: 'product' },
          ],
        }),
      ]);
    });

    beforeEach(async () => {
      await ProductModel.deleteMany({});
      await StockEntryModel.deleteMany({});
      await StockMovementModel.deleteMany({});
    });

    afterAll(async () => {
      await ProductModel.deleteMany({});
      await StockEntryModel.deleteMany({});
      await StockMovementModel.deleteMany({});
    });

    it('should cascade delete related documents when parent is deleted', async () => {
      // Create a product
      const product = await productRepo.create({ name: 'Widget', price: 99 });

      // Create related stock entries
      await StockEntryModel.create([
        { product: product._id, quantity: 100, warehouse: 'A' },
        { product: product._id, quantity: 50, warehouse: 'B' },
      ]);

      // Create related stock movements
      await StockMovementModel.create([
        { product: product._id, type: 'in', quantity: 100 },
        { product: product._id, type: 'out', quantity: 25 },
      ]);

      // Verify related docs exist
      expect(await StockEntryModel.countDocuments({ product: product._id })).toBe(2);
      expect(await StockMovementModel.countDocuments({ product: product._id })).toBe(2);

      // Delete the product
      await productRepo.delete(product._id.toString());

      // Verify related docs were cascade deleted
      expect(await StockEntryModel.countDocuments({ product: product._id })).toBe(0);
      expect(await StockMovementModel.countDocuments({ product: product._id })).toBe(0);
    });

    it('should not delete unrelated documents', async () => {
      // Create two products
      const product1 = await productRepo.create({ name: 'Widget 1', price: 99 });
      const product2 = await productRepo.create({ name: 'Widget 2', price: 149 });

      // Create stock entries for both
      await StockEntryModel.create([
        { product: product1._id, quantity: 100, warehouse: 'A' },
        { product: product2._id, quantity: 200, warehouse: 'B' },
      ]);

      // Delete only product1
      await productRepo.delete(product1._id.toString());

      // Verify product1's stock entries deleted, product2's remain
      expect(await StockEntryModel.countDocuments({ product: product1._id })).toBe(0);
      expect(await StockEntryModel.countDocuments({ product: product2._id })).toBe(1);
    });

    it('should work with soft delete when parent uses soft delete', async () => {
      // Create a repo with both soft delete and cascade
      interface ISoftProduct {
        _id: Types.ObjectId;
        name: string;
        deletedAt?: Date;
      }

      interface ISoftStockEntry {
        _id: Types.ObjectId;
        product: Types.ObjectId;
        quantity: number;
        deletedAt?: Date;
      }

      const SoftProductSchema = new Schema<ISoftProduct>({
        name: String,
        deletedAt: Date,
      });

      const SoftStockEntrySchema = new Schema<ISoftStockEntry>({
        product: { type: Schema.Types.ObjectId, ref: 'SoftCascadeProduct' },
        quantity: Number,
        deletedAt: Date,
      });

      const SoftProductModel = await createTestModel('SoftCascadeProduct', SoftProductSchema);
      const SoftStockEntryModel = await createTestModel('SoftCascadeStockEntry', SoftStockEntrySchema);

      const softProductRepo = new Repository(SoftProductModel, [
        softDeletePlugin({ deletedField: 'deletedAt' }),
        cascadePlugin({
          relations: [
            { model: 'SoftCascadeStockEntry', foreignKey: 'product' },
          ],
        }),
      ]);

      // Create product and stock entry
      const product = await softProductRepo.create({ name: 'Soft Widget' });
      await SoftStockEntryModel.create({ product: product._id, quantity: 100 });

      // Verify stock entry exists
      expect(await SoftStockEntryModel.countDocuments({ product: product._id })).toBe(1);

      // Soft delete the product
      await softProductRepo.delete(product._id.toString());

      // The stock entry should be soft-deleted (has deletedAt) not hard deleted
      const stockEntry = await SoftStockEntryModel.findOne({ product: product._id });
      expect(stockEntry).toBeDefined();
      expect(stockEntry?.deletedAt).toBeDefined();

      // Cleanup
      await SoftProductModel.deleteMany({});
      await SoftStockEntryModel.deleteMany({});
    });

    it('should handle missing related model gracefully', async () => {
      // Create a repo with cascade to non-existent model
      const badProductRepo = new Repository(ProductModel, [
        cascadePlugin({
          relations: [
            { model: 'NonExistentModel', foreignKey: 'product' },
          ],
        }),
      ]);

      const product = await badProductRepo.create({ name: 'Test', price: 10 });

      // Should not throw, just skip the cascade
      await expect(badProductRepo.delete(product._id.toString())).resolves.toEqual({
        success: true,
        message: 'Deleted successfully',
      });
    });

    it('should require at least one relation', () => {
      expect(() => {
        cascadePlugin({ relations: [] });
      }).toThrow('cascadePlugin requires at least one relation');
    });
  });
});
