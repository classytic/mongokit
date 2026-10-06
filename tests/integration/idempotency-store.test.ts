/**
 * The mongo claim store is held to the SAME conformance suite every
 * `IdempotencyClaimStore` must pass — on a real replica set, so the concurrency
 * cases exercise real unique-index and single-document atomicity.
 */
import { runIdempotent } from '@classytic/repo-core/idempotency';
import { runIdempotencyStoreConformance } from '@classytic/repo-core/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdempotencyModel, createIdempotencyStore } from '../../src/idempotency/index.js';
import { connectDB, disconnectDB } from '../setup.js';

describe('mongo idempotency store', () => {
  let model: ReturnType<typeof createIdempotencyModel>;

  beforeAll(async () => {
    await connectDB();
    model = createIdempotencyModel(mongoose.connection, { collection: 'idempotency_conformance', modelName: 'IdempotencyConformance' });
    await model.deleteMany({});
    await model.syncIndexes();
  });

  afterAll(async () => {
    await model.deleteMany({});
    await disconnectDB();
  });

  describe('conformance', () => {
    runIdempotencyStoreConformance({ createStore: () => createIdempotencyStore(model) });
  });

  it('a claim written in the caller\'s transaction rolls back WITH it', async () => {
    const store = createIdempotencyStore(model);
    const identity = { operation: 'txn.check', key: `k-${Date.now()}` };
    const session = await mongoose.startSession();
    try {
      await session
        .withTransaction(async () => {
          await runIdempotent({
            store,
            identity,
            requestFingerprint: 'fp',
            storeOptions: { session },
            execute: async () => ({ orderNumber: 'ORD-1' }),
          });
          throw new Error('the order write failed — abort');
        })
        .catch(() => undefined);
    } finally {
      await session.endSession();
    }
    // A committed claim here would replay an order that was rolled back.
    expect(await store.get(identity)).toBeNull();
  });

  it('has the retention TTL index', async () => {
    const indexes = await model.collection.indexes();
    expect(indexes.find((i) => i.name === 'retention')).toMatchObject({ key: { purgeAt: 1 }, expireAfterSeconds: 0 });
  });

  it('stamps purgeAt from retentionSeconds on every write', async () => {
    const store = createIdempotencyStore(model, { retentionSeconds: 60 });
    const identity = { operation: 'retention.check', key: `k-${Date.now()}` };
    const before = Date.now();
    await runIdempotent({ store, identity, requestFingerprint: 'fp', execute: async () => 1 });
    const doc = (await model.collection.findOne({ 'identity.key': identity.key })) as { purgeAt: Date } | null;
    expect(doc?.purgeAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(doc?.purgeAt.getTime()).toBeLessThan(before + 120_000);
  });
});
