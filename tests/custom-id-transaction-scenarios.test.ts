/**
 * Custom ID Plugin — real-world transactional scenarios
 *
 * Scenario-oriented integration tests (openclaw-style) that pin the
 * end-to-end contract for sequentialId / dateSequentialId + withTransaction
 * under real concurrency and multi-entity commits.
 *
 * Every scenario follows: setup → script → assert. We never mock the model
 * layer; all writes hit the replica set provided by tests/_shared/global-setup.
 *
 * Coverage:
 *   1. High-concurrency commit — 40 parallel txs, contiguous sequence.
 *   2. Commit/abort mix — counter advances only for committed txs; no gaps.
 *   3. Multi-entity atomic write — invoice + ledger + stock, all-or-nothing.
 *   4. createMany batch inside a transaction — 25 docs, one tx.
 *   5. createMany batch abort — nothing persists, counter does not advance.
 *   6. Hot-path contention — back-to-back txs sharing a counter key.
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Repository,
  customIdPlugin,
  sequentialId,
  withTransaction,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

// ============================================================
// Schemas
// ============================================================

interface IScenarioInvoice {
  _id: Types.ObjectId;
  invoiceNumber?: string;
  customer: string;
  amount: number;
}

const ScenarioInvoiceSchema = new Schema<IScenarioInvoice>({
  invoiceNumber: { type: String, index: true },
  customer: { type: String, required: true },
  amount: { type: Number, required: true },
});

interface IScenarioLedger {
  _id: Types.ObjectId;
  invoiceNumber: string;
  debit: number;
  credit: number;
}

const ScenarioLedgerSchema = new Schema<IScenarioLedger>({
  invoiceNumber: { type: String, required: true },
  debit: { type: Number, required: true },
  credit: { type: Number, required: true },
});

interface IScenarioStock {
  _id: Types.ObjectId;
  sku: string;
  qty: number;
}

const ScenarioStockSchema = new Schema<IScenarioStock>({
  sku: { type: String, required: true, unique: true },
  qty: { type: Number, required: true },
});

// ============================================================
// Counter-key scoping (parallel-fork-safe)
// ============================================================

const COUNTER_KEY_PATTERN = /^custom-id-tx-scn-/;

async function clearOwnCounters(): Promise<void> {
  try {
    await mongoose.connection
      .collection('_mongokit_counters')
      .deleteMany({ _id: { $regex: COUNTER_KEY_PATTERN } as unknown as string });
  } catch {
    // may not exist
  }
}

async function readCounter(key: string): Promise<number> {
  const doc = await mongoose.connection
    .collection('_mongokit_counters')
    .findOne({ _id: key as unknown as string });
  return doc ? (doc.seq as number) : 0;
}

describe('custom-id + withTransaction — real-world scenarios', () => {
  let InvoiceModel: mongoose.Model<IScenarioInvoice>;
  let LedgerModel: mongoose.Model<IScenarioLedger>;
  let StockModel: mongoose.Model<IScenarioStock>;

  beforeAll(async () => {
    await connectDB();
    InvoiceModel = await createTestModel('CustomIdTxScnInvoice', ScenarioInvoiceSchema);
    LedgerModel = await createTestModel('CustomIdTxScnLedger', ScenarioLedgerSchema);
    StockModel = await createTestModel('CustomIdTxScnStock', ScenarioStockSchema);
  });

  afterAll(async () => {
    await clearOwnCounters();
    await InvoiceModel.deleteMany({});
    await LedgerModel.deleteMany({});
    await StockModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await clearOwnCounters();
    await InvoiceModel.deleteMany({});
    await LedgerModel.deleteMany({});
    await StockModel.deleteMany({});
  });

  // ==========================================================================
  // Scenario 1 — N parallel transactions, every one commits
  // ==========================================================================

  it('issues contiguous sequence numbers for N parallel committing transactions', async () => {
    const CONCURRENCY = 40;
    const repo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-scn-concurrent',
        }),
      }),
    ]);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        withTransaction(mongoose.connection, async (session) =>
          repo.create({ customer: `cust-${i}`, amount: 10 + i }, { session }),
        ),
      ),
    );

    // Every invoice has a sequential number
    const numbers = results
      .map((r) => r.invoiceNumber)
      .filter((n): n is string => typeof n === 'string')
      .sort();

    expect(numbers).toHaveLength(CONCURRENCY);
    // Contiguous 0001 … 0040 (zero-padded, so string sort matches numeric)
    for (let i = 1; i <= CONCURRENCY; i++) {
      expect(numbers[i - 1]).toBe(`INV-${String(i).padStart(4, '0')}`);
    }

    // Counter landed on exactly N
    expect(await readCounter('custom-id-tx-scn-concurrent')).toBe(CONCURRENCY);

    // DB has exactly N documents, one per number
    const persisted = await InvoiceModel.find({}).lean();
    expect(persisted).toHaveLength(CONCURRENCY);
    const persistedNumbers = new Set(persisted.map((d) => d.invoiceNumber));
    expect(persistedNumbers.size).toBe(CONCURRENCY);
  });

  // ==========================================================================
  // Scenario 2 — mixed commit/abort; counter advances only for commits
  // ==========================================================================

  it('commits contiguously and skips aborted transactions without leaving gaps', async () => {
    const CONCURRENCY = 20;
    const repo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-scn-mixed',
        }),
      }),
    ]);

    // Alternate: even indices commit, odd indices abort.
    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        withTransaction(mongoose.connection, async (session) => {
          const doc = await repo.create(
            { customer: `cust-${i}`, amount: 100 },
            { session },
          );
          if (i % 2 === 1) throw new Error(`intentional abort for ${i}`);
          return doc;
        }),
      ),
    );

    const committed = outcomes.filter((o) => o.status === 'fulfilled').length;
    const aborted = outcomes.filter((o) => o.status === 'rejected').length;
    expect(committed).toBe(CONCURRENCY / 2);
    expect(aborted).toBe(CONCURRENCY / 2);

    // Persisted docs = committed count
    const persisted = await InvoiceModel.find({}).sort({ invoiceNumber: 1 }).lean();
    expect(persisted).toHaveLength(committed);

    // Sequence numbers form a contiguous 1..committed — NO GAPS
    const persistedNumbers = persisted.map((d) => d.invoiceNumber);
    for (let i = 1; i <= committed; i++) {
      expect(persistedNumbers).toContain(`INV-${String(i).padStart(4, '0')}`);
    }

    // Counter equals committed count
    expect(await readCounter('custom-id-tx-scn-mixed')).toBe(committed);
  });

  // ==========================================================================
  // Scenario 3 — multi-entity atomic commit (real accounting flow)
  // ==========================================================================

  it('writes invoice + ledger + stock decrement in one atomic tx', async () => {
    await StockModel.create({ sku: 'WIDGET-A', qty: 100 });

    const invoiceRepo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-scn-multi-commit',
        }),
      }),
    ]);
    const ledgerRepo = new Repository(LedgerModel);

    const invoice = await withTransaction(mongoose.connection, async (session) => {
      const inv = await invoiceRepo.create(
        { customer: 'Acme', amount: 250 },
        { session },
      );
      await ledgerRepo.create(
        { invoiceNumber: inv.invoiceNumber!, debit: 250, credit: 0 },
        { session },
      );
      await StockModel.updateOne(
        { sku: 'WIDGET-A' },
        { $inc: { qty: -5 } },
        { session },
      );
      return inv;
    });

    expect(invoice.invoiceNumber).toBe('INV-0001');

    const persistedInvoice = await InvoiceModel.findOne({ invoiceNumber: 'INV-0001' }).lean();
    const persistedLedger = await LedgerModel.findOne({ invoiceNumber: 'INV-0001' }).lean();
    const persistedStock = await StockModel.findOne({ sku: 'WIDGET-A' }).lean();

    expect(persistedInvoice).toBeTruthy();
    expect(persistedLedger?.debit).toBe(250);
    expect(persistedStock?.qty).toBe(95);
    expect(await readCounter('custom-id-tx-scn-multi-commit')).toBe(1);
  });

  // ==========================================================================
  // Scenario 4 — multi-entity abort; invoice + counter both rolled back
  // ==========================================================================

  it('rolls back invoice AND counter when a downstream write fails', async () => {
    await StockModel.create({ sku: 'WIDGET-B', qty: 2 });

    const invoiceRepo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-scn-multi-abort',
        }),
      }),
    ]);
    const ledgerRepo = new Repository(LedgerModel);

    await expect(
      withTransaction(mongoose.connection, async (session) => {
        const inv = await invoiceRepo.create(
          { customer: 'Oversell', amount: 99 },
          { session },
        );
        await ledgerRepo.create(
          { invoiceNumber: inv.invoiceNumber!, debit: 99, credit: 0 },
          { session },
        );
        // Simulate stock oversell check — business rule violation
        const stock = await StockModel.findOne({ sku: 'WIDGET-B' }).session(session);
        if (!stock || stock.qty < 10) {
          throw new Error('insufficient stock');
        }
      }),
    ).rejects.toThrow(/insufficient stock/);

    expect(await InvoiceModel.findOne({ customer: 'Oversell' }).lean()).toBeNull();
    expect(await LedgerModel.countDocuments({})).toBe(0);
    expect(await readCounter('custom-id-tx-scn-multi-abort')).toBe(0);

    // Stock must be untouched (no decrement attempted, but let's verify)
    const stockAfter = await StockModel.findOne({ sku: 'WIDGET-B' }).lean();
    expect(stockAfter?.qty).toBe(2);
  });

  // ==========================================================================
  // Scenario 5 — createMany in one transaction, all sequential, one commit
  // ==========================================================================

  it('assigns contiguous sequence numbers to createMany inside a single tx', async () => {
    const BATCH = 25;
    const repo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-scn-batch',
        }),
      }),
    ]);

    const docs = await withTransaction(mongoose.connection, async (session) =>
      repo.createMany(
        Array.from({ length: BATCH }, (_, i) => ({
          customer: `batch-${i}`,
          amount: i * 10,
        })),
        { session },
      ),
    );

    expect(docs).toHaveLength(BATCH);
    for (let i = 0; i < BATCH; i++) {
      expect(docs[i].invoiceNumber).toBe(`INV-${String(i + 1).padStart(4, '0')}`);
    }

    expect(await readCounter('custom-id-tx-scn-batch')).toBe(BATCH);

    const persisted = await InvoiceModel.find({}).lean();
    expect(persisted).toHaveLength(BATCH);
  });

  // ==========================================================================
  // Scenario 6 — createMany abort; nothing persists, counter untouched
  // ==========================================================================

  it('rolls back all BATCH inserts and the counter when the batch tx aborts', async () => {
    const BATCH = 15;
    const repo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-scn-batch-abort',
        }),
      }),
    ]);

    await expect(
      withTransaction(mongoose.connection, async (session) => {
        await repo.createMany(
          Array.from({ length: BATCH }, (_, i) => ({
            customer: `doomed-${i}`,
            amount: i,
          })),
          { session },
        );
        throw new Error('post-insert failure');
      }),
    ).rejects.toThrow(/post-insert failure/);

    expect(await InvoiceModel.countDocuments({})).toBe(0);
    expect(await readCounter('custom-id-tx-scn-batch-abort')).toBe(0);

    // A new tx sees a clean counter → INV-0001 on retry (no gap of BATCH).
    const retryDoc = await withTransaction(mongoose.connection, async (session) =>
      repo.create({ customer: 'retry', amount: 1 }, { session }),
    );
    expect(retryDoc.invoiceNumber).toBe('INV-0001');
  });

  // ==========================================================================
  // Scenario 7 — hot-path contention: 50 back-to-back txs on one counter
  // ==========================================================================

  it('handles 50 sequential transactional inserts without duplicate numbers', async () => {
    const N = 50;
    const repo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-scn-hot',
        }),
      }),
    ]);

    const nums: string[] = [];
    for (let i = 0; i < N; i++) {
      const doc = await withTransaction(mongoose.connection, async (session) =>
        repo.create({ customer: `hot-${i}`, amount: i }, { session }),
      );
      nums.push(doc.invoiceNumber!);
    }

    // All unique
    expect(new Set(nums).size).toBe(N);
    // Contiguous and in order
    for (let i = 0; i < N; i++) {
      expect(nums[i]).toBe(`INV-${String(i + 1).padStart(4, '0')}`);
    }
    expect(await readCounter('custom-id-tx-scn-hot')).toBe(N);
  });
});
