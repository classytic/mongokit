/**
 * v3.4.4 Bug Fix Tests (TDD — written BEFORE implementation)
 *
 * Issue 1 (Critical): getAll() always paginates — no unlimited mode
 * Issue 3 (High): maxLimit silently caps to 100
 * Issue 4 (Low): getById() CastError on string IDs
 * Issue 5 (Low): createMany() ordered:true default
 */
import mongoose, { type Document, Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Repository from '../src/Repository.js';

interface IItem extends Document {
  name: string;
  status: string;
  priority: number;
}

const ItemSchema = new Schema<IItem>({
  name: { type: String, required: true },
  status: { type: String, default: 'active' },
  priority: { type: Number, default: 0 },
});

let mongo: MongoMemoryServer;
let ItemModel: mongoose.Model<IItem>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ItemModel = mongoose.model<IItem>('Item', ItemSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await ItemModel.deleteMany({});
});

// ─── Issue 1: No unlimited query mode ───────────────────────────────────────

describe('Issue 1 (Critical): findAll() unlimited query', () => {
  beforeEach(async () => {
    // Seed 150 items — more than any default limit
    const items = Array.from({ length: 150 }, (_, i) => ({
      name: `item-${String(i).padStart(3, '0')}`,
      status: i % 3 === 0 ? 'inactive' : 'active',
      priority: i,
    }));
    await ItemModel.insertMany(items);
  });

  it('findAll() returns ALL documents without pagination', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.findAll();
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(150);
  });

  it('findAll() with filters returns all matching docs', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.findAll({ status: 'active' });
    expect(result.length).toBe(100); // 150 - 50 inactive (every 3rd)
  });

  it('findAll() with session support', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.findAll({}, { lean: true });
    expect(result.length).toBe(150);
    // Lean results should be plain objects
    expect(result[0]).not.toBeInstanceOf(mongoose.Document);
  });

  it('findAll() with select returns only specified fields', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.findAll({}, { select: 'name' });
    expect(result.length).toBe(150);
    expect(result[0]).toHaveProperty('name');
    expect(result[0]).not.toHaveProperty('priority');
  });

  it('findAll() fires before:findAll and after:findAll hooks', async () => {
    const repo = new Repository(ItemModel);
    const hookCalls: string[] = [];
    repo.on('before:findAll', () => { hookCalls.push('before'); });
    repo.on('after:findAll', () => { hookCalls.push('after'); });

    await repo.findAll();
    expect(hookCalls).toEqual(['before', 'after']);
  });

  it('getAll() with noPagination: true returns raw array', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.getAll({ noPagination: true });
    // Should return plain array, not paginated result
    expect(Array.isArray(result)).toBe(true);
    expect((result as IItem[]).length).toBe(150);
  });

  it('noPagination respects before:getAll hook filters (multi-tenant)', async () => {
    const repo = new Repository(ItemModel);
    // Simulate multi-tenant plugin injecting a filter via before:getAll
    repo.on('before:getAll', (ctx) => {
      ctx.filters = { ...(ctx.filters || {}), status: 'inactive' };
    });

    const result = await repo.getAll({ noPagination: true });
    expect(Array.isArray(result)).toBe(true);
    // Only inactive items (every 3rd = 50 out of 150)
    for (const item of result as IItem[]) {
      expect(item.status).toBe('inactive');
    }
  });

  it('noPagination respects sort', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.getAll({
      noPagination: true,
      sort: { priority: -1 },
    });
    const items = result as IItem[];
    expect(items.length).toBe(150);
    // First item should have highest priority
    expect(items[0].priority).toBeGreaterThanOrEqual(items[1].priority);
    expect(items[1].priority).toBeGreaterThanOrEqual(items[2].priority);
  });

  it('findAll() accepts sort option directly', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.findAll({}, { sort: { priority: -1 } });
    expect(result.length).toBe(150);
    expect((result[0] as IItem).priority).toBeGreaterThanOrEqual((result[1] as IItem).priority);
  });
});

// ─── Issue 3: maxLimit silently caps to 100 ─────────────────────────────────

