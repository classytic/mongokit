/**
 * `createMongoDailyLedger` — Mongo implementation of arc's `DailyLedger`
 * contract (one claim per key + civil date, stale re-grant, complete,
 * release), plus the lock adapter's injectable clock.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongoDailyLedger, createMongoLockAdapter } from '../../src/lock/index.js';
import { clearDB, connectDB, disconnectDB } from '../setup.js';

const T0 = new Date('2026-10-30T06:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = '2026-10-30';

describe('createMongoDailyLedger', () => {
  beforeAll(async () => {
    await connectDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });
  beforeEach(async () => {
    await clearDB();
  });

  const ledger = () =>
    createMongoDailyLedger({
      collectionName: 'daily_ledger_test',
      modelName: 'DailyLedgerTest',
      nowFn: () => at(5_000),
    });

  it('exactly one of N concurrent claimers wins a day', async () => {
    const l = ledger();
    const wins = await Promise.all(
      Array.from({ length: 8 }, () => l.claimDay('digest', DAY, { now: T0 })),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
    const wins2 = await Promise.all(
      Array.from({ length: 8 }, () => l.claimDay('digest', DAY, { now: T0, staleAfterMs: 60_000 })),
    );
    expect(wins2.filter(Boolean)).toHaveLength(0);
  });

  it('keys and days are independent', async () => {
    const l = ledger();
    expect(await l.claimDay('a', DAY, { now: T0 })).toBe(true);
    expect(await l.claimDay('b', DAY, { now: T0 })).toBe(true);
    expect(await l.claimDay('a', '2026-10-31', { now: T0 })).toBe(true);
    expect(await l.claimDay('a', DAY, { now: T0 })).toBe(false);
  });

  it('re-grants an uncompleted stale claim, never a completed one', async () => {
    const l = ledger();
    expect(await l.claimDay('job', DAY, { now: T0, staleAfterMs: 60_000 })).toBe(true);
    // Not yet stale.
    expect(await l.claimDay('job', DAY, { now: at(30_000), staleAfterMs: 60_000 })).toBe(false);
    // Stale: re-granted with the new claim time.
    expect(await l.claimDay('job', DAY, { now: at(61_000), staleAfterMs: 60_000 })).toBe(true);
    expect((await l.inspect('job', DAY))?.claimedAt.getTime()).toBe(at(61_000).getTime());

    await l.completeDay('job', DAY, { sent: 3 });
    const row = await l.inspect('job', DAY);
    expect(row).toMatchObject({ completed: true, result: { sent: 3 } });
    expect(row?.completedAt?.getTime()).toBe(at(5_000).getTime());
    expect(await l.claimDay('job', DAY, { now: at(999_999_999), staleAfterMs: 1 })).toBe(false);
  });

  it('releaseDay drops an uncompleted claim but keeps a completed day', async () => {
    const l = ledger();
    await l.claimDay('r', DAY, { now: T0 });
    await l.releaseDay('r', DAY);
    expect(await l.inspect('r', DAY)).toBeNull();
    expect(await l.claimDay('r', DAY, { now: T0 })).toBe(true);
    await l.completeDay('r', DAY);
    await l.releaseDay('r', DAY);
    expect((await l.inspect('r', DAY))?.completed).toBe(true);
  });

  it('fences complete / release to the replica holding the current claim', async () => {
    const a = ledger();
    const b = ledger();
    expect(await a.claimDay('f', DAY, { now: T0, staleAfterMs: 60_000 })).toBe(true);
    // A overruns; B re-grants the stale claim.
    expect(await b.claimDay('f', DAY, { now: at(61_000), staleAfterMs: 60_000 })).toBe(true);
    // A's late failure must not drop B's in-flight claim.
    await a.releaseDay('f', DAY);
    expect((await a.inspect('f', DAY))?.claimedAt.getTime()).toBe(at(61_000).getTime());

    // Nor may A's late success mark B's run complete (fresh day).
    const D2 = '2026-10-31';
    expect(await a.claimDay('f', D2, { now: T0, staleAfterMs: 60_000 })).toBe(true);
    expect(await b.claimDay('f', D2, { now: at(61_000), staleAfterMs: 60_000 })).toBe(true);
    await a.completeDay('f', D2, { by: 'a' });
    expect((await b.inspect('f', D2))?.completed).toBe(false);
    await b.completeDay('f', D2, { by: 'b' });
    expect(await b.inspect('f', D2)).toMatchObject({ completed: true, result: { by: 'b' } });
    await b.completeDay('f', DAY, { by: 'b' });
    expect(await b.inspect('f', DAY)).toMatchObject({ completed: true, result: { by: 'b' } });
  });

  it('releaseDay is a no-op on a ledger that holds no claim for the day', async () => {
    const a = ledger();
    const other = ledger();
    await a.claimDay('n', DAY, { now: T0 });
    await other.releaseDay('n', DAY);
    expect(await a.inspect('n', DAY)).not.toBeNull();
  });

  it('rejects a negative or non-finite staleAfterMs', async () => {
    const l = ledger();
    await expect(l.claimDay('s', DAY, { now: T0, staleAfterMs: -1 })).rejects.toThrow(
      /staleAfterMs/,
    );
    await expect(l.claimDay('s', DAY, { now: T0, staleAfterMs: Number.NaN })).rejects.toThrow(
      /staleAfterMs/,
    );
    expect(await l.inspect('s', DAY)).toBeNull();
  });

  it('validates the civil date and the claim clock', async () => {
    const l = ledger();
    await expect(l.claimDay('x', '2026-10-30T00:00', { now: T0 })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(l.claimDay('', DAY, { now: T0 })).rejects.toThrow(/non-empty/);
    await expect(l.claimDay('x', DAY, { now: new Date('bad') })).rejects.toThrow(/valid Date/);
  });

  // ── Per-invocation fencing (review P1) ──────────────────────────────────
  // Ownership belongs to the invocation that won the claim, not to the
  // ledger instance: a stale re-grant by the SAME instance must not hand the
  // newer claim to the older, still-running invocation.

  /** A promise plus its resolver, to interleave two invocations deterministically. */
  const gate = () => {
    let open!: () => void;
    const wait = new Promise<void>((r) => {
      open = r;
    });
    return { open, wait };
  };

  it('same instance re-grant: the older invocation cannot release the newer claim', async () => {
    const l = ledger();
    const g1 = gate();
    const claimed = gate();
    const inv1 = (async () => {
      const won = await l.claimDay('p', DAY, { now: T0, staleAfterMs: 60_000 });
      claimed.open();
      await g1.wait;
      await l.releaseDay('p', DAY); // the overrun run fails late
      return won;
    })();
    await claimed.wait;
    const inv2 = (async () => l.claimDay('p', DAY, { now: at(61_000), staleAfterMs: 60_000 }))();
    expect(await inv2).toBe(true);
    g1.open();
    expect(await inv1).toBe(true);
    const row = await l.inspect('p', DAY);
    expect(row).not.toBeNull();
    expect(row?.claimedAt.getTime()).toBe(at(61_000).getTime());
    expect(row?.completed).toBe(false);
  });

  it('same instance re-grant: each invocation completes only its own claim', async () => {
    const l = ledger();
    const g1 = gate();
    const g2 = gate();
    const claimed = gate();
    const inv1 = (async () => {
      await l.claimDay('q', DAY, { now: T0, staleAfterMs: 60_000 });
      claimed.open();
      await g1.wait;
      await l.completeDay('q', DAY, { by: 'inv1' });
    })();
    await claimed.wait;
    const claimed2 = gate();
    const inv2 = (async () => {
      await l.claimDay('q', DAY, { now: at(61_000), staleAfterMs: 60_000 });
      claimed2.open();
      await g2.wait;
      await l.completeDay('q', DAY, { by: 'inv2' });
    })();
    await claimed2.wait;
    g1.open();
    await inv1;
    // The older invocation's late success must not complete the newer claim.
    expect((await l.inspect('q', DAY))?.completed).toBe(false);
    g2.open();
    await inv2;
    expect(await l.inspect('q', DAY)).toMatchObject({ completed: true, result: { by: 'inv2' } });
  });

  it('a retried stale completion stays fenced (never falls through to an unfenced completion)', async () => {
    const a = ledger();
    const b = ledger();
    expect(await a.claimDay('r2', DAY, { now: T0, staleAfterMs: 60_000 })).toBe(true);
    expect(await b.claimDay('r2', DAY, { now: at(61_000), staleAfterMs: 60_000 })).toBe(true);
    await a.completeDay('r2', DAY, { by: 'a' });
    await a.completeDay('r2', DAY, { by: 'a' }); // retry after the fenced no-op
    expect((await b.inspect('r2', DAY))?.completed).toBe(false);
    await b.completeDay('r2', DAY, { by: 'b' });
    expect(await b.inspect('r2', DAY)).toMatchObject({ completed: true, result: { by: 'b' } });
  });

  it('completeDay on a ledger holding no claim is a no-op; adminCompleteDay is the explicit path', async () => {
    const a = ledger();
    const admin = ledger();
    expect(await a.claimDay('m', DAY, { now: T0 })).toBe(true);
    await admin.completeDay('m', DAY, { by: 'admin' });
    expect((await a.inspect('m', DAY))?.completed).toBe(false);
    expect(await admin.adminCompleteDay('m', DAY, { by: 'admin' })).toBe(true);
    expect(await a.inspect('m', DAY)).toMatchObject({ completed: true, result: { by: 'admin' } });
    // Already complete: nothing left to complete.
    expect(await admin.adminCompleteDay('m', DAY, { by: 'again' })).toBe(false);
    expect((await a.inspect('m', DAY))?.result).toEqual({ by: 'admin' });
  });

  it('claim() returns a per-invocation handle whose complete/release are fenced by its token', async () => {
    const l = ledger();
    const first = await l.claim('h', DAY, { now: T0, staleAfterMs: 60_000 });
    expect(first).not.toBeNull();
    expect(await l.claim('h', DAY, { now: at(1_000), staleAfterMs: 60_000 })).toBeNull();
    const second = await l.claim('h', DAY, { now: at(61_000), staleAfterMs: 60_000 });
    expect(second).not.toBeNull();
    expect(second?.token).not.toBe(first?.token);
    expect(await first?.release()).toBe(false);
    expect(await first?.complete({ by: 'first' })).toBe(false);
    expect((await l.inspect('h', DAY))?.completed).toBe(false);
    expect(await second?.complete({ by: 'second' })).toBe(true);
    expect(await second?.complete({ by: 'again' })).toBe(false);
    expect(await l.inspect('h', DAY)).toMatchObject({ completed: true, result: { by: 'second' } });
    // A handle's release drops its own uncompleted claim.
    const d2 = await l.claim('h', '2026-10-31', { now: T0 });
    expect(await d2?.release()).toBe(true);
    expect(await l.inspect('h', '2026-10-31')).toBeNull();
  });
});

describe('createMongoLockAdapter — nowFn', () => {
  beforeAll(async () => {
    await connectDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });

  it('drives expiry and inspect from the injected clock', async () => {
    // Far-future base so the TTL monitor never prunes the row mid-test.
    const B0 = new Date('2099-01-01T00:00:00.000Z');
    let clock = B0;
    const lock = createMongoLockAdapter({
      collectionName: 'lock_test_clock',
      modelName: 'MongoLockClockTest',
      nowFn: () => clock,
    });
    expect(await lock.tryAcquire('job', 'A', 5_000)).toBe(true);
    expect((await lock.inspect('job'))?.expiresAt.getTime()).toBe(B0.getTime() + 5_000);
    expect(await lock.tryAcquire('job', 'B', 5_000)).toBe(false);
    clock = new Date(B0.getTime() + 5_001);
    expect(await lock.inspect('job')).toBeNull();
    expect(await lock.tryAcquire('job', 'B', 5_000)).toBe(true);
    await lock.release('job', 'B');
  });
});
