/**
 * `leasePlugin()` — injectable clock, scoped dead-lease recovery, caller
 * `$or` preservation, attempts counter / cap, pending-only filter, and
 * composition with tenant + immutable-state plugins.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository, withTransaction } from '../../src/index.js';
import {
  immutableStatesPlugin,
  type LeaseMethods,
  type LeasePluginOptions,
  leasePlugin,
  methodRegistryPlugin,
  multiTenantPlugin,
} from '../../src/plugins/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface ITimer {
  _id?: mongoose.Types.ObjectId;
  organizationId?: string;
  state: string;
  payload: string;
  dueAt?: Date;
  createdAt: Date;
  leasedBy?: string;
  leaseUntil?: Date | null;
  attempts?: number;
}

type TimerRepo = Repository<ITimer> & LeaseMethods<ITimer>;

const T0 = new Date('2026-10-30T08:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const FIELDS: LeasePluginOptions = {
  statusField: 'state',
  leaseExpiresAtField: 'leaseUntil',
  pendingStatus: 'pending',
  processingStatus: 'claimed',
  doneStatus: 'fired',
};

describe('leasePlugin — clock, scoped recovery, attempts, pendingFilter', () => {
  let Model: mongoose.Model<ITimer>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'LeaseTimerG3',
      new Schema<ITimer>({
        organizationId: String,
        state: { type: String, required: true },
        payload: { type: String, required: true },
        dueAt: Date,
        createdAt: { type: Date, default: () => new Date() },
        leasedBy: String,
        leaseUntil: Date,
        attempts: Number,
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  const makeRepo = (opts: LeasePluginOptions = {}, extra: unknown[] = []): TimerRepo =>
    new Repository<ITimer>(Model, [
      ...(extra as never[]),
      methodRegistryPlugin(),
      leasePlugin({ ...FIELDS, ...opts }),
    ]) as TimerRepo;

  it('never re-leases a cancelled row whose stale lease expired (dead arm scoped to processing)', async () => {
    const repo = makeRepo();
    await Model.create({
      state: 'cancelled',
      payload: 'x',
      leasedBy: 'old',
      leaseUntil: at(-60_000),
    });
    expect(await repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: T0 })).toBeNull();
    expect((await Model.findOne({}).lean())?.state).toBe('cancelled');
  });

  it('still recovers a processing row with an expired lease', async () => {
    const repo = makeRepo();
    const stale = await Model.create({
      state: 'claimed',
      payload: 'x',
      leasedBy: 'crashed',
      leaseUntil: at(-1),
    });
    const got = await repo.lease({ leaseFor: 1_000, leasedBy: 'w2', now: T0 });
    expect(String(got?._id)).toBe(String(stale._id));
    expect(got?.leasedBy).toBe('w2');
  });

  it('deadLeaseStatuses widens recovery explicitly', async () => {
    const repo = makeRepo({ deadLeaseStatuses: ['claimed', 'retrying'] });
    await Model.create({ state: 'retrying', payload: 'x', leaseUntil: at(-1) });
    expect(await repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: T0 })).not.toBeNull();
  });

  it("keeps a caller filter's own $or", async () => {
    const repo = makeRepo();
    await Model.create({ state: 'pending', payload: 'c', createdAt: at(-3) });
    const b = await Model.create({ state: 'pending', payload: 'b', createdAt: at(-2) });
    const got = await repo.lease({
      filter: { $or: [{ payload: 'a' }, { payload: 'b' }] },
      leaseFor: 1_000,
      leasedBy: 'w',
      now: T0,
    });
    expect(String(got?._id)).toBe(String(b._id));
    expect(
      await repo.lease({
        filter: { $or: [{ payload: 'a' }, { payload: 'b' }] },
        leaseFor: 1_000,
        leasedBy: 'w',
        now: T0,
      }),
    ).toBeNull();
  });

  it('an injected clock drives lease, extend and release; per-call now beats nowFn', async () => {
    let clock = T0;
    const repo = makeRepo({ nowFn: () => clock });
    await Model.create({ state: 'pending', payload: 'p' });

    const leased = await repo.lease({ leaseFor: 5_000, leasedBy: 'w1' });
    expect(leased?.leaseUntil?.getTime()).toBe(T0.getTime() + 5_000);

    // Per-call now wins over nowFn.
    const extended = await repo.extend(String(leased?._id), {
      leasedBy: 'w1',
      leaseFor: 5_000,
      now: at(1_000),
    });
    expect(extended?.leaseUntil?.getTime()).toBe(T0.getTime() + 6_000);

    // Advance past expiry: the holder can neither extend nor release.
    clock = at(6_001);
    expect(await repo.extend(String(leased?._id), { leasedBy: 'w1', leaseFor: 5_000 })).toBeNull();
    expect(await repo.release(String(leased?._id), { leasedBy: 'w1' })).toBeNull();

    // Another worker recovers it on the same clock.
    const recovered = await repo.lease({ leaseFor: 5_000, leasedBy: 'w2' });
    expect(recovered?.leasedBy).toBe('w2');
    const released = await repo.release(String(recovered?._id), { leasedBy: 'w2' });
    expect(released?.state).toBe('fired');
  });

  it('rejects an invalid now and an empty leasedBy on extend', async () => {
    const repo = makeRepo();
    await expect(
      repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: new Date('nope') }),
    ).rejects.toThrow(/valid Date/);
    await expect(
      repo.extend(new mongoose.Types.ObjectId().toString(), { leasedBy: '', leaseFor: 1_000 }),
    ).rejects.toThrow(/non-empty string/);
  });

  it('attemptsField increments on every lease, including recovery', async () => {
    const repo = makeRepo({ attemptsField: 'attempts' });
    await Model.create({ state: 'pending', payload: 'p' });
    const first = await repo.lease({ leaseFor: 1_000, leasedBy: 'w1', now: T0 });
    expect(first?.attempts).toBe(1);
    const second = await repo.lease({ leaseFor: 1_000, leasedBy: 'w2', now: at(2_000) });
    expect(second?.attempts).toBe(2);
  });

  it('maxAttempts excludes a capped row; a row missing the field stays leasable', async () => {
    const repo = makeRepo({ attemptsField: 'attempts', maxAttempts: 3 });
    await Model.create({ state: 'pending', payload: 'capped', attempts: 3, createdAt: at(-2) });
    const fresh = await Model.create({ state: 'pending', payload: 'fresh', createdAt: at(-1) });
    const got = await repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: T0 });
    expect(String(got?._id)).toBe(String(fresh._id));
    expect(got?.attempts).toBe(1);
    expect(await repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: T0 })).toBeNull();
  });

  it('maxAttempts without attemptsField throws at construction', () => {
    expect(() => leasePlugin({ maxAttempts: 3 })).toThrow(/requires attemptsField/);
    expect(() => leasePlugin({ attemptsField: 'a', maxAttempts: 0 })).toThrow(/positive integer/);
  });

  it('pendingFilter narrows only the pending arm (plugin-level and per-call)', async () => {
    const repo = makeRepo({ pendingFilter: { payload: 'never' } });
    await Model.create({ state: 'pending', payload: 'p', dueAt: at(60_000) });
    const dead = await Model.create({
      state: 'claimed',
      payload: 'd',
      dueAt: at(60_000),
      leaseUntil: at(-1),
    });
    // Plugin-level filter blocks the pending row; the dead lease is still recovered.
    const recovered = await repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: T0 });
    expect(String(recovered?._id)).toBe(String(dead._id));
    expect(await repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: T0 })).toBeNull();
    // Per-call replaces it: not yet due → nothing; once due → the pending row.
    const due = (now: Date) => ({ dueAt: { $lte: now } });
    expect(
      await repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: T0, pendingFilter: due(T0) }),
    ).toBeNull();
    const later = at(60_000);
    const got = await repo.lease({
      leaseFor: 1_000,
      leasedBy: 'w',
      now: later,
      pendingFilter: due(later),
    });
    expect(got?.payload).toBe('p');
  });

  it('pendingFilter function form is called with each claim now (plugin-level)', async () => {
    let clock = T0;
    const repo = makeRepo({
      nowFn: () => clock,
      pendingFilter: (now) => ({ dueAt: { $lte: now } }),
    });
    await Model.create({ state: 'pending', payload: 'p', dueAt: at(60_000) });
    expect(await repo.lease({ leaseFor: 1_000, leasedBy: 'w' })).toBeNull();
    clock = at(60_000);
    expect((await repo.lease({ leaseFor: 1_000, leasedBy: 'w' }))?.payload).toBe('p');
  });

  it('release / extend refuse a row the host moved out of processing mid-lease', async () => {
    const repo = makeRepo();
    await Model.create({ state: 'pending', payload: 'p' });
    const leased = await repo.lease({ leaseFor: 60_000, leasedBy: 'w', now: T0 });
    await Model.updateOne({ _id: leased?._id }, { $set: { state: 'cancelled' } });
    expect(
      await repo.extend(String(leased?._id), { leasedBy: 'w', leaseFor: 1_000, now: at(1) }),
    ).toBeNull();
    expect(await repo.release(String(leased?._id), { leasedBy: 'w', now: at(1) })).toBeNull();
    expect((await Model.findById(leased?._id).lean())?.state).toBe('cancelled');
  });

  it('rejects a non-array filter.$and with a 400 instead of dropping it', async () => {
    const repo = makeRepo();
    await expect(
      repo.lease({ leaseFor: 1_000, leasedBy: 'w', now: T0, filter: { $and: { payload: 'x' } } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('release inside a transaction rolls back on abort', async () => {
    const repo = makeRepo();
    await Model.create({ state: 'pending', payload: 'p' });
    const leased = await repo.lease({ leaseFor: 60_000, leasedBy: 'w', now: new Date() });
    try {
      await withTransaction(mongoose.connection, async (session) => {
        const released = await repo.release(String(leased?._id), {
          leasedBy: 'w',
          options: { session },
        });
        expect(released?.state).toBe('fired');
        throw new Error('abort');
      }).catch((err: Error) => {
        if (err.message !== 'abort') throw err;
      });
    } catch (err) {
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }
    const row = await Model.findById(leased?._id).lean();
    expect(row?.state).toBe('claimed');
    expect(row?.leasedBy).toBe('w');
  });

  it('composes with multiTenantPlugin + immutableStatesPlugin under the $and', async () => {
    const repo = makeRepo({}, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      immutableStatesPlugin({ states: ['fired'], field: 'state' }),
    ]);
    await Model.create({ organizationId: 'org-a', state: 'pending', payload: 'a' });
    await Model.create({ organizationId: 'org-b', state: 'pending', payload: 'b' });

    const got = await repo.lease({
      filter: { $or: [{ payload: 'a' }, { payload: 'b' }] },
      leaseFor: 1_000,
      leasedBy: 'w',
      now: T0,
      options: { organizationId: 'org-b' },
    });
    expect(got?.payload).toBe('b');
    expect(
      await repo.lease({
        leaseFor: 1_000,
        leasedBy: 'w',
        now: T0,
        options: { organizationId: 'org-b' },
      }),
    ).toBeNull();
  });
});
