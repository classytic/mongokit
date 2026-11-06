/**
 * `archiveByFilter` on fenced repositories: with `retentionPurge`, each chunk
 * delete carries an attestation of the ids the sink acknowledged, and a fence
 * built with `allowArchive` admits exactly those deletes. Every other delete on
 * that repository is still refused.
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
} from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IEvent {
  _id?: mongoose.Types.ObjectId;
  status: 'open' | 'closed';
  at: Date;
  note?: string;
}

const OLD = new Date('2018-01-01T00:00:00Z');
const RECENT = new Date('2026-10-01T00:00:00Z');
const CUTOFF = new Date('2020-01-01T00:00:00Z');
const PURGE = { reason: 'archive: closed 2018', actor: 'job:archive' };
const WINDOW = { at: { $lt: CUTOFF } };

function memorySink() {
  const byId = new Map<string, IEvent>();
  const writes: number[] = [];
  return {
    byId,
    writes,
    sink: {
      async write(docs: readonly IEvent[]) {
        writes.push(docs.length);
        for (const doc of docs) byId.set(String(doc._id), doc);
      },
    },
  };
}

describe('archiveByFilter through appendOnlyPlugin / immutableStatesPlugin', () => {
  let Model: mongoose.Model<IEvent>;
  let archivable: Repository<IEvent>;
  let fenced: Repository<IEvent>;
  let frozen: Repository<IEvent>;
  let events: AppendOnlyPurgeEvent[];
  let frozenEvents: ImmutablePurgeEvent[];

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'ArchiveAppendOnlyEvent',
      new Schema<IEvent>(
        {
          status: { type: String, required: true },
          at: { type: Date, required: true },
          note: { type: String },
        },
        { timestamps: true },
      ),
    );
    archivable = new Repository<IEvent>(Model, [appendOnlyPlugin({ allowArchive: true })]);
    archivable.on('after:append-only-purge', (e: AppendOnlyPurgeEvent) => events.push(e));
    fenced = new Repository<IEvent>(Model, [appendOnlyPlugin()]);
    frozen = new Repository<IEvent>(Model, [
      immutableStatesPlugin({ states: ['closed'], field: 'status', allowArchive: true }),
    ]);
    frozen.on('after:immutable-states-purge', (e: ImmutablePurgeEvent) => frozenEvents.push(e));
  });
  afterAll(async () => {
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    events = [];
    frozenEvents = [];
    await Model.create([
      ...Array.from({ length: 7 }, () => ({ status: 'closed', at: OLD })),
      { status: 'closed', at: RECENT },
    ]);
  });

  it('completes on an append-only repository and audits every chunk as archived', async () => {
    const memory = memorySink();
    const result = await archivable.archiveByFilter(WINDOW, memory.sink, {
      batchSize: 3,
      retentionPurge: PURGE,
    });

    expect(result).toMatchObject({ ok: true, processed: 7 });
    expect(memory.byId.size).toBe(7);
    expect(memory.writes).toEqual([3, 3, 1]);
    expect(await Model.countDocuments(WINDOW)).toBe(0);
    expect(await Model.countDocuments({})).toBe(1);
    expect(events.map((e) => e.deletedCount)).toEqual([3, 3, 1]);
    expect(events.every((e) => e.archived && e.reason === PURGE.reason)).toBe(true);
  });

  it('completes on an immutable-states repository for frozen rows', async () => {
    const memory = memorySink();
    const result = await frozen.archiveByFilter(WINDOW, memory.sink, {
      batchSize: 4,
      retentionPurge: PURGE,
    });
    expect(result).toMatchObject({ ok: true, processed: 7 });
    expect(frozenEvents.every((e) => e.archived)).toBe(true);
  });

  it('a delete outside an archive run is still refused by an allowArchive fence', async () => {
    await expect(archivable.deleteMany(WINDOW, { mode: 'hard' })).rejects.toMatchObject({
      code: 'APPEND_ONLY_VIOLATION',
    });
    await expect(
      archivable.deleteMany(WINDOW, { mode: 'hard', retentionPurge: PURGE }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_DISABLED' });
    await expect(
      archivable.purgeByFilter(WINDOW, { type: 'hard' }, { retentionPurge: PURGE }),
    ).resolves.toMatchObject({ ok: false });
    const one = await Model.findOne({}).lean();
    await expect(
      frozen.deleteMany({ _id: one?._id }, { mode: 'hard', retentionPurge: PURGE }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_DISABLED' });
    expect(await Model.countDocuments({})).toBe(8);
  });

  it('a forged attestation is refused, and so is a real one stretched over other rows', async () => {
    await expect(
      archivable.deleteMany(WINDOW, {
        mode: 'hard',
        retentionPurge: PURGE,
        archiveAttestation: Object.freeze({}),
      }),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_ARCHIVE_UNATTESTED' });

    // A sink that tries to delete a row outside its chunk from inside write().
    const outsider = await Model.findOne({ at: RECENT }).lean();
    let attempt: unknown;
    const result = await archivable.archiveByFilter(
      WINDOW,
      {
        async write() {
          attempt = await archivable
            .deleteMany(
              { _id: { $in: [outsider?._id] } },
              { mode: 'hard', retentionPurge: PURGE, archiveAttestation: {} },
            )
            .catch((err: { code?: string }) => err.code);
        },
      },
      { batchSize: 10, retentionPurge: PURGE },
    );
    expect(attempt).toBe('RETENTION_PURGE_ARCHIVE_UNATTESTED');
    expect(result.ok).toBe(true);
    expect(await Model.exists({ _id: outsider?._id })).toBeTruthy();
  });

  it('without allowArchive, or without retentionPurge, the delete half is refused and nothing is lost', async () => {
    const memory = memorySink();
    const noOption = await fenced.archiveByFilter(WINDOW, memory.sink, {
      batchSize: 10,
      retentionPurge: PURGE,
    });
    expect(noOption).toMatchObject({ ok: false, error: { phase: 'delete' } });

    const noPurge = await archivable.archiveByFilter(WINDOW, memory.sink, { batchSize: 10 });
    expect(noPurge).toMatchObject({ ok: false, error: { phase: 'delete' } });
    expect(await Model.countDocuments(WINDOW)).toBe(7);
  });

  it('a row that leaves the filter between read and delete stays hot', async () => {
    const plain = new Repository<IEvent>(Model, []);
    const target = await Model.findOne(WINDOW).sort({ _id: 1 }).lean();
    const sunk: IEvent[] = [];
    const result = await plain.archiveByFilter(
      { ...WINDOW, status: 'closed' },
      {
        async write(docs) {
          sunk.push(...docs);
          // Concurrent writer: reopen a row of THIS chunk after it was read.
          await Model.updateOne({ _id: target?._id }, { $set: { status: 'open' } });
        },
      },
      { batchSize: 100 },
    );
    expect(result.ok).toBe(true);
    expect(sunk.some((d) => String(d._id) === String(target?._id))).toBe(true);
    expect(await Model.exists({ _id: target?._id, status: 'open' })).toBeTruthy();
  });

  it('a row edited between export and delete that still matches stays live with its edit; the next run archives the new version', async () => {
    const plain = new Repository<IEvent>(Model, []);
    const target = await Model.findOne(WINDOW).sort({ _id: 1 }).lean();
    const sunk: IEvent[] = [];
    let edited = false;
    const sink = {
      async write(docs: readonly IEvent[]) {
        sunk.push(...docs);
        if (edited) return;
        edited = true;
        // Concurrent writer: edit a row of THIS chunk; it still matches the filter.
        await plain.update(String(target?._id), { note: 'edited after export' });
      },
    };
    const first = await plain.archiveByFilter(WINDOW, sink, { batchSize: 100 });
    expect(first).toMatchObject({ ok: true, processed: 6 });
    const live = await Model.findById(target?._id).lean();
    expect(live?.note, 'the edit must survive the run').toBe('edited after export');

    const second = await plain.archiveByFilter(WINDOW, sink, { batchSize: 100 });
    expect(second).toMatchObject({ ok: true, processed: 1 });
    const versions = sunk.filter((d) => String(d._id) === String(target?._id));
    expect(versions.map((d) => d.note)).toEqual([undefined, 'edited after export']);
    expect(await Model.exists({ _id: target?._id })).toBeNull();
  });

  it('refuses a collection with no maintained updatedAt before reading, unless declared immutable', async () => {
    const Bare = await createTestModel(
      'ArchiveNoTimestamps',
      new Schema<IEvent>({
        status: { type: String, required: true },
        at: { type: Date, required: true },
      }),
    );
    await Bare.create([{ status: 'closed', at: OLD }]);
    const bare = new Repository<IEvent>(Bare, []);
    let wrote = false;
    const sink = {
      async write() {
        wrote = true;
      },
    };
    await expect(bare.archiveByFilter(WINDOW, sink)).rejects.toMatchObject({
      code: 'ARCHIVE_NO_CHANGE_TOKEN',
    });
    expect(wrote).toBe(false);
    await expect(bare.archiveByFilter(WINDOW, sink, { immutable: true })).resolves.toMatchObject({
      ok: true,
      processed: 1,
    });
  });

  it('rejects a malformed retentionPurge before reading anything', async () => {
    let wrote = false;
    await expect(
      archivable.archiveByFilter(
        WINDOW,
        {
          async write() {
            wrote = true;
          },
        },
        { retentionPurge: { reason: ' ' } },
      ),
    ).rejects.toMatchObject({ code: 'RETENTION_PURGE_REASON_REQUIRED' });
    expect(wrote).toBe(false);
  });
});