describe('Issue 3 (High): maxLimit configurable', () => {
  beforeEach(async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      name: `item-${i}`,
      status: 'active',
      priority: i,
    }));
    await ItemModel.insertMany(items);
  });

  it('maxLimit: 0 means unlimited — returns all docs', async () => {
    const repo = new Repository(ItemModel, [], { maxLimit: 0 });
    const result = await repo.getAll({ limit: 200 });
    expect(result.docs.length).toBe(200);
  });

  it('maxLimit: 500 allows fetching up to 500', async () => {
    const repo = new Repository(ItemModel, [], { maxLimit: 500 });
    const result = await repo.getAll({ limit: 200 });
    expect(result.docs.length).toBe(200);
  });

  it('maxLimit: 50 caps at 50', async () => {
    const repo = new Repository(ItemModel, [], { maxLimit: 50 });
    const result = await repo.getAll({ limit: 200 });
    expect(result.docs.length).toBe(50);
  });

  it('default maxLimit: 100 still works', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.getAll({ limit: 200 });
    expect(result.docs.length).toBe(100);
  });
});

// ─── Issue 4: CastError on string IDs ───────────────────────────────────────

describe('Issue 4 (Low): getById() handles invalid ObjectId gracefully', () => {
  it('returns null for non-ObjectId string when throwOnNotFound: false', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.getById('stock', { throwOnNotFound: false });
    expect(result).toBeNull();
  });

  it('returns null for random string when throwOnNotFound: false', async () => {
    const repo = new Repository(ItemModel);
    const result = await repo.getById('not-a-valid-id', { throwOnNotFound: false });
    expect(result).toBeNull();
  });

  it('throws 404 (not 400) for non-ObjectId string when throwOnNotFound: true', async () => {
    const repo = new Repository(ItemModel);
    await expect(repo.getById('stock')).rejects.toMatchObject({
      status: 404,
      message: 'Document not found',
    });
  });

  it('still works with valid ObjectId', async () => {
    const repo = new Repository(ItemModel);
    const created = await repo.create({ name: 'test' });
    const found = await repo.getById(String(created._id));
    expect(found).not.toBeNull();
    expect((found as IItem).name).toBe('test');
  });

  it('returns null for valid-format but non-existent ObjectId', async () => {
    const repo = new Repository(ItemModel);
    const fakeId = new mongoose.Types.ObjectId().toString();
    const result = await repo.getById(fakeId, { throwOnNotFound: false });
    expect(result).toBeNull();
  });
});

// ─── Issue 5: createMany() ordered default ──────────────────────────────────

describe('Issue 5 (Low): createMany() ordered default', () => {
  it('ordered: false by default — partial inserts succeed', async () => {
    // Create a unique index on name
    await ItemModel.collection.createIndex({ name: 1 }, { unique: true });

    const repo = new Repository(ItemModel);

    // Insert first item
    await repo.create({ name: 'duplicate' });

    // Batch with one duplicate in the middle — with ordered:false, other items still insert
    const batch = [
      { name: 'unique-1' },
      { name: 'duplicate' }, // will fail
      { name: 'unique-2' },
    ];

    try {
      await repo.createMany(batch);
    } catch {
      // Expected to throw due to duplicate
    }

    // With ordered:false, unique-1 and unique-2 should still be inserted
    const all = await ItemModel.find({ name: { $in: ['unique-1', 'unique-2'] } });
    expect(all.length).toBe(2);

    // Cleanup index
    await ItemModel.collection.dropIndex('name_1');
  });

  it('ordered: true can be explicitly set', async () => {
    await ItemModel.collection.createIndex({ name: 1 }, { unique: true });

    const repo = new Repository(ItemModel);
    await repo.create({ name: 'dup' });

    const batch = [
      { name: 'before-dup' },
      { name: 'dup' }, // fails here
      { name: 'after-dup' }, // should NOT insert with ordered:true
    ];

    try {
      await repo.createMany(batch, { ordered: true });
    } catch {
      // Expected
    }

    // With ordered:true, after-dup should NOT be inserted
    const afterDup = await ItemModel.findOne({ name: 'after-dup' });
    expect(afterDup).toBeNull();

    await ItemModel.collection.dropIndex('name_1');
  });
});
