/**
 * Load & Stress Tests — validates MongoKit handles big data correctly
 *
 * Tests: findAll at scale, keyset vs offset at depth, concurrent writes,
 * createMany partial failure, cache invalidation under load, pagination
 * consistency during concurrent mutations.
 */
import mongoose, { type Document, Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import Repository from '../src/Repository.js';
import {
  softDeletePlugin,
  methodRegistryPlugin,
  batchOperationsPlugin,
  cachePlugin,
  createMemoryCache,
  timestampPlugin,
} from '../src/index.js';

// ─── Schemas ────────────────────────────────────────────────────────────────

interface IOrder extends Document {
  orderNo: string;
  customer: string;
  amount: number;
  status: string;
  region: string;
  createdAt: Date;
}

const OrderSchema = new Schema<IOrder>({
  orderNo: { type: String, required: true, unique: true },
  customer: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
  region: { type: String, enum: ['US', 'EU', 'APAC'], required: true },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null },
});

OrderSchema.index({ status: 1, createdAt: -1, _id: -1 });
OrderSchema.index({ region: 1, amount: -1, _id: -1 });
OrderSchema.index({ customer: 1 });

let mongo: MongoMemoryServer;
let OrderModel: mongoose.Model<IOrder>;

// ─── Seed helpers ───────────────────────────────────────────────────────────

const REGIONS = ['US', 'EU', 'APAC'] as const;
const STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'] as const;
const CUSTOMERS = Array.from({ length: 50 }, (_, i) => `customer-${String(i).padStart(3, '0')}`);

function seedOrder(i: number) {
  return {
    orderNo: `ORD-${String(i).padStart(6, '0')}`,
    customer: CUSTOMERS[i % CUSTOMERS.length],
    amount: Math.round((10 + (i * 7.31) % 990) * 100) / 100,
    status: STATUSES[i % STATUSES.length],
    region: REGIONS[i % REGIONS.length],
    createdAt: new Date(Date.now() - i * 60_000), // 1 min apart
  };
}

