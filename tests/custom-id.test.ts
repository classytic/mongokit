/**
 * Custom ID Plugin Tests
 *
 * Tests atomic counters, built-in generators, and the plugin hook system.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  customIdPlugin,
  sequentialId,
  dateSequentialId,
  prefixedId,
  getNextSequence,
} from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

// ============================================================
// Test Models
// ============================================================

interface IInvoice {
  _id: Types.ObjectId;
  invoiceNumber?: string;
  amount: number;
}

const InvoiceSchema = new Schema<IInvoice>({
  invoiceNumber: String,
  amount: { type: Number, required: true },
});

interface IOrder {
  _id: Types.ObjectId;
  orderRef?: string;
  customId?: string;
  total: number;
}

const OrderSchema = new Schema<IOrder>({
  orderRef: String,
  customId: String,
  total: { type: Number, required: true },
});

// ============================================================
// Tests
// ============================================================

describe('Custom ID Plugin', () => {
  let InvoiceModel: mongoose.Model<IInvoice>;
  let OrderModel: mongoose.Model<IOrder>;

  beforeAll(async () => {
    await connectDB();
    InvoiceModel = await createTestModel('CustomIdInvoice', InvoiceSchema);
    OrderModel = await createTestModel('CustomIdOrder', OrderSchema);
  });

  // Only clear counter keys owned by this file. The `_mongokit_counters`
  // collection is shared across every test file that uses customIdPlugin,
  // and parallel forks against the same memory-server mean a broad
  // `deleteMany({})` will race with other files' in-flight counter bumps.
  const OWN_COUNTER_PATTERN =
    /^(test-counter|counter-[ab]|concurrency-test|CustomIdInvoice|bill-custom-padding|series-[ab]|yearly-test|daily-test|bulk-test|compose-test)/;

  const clearOwnCounters = async () => {
    try {
      await mongoose.connection
        .collection('_mongokit_counters')
        .deleteMany({ _id: { $regex: OWN_COUNTER_PATTERN } as unknown as string });
    } catch {
      // Collection may not exist yet
    }
  };

  afterAll(async () => {
    await clearOwnCounters();
    await InvoiceModel.deleteMany({});
    await OrderModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await InvoiceModel.deleteMany({});
    await OrderModel.deleteMany({});
    await clearOwnCounters();
  });

  // ============================================================
  // getNextSequence (atomic counter)
  // ============================================================

  describe('getNextSequence', () => {
    it('should return 1 on first call', async () => {
      const seq = await getNextSequence('test-counter-1');
      expect(seq).toBe(1);
    });

    it('should increment atomically on each call', async () => {
      const seq1 = await getNextSequence('test-counter-2');
      const seq2 = await getNextSequence('test-counter-2');
      const seq3 = await getNextSequence('test-counter-2');

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    it('should support batch increment', async () => {
      const endSeq = await getNextSequence('test-counter-batch', 5);
      expect(endSeq).toBe(5);

      // Next single increment should continue from 5
      const next = await getNextSequence('test-counter-batch');
      expect(next).toBe(6);
    });

    it('should maintain separate counters per key', async () => {
      const a1 = await getNextSequence('counter-a');
      const b1 = await getNextSequence('counter-b');
      const a2 = await getNextSequence('counter-a');
      const b2 = await getNextSequence('counter-b');

      expect(a1).toBe(1);
      expect(b1).toBe(1);
      expect(a2).toBe(2);
      expect(b2).toBe(2);
    });

    it('should handle concurrent increments without duplicates', async () => {
      const KEY = 'concurrency-test';
      const COUNT = 20;

      // Fire all increments concurrently
      const results = await Promise.all(
        Array.from({ length: COUNT }, () => getNextSequence(KEY))
      );

      // All values should be unique
      const unique = new Set(results);
      expect(unique.size).toBe(COUNT);

      // Should contain all numbers 1..COUNT
      const sorted = results.sort((a, b) => a - b);
      expect(sorted[0]).toBe(1);
      expect(sorted[sorted.length - 1]).toBe(COUNT);
    });
  });

  // ============================================================
  // sequentialId generator
  // ============================================================

  describe('sequentialId', () => {
    it('should generate sequential IDs with prefix', async () => {
      const repo = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: sequentialId({ prefix: 'INV', model: InvoiceModel }),
        }),
      ]);

      const inv1 = await repo.create({ amount: 100 });
      const inv2 = await repo.create({ amount: 200 });
      const inv3 = await repo.create({ amount: 300 });

      expect(inv1.invoiceNumber).toBe('INV-0001');
      expect(inv2.invoiceNumber).toBe('INV-0002');
      expect(inv3.invoiceNumber).toBe('INV-0003');
    });

    it('should respect custom padding and separator', async () => {
      const repo = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: sequentialId({
            prefix: 'BILL',
            model: InvoiceModel,
            padding: 6,
            separator: '/',
            counterKey: 'bill-custom-padding',
          }),
        }),
      ]);

      const doc = await repo.create({ amount: 50 });
      expect(doc.invoiceNumber).toBe('BILL/000001');
    });

    it('should use custom counter key to avoid collisions', async () => {
      const repo1 = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: sequentialId({
            prefix: 'A',
            model: InvoiceModel,
            counterKey: 'series-a',
          }),
        }),
      ]);

      const repo2 = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: sequentialId({
            prefix: 'B',
            model: InvoiceModel,
            counterKey: 'series-b',
          }),
        }),
      ]);

      const a1 = await repo1.create({ amount: 10 });
      const b1 = await repo2.create({ amount: 20 });
      const a2 = await repo1.create({ amount: 30 });

      expect(a1.invoiceNumber).toBe('A-0001');
      expect(b1.invoiceNumber).toBe('B-0001');
      expect(a2.invoiceNumber).toBe('A-0002');
    });
  });

  // ============================================================
  // dateSequentialId generator
  // ============================================================

  describe('dateSequentialId', () => {
    it('should generate monthly-partitioned IDs', async () => {
      const repo = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: dateSequentialId({
            prefix: 'BILL',
            model: InvoiceModel,
            partition: 'monthly',
          }),
        }),
      ]);

      const doc = await repo.create({ amount: 100 });

      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');

      expect(doc.invoiceNumber).toBe(`BILL-${year}-${month}-0001`);
    });

    it('should generate yearly-partitioned IDs', async () => {
      const repo = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: dateSequentialId({
            prefix: 'REF',
            model: InvoiceModel,
            partition: 'yearly',
            counterKey: 'yearly-test',
          }),
        }),
      ]);

      const doc = await repo.create({ amount: 50 });
      const year = String(new Date().getFullYear());

      expect(doc.invoiceNumber).toBe(`REF-${year}-0001`);
    });

    it('should generate daily-partitioned IDs', async () => {
      const repo = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: dateSequentialId({
            prefix: 'TXN',
            model: InvoiceModel,
            partition: 'daily',
            counterKey: 'daily-test',
          }),
        }),
      ]);

      const doc = await repo.create({ amount: 75 });
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');

      expect(doc.invoiceNumber).toBe(`TXN-${year}-${month}-${day}-0001`);
    });

    it('should increment within the same partition', async () => {
      const repo = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: dateSequentialId({
            prefix: 'B',
            model: InvoiceModel,
            partition: 'monthly',
          }),
        }),
      ]);

      const doc1 = await repo.create({ amount: 10 });
      const doc2 = await repo.create({ amount: 20 });

      // Both should have same date prefix, different seq
      const base = doc1.invoiceNumber!.slice(0, -4); // Remove "0001"
      expect(doc2.invoiceNumber).toBe(`${base}0002`);
    });
  });

  // ============================================================
  // prefixedId generator
  // ============================================================

  describe('prefixedId', () => {
    it('should generate prefixed random IDs', async () => {
      const repo = new Repository(OrderModel, [
        customIdPlugin({
          field: 'orderRef',
          generator: prefixedId({ prefix: 'ORD' }),
        }),
      ]);

      const doc = await repo.create({ total: 100 });
      expect(doc.orderRef).toBeDefined();
      expect(doc.orderRef!.startsWith('ORD_')).toBe(true);
      // Default length is 12
      expect(doc.orderRef!.length).toBe('ORD_'.length + 12);
    });

    it('should respect custom separator and length', async () => {
      const repo = new Repository(OrderModel, [
        customIdPlugin({
          field: 'orderRef',
          generator: prefixedId({ prefix: 'TX', separator: '-', length: 8 }),
        }),
      ]);

      const doc = await repo.create({ total: 50 });
      expect(doc.orderRef!.startsWith('TX-')).toBe(true);
      expect(doc.orderRef!.length).toBe('TX-'.length + 8);
    });

    it('should generate unique IDs', async () => {
      const gen = prefixedId({ prefix: 'U', length: 16 });
      const ids = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const id = gen({} as any);
        ids.add(id);
      }

      expect(ids.size).toBe(100);
    });
  });

  // ============================================================
  // customIdPlugin behavior
  // ============================================================

  describe('customIdPlugin', () => {
    it('should not overwrite existing IDs when generateOnlyIfEmpty is true (default)', async () => {
      const repo = new Repository(OrderModel, [
        customIdPlugin({
          field: 'customId',
          generator: () => 'GENERATED',
        }),
      ]);

      const doc = await repo.create({ total: 100, customId: 'ALREADY-SET' } as any);
      expect((doc as any).customId).toBe('ALREADY-SET');
    });

    it('should overwrite existing IDs when generateOnlyIfEmpty is false', async () => {
      const repo = new Repository(OrderModel, [
        customIdPlugin({
          field: 'customId',
          generator: () => 'FORCED',
          generateOnlyIfEmpty: false,
        }),
      ]);

      const doc = await repo.create({ total: 100, customId: 'OLD' } as any);
      expect((doc as any).customId).toBe('FORCED');
    });

    it('should default to customId field name', async () => {
      const repo = new Repository(OrderModel, [
        customIdPlugin({
          generator: () => 'DEFAULT-FIELD',
        }),
      ]);

      const doc = await repo.create({ total: 100 });
      expect((doc as any).customId).toBe('DEFAULT-FIELD');
    });

    it('should work with async generators', async () => {
      const repo = new Repository(OrderModel, [
        customIdPlugin({
          field: 'orderRef',
          generator: async (context) => {
            // Simulate async work
            await new Promise(resolve => setTimeout(resolve, 5));
            return `ASYNC-${(context.data as any).total}`;
          },
        }),
      ]);

      const doc = await repo.create({ total: 42 });
      expect(doc.orderRef).toBe('ASYNC-42');
    });

    it('should work with createMany', async () => {
      const repo = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: sequentialId({
            prefix: 'BULK',
            model: InvoiceModel,
            counterKey: 'bulk-test',
          }),
        }),
      ]);

      const docs = await repo.createMany([
        { amount: 10 },
        { amount: 20 },
        { amount: 30 },
      ]);

      expect(docs).toHaveLength(3);
      expect(docs[0].invoiceNumber).toBe('BULK-0001');
      expect(docs[1].invoiceNumber).toBe('BULK-0002');
      expect(docs[2].invoiceNumber).toBe('BULK-0003');
    });

    it('should skip docs that already have IDs in createMany', async () => {
      let callCount = 0;
      const repo = new Repository(InvoiceModel, [
        customIdPlugin({
          field: 'invoiceNumber',
          generator: () => {
            callCount++;
            return `GEN-${callCount}`;
          },
        }),
      ]);

      const docs = await repo.createMany([
        { amount: 10 },
        { amount: 20, invoiceNumber: 'MANUAL' } as any,
        { amount: 30 },
      ]);

      expect(docs[0].invoiceNumber).toBe('GEN-1');
      expect(docs[1].invoiceNumber).toBe('MANUAL');
      expect(docs[2].invoiceNumber).toBe('GEN-2');
    });

    it('should compose with timestampPlugin', async () => {
      const { timestampPlugin } = await import('../src/index.js');

      const TestSchema = new Schema({
        name: String,
        code: String,
        createdAt: Date,
        updatedAt: Date,
      });
      const TestModel = await createTestModel('CustomIdWithTimestamp', TestSchema);

      const repo = new Repository(TestModel, [
        timestampPlugin(),
        customIdPlugin({
          field: 'code',
          generator: sequentialId({
            prefix: 'T',
            model: TestModel,
            counterKey: 'compose-test',
          }),
        }),
      ]);

      const doc = await repo.create({ name: 'Test' });
      expect((doc as any).code).toBe('T-0001');
      expect((doc as any).createdAt).toBeDefined();
      expect((doc as any).updatedAt).toBeDefined();

      await TestModel.deleteMany({});
    });
  });
});
