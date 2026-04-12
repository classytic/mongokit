/**
 * withTransaction tests
 *
 * Exercises `withTransaction(connection, cb)` (module-level) and
 * `Repository#withTransaction` (instance method) against the single-node
 * replica set provisioned by `tests/_shared/global-setup.ts`. Both entry
 * points delegate to the same helper in `src/transaction.ts` — we verify
 * both take the transactional path, not the standalone fallback.
 *
 * Replica-set coverage (this file):
 *   - Happy path commit persists multi-repo writes atomically.
 *   - Throwing inside the callback rolls BOTH writes back (real atomicity).
 *   - `onFallback` is NOT invoked when the topology supports transactions.
 *   - `allowFallback: false` commits normally when real transactions work.
 *   - Application errors propagate (not masked by retry machinery).
 *   - Instance method matches module-level semantics.
 *
 * Standalone-only behaviors — `onFallback` firing, error code 263
 * classification — are covered as pure unit tests in the
 * `isTransactionUnsupported` block at the bottom. They don't need a real
 * standalone server; they just need the error objects.
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository, isTransactionUnsupported, withTransaction } from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IOrder {
  _id: Types.ObjectId;
  sku: string;
  qty: number;
}

interface ILedgerEntry {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  amount: number;
}

const OrderSchema = new Schema<IOrder>({
  sku: { type: String, required: true },
  qty: { type: Number, required: true },
});

const LedgerSchema = new Schema<ILedgerEntry>({
  orderId: { type: Schema.Types.ObjectId, required: true },
  amount: { type: Number, required: true },
});

describe('module-level withTransaction (replica set)', () => {
  let OrderModel: mongoose.Model<IOrder>;
  let LedgerModel: mongoose.Model<ILedgerEntry>;
  let orderRepo: Repository<IOrder>;
  let ledgerRepo: Repository<ILedgerEntry>;

  beforeAll(async () => {
    await connectDB();
    OrderModel = await createTestModel('TxOrder', OrderSchema);
    LedgerModel = await createTestModel('TxLedger', LedgerSchema);
    orderRepo = new Repository<IOrder>(OrderModel);
    ledgerRepo = new Repository<ILedgerEntry>(LedgerModel);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await OrderModel.deleteMany({});
    await LedgerModel.deleteMany({});
  });

  // ==========================================================================
  // Happy path — real commit
  // ==========================================================================

  it('commits multi-repo writes atomically and returns the callback result', async () => {
    const result = await withTransaction(
      mongoose.connection,
      async (session) => {
        const order = await orderRepo.create({ sku: 'SKU-1', qty: 3 }, { session });
        await ledgerRepo.create(
          { orderId: order._id, amount: 300 },
          { session },
        );
        return { orderId: order._id };
      },
    );

    expect(result.orderId).toBeDefined();

    const orders = await OrderModel.find({}).lean();
    const ledger = await LedgerModel.find({}).lean();
    expect(orders).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(String(ledger[0].orderId)).toBe(String(orders[0]._id));
  });

  it('passes the same ClientSession object for every call in the callback', async () => {
    const seen: unknown[] = [];
    await withTransaction(mongoose.connection, async (session) => {
      seen.push(session);
      await orderRepo.create({ sku: 'A', qty: 1 }, { session });
      seen.push(session);
      await ledgerRepo.create(
        { orderId: new mongoose.Types.ObjectId(), amount: 10 },
        { session },
      );
      seen.push(session);
    });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    const first = seen[0];
    for (const s of seen) {
      expect(s).toBe(first);
    }
  });

  // ==========================================================================
  // Atomicity — the reason withTransaction exists
  // ==========================================================================

  it('rolls back EVERY write when the callback throws (real atomicity)', async () => {
    await expect(
      withTransaction(mongoose.connection, async (session) => {
        const order = await orderRepo.create(
          { sku: 'ROLLBACK', qty: 99 },
          { session },
        );
        await ledgerRepo.create(
          { orderId: order._id, amount: 9999 },
          { session },
        );
        throw new Error('business rule violation');
      }),
    ).rejects.toThrow(/business rule violation/);

    // Neither write should be visible after the throw.
    const orders = await OrderModel.find({ sku: 'ROLLBACK' }).lean();
    const ledger = await LedgerModel.find({ amount: 9999 }).lean();
    expect(orders).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });

  it('does not roll back writes from a previous successful transaction', async () => {
    // Prior tx commits cleanly.
    await withTransaction(mongoose.connection, async (session) => {
      await orderRepo.create({ sku: 'KEEPER', qty: 1 }, { session });
    });

    // Next tx fails — must not affect the first.
    await expect(
      withTransaction(mongoose.connection, async (session) => {
        await orderRepo.create({ sku: 'DOOMED', qty: 1 }, { session });
        throw new Error('fail');
      }),
    ).rejects.toThrow();

    const keepers = await OrderModel.find({ sku: 'KEEPER' }).lean();
    const doomed = await OrderModel.find({ sku: 'DOOMED' }).lean();
    expect(keepers).toHaveLength(1);
    expect(doomed).toHaveLength(0);
  });

  // ==========================================================================
  // Fallback path — should NOT fire on a real replica set
  // ==========================================================================

  it('does NOT invoke onFallback when the topology supports transactions', async () => {
    const fallbackSpy = vi.fn();
    await withTransaction(
      mongoose.connection,
      async (session) => {
        await orderRepo.create({ sku: 'B', qty: 2 }, { session });
      },
      { allowFallback: true, onFallback: fallbackSpy },
    );

    expect(fallbackSpy).not.toHaveBeenCalled();

    // Write actually committed.
    const docs = await OrderModel.find({ sku: 'B' }).lean();
    expect(docs).toHaveLength(1);
  });

  it('commits normally with allowFallback:false on a real replica set', async () => {
    await withTransaction(
      mongoose.connection,
      async (session) => {
        await orderRepo.create({ sku: 'NOFB', qty: 4 }, { session });
      },
      { allowFallback: false },
    );

    const docs = await OrderModel.find({ sku: 'NOFB' }).lean();
    expect(docs).toHaveLength(1);
  });

  // ==========================================================================
  // Error propagation
  // ==========================================================================

  it('propagates application errors thrown inside the callback', async () => {
    await expect(
      withTransaction(mongoose.connection, async () => {
        throw new Error('business rule violation');
      }),
    ).rejects.toThrow(/business rule violation/);
  });

  // ==========================================================================
  // Parity: instance method delegates to the same helper
  // ==========================================================================

  it('Repository.withTransaction delegates with identical semantics', async () => {
    const result = await orderRepo.withTransaction(async (session) => {
      return orderRepo.create({ sku: 'INSTANCE', qty: 7 }, { session });
    });

    expect(result.sku).toBe('INSTANCE');
    const docs = await OrderModel.find({ sku: 'INSTANCE' }).lean();
    expect(docs).toHaveLength(1);
  });

  it('Repository.withTransaction also rolls back on error', async () => {
    await expect(
      orderRepo.withTransaction(async (session) => {
        await orderRepo.create({ sku: 'INSTANCE-FAIL', qty: 1 }, { session });
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);

    const docs = await OrderModel.find({ sku: 'INSTANCE-FAIL' }).lean();
    expect(docs).toHaveLength(0);
  });
});

// ============================================================================
// isTransactionUnsupported — pure unit tests, no DB
// ============================================================================

describe('isTransactionUnsupported', () => {
  it('classifies error code 263 as unsupported (standalone server)', () => {
    const err = Object.assign(new Error('standalone'), { code: 263 });
    expect(isTransactionUnsupported(err)).toBe(true);
  });

  it('classifies error code 20 as unsupported (unsupported topology)', () => {
    const err = Object.assign(new Error('topology'), { code: 20 });
    expect(isTransactionUnsupported(err)).toBe(true);
  });

  it('classifies replica-set message as unsupported', () => {
    const err = new Error(
      'Transaction numbers are only allowed on a replica set member or mongos',
    );
    expect(isTransactionUnsupported(err)).toBe(true);
  });

  it('classifies "transaction is not supported" message', () => {
    const err = new Error('Transaction is not supported here');
    expect(isTransactionUnsupported(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isTransactionUnsupported(new Error('validation failed'))).toBe(false);
    expect(
      isTransactionUnsupported(Object.assign(new Error('dup key'), { code: 11000 })),
    ).toBe(false);
  });
});
