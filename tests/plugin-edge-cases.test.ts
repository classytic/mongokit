/**
 * Plugin Edge Cases & Error Handling Tests
 *
 * Comprehensive tests for edge cases, error conditions, and boundary scenarios
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  batchOperationsPlugin,
  aggregateHelpersPlugin,
  subdocumentPlugin,
  timestampPlugin,
  softDeletePlugin,
  validationChainPlugin,
  requireField,
  immutableField,
} from '../src/index.js';
import type {
  MongoOperationsMethods,
  BatchOperationsMethods,
  AggregateHelpersMethods,
  SubdocumentMethods,
} from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

describe('Plugin Edge Cases & Error Handling', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // ============================================================================
  // mongoOperationsPlugin - Edge Cases
  // ============================================================================

  describe('mongoOperationsPlugin - Edge Cases', () => {
    interface IEdgeCase {
      _id: Types.ObjectId;
      counter: number;
      amount: number;
      items: string[];
      optional?: string;
      optional2?: string;
      nested?: {
        value: number;
      };
    }

    const EdgeCaseSchema = new Schema<IEdgeCase>({
      counter: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
      items: [String],
      optional: String,
      optional2: String,
      nested: {
        value: Number,
      },
    });

    let Model: mongoose.Model<IEdgeCase>;
    type Repo = Repository<IEdgeCase> & MongoOperationsMethods<IEdgeCase>;
    let repo: Repo;

    beforeAll(async () => {
      Model = await createTestModel('MongoOpsEdgeCase', EdgeCaseSchema);
      repo = new Repository(Model, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
      ]) as Repo;
    });

    beforeEach(async () => {
      await Model.deleteMany({});
    });

    afterAll(async () => {
      await Model.deleteMany({});
    });

    it('should handle increment with negative values', async () => {
      const doc = await repo.create({ counter: 10, amount: 0, items: [] });

      // Negative increment should decrement
      const result = await repo.increment(doc._id.toString(), 'counter', -3);
      expect(result.counter).toBe(7);
    });

    it('should handle decrement to negative numbers', async () => {
      const doc = await repo.create({ counter: 5, amount: 0, items: [] });

      const result = await repo.decrement(doc._id.toString(), 'counter', 10);
      expect(result.counter).toBe(-5);
    });

    it('should handle increment/decrement on zero', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: [] });

      const inc = await repo.increment(doc._id.toString(), 'counter', 1);
      expect(inc.counter).toBe(1);

      const dec = await repo.decrement(doc._id.toString(), 'counter', 1);
      expect(dec.counter).toBe(0);
    });

    it('should reject non-numeric increment values', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: [] });

      await expect(
        repo.increment(doc._id.toString(), 'counter', 'invalid' as any)
      ).rejects.toThrow();
    });

    it('should handle pushToArray with duplicate values', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: ['a', 'b'] });

      // Push allows duplicates
      await repo.pushToArray(doc._id.toString(), 'items', 'a');
      const result = await repo.getById(doc._id.toString());

      expect(result!.items).toEqual(['a', 'b', 'a']);
    });

    it('should handle addToSet preventing duplicates', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: ['a', 'b'] });

      // AddToSet prevents duplicates
      await repo.addToSet(doc._id.toString(), 'items', 'a');
      const result = await repo.getById(doc._id.toString());

      expect(result!.items).toEqual(['a', 'b']); // No duplicate 'a'
    });

    it('should handle pullFromArray on non-existent value', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: ['a', 'b'] });

      await repo.pullFromArray(doc._id.toString(), 'items', 'c');
      const result = await repo.getById(doc._id.toString());

      expect(result!.items).toEqual(['a', 'b']); // Unchanged
    });

    it('should handle pushToArray on empty array', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: [] });

      await repo.pushToArray(doc._id.toString(), 'items', 'first');
      const result = await repo.getById(doc._id.toString());

      expect(result!.items).toEqual(['first']);
    });

    it('should handle pullFromArray removing all matching values', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: ['a', 'b', 'a', 'c', 'a'] });

      await repo.pullFromArray(doc._id.toString(), 'items', 'a');
      const result = await repo.getById(doc._id.toString());

      expect(result!.items).toEqual(['b', 'c']); // All 'a' removed
    });

    it('should handle setField on non-existent field', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: [] });

      await repo.setField(doc._id.toString(), 'optional', 'new value');
      const result = await repo.getById(doc._id.toString());

      expect(result!.optional).toBe('new value');
    });

    it('should handle unsetField on already undefined field', async () => {
      const doc = await repo.create({ counter: 0, amount: 0, items: [] });

      // Optional is undefined, unsetting should not error
      await repo.unsetField(doc._id.toString(), 'optional');
      const result = await repo.getById(doc._id.toString());

      expect(result!.optional).toBeUndefined();
    });

    it('should handle unsetField with multiple fields', async () => {
      const doc = await repo.create({
        counter: 0,
        amount: 0,
        items: [],
        optional: 'test1',
        optional2: 'test2',
      });

      // Test unsetting multiple fields (both without defaults to avoid Mongoose default behavior)
      await repo.unsetField(doc._id.toString(), ['optional', 'optional2']);
      const result = await repo.getById(doc._id.toString());

      expect(result!.optional).toBeUndefined();
      expect(result!.optional2).toBeUndefined();
    });

    it('should handle multiplyField by zero', async () => {
      const doc = await repo.create({ counter: 10, amount: 0, items: [] });

      const result = await repo.multiplyField(doc._id.toString(), 'counter', 0);
      expect(result.counter).toBe(0);
    });

    it('should handle multiplyField by negative', async () => {
      const doc = await repo.create({ counter: 5, amount: 0, items: [] });

      const result = await repo.multiplyField(doc._id.toString(), 'counter', -2);
      expect(result.counter).toBe(-10);
    });

    it('should handle setMin with equal value', async () => {
      const doc = await repo.create({ counter: 10, amount: 0, items: [] });

      const result = await repo.setMin(doc._id.toString(), 'counter', 10);
      expect(result.counter).toBe(10); // Unchanged
    });

    it('should handle setMax with equal value', async () => {
      const doc = await repo.create({ counter: 10, amount: 0, items: [] });

      const result = await repo.setMax(doc._id.toString(), 'counter', 10);
      expect(result.counter).toBe(10); // Unchanged
    });

    it('should handle operations on non-existent document ID', async () => {
      const fakeId = new Types.ObjectId().toString();

      await expect(
        repo.increment(fakeId, 'counter', 1)
      ).rejects.toThrow();
    });

    it('should handle upsert creating new document', async () => {
      const result = await repo.upsert(
        { counter: 999 },
        { counter: 999, amount: 100, items: [] }
      );

      expect(result).toBeDefined();
      expect(result!.counter).toBe(999);
      expect(result!.amount).toBe(100);
    });

    it('should handle upsert finding existing document', async () => {
      const doc = await repo.create({ counter: 5, amount: 50, items: [] });

      const result = await repo.upsert(
        { counter: 5 },
        { counter: 5, amount: 100, items: [] }
      );

      expect(result!._id.toString()).toBe(doc._id.toString());
    });
  });

  // ============================================================================
  // batchOperationsPlugin - Edge Cases
  // ============================================================================

  describe('batchOperationsPlugin - Edge Cases', () => {
    interface IBatchEdge {
      _id: Types.ObjectId;
      status: string;
      value: number;
    }

    const BatchEdgeSchema = new Schema<IBatchEdge>({
      status: String,
      value: Number,
    });

    let Model: mongoose.Model<IBatchEdge>;
    type Repo = Repository<IBatchEdge> & BatchOperationsMethods;
    let repo: Repo;

    beforeAll(async () => {
      Model = await createTestModel('BatchEdgeCase', BatchEdgeSchema);
      repo = new Repository(Model, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
      ]) as Repo;
    });

    beforeEach(async () => {
      await Model.deleteMany({});
    });

    afterAll(async () => {
      await Model.deleteMany({});
    });

    it('should handle updateMany with no matching documents', async () => {
      await repo.createMany([
        { status: 'active', value: 1 },
        { status: 'active', value: 2 },
      ]);

      const result = await repo.updateMany(
        { status: 'nonexistent' },
        { value: 999 }
      );

      expect(result.matchedCount).toBe(0);
      expect(result.modifiedCount).toBe(0);
    });

    it('should handle deleteMany with no matching documents', async () => {
      await repo.createMany([
        { status: 'active', value: 1 },
        { status: 'active', value: 2 },
      ]);

      const result = await repo.deleteMany({ status: 'nonexistent' });

      expect(result.deletedCount).toBe(0);
    });

    it('should handle updateMany with empty query (updates all)', async () => {
      await repo.createMany([
        { status: 'active', value: 1 },
        { status: 'pending', value: 2 },
      ]);

      const result = await repo.updateMany({}, { value: 999 });

      expect(result.matchedCount).toBe(2);
      expect(result.modifiedCount).toBe(2);
    });

    it('should handle updateMany with complex query', async () => {
      await repo.createMany([
        { status: 'active', value: 5 },
        { status: 'active', value: 15 },
        { status: 'pending', value: 15 },
      ]);

      const result = await repo.updateMany(
        { status: 'active', value: { $gte: 10 } },
        { status: 'archived' }
      );

      expect(result.modifiedCount).toBe(1);
    });

    it('should handle deleteMany with complex query', async () => {
      await repo.createMany([
        { status: 'active', value: 5 },
        { status: 'active', value: 15 },
        { status: 'pending', value: 15 },
      ]);

      const result = await repo.deleteMany({
        status: 'active',
        value: { $lt: 10 },
      });

      expect(result.deletedCount).toBe(1);
    });

    it('should reject array updates without updatePipeline flag', async () => {
      const doc = await repo.create({ status: 'active', value: 1 });

      await expect(
        repo.updateMany({ _id: doc._id }, [{ $set: { value: 999 } }] as any)
      ).rejects.toThrow(/pipeline/i);
    });
  });

  // ============================================================================
  // aggregateHelpersPlugin - Edge Cases
  // ============================================================================

  describe('aggregateHelpersPlugin - Edge Cases', () => {
    interface IAggEdge {
      _id: Types.ObjectId;
      category: string;
      amount: number;
      quantity: number;
    }

    const AggEdgeSchema = new Schema<IAggEdge>({
      category: String,
      amount: Number,
      quantity: Number,
    });

    let Model: mongoose.Model<IAggEdge>;
    type Repo = Repository<IAggEdge> & AggregateHelpersMethods;
    let repo: Repo;

    beforeAll(async () => {
      Model = await createTestModel('AggEdgeCase', AggEdgeSchema);
      repo = new Repository(Model, [
        methodRegistryPlugin(),
        aggregateHelpersPlugin(),
      ]) as Repo;
    });

    beforeEach(async () => {
      await Model.deleteMany({});
    });

    afterAll(async () => {
      await Model.deleteMany({});
    });

    it('should handle sum on empty collection', async () => {
      const total = await repo.sum('amount');
      expect(total).toBe(0);
    });

    it('should handle average on empty collection', async () => {
      const avg = await repo.average('amount');
      expect(avg).toBe(0);
    });

    it('should handle min on empty collection', async () => {
      const min = await repo.min('amount');
      expect(min).toBe(0);
    });

    it('should handle max on empty collection', async () => {
      const max = await repo.max('amount');
      expect(max).toBe(0);
    });

    it('should handle groupBy on empty collection', async () => {
      const groups = await repo.groupBy('category');
      expect(groups).toEqual([]);
    });

    it('should handle sum with no matching query', async () => {
      await repo.createMany([
        { category: 'A', amount: 100, quantity: 1 },
        { category: 'A', amount: 200, quantity: 2 },
      ]);

      const total = await repo.sum('amount', { category: 'Z' });
      expect(total).toBe(0);
    });

    it('should handle groupBy with limit', async () => {
      await repo.createMany([
        { category: 'A', amount: 100, quantity: 1 },
        { category: 'A', amount: 100, quantity: 1 },
        { category: 'B', amount: 100, quantity: 1 },
        { category: 'C', amount: 100, quantity: 1 },
      ]);

      const groups = await repo.groupBy('category', { limit: 2 });
      expect(groups).toHaveLength(2);
      expect(groups[0]._id).toBe('A'); // Most common
    });

    it('should handle average with single document', async () => {
      await repo.create({ category: 'A', amount: 50, quantity: 1 });

      const avg = await repo.average('amount');
      expect(avg).toBe(50);
    });

    it('should handle negative numbers in aggregations', async () => {
      await repo.createMany([
        { category: 'A', amount: -10, quantity: 1 },
        { category: 'A', amount: 10, quantity: 1 },
        { category: 'A', amount: -5, quantity: 1 },
      ]);

      const sum = await repo.sum('amount');
      expect(sum).toBe(-5);

      const min = await repo.min('amount');
      expect(min).toBe(-10);

      const max = await repo.max('amount');
      expect(max).toBe(10);
    });

    it('should handle decimal numbers in aggregations', async () => {
      await repo.createMany([
        { category: 'A', amount: 10.5, quantity: 1 },
        { category: 'A', amount: 20.7, quantity: 1 },
      ]);

      const sum = await repo.sum('amount');
      expect(sum).toBeCloseTo(31.2, 1);

      const avg = await repo.average('amount');
      expect(avg).toBeCloseTo(15.6, 1);
    });
  });

  // ============================================================================
  // subdocumentPlugin - Edge Cases
  // ============================================================================

  describe('subdocumentPlugin - Edge Cases', () => {
    interface ISubEdge {
      _id: Types.ObjectId;
      items: Array<{
        _id: Types.ObjectId;
        name: string;
        value: number;
      }>;
    }

    const SubEdgeSchema = new Schema<ISubEdge>({
      items: [{
        name: { type: String, required: true },
        value: { type: Number, required: true },
      }],
    });

    let Model: mongoose.Model<ISubEdge>;
    type Repo = Repository<ISubEdge> & SubdocumentMethods<ISubEdge>;
    let repo: Repo;

    beforeAll(async () => {
      Model = await createTestModel('SubEdgeCase', SubEdgeSchema);
      repo = new Repository(Model, [
        methodRegistryPlugin(),
        subdocumentPlugin(),
      ]) as Repo;
    });

    beforeEach(async () => {
      await Model.deleteMany({});
    });

    afterAll(async () => {
      await Model.deleteMany({});
    });

    it('should handle addSubdocument to empty array', async () => {
      const doc = await repo.create({ items: [] });

      const result = await repo.addSubdocument(doc._id.toString(), 'items', {
        name: 'First',
        value: 1,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('First');
    });

    it('should handle getSubdocument on non-existent subdocument ID', async () => {
      const doc = await repo.create({ items: [{ name: 'Item', value: 1 }] });
      const fakeId = new Types.ObjectId().toString();

      await expect(
        repo.getSubdocument(doc._id.toString(), 'items', fakeId)
      ).rejects.toThrow(/not found/i);
    });

    it('should handle updateSubdocument on non-existent subdocument ID', async () => {
      const doc = await repo.create({ items: [{ name: 'Item', value: 1 }] });
      const fakeId = new Types.ObjectId().toString();

      await expect(
        repo.updateSubdocument(doc._id.toString(), 'items', fakeId, {
          name: 'Updated',
          value: 2,
        })
      ).rejects.toThrow(/not found/i);
    });

    it('should handle deleteSubdocument on non-existent subdocument ID', async () => {
      const doc = await repo.create({ items: [{ name: 'Item', value: 1 }] });
      const fakeId = new Types.ObjectId().toString();

      // Delete non-existent should not error, just return unchanged
      const result = await repo.deleteSubdocument(doc._id.toString(), 'items', fakeId);
      expect(result.items).toHaveLength(1);
    });

    it('should handle subdocument operations on non-existent parent ID', async () => {
      const fakeId = new Types.ObjectId().toString();

      await expect(
        repo.addSubdocument(fakeId, 'items', { name: 'Item', value: 1 })
      ).rejects.toThrow();
    });

    it('should handle addSubdocument with validation errors', async () => {
      const doc = await repo.create({ items: [] });

      // Missing required field 'value'
      await expect(
        repo.addSubdocument(doc._id.toString(), 'items', {
          name: 'Invalid',
        } as any)
      ).rejects.toThrow(/validation/i);
    });

    it('should handle multiple subdocuments in array', async () => {
      const doc = await repo.create({ items: [] });

      await repo.addSubdocument(doc._id.toString(), 'items', { name: 'Item1', value: 1 });
      await repo.addSubdocument(doc._id.toString(), 'items', { name: 'Item2', value: 2 });
      await repo.addSubdocument(doc._id.toString(), 'items', { name: 'Item3', value: 3 });

      const result = await repo.getById(doc._id.toString());
      expect(result!.items).toHaveLength(3);
    });

    it('should handle deleteSubdocument leaving other items intact', async () => {
      const doc = await repo.create({
        items: [
          { name: 'Item1', value: 1 },
          { name: 'Item2', value: 2 },
          { name: 'Item3', value: 3 },
        ],
      });

      const itemToDelete = doc.items[1]._id.toString();
      const result = await repo.deleteSubdocument(doc._id.toString(), 'items', itemToDelete);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe('Item1');
      expect(result.items[1].name).toBe('Item3');
    });
  });

  // ============================================================================
  // Combined Plugins - Edge Cases with Timestamps + Soft Delete
  // ============================================================================

  describe('Combined Plugins - Edge Cases', () => {
    interface ICombined {
      _id: Types.ObjectId;
      name: string;
      value: number;
      createdAt?: Date;
      updatedAt?: Date;
      deletedAt?: Date;
    }

    const CombinedSchema = new Schema<ICombined>({
      name: String,
      value: Number,
      createdAt: Date,
      updatedAt: Date,
      deletedAt: Date,
    });

    let Model: mongoose.Model<ICombined>;
    let repo: Repository<ICombined>;

    beforeAll(async () => {
      Model = await createTestModel('CombinedEdgeCase', CombinedSchema);
      repo = new Repository(Model, [
        timestampPlugin(),
        softDeletePlugin(),
      ]);
    });

    beforeEach(async () => {
      await Model.deleteMany({});
    });

    afterAll(async () => {
      await Model.deleteMany({});
    });

    it('should set timestamps on create even with soft delete plugin', async () => {
      const doc = await repo.create({ name: 'Test', value: 1 });

      expect(doc.createdAt).toBeDefined();
      expect(doc.updatedAt).toBeDefined();
      expect(doc.deletedAt).toBeUndefined();
    });

    it('should update updatedAt but not createdAt on update', async () => {
      const doc = await repo.create({ name: 'Test', value: 1 });
      const originalCreatedAt = doc.createdAt;

      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = await repo.update(doc._id.toString(), { name: 'Updated' });

      expect(updated.createdAt!.getTime()).toBe(originalCreatedAt!.getTime());
      expect(updated.updatedAt!.getTime()).toBeGreaterThan(originalCreatedAt!.getTime());
    });

    it('should set deletedAt on soft delete', async () => {
      const doc = await repo.create({ name: 'Test', value: 1 });

      await repo.delete(doc._id.toString());

      const raw = await Model.findById(doc._id);
      expect(raw!.deletedAt).toBeDefined();
    });

    it('should not find soft-deleted documents in regular queries', async () => {
      const doc = await repo.create({ name: 'Test', value: 1 });
      await repo.delete(doc._id.toString());

      const found = await repo.getById(doc._id.toString(), { throwOnNotFound: false });
      expect(found).toBeNull();
    });
  });

  // ============================================================================
  // validationChainPlugin - Edge Cases
  // ============================================================================

  describe('validationChainPlugin - Edge Cases', () => {
    interface IValidation {
      _id: Types.ObjectId;
      userId: string;
      email: string;
      role: string;
      immutableField?: string;
    }

    const ValidationSchema = new Schema<IValidation>({
      userId: String,
      email: { type: String, unique: true },
      role: String,
      immutableField: String,
    });

    let Model: mongoose.Model<IValidation>;
    let repo: Repository<IValidation>;

    beforeAll(async () => {
      Model = await createTestModel('ValidationEdgeCase', ValidationSchema);
      repo = new Repository(Model, [
        validationChainPlugin([
          requireField('email', ['create']),
          immutableField('immutableField'),
        ]),
      ]);
    });

    beforeEach(async () => {
      await Model.deleteMany({});
    });

    afterAll(async () => {
      await Model.deleteMany({});
    });

    it('should reject create without required field', async () => {
      await expect(
        repo.create({
          userId: 'user-1',
          role: 'user',
        } as any)
      ).rejects.toThrow(/required/i);
    });

    it('should allow create with required field', async () => {
      const doc = await repo.create({
        userId: 'user-1',
        email: 'test@example.com',
        role: 'user',
      });

      expect(doc.email).toBe('test@example.com');
    });

    it('should prevent updating immutable field', async () => {
      const doc = await repo.create({
        userId: 'user-1',
        email: 'test@example.com',
        role: 'user',
        immutableField: 'original',
      });

      await expect(
        repo.update(doc._id.toString(), { immutableField: 'changed' })
      ).rejects.toThrow(/immutable/i);
    });

    it('should allow updating non-immutable fields', async () => {
      const doc = await repo.create({
        userId: 'user-1',
        email: 'test@example.com',
        role: 'user',
        immutableField: 'original',
      });

      const updated = await repo.update(doc._id.toString(), { role: 'admin' });
      expect(updated.role).toBe('admin');
      expect(updated.immutableField).toBe('original');
    });
  });
});
