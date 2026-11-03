/**
 * Retention purge through the ONE public path (`retentionPurge` +
 * `allowPurge`) on a repository fenced by `appendOnlyPlugin` and/or
 * `immutableStatesPlugin`: `purgeByFilter` / `purgeByField` forward it to
 * every chunk, `delete` / `deleteMany` take it with `mode: 'hard'`, both
 * plugins honour it and audit it, and ordinary deletes stay refused.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppendOnlyPurgeEvent,
  appendOnlyPlugin,
  type ImmutablePurgeEvent,
  immutableStatesPlugin,
  Repository,
  type RetentionPurgeEvent,
} from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  status: 'open' | 'closed';
  at: Date;
}

const OLD = new Date('2018-01-01T00:00:00Z');
const RECENT = new Date('2026-10-01T00:00:00Z');
const CUTOFF = new Date('2020-01-01T00:00:00Z');
const PURGE = { reason: 'retention: 1095 days', actor: 'job:retention' };

describe('retention purge with appendOnlyPlugin + immutableStatesPlugin', () => {
  let Model: mongoose.Model<IRow>;
  let both: Repository<IRow>;
  let appendOnly: Repository<IRow>;
  let locked: Repository<IRow>;
  let appendEvents: AppendOnlyPurgeEvent[];
  let immutableEvents: ImmutablePurgeEvent[];
  let bypasses: number;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'RetentionPurgeRow',
      new Schema<IRow>({
        status: { type: String, required: true },
        at: { type: Date, required: true },
      }),
    );
    both = new Repository<IRow>(Model, [
      appendOnlyPlugin({ allowPurge: true }),
      immutableStatesPlugin({ states: ['closed'], field: 'status', allowPurge: true }),
    ]);
    both.on('after:append-only-purge', (e: AppendOnlyPurgeEvent) => appendEvents.push(e));
    both.on('after:immutable-states-purge', (e: ImmutablePurgeEvent) => immutableEvents.push(e));
    both.on('after:append-only-bypass', () => {
      bypasses += 1;
    });
    appendOnly = new Repository<IRow>(Model, [appendOnlyPlugin({ allowPurge: true })]);
    appendOnly.on('after:append-only-purge', (e: AppendOnlyPurgeEvent) => appendEvents.push(e));
    locked = new Repository<IRow>(Model, [
      appendOnlyPlugin(),
      immutableStatesPlugin({ states: ['closed'], field: 'status', allowPurge: true }),
    ]);
  });
  afterAll(async () => {
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    appendEvents = [];
    immutableEvents = [];
    bypasses = 0;
    await Model.create([
      ...Array.from({ length: 5 }, () => ({ status: 'closed', at: OLD })),
      { status: 'open', at: OLD },
      { status: 'closed', at: RECENT },
    ]);
  });

  it('ordinary deletes stay refused on a purge-enabled repository with both plugins', async () => {
    const one = await Model.findOne({ status: 'open' }).lean();
    await expect(both.delete(String(one?._id), { mode: 'hard' })).rejects.toMatchObject({
      code: 'APPEND_ONLY_VIOLATION',
    });
    await expect(both.deleteMany({ at: { $lt: CUTOFF } }, { mode: 'hard' })).rejects.toMatchObject({
      code: 'APPEND_ONLY_VIOLATION',
    });
    // runChunkedPurge reports a chunk failure in the envelope (no throw).
    const refused = await both.purgeByFilter({ at: { $lt: CUTOFF } }, { type: 'hard' });
    expect(refused.ok).toBe(false);
    expect(refused.processed).toBe(0);
    expect(refused.error?.message).toMatch(/append-only/);
    expect(await Model.countDocuments()).toBe(7);
    expect(appendEvents).toHaveLength(0);
    expect(immutableEvents).toHaveLength(0);
  });

  it('purgeByFilter with retentionPurge removes the slice in chunks; both plugins audit every chunk', async () => {
    const result = await both.purgeByFilter(
      { at: { $lt: CUTOFF } },
      { type: 'hard' },
      { batchSize: 2, retentionPurge: PURGE },
    );
    expect(result.ok).toBe(true);
    expect(result.processed).toBe(6); // 5 closed + 1 open, past the cutoff
    expect(await Model.countDocuments()).toBe(1);
    expect(await Model.countDocuments({ at: RECENT })).toBe(1);

    for (const events of [appendEvents, immutableEvents]) {
      expect(events).toHaveLength(3); // 2 + 2 + 2
      expect(events.reduce((n, e) => n + e.deletedCount, 0)).toBe(6);
      for (const e of events) {
        expect(e).toMatchObject({
          operation: 'deleteMany',
          reason: PURGE.reason,
          actor: PURGE.actor,
        });
        expect(e.filter).toBeDefined();
      }
    }
    expect(immutableEvents[0]?.states).toEqual(['closed']);
    expect(bypasses).toBe(0); // the purge is not the bypass
  });

  it('deleteMany / delete with mode hard + retentionPurge pass both fences', async () => {
    const res = await both.deleteMany(
      { status: 'closed', at: { $lt: CUTOFF } },
      { mode: 'hard', retentionPurge: PURGE },
    );
    expect(res.deletedCount).toBe(5);
    const recent = await Model.findOne({ at: RECENT }).lean();
    await both.delete(String(recent?._id), {
      mode: 'hard',
      retentionPurge: { reason: 'erasure #7' },
    });
    expect(await Model.countDocuments()).toBe(1);
    expect(appendEvents.map((e) => [e.operation, e.deletedCount])).toEqual([
      ['deleteMany', 5],
      ['delete', 1],
    ]);
    expect(immutableEvents.map((e) => [e.operation, e.deletedCount])).toEqual([
      ['deleteMany', 5],
      ['delete', 1],
    ]);
    expect(appendEvents[1]?.id).toBe(String(recent?._id));
  });

  it('purgeByField forwards retentionPurge too', async () => {
    const result = await both.purgeByField('at', OLD, { type: 'hard' }, { retentionPurge: PURGE });
    expect(result.processed).toBe(6);
    expect(appendEvents.reduce((n, e) => n + e.deletedCount, 0)).toBe(6);
  });

  it('appendOnlyPlugin alone: purgeByFilter with retentionPurge works and is audited', async () => {
    const result = await appendOnly.purgeByFilter(
      { at: { $lt: CUTOFF } },
      { type: 'hard' },
      { retentionPurge: PURGE },
    );
    expect(result.processed).toBe(6);
    expect(appendEvents).toHaveLength(1);
    expect(appendEvents[0]?.deletedCount).toBe(6);
  });

  it('refuses the purge when either plugin has not opted in', async () => {
    const refused = await locked.purgeByFilter(
      { at: { $lt: CUTOFF } },
      { type: 'hard' },
      { retentionPurge: PURGE },
    );
    expect(refused).toMatchObject({ ok: false, processed: 0 });
    expect(refused.error?.message).toMatch(/construct appendOnlyPlugin with allowPurge: true/);
    const frozenOnly = new Repository<IRow>(Model, [
      appendOnlyPlugin({ allowPurge: true }),
      immutableStatesPlugin({ states: ['closed'], field: 'status' }),
    ]);
    await expect(
      frozenOnly.deleteMany({ at: { $lt: CUTOFF } }, { mode: 'hard', retentionPurge: PURGE }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_DISABLED' });
    // An `allow`-listed delete still refuses an unauthorized purge request.
    const allowListed = new Repository<IRow>(Model, [appendOnlyPlugin({ allow: ['deleteMany'] })]);
    await expect(
      allowListed.deleteMany({ status: 'open' }, { mode: 'hard', retentionPurge: PURGE }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_DISABLED' });
    expect(await Model.countDocuments()).toBe(7);
  });

  it('refuses a malformed purge before any chunk runs', async () => {
    const filter = { at: { $lt: CUTOFF } };
    for (const bad of [{}, { reason: '  ' }, 'retention']) {
      await expect(
        both.purgeByFilter(filter, { type: 'hard' }, { retentionPurge: bad as never }),
      ).rejects.toMatchObject({ status: 400, code: 'RETENTION_PURGE_REASON_REQUIRED' });
    }
    await expect(
      both.purgeByFilter(filter, { type: 'soft' }, { retentionPurge: PURGE }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_HARD_ONLY' });
    await expect(
      both.purgeByFilter(
        filter,
        { type: 'anonymize', fields: { status: 'x' } },
        { retentionPurge: PURGE },
      ),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_HARD_ONLY' });
    await expect(both.deleteMany(filter, { retentionPurge: PURGE })).rejects.toMatchObject({
      code: 'RETENTION_PURGE_HARD_ONLY',
    });
    expect(await Model.countDocuments()).toBe(7);
    expect(appendEvents).toHaveLength(0);
  });

  it('retentionPurge never unlocks an edit', async () => {
    const row = await Model.findOne({ status: 'open' }).lean();
    const opts = { mode: 'hard', retentionPurge: PURGE } as never;
    await expect(both.update(String(row?._id), { at: RECENT }, opts)).rejects.toMatchObject({
      code: 'APPEND_ONLY_VIOLATION',
    });
    await expect(
      both.updateMany({ status: 'open' }, { $set: { at: RECENT } }, opts),
    ).rejects.toMatchObject({ code: 'APPEND_ONLY_VIOLATION' });
    expect(appendEvents).toHaveLength(0);
  });
});

// ── Audit delivery (review P2) ────────────────────────────────────────────
// The purge audit is part of the purge: its listeners are awaited, a failing
// listener fails the call, and inside a transaction the audit row written in
// the event's session commits or aborts together with the delete.
describe('retention purge audit is awaited, propagated and transactional', () => {
  let Model: mongoose.Model<IRow>;
  let Audit: mongoose.Model<{ reason: string; deletedCount: number; via: string }>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'RetentionAuditRow',
      new Schema<IRow>({
        status: { type: String, required: true },
        at: { type: Date, required: true },
      }),
    );
    Audit = await createTestModel(
      'RetentionAuditLog',
      new Schema({ reason: String, deletedCount: Number, via: String }),
    );
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    await Audit.deleteMany({});
    await Model.create([
      ...Array.from({ length: 3 }, () => ({ status: 'closed', at: OLD })),
      { status: 'closed', at: RECENT },
    ]);
  });

  const make = () =>
    new Repository<IRow>(Model, [
      appendOnlyPlugin({ allowPurge: true }),
      immutableStatesPlugin({ states: ['closed'], field: 'status', allowPurge: true }),
    ]);
  const filter = { at: { $lt: CUTOFF } };
  const opts = { mode: 'hard' as const, retentionPurge: PURGE };

  for (const event of ['after:append-only-purge', 'after:immutable-states-purge'] as const) {
    it(`${event}: an async listener has finished when the purge resolves`, async () => {
      const repo = make();
      const seen: number[] = [];
      repo.on(event, async (e: { deletedCount: number }) => {
        await new Promise((r) => setTimeout(r, 25));
        seen.push(e.deletedCount);
      });
      await repo.deleteMany(filter, opts);
      expect(seen).toEqual([3]);
    });

    it(`${event}: a failing listener fails the purge`, async () => {
      const repo = make();
      repo.on(event, () => {
        throw new Error('audit sink down');
      });
      await expect(repo.deleteMany(filter, opts)).rejects.toThrow(/audit sink down/);
    });

    it(`${event}: the event carries the session; delete + audit commit or abort together`, async () => {
      const repo = make();
      let fail = true;
      repo.on(event, async (e: RetentionPurgeEvent) => {
        expect(e.session).toBeDefined();
        await Audit.create([{ reason: e.reason, deletedCount: e.deletedCount, via: event }], {
          session: e.session as mongoose.ClientSession,
        });
        if (fail) throw new Error('audit rejected after write');
      });
      const run = async () => {
        const session = await Model.db.startSession();
        try {
          await session.withTransaction(async () => {
            await repo.deleteMany(filter, { ...opts, session });
          });
        } finally {
          await session.endSession();
        }
      };
      await expect(run()).rejects.toThrow(/audit rejected/);
      expect(await Model.countDocuments()).toBe(4);
      expect(await Audit.countDocuments()).toBe(0);

      fail = false;
      await run();
      expect(await Model.countDocuments()).toBe(1);
      expect(await Audit.find({ via: event }).lean()).toMatchObject([
        { reason: PURGE.reason, deletedCount: 3 },
      ]);
    });
  }
});
