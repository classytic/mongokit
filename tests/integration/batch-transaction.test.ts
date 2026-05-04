/**
 * `batchTransaction(connection, repos, callback)` — multi-repo
 * transactional batch with automatic session injection.
 *
 * Replaces the per-call-site `{ session }` threading repeated across
 * ~20 sites in the classytic codebase. Each repo passed in becomes a
 * session-bound proxy inside the callback so callers don't have to
 * remember to forward the session — every CRUD call auto-injects.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batchTransaction, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrder {
  _id?: mongoose.Types.ObjectId;
  total: number;
  status: string;
}
interface IEvent {
  _id?: mongoose.Types.ObjectId;
  type: string;
  orderId?: string;
}

describe('batchTransaction — multi-repo transactional batch', () => {
  let OrderModel: mongoose.Model<IOrder>;
  let EventModel: mongoose.Model<IEvent>;
  let orderRepo: Repository<IOrder>;
  let eventRepo: Repository<IEvent>;

  beforeAll(async () => {
    await connectDB();
    OrderModel = await createTestModel(
      'BatchTxOrder',
      new Schema<IOrder>({
        total: { type: Number, required: true },
        status: { type: String, required: true },
      }),
    );
    EventModel = await createTestModel(
      'BatchTxEvent',
      new Schema<IEvent>({
        type: { type: String, required: true },
        orderId: String,
      }),
    );
  });
  afterAll(async () => {
    await OrderModel.deleteMany({});
    await EventModel.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await OrderModel.deleteMany({});
    await EventModel.deleteMany({});
    orderRepo = new Repository<IOrder>(OrderModel);
    eventRepo = new Repository<IEvent>(EventModel);
  });

  it('threads a single session across multiple bound repos (commit)', async () => {
    try {
      const result = await batchTransaction(
        mongoose.connection,
        { orders: orderRepo, events: eventRepo },
        async ({ orders, events }) => {
          // No `{ session }` argument — the bound proxy auto-injects.
          const order = await orders.create({ total: 100, status: 'pending' });
          await events.create({ type: 'order.placed', orderId: String(order._id) });
          return order;
        },
      );

      expect(result.total).toBe(100);
      // Both writes committed.
      expect(await OrderModel.countDocuments()).toBe(1);
      expect(await EventModel.countDocuments()).toBe(1);
    } catch (err) {
      // Standalone mongo without replica-set — skip.
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }
  });

  it('rolls back atomically when the callback throws', async () => {
    try {
      await expect(
        batchTransaction(
          mongoose.connection,
          { orders: orderRepo, events: eventRepo },
          async ({ orders, events }) => {
            await orders.create({ total: 100, status: 'pending' });
            await events.create({ type: 'order.placed' });
            throw new Error('rollback-test');
          },
        ),
      ).rejects.toThrow('rollback-test');
    } catch (err) {
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }

    // Neither write landed.
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await EventModel.countDocuments()).toBe(0);
  });

  it('claim() and claimVersion() inside the batch get the session auto-threaded', async () => {
    interface IRun {
      _id?: mongoose.Types.ObjectId;
      status: string;
      version: number;
    }
    const RunModel = await createTestModel(
      'BatchTxRun',
      new Schema<IRun>({
        status: { type: String, required: true },
        version: { type: Number, required: true, default: 0 },
      }),
    );
    const runRepo = new Repository<IRun>(RunModel);
    const created = await runRepo.create({ status: 'pending', version: 5 });
    const id = String(created._id);

    try {
      await batchTransaction(
        mongoose.connection,
        { runs: runRepo, events: eventRepo },
        async ({ runs, events }) => {
          // claim() with no explicit session — bound proxy injects.
          const claimed = await runs.claim(id, { from: 'pending', to: 'running' });
          expect(claimed?.status).toBe('running');

          // claimVersion() likewise.
          const versioned = await runs.claimVersion(
            id,
            { from: 5 },
            { $set: { status: 'submitted' } },
          );
          expect(versioned?.version).toBe(6);

          await events.create({ type: 'run.transitioned', orderId: id });
        },
      );
    } catch (err) {
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }

    const final = await runRepo.getById(id);
    expect(final?.status).toBe('submitted');
    expect(final?.version).toBe(6);

    await RunModel.deleteMany({});
  });

  it('returns the callback result', async () => {
    try {
      const value = await batchTransaction(
        mongoose.connection,
        { orders: orderRepo },
        async ({ orders }) => {
          const order = await orders.create({ total: 50, status: 'pending' });
          return { id: String(order._id), total: order.total };
        },
      );
      expect(value.total).toBe(50);
      expect(value.id).toBeDefined();
    } catch (err) {
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }
  });

  it('works with a single repo in the bag (degrades gracefully)', async () => {
    // Edge case: caller passes only one repo. batchTransaction should
    // still bind it correctly — same value as withTransaction(instance)
    // but with the cross-repo signature.
    try {
      await batchTransaction(
        mongoose.connection,
        { orders: orderRepo },
        async ({ orders }) => {
          await orders.create({ total: 25, status: 'pending' });
        },
      );
      expect(await OrderModel.countDocuments()).toBe(1);
    } catch (err) {
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }
  });

  it('preserves repo identity — bound proxy points at the original Model', async () => {
    // Sanity: the bound repo's `Model` (non-CRUD passthrough) should
    // reference the original model, so callers reading `bound.Model`
    // for schema introspection don't get a different model.
    try {
      let capturedModelName: string | undefined;
      await batchTransaction(
        mongoose.connection,
        { orders: orderRepo },
        async ({ orders }) => {
          capturedModelName = (orders as Repository<IOrder>).Model.modelName;
        },
      );
      expect(capturedModelName).toBe(OrderModel.modelName);
    } catch (err) {
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }
  });

  it('honors transactionOptions (forwards to underlying withTransaction)', async () => {
    try {
      // Just verify the option forwards without errors — concrete
      // assertion on readConcern/writeConcern would need a stub.
      await batchTransaction(
        mongoose.connection,
        { orders: orderRepo },
        async ({ orders }) => {
          await orders.create({ total: 10, status: 'pending' });
        },
        { transactionOptions: { readConcern: { level: 'snapshot' } } },
      );
      expect(await OrderModel.countDocuments()).toBe(1);
    } catch (err) {
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }
  });
});