async function seedOrders(count: number): Promise<void> {
  const BATCH = 500;
  for (let i = 0; i < count; i += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, count - i) }, (_, j) => seedOrder(i + j));
    await OrderModel.insertMany(batch, { ordered: false });
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  OrderModel = mongoose.model<IOrder>('Order', OrderSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await OrderModel.deleteMany({});
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Load & Stress Tests', () => {
  describe('findAll() at scale', () => {
    beforeEach(async () => {
      await seedOrders(2000);
    }, 30_000);

    it('findAll() returns all 2000 docs without truncation', async () => {
      const repo = new Repository(OrderModel);
      const result = await repo.findAll();
      expect(result.length).toBe(2000);
    });

    it('findAll() with filter returns correct subset', async () => {
      const repo = new Repository(OrderModel);
      // Every 4th order is cancelled
      const cancelled = await repo.findAll({ status: 'cancelled' });
      expect(cancelled.length).toBe(500);
    });

    it('findAll() with select only returns requested fields', async () => {
      const repo = new Repository(OrderModel);
      const result = await repo.findAll({}, { select: 'orderNo amount' });
      expect(result.length).toBe(2000);
      const first = result[0] as Record<string, unknown>;
      expect(first).toHaveProperty('orderNo');
      expect(first).toHaveProperty('amount');
      expect(first).not.toHaveProperty('customer');
    });
  });

  describe('keyset vs offset at depth', () => {
    beforeEach(async () => {
      await seedOrders(1000);
    }, 30_000);

    it('keyset pagination walks all 1000 docs without duplicates or gaps', async () => {
      const repo = new Repository(OrderModel, [], { maxLimit: 0 });
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;

      while (true) {
        const result = await repo.getAll({
          sort: { createdAt: -1 },
          limit: 100,
          ...(cursor ? { after: cursor } : {}),
        });

        if (!('next' in result)) break;
        const keyset = result as { docs: IOrder[]; hasMore: boolean; next: string | null };

        for (const doc of keyset.docs) {
          const id = String(doc._id);
          expect(seen.has(id)).toBe(false); // no duplicates
          seen.add(id);
        }

        pages++;
        if (!keyset.hasMore || !keyset.next) break;
        cursor = keyset.next;
      }

      expect(seen.size).toBe(1000);
      expect(pages).toBe(10); // 1000 / 100
    });

    it('offset pagination at page 10 returns correct docs', async () => {
      const repo = new Repository(OrderModel, [], { maxLimit: 0 });
      const result = await repo.getAll({ page: 10, limit: 100 });
      expect(result.docs.length).toBe(100);
      expect(result.total).toBe(1000);
    });

    it('offset deep page returns correct total', async () => {
      const repo = new Repository(OrderModel, [], { maxLimit: 0 });
      const result = await repo.getAll({
        page: 5,
        limit: 50,
        filters: { status: 'pending' },
      });
      expect(result.total).toBe(250); // 1000 / 4 statuses
      expect(result.docs.length).toBe(50);
    });
  });

  describe('concurrent writes + read consistency', () => {
    it('concurrent creates do not lose documents', async () => {
      const repo = new Repository(OrderModel);
      const promises = Array.from({ length: 100 }, (_, i) =>
        repo.create({
          orderNo: `CONC-${String(i).padStart(4, '0')}`,
          customer: 'concurrent-test',
          amount: i * 10,
          region: 'US',
        }),
      );

      await Promise.all(promises);
      const count = await repo.count({ customer: 'concurrent-test' });
      expect(count).toBe(100);
    });

    it('concurrent updates do not corrupt data', async () => {
      // Seed one doc
      const repo = new Repository(OrderModel);
      const doc = await repo.create({
        orderNo: 'UPD-001',
        customer: 'test',
        amount: 0,
        region: 'EU',
      });

      // 50 concurrent updates to different fields
      const promises = Array.from({ length: 50 }, (_, i) =>
        repo.update(String(doc._id), { amount: i }),
      );

      await Promise.all(promises);
      const final = await repo.getById(String(doc._id));
      // Amount should be one of 0-49 (last write wins)
      expect((final as IOrder).amount).toBeGreaterThanOrEqual(0);
      expect((final as IOrder).amount).toBeLessThan(50);
    });
  });

  describe('createMany with partial failures at scale', () => {
    it('ordered: false inserts all valid docs even with duplicates', async () => {
      const repo = new Repository(OrderModel);

      // 500 orders, but first 10 are duplicated
      const batch = Array.from({ length: 500 }, (_, i) => seedOrder(i));
      await OrderModel.insertMany(batch.slice(0, 10), { ordered: false });

      // Now insert all 500 — 10 will fail (duplicate orderNo)
      try {
        await repo.createMany(batch);
      } catch {
        // Expected: BulkWriteError
      }

      // With ordered:false, remaining 490 should still insert
      const total = await OrderModel.countDocuments();
      expect(total).toBe(500); // 10 original + 490 new
    });
  });

  describe('cache invalidation under load', () => {
    it('cached getAll is invalidated after create', async () => {
      const repo = new Repository(OrderModel, [
        cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
      ]);

      await seedOrders(50);

      // First call — caches
      const first = await repo.getAll({ limit: 50 });
      expect(first.docs.length).toBe(50);

      // Create a new order
      await repo.create({
        orderNo: 'CACHE-NEW',
        customer: 'cache-test',
        amount: 99,
        region: 'US',
      });

      // Second call — should reflect new doc (cache invalidated)
      const second = await repo.getAll({ limit: 100 });
      expect(second.total).toBe(51);
    });

    it('cached getById is invalidated after update', async () => {
      const repo = new Repository(OrderModel, [
        cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
      ]);

      const doc = await repo.create({
        orderNo: 'CACHE-UPD',
        customer: 'test',
        amount: 10,
        region: 'EU',
      });

      // Cache it
      await repo.getById(String(doc._id));

      // Update
      await repo.update(String(doc._id), { amount: 999 });

      // Should return updated value (not stale cache)
      const updated = await repo.getById(String(doc._id));
      expect((updated as IOrder).amount).toBe(999);
    });
  });

  describe('soft-delete + batch at scale', () => {
    it('deleteMany soft-deletes 500 docs, getAll excludes them', async () => {
      const repo = new Repository(OrderModel, [
        timestampPlugin(),
        methodRegistryPlugin(),
        batchOperationsPlugin(),
        softDeletePlugin(),
      ], { maxLimit: 0 }) as Repository<IOrder> & { deleteMany: (filter: Record<string, unknown>) => Promise<unknown> };

      await seedOrders(1000);

      // Soft-delete all cancelled orders
      await repo.deleteMany({ status: 'cancelled' });

      // getAll should exclude soft-deleted (soft-delete hooks into before:getAll)
      const result = await repo.getAll({ limit: 1000 } as Record<string, unknown>);
      expect(result.docs.length).toBe(750); // 1000 - 250 cancelled

      // Include deleted should show all
      const all = await repo.getAll({ includeDeleted: true, limit: 1000 } as Record<string, unknown>);
      expect(all.total).toBe(1000);
    });
  });

  describe('pagination consistency during mutations', () => {
    it('keyset cursor remains stable after inserts between pages', async () => {
      const repo = new Repository(OrderModel, [], { maxLimit: 0 });
      await seedOrders(100);

      // Get first page
      const page1 = await repo.getAll({ sort: { createdAt: -1 }, limit: 50 });
      expect(page1.docs.length).toBe(50);

      // Insert 20 NEW orders (newer createdAt — will appear before existing data)
      const newOrders = Array.from({ length: 20 }, (_, i) => ({
        orderNo: `NEW-${String(i).padStart(4, '0')}`,
        customer: 'mid-page-insert',
        amount: 1,
        region: 'US' as const,
        createdAt: new Date(Date.now() + (i + 1) * 60_000), // future dates
      }));
      await OrderModel.insertMany(newOrders);

      // Get second page using cursor from page1
      if ('next' in page1 && page1.next) {
        const page2 = await repo.getAll({
          sort: { createdAt: -1 },
          limit: 50,
          after: page1.next as string,
        });

        // Page 2 should not re-include any docs from page 1
        const page1Ids = new Set(page1.docs.map((d: IOrder) => String(d._id)));
        for (const doc of page2.docs) {
          expect(page1Ids.has(String(doc._id))).toBe(false);
        }
      }
    });
  });
});
