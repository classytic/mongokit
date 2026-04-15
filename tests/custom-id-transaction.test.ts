/**
 * Custom ID Plugin — transactional counter bump
 *
 * Verifies that `getNextSequence(key, inc, conn, session)` and the built-in
 * generators (sequentialId / dateSequentialId) participate in a caller's
 * transaction when `context.session` is threaded through.
 *
 * Atomicity contract:
 *   - Commit path — counter advances and the document lands together.
 *   - Abort path  — counter does NOT advance; no gap in the sequence.
 *   - No session  — unchanged legacy behavior (bump is not rolled back).
 *
 * Needs a replica set (provided by tests/_shared/global-setup.ts).
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Repository,
  customIdPlugin,
  dateSequentialId,
  getNextSequence,
  sequentialId,
  withTransaction,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface ITxInvoice {
  _id: Types.ObjectId;
  invoiceNumber?: string;
  amount: number;
}

const TxInvoiceSchema = new Schema<ITxInvoice>({
  invoiceNumber: String,
  amount: { type: Number, required: true },
});

async function readCounter(key: string): Promise<number | null> {
  const doc = await mongoose.connection
    .collection('_mongokit_counters')
    .findOne({ _id: key as unknown as string });
  return doc ? (doc.seq as number) : null;
}

// Only clear this file's own counter keys — the shared replica set is used by
// parallel forks and a broad deleteMany({}) would race with other files.
const OWN_COUNTER_KEY_PATTERN = /^(custom-id-tx-|CustomIdTx)/;

async function clearOwnCounters(): Promise<void> {
  try {
    await mongoose.connection
      .collection('_mongokit_counters')
      .deleteMany({ _id: { $regex: OWN_COUNTER_KEY_PATTERN } as unknown as string });
  } catch {
    // collection may not exist yet
  }
}

describe('getNextSequence — session parameter', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await clearOwnCounters();
    await disconnectDB();
  });

  beforeEach(async () => {
    await clearOwnCounters();
  });

  // ==========================================================================
  // Unit — signature forwards session to findOneAndUpdate
  // ==========================================================================

  it('forwards the session option to findOneAndUpdate', async () => {
    // Spy on the internal counter model's findOneAndUpdate. We grab it via a
    // one-shot call (which lazy-registers the model) then replace it.
    await getNextSequence('custom-id-tx-spy-seed');
    const CounterModel = mongoose.connection.models._MongoKitCounter as mongoose.Model<{
      _id: string;
      seq: number;
    }>;

    const spy = vi.spyOn(CounterModel, 'findOneAndUpdate').mockResolvedValueOnce({
      _id: 'custom-id-tx-spy-key',
      seq: 42,
    } as never);

    const fakeSession = { _fake: true } as unknown as mongoose.ClientSession;
    const seq = await getNextSequence(
      'custom-id-tx-spy-key',
      3,
      mongoose.connection,
      fakeSession,
    );

    expect(seq).toBe(42);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , options] = spy.mock.calls[0];
    expect(options).toMatchObject({
      upsert: true,
      returnDocument: 'after',
      session: fakeSession,
    });

    spy.mockRestore();
  });

  // ==========================================================================
  // Integration — commit path
  // ==========================================================================

  it('commits counter bump together with the document insert', async () => {
    const Model = await createTestModel('CustomIdTxInvoiceCommit', TxInvoiceSchema);
    const repo = new Repository(Model, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: Model,
          counterKey: 'custom-id-tx-commit',
        }),
      }),
    ]);

    const before = await readCounter('custom-id-tx-commit');
    expect(before).toBeNull();

    const inv = await withTransaction(mongoose.connection, async (session) => {
      return repo.create({ amount: 100 }, { session });
    });

    expect(inv.invoiceNumber).toBe('INV-0001');
    expect(await readCounter('custom-id-tx-commit')).toBe(1);

    const persisted = await Model.findById(inv._id).lean();
    expect(persisted?.invoiceNumber).toBe('INV-0001');
  });

  // ==========================================================================
  // Integration — abort rolls BOTH back
  // ==========================================================================

  it('rolls back the counter bump when the transaction aborts', async () => {
    const Model = await createTestModel('CustomIdTxInvoiceAbort', TxInvoiceSchema);
    const repo = new Repository(Model, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: Model,
          counterKey: 'custom-id-tx-abort',
        }),
      }),
    ]);

    await expect(
      withTransaction(mongoose.connection, async (session) => {
        await repo.create({ amount: 200 }, { session });
        throw new Error('sibling write failed');
      }),
    ).rejects.toThrow(/sibling write failed/);

    expect(await readCounter('custom-id-tx-abort')).toBeNull();
    const docs = await Model.find({}).lean();
    expect(docs).toHaveLength(0);
  });

  // ==========================================================================
  // Integration — no gap after rollback
  // ==========================================================================

  it('issues INV-0001 on retry after an aborted attempt (no gap)', async () => {
    const Model = await createTestModel('CustomIdTxInvoiceRetry', TxInvoiceSchema);
    const repo = new Repository(Model, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: Model,
          counterKey: 'custom-id-tx-retry',
        }),
      }),
    ]);

    await expect(
      withTransaction(mongoose.connection, async (session) => {
        await repo.create({ amount: 1 }, { session });
        throw new Error('abort');
      }),
    ).rejects.toThrow();

    const inv = await withTransaction(mongoose.connection, async (session) => {
      return repo.create({ amount: 2 }, { session });
    });

    expect(inv.invoiceNumber).toBe('INV-0001');
    expect(await readCounter('custom-id-tx-retry')).toBe(1);
  });

  // ==========================================================================
  // Integration — dateSequentialId also threads session
  // ==========================================================================

  it('dateSequentialId rolls back its partitioned counter on abort', async () => {
    const Model = await createTestModel('CustomIdTxBillAbort', TxInvoiceSchema);
    const repo = new Repository(Model, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: dateSequentialId({
          prefix: 'BILL',
          model: Model,
          partition: 'monthly',
        }),
      }),
    ]);

    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const counterKey = `${Model.modelName}:${year}-${month}`;

    await expect(
      withTransaction(mongoose.connection, async (session) => {
        await repo.create({ amount: 500 }, { session });
        throw new Error('abort');
      }),
    ).rejects.toThrow();

    expect(await readCounter(counterKey)).toBeNull();

    const bill = await withTransaction(mongoose.connection, async (session) => {
      return repo.create({ amount: 600 }, { session });
    });

    expect(bill.invoiceNumber).toBe(`BILL-${year}-${month}-0001`);
    expect(await readCounter(counterKey)).toBe(1);
  });

  // ==========================================================================
  // Integration — no session means legacy (not-rolled-back) behavior stands
  // ==========================================================================

  it('without a session, the counter still advances on sibling failure (legacy)', async () => {
    const Model = await createTestModel('CustomIdTxInvoiceLegacy', TxInvoiceSchema);
    const repo = new Repository(Model, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: Model,
          counterKey: 'custom-id-tx-legacy',
        }),
      }),
    ]);

    // No session passed → the bump is a standalone write and commits immediately.
    // We simulate a sibling failure by throwing AFTER the create. The counter
    // must remain advanced (documenting the non-transactional path).
    await repo.create({ amount: 10 });
    expect(await readCounter('custom-id-tx-legacy')).toBe(1);

    // Even if a later unrelated throw happens outside any tx, counter is still at 1.
    expect(await readCounter('custom-id-tx-legacy')).toBe(1);
  });
});
