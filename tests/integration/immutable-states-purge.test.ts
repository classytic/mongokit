/**
 * `immutableStatesPlugin({ allowPurge })` — the audited retention purge of
 * frozen rows (G-OCC-3). Ordinary deletes stay refused; a purge needs the
 * plugin opt-in, a reason and `mode: 'hard'`, and emits
 * `after:immutable-states-purge` with what it removed.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendOnlyPlugin,
  type ImmutablePurgeEvent,
  immutableStatesPlugin,
  multiTenantPlugin,
  Repository,
  softDeletePlugin,
} from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRecord {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  status: 'OPEN' | 'CLOSED';
  endedAt?: Date;
  deletedAt?: Date | null;
}

const OLD = new Date('2018-01-01T00:00:00Z');
const RECENT = new Date('2026-10-01T00:00:00Z');
const CUTOFF = new Date('2020-01-01T00:00:00Z');
const PURGE = { reason: 'retention: 5 years', actor: 'job:records.retention' };

describe('immutableStatesPlugin — audited retention purge', () => {
  let RecordModel: mongoose.Model<IRecord>;
  let repo: Repository<IRecord>;
  let lockedRepo: Repository<IRecord>;
  let events: ImmutablePurgeEvent[];

  beforeAll(async () => {
    await connectDB();
    RecordModel = await createTestModel(
      'ImmutablePurgeRecord',
      new Schema<IRecord>({
        organizationId: { type: String, required: true },
        status: { type: String, required: true },
        endedAt: Date,
        deletedAt: { type: Date, default: null },
      }),
    );
    repo = new Repository<IRecord>(RecordModel, [
      immutableStatesPlugin({ states: ['CLOSED'], field: 'status', allowPurge: true }),
    ]);
    repo.on('after:immutable-states-purge', (e: ImmutablePurgeEvent) => {
      events.push(e);
    });
    lockedRepo = new Repository<IRecord>(RecordModel, [
      immutableStatesPlugin({ states: ['CLOSED'], field: 'status' }),
    ]);
  });
  afterAll(async () => {
    await disconnectDB();
  });
  beforeEach(async () => {
    await RecordModel.deleteMany({});
    events = [];
  });

  const seed = async () => {
    const oldClosed = await RecordModel.create({
      organizationId: 'org1',
      status: 'CLOSED',
      endedAt: OLD,
    });
    const recentClosed = await RecordModel.create({
      organizationId: 'org1',
      status: 'CLOSED',
      endedAt: RECENT,
    });
    const open = await RecordModel.create({ organizationId: 'org1', status: 'OPEN' });
    return { oldClosed, recentClosed, open };
  };

  it('ordinary deletes of frozen rows stay refused on a purge-enabled repository', async () => {
    const { oldClosed } = await seed();
    await expect(repo.delete(String(oldClosed._id))).rejects.toMatchObject({
      status: 403,
      code: 'IMMUTABLE_STATE_VIOLATION',
    });
    await expect(repo.deleteMany({ endedAt: { $lt: CUTOFF } })).rejects.toMatchObject({
      code: 'IMMUTABLE_STATE_VIOLATION',
    });
    await expect(
      repo.deleteMany({ endedAt: { $lt: CUTOFF } }, { mode: 'hard' }),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_STATE_VIOLATION' });
    expect(await RecordModel.countDocuments()).toBe(3);
    expect(events).toHaveLength(0);
  });

  it('deleteMany purge removes frozen rows past the cutoff and emits one audit event', async () => {
    await seed();
    const result = await repo.deleteMany(
      { status: 'CLOSED', endedAt: { $lt: CUTOFF } },
      { mode: 'hard', retentionPurge: PURGE },
    );
    expect(result.deletedCount).toBe(1);
    expect(await RecordModel.countDocuments()).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: 'deleteMany',
      reason: PURGE.reason,
      actor: PURGE.actor,
      deletedCount: 1,
      states: ['CLOSED'],
      filter: { status: 'CLOSED', endedAt: { $lt: CUTOFF } },
    });
    expect(events[0]?.id).toBeUndefined();
  });

  it('delete purge removes one frozen row; a miss is audited with deletedCount 0', async () => {
    const { oldClosed } = await seed();
    const res = await repo.delete(String(oldClosed._id), {
      mode: 'hard',
      retentionPurge: { reason: 'erasure request #42' },
    });
    expect(res).toBeTruthy();
    expect(await RecordModel.exists({ _id: oldClosed._id })).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: 'delete',
      reason: 'erasure request #42',
      actor: undefined,
      id: String(oldClosed._id),
      deletedCount: 1,
    });

    await repo.delete(String(oldClosed._id), {
      mode: 'hard',
      retentionPurge: { reason: 'erasure request #42' },
    });
    expect(events).toHaveLength(2);
    expect(events[1]?.deletedCount).toBe(0);
  });

  it('refuses a purge without the plugin opt-in', async () => {
    const { oldClosed } = await seed();
    await expect(
      lockedRepo.deleteMany({ endedAt: { $lt: CUTOFF } }, { mode: 'hard', retentionPurge: PURGE }),
    ).rejects.toMatchObject({ status: 403, code: 'RETENTION_PURGE_DISABLED' });
    await expect(
      lockedRepo.delete(String(oldClosed._id), { mode: 'hard', retentionPurge: PURGE }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_DISABLED' });
    // Even on rows that are NOT frozen: the option itself is the refusal.
    await expect(
      lockedRepo.deleteMany({ status: 'OPEN' }, { mode: 'hard', retentionPurge: PURGE }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_DISABLED' });
    expect(await RecordModel.countDocuments()).toBe(3);
  });

  it('refuses a purge with a missing or blank reason, a bad actor, or without mode hard', async () => {
    await seed();
    const filter = { endedAt: { $lt: CUTOFF } };
    for (const bad of [{}, { reason: '' }, { reason: '   ' }, { reason: 42 }, 'retention', true]) {
      await expect(
        repo.deleteMany(filter, { mode: 'hard', retentionPurge: bad as never }),
      ).rejects.toMatchObject({ status: 400, code: 'RETENTION_PURGE_REASON_REQUIRED' });
    }
    await expect(
      repo.deleteMany(filter, { mode: 'hard', retentionPurge: { reason: 'r', actor: '' } }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_INVALID_ACTOR' });
    await expect(repo.deleteMany(filter, { retentionPurge: PURGE })).rejects.toMatchObject({
      code: 'RETENTION_PURGE_HARD_ONLY',
    });
    expect(await RecordModel.countDocuments()).toBe(3);
    expect(events).toHaveLength(0);
  });

  it('purge never unlocks edits: update / updateMany / findOneAndUpdate stay refused', async () => {
    const { oldClosed } = await seed();
    const opts = { mode: 'hard', retentionPurge: PURGE } as never;
    await expect(
      repo.update(String(oldClosed._id), { endedAt: RECENT }, opts),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_STATE_VIOLATION' });
    await expect(
      repo.updateMany({ status: 'CLOSED' }, { $set: { endedAt: RECENT } }, opts),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_STATE_VIOLATION' });
    await expect(
      repo.findOneAndUpdate({ _id: oldClosed._id }, { $set: { endedAt: RECENT } }, opts),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_STATE_VIOLATION' });
    expect(events).toHaveLength(0);
  });

  it('keeps tenant scope: a purge only reaches the caller tenant', async () => {
    const TenantModel = await createTestModel(
      'ImmutablePurgeTenantRecord',
      new Schema<IRecord>({
        organizationId: { type: String, required: true },
        status: { type: String, required: true },
        endedAt: Date,
      }),
    );
    await TenantModel.deleteMany({});
    const tenantRepo = new Repository<IRecord>(TenantModel, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      immutableStatesPlugin({ states: ['CLOSED'], field: 'status', allowPurge: true }),
    ]);
    await TenantModel.create([
      { organizationId: 'org1', status: 'CLOSED', endedAt: OLD },
      { organizationId: 'org2', status: 'CLOSED', endedAt: OLD },
    ]);
    const res = await tenantRepo.deleteMany(
      { endedAt: { $lt: CUTOFF } },
      { organizationId: 'org1', mode: 'hard', retentionPurge: PURGE },
    );
    expect(res.deletedCount).toBe(1);
    expect(await TenantModel.countDocuments({ organizationId: 'org2' })).toBe(1);
  });

  it('with softDeletePlugin the purge is a physical delete', async () => {
    const SoftModel = await createTestModel(
      'ImmutablePurgeSoftRecord',
      new Schema<IRecord>({
        organizationId: { type: String, required: true },
        status: { type: String, required: true },
        endedAt: Date,
        deletedAt: { type: Date, default: null },
      }),
    );
    await SoftModel.deleteMany({});
    const softRepo = new Repository<IRecord>(SoftModel, [
      softDeletePlugin(),
      immutableStatesPlugin({ states: ['CLOSED'], field: 'status', allowPurge: true }),
    ]);
    await SoftModel.create({ organizationId: 'org1', status: 'CLOSED', endedAt: OLD });
    const res = await softRepo.deleteMany(
      { endedAt: { $lt: CUTOFF } },
      { mode: 'hard', retentionPurge: PURGE },
    );
    expect(res.deletedCount).toBe(1);
    expect(await SoftModel.countDocuments({})).toBe(0);
  });
});

// ── Functional anonymize goes through the fences (review: purge.ts) ───────
// Function-form anonymize used a raw `Model.bulkWrite`, so frozen and
// append-only rows were rewritten. It must meet the same guards as the
// static form (`updateMany`).
describe('purge anonymize (function form) respects immutable + append-only fences', () => {
  interface IPerson {
    _id?: mongoose.Types.ObjectId;
    status: 'OPEN' | 'CLOSED';
    name: string;
  }
  let PersonModel: mongoose.Model<IPerson>;

  beforeAll(async () => {
    await connectDB();
    PersonModel = await createTestModel(
      'ImmutableAnonPerson',
      new Schema<IPerson>({
        status: { type: String, required: true },
        name: { type: String, required: true },
      }),
    );
  });
  beforeEach(async () => {
    await PersonModel.deleteMany({});
  });

  const anonymize = { type: 'anonymize' as const, fields: { name: (d: Record<string, unknown>) => `anon-${String(d._id).slice(-4)}` } };

  it('immutableStates: a frozen row is never rewritten by function-form anonymize', async () => {
    const repo = new Repository<IPerson>(PersonModel, [
      immutableStatesPlugin({ states: ['CLOSED'], field: 'status' }),
    ]);
    await PersonModel.create([
      { status: 'OPEN', name: 'Ada' },
      { status: 'CLOSED', name: 'Grace' },
    ]);
    const res = await repo
      .purgeByFilter({ name: { $exists: true } }, anonymize as never, { batchSize: 10 })
      .catch((e: unknown) => e);
    const frozen = await PersonModel.findOne({ status: 'CLOSED' }).lean();
    expect(frozen?.name).toBe('Grace');
    // Same verdict as the static form: refused, not silently partial.
    const ok = (res as { ok?: boolean }).ok;
    expect(res instanceof Error || ok === false).toBe(true);
  });

  it('immutableStates: function-form anonymize still rewrites non-frozen rows', async () => {
    const repo = new Repository<IPerson>(PersonModel, [
      immutableStatesPlugin({ states: ['CLOSED'], field: 'status' }),
    ]);
    await PersonModel.create([
      { status: 'OPEN', name: 'Ada' },
      { status: 'OPEN', name: 'Linus' },
      { status: 'CLOSED', name: 'Grace' },
    ]);
    const res = await repo.purgeByFilter({ status: 'OPEN' }, anonymize as never, {
      batchSize: 1,
    });
    expect(res.ok).toBe(true);
    expect(res.processed).toBe(2);
    const open = await PersonModel.find({ status: 'OPEN' }).lean();
    for (const p of open) expect(p.name).toMatch(/^anon-/);
    expect((await PersonModel.findOne({ status: 'CLOSED' }).lean())?.name).toBe('Grace');
  });

  it('appendOnly: function-form anonymize is refused like any edit', async () => {
    const repo = new Repository<IPerson>(PersonModel, [appendOnlyPlugin()]);
    await PersonModel.create([{ status: 'OPEN', name: 'Ada' }]);
    const res = await repo
      .purgeByFilter({ status: 'OPEN' }, anonymize as never, { batchSize: 10 })
      .catch((e: unknown) => e);
    expect((await PersonModel.findOne({}).lean())?.name).toBe('Ada');
    const ok = (res as { ok?: boolean }).ok;
    expect(res instanceof Error || ok === false).toBe(true);
  });
});
