/**
 * `leasePlugin` `exhaustedStatus` + `reapExhausted()`.
 *
 * With `maxAttempts` alone a row that failed on every claim stays in the processing status
 * forever: never leased again, never surfaced. `reapExhausted()` moves such a row (lease lapsed,
 * or pending) to a terminal status once, by compare-and-set, and returns it for the host to
 * audit; a row whose lease is still live, or still under the cap, is left alone.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import {
  type LeaseMethods,
  type LeasePluginOptions,
  leasePlugin,
  methodRegistryPlugin,
  multiTenantPlugin,
} from '../../src/plugins/index.js';
import { connectDB, createTestModel } from '../setup.js';

interface IJob {
  _id?: mongoose.Types.ObjectId;
  organizationId?: string;
  state: string;
  payload: string;
  dueAt?: Date;
  createdAt: Date;
  leasedBy?: string;
  leaseUntil?: Date | null;
  attempts?: number;
  failedAt?: Date;
}

type JobRepo = Repository<IJob> & LeaseMethods<IJob>;

const T0 = new Date('2026-10-30T08:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MAX = 3;
const LEASE = 30_000;

const BASE: LeasePluginOptions = {
  statusField: 'state',
  leaseExpiresAtField: 'leaseUntil',
  pendingStatus: 'pending',
  processingStatus: 'claimed',
  doneStatus: 'fired',
  attemptsField: 'attempts',
  maxAttempts: MAX,
  exhaustedStatus: 'failed',
  exhaustedAtField: 'failedAt',
};

describe('leasePlugin reapExhausted', () => {
  let Model: mongoose.Model<IJob>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'LeaseReapExhausted',
      new Schema<IJob>({
        organizationId: String,
        state: { type: String, required: true },
        payload: { type: String, required: true },
        dueAt: Date,
        createdAt: { type: Date, default: () => new Date() },
        leasedBy: String,
        leaseUntil: Date,
        attempts: Number,
        failedAt: Date,
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  const makeRepo = (opts: Partial<LeasePluginOptions> = {}, extra: unknown[] = []): JobRepo =>
    new Repository<IJob>(Model, [
      ...(extra as never[]),
      methodRegistryPlugin(),
      leasePlugin({ ...BASE, ...opts }),
    ]) as JobRepo;

  it('a row claimed maxAttempts times whose lease lapsed is returned once and never leased again', async () => {
    const repo = makeRepo();
    const job = await Model.create({ state: 'pending', payload: 'poison', createdAt: at(-10) });

    // Every claim "fails": the worker never releases, the lease lapses, the next claim recovers it.
    let now = T0;
    for (let i = 1; i <= MAX; i++) {
      const got = await repo.lease({ leaseFor: LEASE, leasedBy: `w:${i}`, now });
      expect(String(got?._id)).toBe(String(job._id));
      expect(got?.attempts).toBe(i);
      now = at(i * (LEASE + 1));
    }
    expect(await repo.lease({ leaseFor: LEASE, leasedBy: 'w:late', now })).toBeNull();
    expect((await Model.findById(job._id).lean())?.state).toBe('claimed');

    const reaped = await repo.reapExhausted({ now });
    expect(reaped).toHaveLength(1);
    expect(String(reaped[0]?._id)).toBe(String(job._id));
    expect(reaped[0]?.state).toBe('failed');
    expect(reaped[0]?.attempts).toBe(MAX);
    expect(reaped[0]?.failedAt?.getTime()).toBe(now.getTime());
    expect(reaped[0]?.leasedBy).toBeUndefined();
    expect(reaped[0]?.leaseUntil).toBeUndefined();

    // Returned once; never leased again, even far in the future.
    expect(await repo.reapExhausted({ now })).toEqual([]);
    expect(await repo.reapExhausted({ now: at(10 * LEASE * MAX) })).toEqual([]);
    expect(
      await repo.lease({ leaseFor: LEASE, leasedBy: 'w:later', now: at(10 * LEASE * MAX) }),
    ).toBeNull();
  });

  it('leaves a row whose last lease is still live, a row under the cap, and a terminal row alone', async () => {
    const repo = makeRepo();
    await Model.create([
      { state: 'claimed', payload: 'live', attempts: MAX, leasedBy: 'w', leaseUntil: at(5_000) },
      { state: 'claimed', payload: 'under-cap', attempts: MAX - 1, leaseUntil: at(-1) },
      { state: 'fired', payload: 'done', attempts: MAX, leaseUntil: at(-1) },
      { state: 'cancelled', payload: 'cancelled', attempts: MAX + 2, leaseUntil: at(-1) },
    ]);
    expect(await repo.reapExhausted({ now: T0 })).toEqual([]);

    // The live lease lapses: now it is exhausted.
    const later = await repo.reapExhausted({ now: at(5_001) });
    expect(later.map((r) => r.payload)).toEqual(['live']);
  });

  it('reaps an exhausted PENDING row (released back for retry) once it is due', async () => {
    const repo = makeRepo({ pendingFilter: (now) => ({ dueAt: { $lte: now } }) });
    await Model.create([
      { state: 'pending', payload: 'retry-due', attempts: MAX, dueAt: at(-1) },
      { state: 'pending', payload: 'retry-later', attempts: MAX, dueAt: at(60_000) },
      { state: 'pending', payload: 'fresh', dueAt: at(-1) },
    ]);
    expect((await repo.reapExhausted({ now: T0 })).map((r) => r.payload)).toEqual(['retry-due']);
    expect((await repo.reapExhausted({ now: at(60_000) })).map((r) => r.payload)).toEqual([
      'retry-later',
    ]);
    expect((await Model.findOne({ payload: 'fresh' }).lean())?.state).toBe('pending');
  });

  it('two concurrent reapers return each row exactly once', async () => {
    const repo = makeRepo();
    await Model.create(
      Array.from({ length: 12 }, (_, i) => ({
        state: 'claimed',
        payload: `p${i}`,
        attempts: MAX,
        leaseUntil: at(-1),
        createdAt: at(i),
      })),
    );
    const [a, b] = await Promise.all([
      repo.reapExhausted({ now: T0 }),
      repo.reapExhausted({ now: T0 }),
    ]);
    const ids = [...a, ...b].map((r) => String(r._id));
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(await Model.countDocuments({ state: 'failed' })).toBe(12);
  });

  it('reads at most `limit` rows in sort order; the caller filter narrows', async () => {
    const repo = makeRepo();
    await Model.create(
      Array.from({ length: 5 }, (_, i) => ({
        state: 'claimed',
        payload: i % 2 === 0 ? 'even' : 'odd',
        attempts: MAX,
        leaseUntil: at(-1),
        createdAt: at(-100 + i),
      })),
    );
    const first = await repo.reapExhausted({ now: T0, limit: 2 });
    expect(first.map((r) => r.createdAt.getTime())).toEqual([
      at(-100).getTime(),
      at(-99).getTime(),
    ]);
    const odd = await repo.reapExhausted({ now: T0, filter: { payload: 'odd' } });
    expect(odd.map((r) => r.payload)).toEqual(['odd']);
  });

  it('runs through the hook pipeline: a tenant-scoped reaper never touches another tenant', async () => {
    const repo = makeRepo({}, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
    ]);
    await Model.create([
      {
        organizationId: 'org-a',
        state: 'claimed',
        payload: 'a',
        attempts: MAX,
        leaseUntil: at(-1),
      },
      {
        organizationId: 'org-b',
        state: 'claimed',
        payload: 'b',
        attempts: MAX,
        leaseUntil: at(-1),
      },
    ]);
    const reaped = await repo.reapExhausted({ now: T0, options: { organizationId: 'org-b' } });
    expect(reaped.map((r) => r.payload)).toEqual(['b']);
    expect((await Model.findOne({ payload: 'a' }).lean())?.state).toBe('claimed');
  });

  it('a per-call status works without exhaustedStatus; none at all is a 400', async () => {
    const repo = makeRepo({ exhaustedStatus: undefined, exhaustedAtField: undefined });
    await Model.create({ state: 'claimed', payload: 'x', attempts: MAX, leaseUntil: at(-1) });
    await expect(repo.reapExhausted({ now: T0 })).rejects.toMatchObject({ status: 400 });
    await expect(repo.reapExhausted({ now: T0, status: 'claimed' })).rejects.toMatchObject({
      status: 400,
    });
    const [row] = await repo.reapExhausted({ now: T0, status: 'dead' });
    expect(row?.state).toBe('dead');
    expect(row?.failedAt).toBeUndefined();
  });

  it('validates its configuration at construction', () => {
    expect(() =>
      leasePlugin({ ...BASE, maxAttempts: undefined, attemptsField: 'attempts' }),
    ).toThrow(/exhaustedStatus requires maxAttempts/);
    expect(() => leasePlugin({ ...BASE, exhaustedStatus: 'pending' })).toThrow(/must differ/);
    expect(() => leasePlugin({ ...BASE, exhaustedStatus: 'claimed' })).toThrow(/must differ/);
    expect(() =>
      leasePlugin({
        ...BASE,
        deadLeaseStatuses: ['claimed', 'retrying'],
        exhaustedStatus: 'retrying',
      }),
    ).toThrow(/must differ/);
    expect(() =>
      leasePlugin({
        ...BASE,
        maxAttempts: undefined,
        exhaustedStatus: undefined,
        exhaustedAtField: 'failedAt',
      }),
    ).toThrow(/exhaustedAtField requires maxAttempts/);
  });

  it('without maxAttempts reapExhausted is a 400', async () => {
    const repo = new Repository<IJob>(Model, [
      methodRegistryPlugin(),
      leasePlugin({ statusField: 'state', leaseExpiresAtField: 'leaseUntil' }),
    ]) as JobRepo;
    await expect(repo.reapExhausted({ now: T0, status: 'failed' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
