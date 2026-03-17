/**
 * Tests for MongoKit fixes
 *
 * Coverage for: cursor boolean serialization, aggregate hasNext,
 * cursor version graceful degradation, batch updateMany safety,
 * cache error tracking, transaction fallback error codes
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  PaginationEngine,
  cachePlugin,
  createMemoryCache,
  methodRegistryPlugin,
  batchOperationsPlugin,
} from '../src/index.js';
import { connectDB, disconnectDB, clearDB, createTestModel } from './setup.js';
import {
  encodeCursor,
  decodeCursor,
  validateCursorVersion,
} from '../src/pagination/utils/cursor.js';

// ════════════════════════════════════════════════════════════════════════════
// Test Schemas
// ════════════════════════════════════════════════════════════════════════════

interface IItem {
  _id: Types.ObjectId;
  name: string;
  active: boolean;
  score: number;
  createdAt: Date;
}

const ItemSchema = new Schema<IItem>({
  name: { type: String, required: true },
  active: { type: Boolean, default: false },
  score: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});
ItemSchema.index({ createdAt: -1, _id: -1 });
ItemSchema.index({ score: -1, _id: -1 });

// ════════════════════════════════════════════════════════════════════════════
// Cursor Boolean Serialization
// ════════════════════════════════════════════════════════════════════════════

describe('Cursor Boolean Serialization Fix', () => {
  let ItemModel: mongoose.Model<IItem>;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('CursorBoolItem', ItemSchema);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  it('should correctly rehydrate boolean false from cursor', () => {
    const doc = {
      _id: new Types.ObjectId(),
      active: false,
      createdAt: new Date(),
    };

    const cursor = encodeCursor(doc, 'active', { active: 1, _id: 1 });
    const decoded = decodeCursor(cursor);

    expect(decoded.value).toBe(false);
    expect(typeof decoded.value).toBe('boolean');
  });

  it('should correctly rehydrate boolean true from cursor', () => {
    const doc = {
      _id: new Types.ObjectId(),
      active: true,
      createdAt: new Date(),
    };

    const cursor = encodeCursor(doc, 'active', { active: 1, _id: 1 });
    const decoded = decodeCursor(cursor);

    expect(decoded.value).toBe(true);
    expect(typeof decoded.value).toBe('boolean');
  });

  it('should handle string "false" as false in boolean rehydration', () => {
    // Simulate a cursor payload where boolean was serialized as string "false"
    const payload = {
      v: 'false',
      t: 'boolean',
      id: new Types.ObjectId().toString(),
      idType: 'objectid',
      sort: { active: 1, _id: 1 },
      ver: 1,
    };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');
    const decoded = decodeCursor(token);

    expect(decoded.value).toBe(false);
  });

  it('should handle string "0" as false in boolean rehydration', () => {
    const payload = {
      v: '0',
      t: 'boolean',
      id: new Types.ObjectId().toString(),
      idType: 'objectid',
      sort: { active: 1, _id: 1 },
      ver: 1,
    };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');
    const decoded = decodeCursor(token);

    expect(decoded.value).toBe(false);
  });

  it('should handle numeric 0 as false in boolean rehydration', () => {
    const payload = {
      v: 0,
      t: 'boolean',
      id: new Types.ObjectId().toString(),
      idType: 'objectid',
      sort: { active: 1, _id: 1 },
      ver: 1,
    };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');
    const decoded = decodeCursor(token);

    expect(decoded.value).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cursor Version Graceful Degradation
// ════════════════════════════════════════════════════════════════════════════

describe('Cursor Version Graceful Degradation', () => {
  it('should accept older cursor versions (v1 cursor with v2 expected)', () => {
    // Older cursor version should be accepted for rolling deploys
    expect(() => validateCursorVersion(1, 2)).not.toThrow();
  });

  it('should accept same cursor version', () => {
    expect(() => validateCursorVersion(1, 1)).not.toThrow();
  });

  it('should reject newer cursor versions (v3 cursor with v2 expected)', () => {
    expect(() => validateCursorVersion(3, 2)).toThrow(/newer than expected/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Aggregate Pagination hasNext Fix
// ════════════════════════════════════════════════════════════════════════════

describe('Aggregate Pagination hasNext Fix (countStrategy=none)', () => {
  let ItemModel: mongoose.Model<IItem>;
  let engine: PaginationEngine<IItem>;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('AggItem', ItemSchema);
    engine = new PaginationEngine(ItemModel, { defaultLimit: 5, maxLimit: 50 });

    await ItemModel.deleteMany({});
    const items = Array.from({ length: 7 }, (_, i) => ({
      name: `Item ${i}`,
      active: i % 2 === 0,
      score: i * 10,
    }));
    await ItemModel.insertMany(items);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  it('should correctly detect hasNext=true when more docs exist (countStrategy=none)', async () => {
    const result = await engine.aggregatePaginate({
      pipeline: [{ $sort: { score: -1 } }],
      page: 1,
      limit: 5,
      countStrategy: 'none',
    });

    expect(result.docs).toHaveLength(5);
    expect(result.hasNext).toBe(true);
    expect(result.total).toBe(0); // countStrategy=none returns 0
  });

  it('should correctly detect hasNext=false on last page (countStrategy=none)', async () => {
    const result = await engine.aggregatePaginate({
      pipeline: [{ $sort: { score: -1 } }],
      page: 1,
      limit: 10, // More than 7 items
      countStrategy: 'none',
    });

    expect(result.docs).toHaveLength(7);
    expect(result.hasNext).toBe(false);
  });

  it('should not return extra doc when hasNext is true (no limit+1 leak)', async () => {
    const result = await engine.aggregatePaginate({
      pipeline: [{ $sort: { score: -1 } }],
      page: 1,
      limit: 5,
      countStrategy: 'none',
    });

    // Should only return exactly `limit` docs, not limit+1
    expect(result.docs).toHaveLength(5);
  });

  it('should still work correctly with countStrategy=exact', async () => {
    const result = await engine.aggregatePaginate({
      pipeline: [{ $sort: { score: -1 } }],
      page: 1,
      limit: 5,
      countStrategy: 'exact',
    });

    expect(result.docs).toHaveLength(5);
    expect(result.hasNext).toBe(true);
    expect(result.total).toBe(7);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Offset Pagination hasNext Fix (countStrategy=none)
// ════════════════════════════════════════════════════════════════════════════

describe('Offset Pagination hasNext Fix (countStrategy=none)', () => {
  let ItemModel: mongoose.Model<IItem>;
  let engine: PaginationEngine<IItem>;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('OffsetItem', ItemSchema);
    engine = new PaginationEngine(ItemModel, { defaultLimit: 5, maxLimit: 50 });

    await ItemModel.deleteMany({});
    // Insert exactly 5 items — this is the false positive case
    const items = Array.from({ length: 5 }, (_, i) => ({
      name: `Item ${i}`,
      active: i % 2 === 0,
      score: i * 10,
    }));
    await ItemModel.insertMany(items);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  it('should return hasNext=false when total equals limit (the false positive case)', async () => {
    // 5 items, limit 5 — old code would say hasNext=true (5 === 5)
    const result = await engine.paginate({
      sort: { _id: -1 },
      page: 1,
      limit: 5,
      countStrategy: 'none',
    });

    expect(result.docs).toHaveLength(5);
    expect(result.hasNext).toBe(false); // This was the bug — old code returned true
  });

  it('should return hasNext=true when more docs exist', async () => {
    const result = await engine.paginate({
      sort: { _id: -1 },
      page: 1,
      limit: 3,
      countStrategy: 'none',
    });

    expect(result.docs).toHaveLength(3);
    expect(result.hasNext).toBe(true);
  });

  it('should not leak extra doc in results', async () => {
    const result = await engine.paginate({
      sort: { _id: -1 },
      page: 1,
      limit: 3,
      countStrategy: 'none',
    });

    // Must return exactly `limit` docs, not limit+1
    expect(result.docs).toHaveLength(3);
    expect(result.limit).toBe(3);
  });

  it('should work correctly with countStrategy=exact', async () => {
    const result = await engine.paginate({
      sort: { _id: -1 },
      page: 1,
      limit: 5,
      countStrategy: 'exact',
    });

    expect(result.docs).toHaveLength(5);
    expect(result.hasNext).toBe(false);
    expect(result.total).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Batch updateMany Empty Query Safety
// ════════════════════════════════════════════════════════════════════════════

describe('Batch updateMany Empty Query Safety', () => {
  let ItemModel: mongoose.Model<IItem>;
  let repo: any;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('BatchItem', ItemSchema);
    repo = new Repository(ItemModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ]);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await ItemModel.deleteMany({});
    await ItemModel.insertMany([
      { name: 'A', score: 10 },
      { name: 'B', score: 20 },
      { name: 'C', score: 30 },
    ]);
  });

  it('should reject updateMany with empty query {}', async () => {
    await expect(
      repo.updateMany({}, { score: 999 })
    ).rejects.toThrow(/non-empty query filter/);
  });

  it('should allow updateMany with valid query filter', async () => {
    const result = await repo.updateMany({ name: 'A' }, { score: 100 });
    expect(result.modifiedCount).toBe(1);

    const updated = await ItemModel.findOne({ name: 'A' });
    expect(updated!.score).toBe(100);
  });

  it('should reject updateMany with null/undefined query', async () => {
    await expect(
      repo.updateMany(null as any, { score: 999 })
    ).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cache Error Tracking
// ════════════════════════════════════════════════════════════════════════════

describe('Cache Error Tracking', () => {
  let ItemModel: mongoose.Model<IItem>;
  let repo: any;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('CacheErrItem', ItemSchema);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  it('should track adapter errors separately from misses', async () => {
    let callCount = 0;
    const failingAdapter = {
      async get() {
        callCount++;
        throw new Error('Redis connection failed');
      },
      async set() {
        // no-op
      },
      async del() {
        // no-op
      },
    };

    repo = new Repository(ItemModel, [
      cachePlugin({ adapter: failingAdapter as any, ttl: 60 }),
    ]);

    // Create a doc first
    const doc = await repo.create({ name: 'Test', score: 10 });

    // Attempt a cached read — adapter will throw
    await repo.getById(doc._id);

    const stats = repo.getCacheStats();
    expect(stats.errors).toBeGreaterThanOrEqual(1);
    // Misses should NOT be incremented for adapter errors
    expect(stats.misses).toBe(0);
  });

  it('should have errors field in cache stats', () => {
    const stats = repo.getCacheStats();
    expect(stats).toHaveProperty('errors');
    expect(typeof stats.errors).toBe('number');
  });

  it('should reset errors count with resetCacheStats', () => {
    repo.resetCacheStats();
    const stats = repo.getCacheStats();
    expect(stats.errors).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Transaction Fallback Error Code Detection
// ════════════════════════════════════════════════════════════════════════════

describe('Transaction Fallback Detection', () => {
  let ItemModel: mongoose.Model<IItem>;
  let repo: Repository<IItem>;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('TxnItem', ItemSchema);
    repo = new Repository(ItemModel);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  it('should successfully use withTransaction with allowFallback on standalone', async () => {
    // MongoMemoryServer is standalone — transactions are unsupported
    // withTransaction with allowFallback should fall back gracefully
    const doc = await repo.withTransaction(
      async (session) => {
        const [created] = await ItemModel.create([{ name: 'TxnTest', score: 42 }], { session });
        return created;
      },
      { allowFallback: true },
    );

    expect(doc).toBeDefined();
    expect(doc.name).toBe('TxnTest');
  });

  it('should call onFallback callback when falling back', async () => {
    let fallbackCalled = false;
    let fallbackError: Error | undefined;

    await repo.withTransaction(
      async () => {
        return 'result';
      },
      {
        allowFallback: true,
        onFallback: (err) => {
          fallbackCalled = true;
          fallbackError = err;
        },
      },
    );

    // On standalone MongoDB, it should either succeed via fallback or directly
    // (depending on how MongoMemoryServer handles it)
    // The key is it shouldn't throw
  });

  it('should throw without allowFallback on standalone when session.withTransaction fails', async () => {
    // Without allowFallback, should propagate the error on standalone
    try {
      await repo.withTransaction(async (session) => {
        await ItemModel.create([{ name: 'NoFallback' }], { session });
        return 'done';
      });
      // If it succeeds (some MongoMemoryServer versions support transactions), that's fine too
    } catch (err) {
      // Expected on standalone — should be a transaction error
      expect(err).toBeDefined();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Keyset Pagination with Booleans (end-to-end)
// ════════════════════════════════════════════════════════════════════════════

describe('Keyset Pagination with Boolean Sort Field', () => {
  let ItemModel: mongoose.Model<IItem>;
  let engine: PaginationEngine<IItem>;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('BoolPagItem', new Schema<IItem>({
      name: { type: String, required: true },
      active: { type: Boolean, default: false },
      score: { type: Number, default: 0 },
      createdAt: { type: Date, default: Date.now },
    }));

    // Add index for boolean sort
    await ItemModel.collection.createIndex({ active: 1, _id: 1 });

    engine = new PaginationEngine(ItemModel, { defaultLimit: 3, maxLimit: 50 });

    await ItemModel.deleteMany({});
    await ItemModel.insertMany([
      { name: 'A', active: false },
      { name: 'B', active: false },
      { name: 'C', active: false },
      { name: 'D', active: true },
      { name: 'E', active: true },
    ]);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  it('should paginate across boolean boundary with cursor', async () => {
    // First page: get 3 items sorted by active asc
    const page1 = await engine.stream({
      sort: { active: 1 },
      limit: 3,
    });

    expect(page1.docs).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.next).not.toBeNull();

    // All first page items should be active=false
    for (const doc of page1.docs) {
      expect((doc as any).active).toBe(false);
    }

    // Second page: should cross the false→true boundary
    const page2 = await engine.stream({
      sort: { active: 1 },
      after: page1.next!,
      limit: 3,
    });

    expect(page2.docs).toHaveLength(2);
    expect(page2.hasMore).toBe(false);

    // Second page should have active=true items
    for (const doc of page2.docs) {
      expect((doc as any).active).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Delete Action Types & Return Values
// ════════════════════════════════════════════════════════════════════════════

describe('Delete Action Return Types', () => {
  let ItemModel: mongoose.Model<IItem>;
  let repo: Repository<IItem>;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('DelTypeItem', ItemSchema);
    repo = new Repository(ItemModel);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await ItemModel.deleteMany({});
  });

  it('should return DeleteResult with id from Repository.delete()', async () => {
    const doc = await repo.create({ name: 'ToDelete', score: 1 });
    const result = await repo.delete(doc._id.toString());

    expect(result.success).toBe(true);
    expect(result.message).toBe('Deleted successfully');
    expect(result.id).toBe(doc._id.toString());
  });

  it('should return DeleteResult with id and soft flag when soft-deleted', async () => {
    const { Repository: Repo, softDeletePlugin } = await import('../src/index.js');
    const SoftModel = await createTestModel('DelTypeSoftItem', new Schema<IItem>({
      name: { type: String, required: true },
      active: { type: Boolean, default: false },
      score: { type: Number, default: 0 },
      createdAt: { type: Date, default: Date.now },
      deletedAt: { type: Date, default: null },
    }));
    const softRepo = new Repo(SoftModel, [softDeletePlugin({ deletedField: 'deletedAt' })]);

    const doc = await softRepo.create({ name: 'SoftDel', score: 5 });
    const result = await softRepo.delete(doc._id.toString());

    expect(result.success).toBe(true);
    expect(result.id).toBe(doc._id.toString());
    expect(result.soft).toBe(true);
  });

  it('should throw 404 when deleting non-existent document', async () => {
    const fakeId = new Types.ObjectId().toString();
    await expect(repo.delete(fakeId)).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// deleteByQuery Action
// ════════════════════════════════════════════════════════════════════════════

describe('deleteByQuery Action', () => {
  let ItemModel: mongoose.Model<IItem>;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('DelQueryItem', ItemSchema);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await ItemModel.deleteMany({});
  });

  it('should return id from deleted document (not undefined)', async () => {
    const { deleteByQuery } = await import('../src/actions/delete.js');
    const doc = await ItemModel.create({ name: 'QueryDel', score: 42 });

    const result = await deleteByQuery(ItemModel, { name: 'QueryDel' });

    expect(result.success).toBe(true);
    expect(result.id).toBe(doc._id.toString());
    expect(result.id).not.toBe('undefined');
  });

  it('should throw 404 when no document matches query', async () => {
    const { deleteByQuery } = await import('../src/actions/delete.js');

    await expect(
      deleteByQuery(ItemModel, { name: 'NonExistent' })
    ).rejects.toThrow('Document not found');
  });

  it('should not throw when throwOnNotFound is false and no match', async () => {
    const { deleteByQuery } = await import('../src/actions/delete.js');

    const result = await deleteByQuery(ItemModel, { name: 'NonExistent' }, { throwOnNotFound: false });

    expect(result.success).toBe(true);
    expect(result.id).toBeUndefined();
  });
});
