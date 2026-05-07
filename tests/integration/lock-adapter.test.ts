/**
 * Integration tests for the Mongo-backed `LockAdapter`.
 *
 * Runs against the shared MongoMemoryServer started by `globalSetup`.
 * Each test uses a unique lock name so parallel files don't collide.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongoLockAdapter } from '../../src/lock/index.js';
import { clearDB, connectDB, disconnectDB, getMongoUri } from '../setup.js';

const A = 'replica-A';
const B = 'replica-B';

describe('createMongoLockAdapter', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await clearDB();
  });

  it('first replica wins; second replica observes contention', async () => {
    const lock = createMongoLockAdapter({ collectionName: 'lock_test_basic' });
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
    expect(await lock.tryAcquire('cron.outbox', B, 5_000)).toBe(false);
  });

  it('same holder may extend (idempotent)', async () => {
    const lock = createMongoLockAdapter({ collectionName: 'lock_test_extend' });
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(true);
  });

  it('expired lease is reclaimable by a different replica', async () => {
    const lock = createMongoLockAdapter({ collectionName: 'lock_test_expiry' });
    // Acquire with a 1ms lease and let it expire.
    expect(await lock.tryAcquire('cron.outbox', A, 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(await lock.tryAcquire('cron.outbox', B, 5_000)).toBe(true);
    // A is now locked out — B owns it.
    expect(await lock.tryAcquire('cron.outbox', A, 5_000)).toBe(false);
  });

  it('release(): only the holder can release', async () => {
    const lock = createMongoLockAdapter({ collectionName: 'lock_test_release' });
    await lock.tryAcquire('cron.outbox', A, 5_000);
    expect(await lock.release('cron.outbox', B)).toBe(false);
    expect(await lock.release('cron.outbox', A)).toBe(true);
    // Released → next acquire wins.
    expect(await lock.tryAcquire('cron.outbox', B, 5_000)).toBe(true);
  });

  it('release() on an unheld lock returns false (idempotent)', async () => {
    const lock = createMongoLockAdapter({ collectionName: 'lock_test_release_unheld' });
    expect(await lock.release('never.acquired', A)).toBe(false);
  });

  it('inspect() reports the current holder', async () => {
    const lock = createMongoLockAdapter({ collectionName: 'lock_test_inspect' });
    await lock.tryAcquire('cron.outbox', A, 5_000);
    const state = await lock.inspect?.('cron.outbox');
    expect(state).toBeTruthy();
    expect(state?.name).toBe('cron.outbox');
    expect(state?.holder).toBe(A);
    expect(state?.expiresAt).toBeInstanceOf(Date);
    expect(state?.acquiredAt).toBeInstanceOf(Date);
  });

  it('inspect() returns null after expiry (even before TTL sweep)', async () => {
    const lock = createMongoLockAdapter({ collectionName: 'lock_test_inspect_expired' });
    await lock.tryAcquire('cron.outbox', A, 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(await lock.inspect?.('cron.outbox')).toBeNull();
  });

  it('parallel acquires resolve to exactly one winner', async () => {
    // Use a unique model name so this test starts from a clean slate
    // (no doc to filter on; the upsert race is exercised).
    const lock = createMongoLockAdapter({
      collectionName: 'lock_test_race',
      modelName: 'MongoLockRace',
    });
    const results = await Promise.all([
      lock.tryAcquire('shared.name', A, 5_000),
      lock.tryAcquire('shared.name', B, 5_000),
    ]);
    expect(results.filter((r) => r === true)).toHaveLength(1);
  });

  it('multi-connection race: 5 separate Mongoose connections → exactly 1 winner', async () => {
    // The "parallel acquires" test above runs both promises through
    // ONE Mongoose connection — atomicity is enforced by the
    // server's WT engine. This test goes further: each "replica"
    // gets its OWN Mongoose connection (its own TCP socket, its
    // own client metadata). That genuinely simulates a multi-pod
    // deployment where replicas don't share a connection pool. If
    // the adapter or the server-side primitive ever drifted to
    // "atomic only within one connection," this would catch it.
    const uri = getMongoUri();
    const conns = await Promise.all(
      Array.from({ length: 5 }, () => mongoose.createConnection(uri).asPromise()),
    );
    try {
      const adapters = conns.map((conn, i) =>
        createMongoLockAdapter({
          connection: conn,
          collectionName: 'lock_test_multi_conn',
          modelName: `MongoLockMultiConn_${i}`,
        }),
      );
      const results = await Promise.all(
        adapters.map((a, i) => a.tryAcquire('multi.conn', `replica-${i}`, 5_000)),
      );
      expect(results.filter((r) => r === true)).toHaveLength(1);
    } finally {
      // Drop the collection BEFORE closing connections so the next
      // run starts clean even if a prior assertion failed.
      try {
        await conns[0]?.collection('lock_test_multi_conn').deleteMany({});
      } catch {
        // best-effort
      }
      await Promise.all(conns.map((c) => c.close()));
    }
  });

  it('clock-skew behaviour: a future-clock replica steals early (documented)', async () => {
    // The Mongo adapter uses `new Date()` (CLIENT clock) for both
    // the `expiresAt: { $lt: now }` filter and the `expiresAt`
    // value it writes. If client clocks drift, a "future-clock"
    // replica considers an unexpired lease expired and steals it.
    //
    // This is documented behaviour: hosts MUST keep replica
    // clocks synchronised within `leaseMs` (NTP / chrony). The
    // test pins the trade-off so a future change to "use server
    // clock via $$NOW" surfaces here.
    const lock = createMongoLockAdapter({
      collectionName: 'lock_test_skew',
      modelName: 'MongoLockSkew',
    });
    await lock.tryAcquire('skewed', A, 60_000);

    const realDate = global.Date;
    try {
      // Simulate B's clock running 2 minutes ahead. From B's view
      // the lease (60s long) is already expired, so B steals.
      const skewMs = 120_000;
      const SkewedDate: typeof Date = class extends realDate {
        constructor(...args: ConstructorParameters<typeof Date>) {
          if (args.length === 0) {
            super(realDate.now() + skewMs);
            return;
          }
          // biome-ignore lint/suspicious/noExplicitAny: passthrough to Date constructor
          super(...(args as any));
        }
        static override now() {
          return realDate.now() + skewMs;
        }
      } as unknown as typeof Date;
      // biome-ignore lint/suspicious/noExplicitAny: global.Date assignment for time mocking
      (global as any).Date = SkewedDate;

      // B steals — its filter sees the lease as expired.
      expect(await lock.tryAcquire('skewed', B, 60_000)).toBe(true);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore Date
      (global as any).Date = realDate;
    }
  });
});
