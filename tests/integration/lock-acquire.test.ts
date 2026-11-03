/**
 * `createMongoLockAdapter().acquire()` (G-MON-4): the outcome of ONE atomic write, with the
 * previous holder of the row, so a caller that records "who held it before" never reads first.
 * `tryAcquire` is unchanged (its own suite: `lock-adapter.test.ts`).
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongoLockAdapter } from '../../src/lock/index.js';
import { clearDB, connectDB, disconnectDB } from '../setup.js';

const A = 'replica-A';
const B = 'replica-B';
const BASE = Date.parse('2030-01-01T00:00:00.000Z');

function clocked(collectionName: string) {
  let at = BASE;
  const lock = createMongoLockAdapter({
    collectionName,
    modelName: collectionName,
    nowFn: () => new Date(at),
  });
  return {
    lock,
    advance: (ms: number) => {
      at += ms;
    },
    at: () => new Date(at),
  };
}

describe('createMongoLockAdapter().acquire', () => {
  beforeAll(async () => {
    await connectDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });
  beforeEach(async () => {
    await clearDB();
  });

  it('a free lock: acquired, no previous holder, acquiredAt = now', async () => {
    const { lock, at } = clocked('lock_acq_free');
    const got = await lock.acquire('room', A, 5_000);
    expect(got).toEqual({
      acquired: true,
      holder: A,
      acquiredAt: at(),
      expiresAt: new Date(at().getTime() + 5_000),
    });
    expect('previousHolder' in got).toBe(false);
  });

  it('a renewal: previousHolder is the same holder, acquiredAt kept, expiry extended', async () => {
    const { lock, advance, at } = clocked('lock_acq_renew');
    const first = await lock.acquire('room', A, 5_000);
    advance(2_000);
    const again = await lock.acquire('room', A, 5_000);
    expect(again).toEqual({
      acquired: true,
      holder: A,
      previousHolder: A,
      acquiredAt: first.acquiredAt,
      expiresAt: new Date(at().getTime() + 5_000),
    });
  });

  it('a takeover of a lapsed lease names the previous holder from the same write', async () => {
    const { lock, advance, at } = clocked('lock_acq_takeover');
    await lock.acquire('room', A, 5_000);
    advance(6_000);
    const got = await lock.acquire('room', B, 5_000);
    expect(got).toEqual({
      acquired: true,
      holder: B,
      previousHolder: A,
      acquiredAt: at(),
      expiresAt: new Date(at().getTime() + 5_000),
    });
    expect((await lock.inspect('room'))?.holder).toBe(B);
  });

  it('a live lease of another holder: not acquired, the live holder and its times, nothing written', async () => {
    const { lock, advance } = clocked('lock_acq_busy');
    const held = await lock.acquire('room', A, 5_000);
    advance(1_000);
    const got = await lock.acquire('room', B, 5_000);
    expect(got).toEqual({
      acquired: false,
      holder: A,
      acquiredAt: held.acquiredAt,
      expiresAt: held.expiresAt,
    });
    expect(await lock.inspect('room')).toMatchObject({ holder: A, expiresAt: held.expiresAt });
  });

  it('after release the lock is free again: no previous holder', async () => {
    const { lock } = clocked('lock_acq_release');
    await lock.acquire('room', A, 5_000);
    expect(await lock.release('room', A)).toBe(true);
    const got = await lock.acquire('room', B, 5_000);
    expect(got.acquired).toBe(true);
    expect(got.previousHolder).toBeUndefined();
  });

  it('parallel acquires on a free lock: exactly one winner, every loser names it', async () => {
    const lock = createMongoLockAdapter({ collectionName: 'lock_acq_race' });
    const holders = Array.from({ length: 12 }, (_, i) => `replica-${i}`);
    const results = await Promise.all(holders.map((h) => lock.acquire('contended', h, 5_000)));
    const winners = results.filter((r) => r.acquired);
    expect(winners).toHaveLength(1);
    const winner = winners[0]?.holder;
    for (const r of results.filter((x) => !x.acquired)) expect(r.holder).toBe(winner);
  });

  it('stays consistent with tryAcquire and keeps a `$` holder id literal', async () => {
    const { lock } = clocked('lock_acq_mixed');
    expect(await lock.tryAcquire('room', '$weird', 5_000)).toBe(true);
    const got = await lock.acquire('room', '$weird', 5_000);
    expect(got).toMatchObject({ acquired: true, holder: '$weird', previousHolder: '$weird' });
    expect(await lock.tryAcquire('room', B, 5_000)).toBe(false);
    const row = await mongoose.connection
      .collection('lock_acq_mixed')
      .findOne({ _id: 'room' as never });
    expect(row).toMatchObject({ holder: '$weird' });
    expect(Object.keys(row ?? {}).sort()).toEqual(['_id', 'acquiredAt', 'expiresAt', 'holder']);
  });

  it('leaseMs <= 0 uses the default lease', async () => {
    const lock = createMongoLockAdapter({
      collectionName: 'lock_acq_default',
      defaultLeaseMs: 7_000,
      nowFn: () => new Date(BASE),
    });
    const got = await lock.acquire('room', A, 0);
    expect(got.expiresAt.getTime()).toBe(BASE + 7_000);
  });
});
