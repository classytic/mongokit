/**
 * The deferred sequencer's lease (G-PB06-1): configurable, renewed per batch, judged on the database clock, and
 * fenced. A sequencer that dies mid-pass delays numbering by at most one lease (it used to be a fixed 30 s), and a
 * holder that wakes after a takeover writes nothing.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ChangeLogModels,
  createChangeLogModels,
  createChangeLogStore,
  DEFAULT_SEQUENCER_LEASE_MS,
} from '../../src/sync/index.js';
import { connectDB, disconnectDB } from '../setup.js';

let feeds = 0;
async function deferredModels(sequencerLeaseMs?: number): Promise<ChangeLogModels> {
  feeds += 1;
  const models = createChangeLogModels(mongoose.connection, {
    collection: `sync_lease_${feeds}`,
    modelName: `SyncLease${feeds}`,
    sequencing: 'deferred',
    ...(sequencerLeaseMs !== undefined ? { sequencerLeaseMs } : {}),
  });
  await models.entries.syncIndexes();
  await models.pending?.syncIndexes();
  await models.counter.syncIndexes();
  return models;
}

const entry = (docId: string, version = 1) => ({
  scope: 'order',
  docId,
  op: 'upsert' as const,
  version,
  doc: { docId, version },
});

/** A pass that "dies" right before its first insert: it holds the lease and never renews or releases it. */
function hangFirstInsert(models: ChangeLogModels) {
  let reached!: () => void;
  const atInsert = new Promise<void>((r) => {
    reached = r;
  });
  let resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  const original = models.entries.insertMany.bind(models.entries);
  const spy = vi.spyOn(models.entries, 'insertMany').mockImplementationOnce((async (
    ...args: unknown[]
  ) => {
    reached();
    await gate;
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as never);
  return { atInsert, resume, spy };
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`not reached within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('mongo change-log store — deferred sequencer lease', () => {
  beforeAll(async () => {
    await connectDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });

  it('defaults to a short lease and rejects an invalid one', async () => {
    expect(DEFAULT_SEQUENCER_LEASE_MS).toBeLessThanOrEqual(5_000);
    expect((await deferredModels()).sequencerLeaseMs).toBe(DEFAULT_SEQUENCER_LEASE_MS);
    for (const bad of [0, 50, 1.5, Number.NaN]) {
      expect(() =>
        createChangeLogModels(mongoose.connection, {
          collection: 'sync_lease_bad',
          modelName: 'SyncLeaseBad',
          sequencing: 'deferred',
          sequencerLeaseMs: bad,
        }),
      ).toThrow(/sequencerLeaseMs/);
    }
  });

  it('a sequencer that dies mid-pass is taken over within one lease', async () => {
    const models = await deferredModels(400);
    const crashed = createChangeLogStore(models);
    const reader = createChangeLogStore(models);
    await crashed.stage(entry('a'));
    const { atInsert, resume } = hangFirstInsert(models);
    const dead = crashed.sequencePending();
    await atInsert;
    const crashAt = Date.now();
    // Held: the reader reads what is numbered (nothing) instead of waiting.
    expect(await reader.sequencePending()).toBeNull();
    const page = await until(async () => {
      const p = await reader.since('');
      return p.changes.length > 0 ? p : undefined;
    }, 3_000);
    const waited = Date.now() - crashAt;
    expect(page.changes.map((c) => c.docId)).toEqual(['a']);
    expect(waited).toBeLessThan(400 + 1_000);
    resume();
    await dead;
    // The woken holder added nothing: one entry, numbered once.
    expect(await models.entries.countDocuments({})).toBe(1);
    expect(await models.pending?.countDocuments({})).toBe(0);
  });

  it('a holder that wakes after a takeover writes nothing (fenced), even where no unique key would stop it', async () => {
    const models = await deferredModels(300);
    const stale = createChangeLogStore(models);
    const next = createChangeLogStore(models);
    await stale.stage(entry('x', 1));
    const { atInsert, resume } = hangFirstInsert(models);
    const woken = stale.sequencePending();
    await atInsert; // `stale` read [x@1] and holds seq 0..
    await next.stage(entry('x', 2));
    await new Promise((r) => setTimeout(r, 400)); // lease lapses
    expect(await next.sequencePending()).toBe(2);
    // Retention drops the superseded x@1 (seq 1): neither its seq nor its pendingId is taken any more.
    expect((await next.compactSuperseded()).removed).toBe(1);
    const checkpoint = (await next.since('')).cursor;
    resume();
    expect(await woken).toBe(0);
    // Unfenced, the stale holder would re-insert x@1 at seq 1, below the reader's checkpoint.
    const rows = (await models.entries.find({}).sort({ seq: 1 }).lean()) as Array<{
      seq: number;
      version: number;
    }>;
    expect(rows.map((r) => [r.seq, r.version])).toEqual([[2, 2]]);
    expect((await next.since(checkpoint)).changes).toEqual([]);
    const counterRow = (await models.counter.findById(models.feed).lean()) as {
      seq?: number;
      lockBy?: unknown;
    } | null;
    expect(counterRow?.seq).toBe(2);
    expect(counterRow?.lockBy).toBeNull();
  });

  it('a live holder renews per batch: a pass longer than one lease keeps it', async () => {
    const models = await deferredModels(700);
    const holder = createChangeLogStore(models);
    const other = createChangeLogStore(models);
    // Two full batches plus one, each held back 350 ms: the pass (over 1 s) outlives its first lease.
    await models.pending?.insertMany(
      Array.from({ length: 1_001 }, (_, i) => ({
        scope: 'order',
        docId: `d${i}`,
        op: 'upsert',
        version: 1,
        at: new Date(),
      })),
    );
    const original = models.entries.insertMany.bind(models.entries);
    const contests: Array<number | null> = [];
    let contending = false;
    const spy = vi.spyOn(models.entries, 'insertMany').mockImplementation((async (
      ...args: unknown[]
    ) => {
      if (!contending) {
        await new Promise((r) => setTimeout(r, 350));
        // A reader racing for the lease at every batch: the renewed lease turns it away.
        contending = true;
        try {
          contests.push(await other.sequencePending());
        } finally {
          contending = false;
        }
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as never);
    try {
      expect(await holder.sequencePending()).toBe(1_001);
    } finally {
      spy.mockRestore();
    }
    expect(contests).toEqual([null, null, null]);
    const seqs = (
      (await models.entries.find({}).sort({ seq: 1 }).select({ seq: 1 }).lean()) as Array<{
        seq: number;
      }>
    ).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 1_001 }, (_, i) => i + 1));
  });

  it('a standalone append waits out a crashed holder lease instead of failing', async () => {
    const models = await deferredModels(4_000);
    const store = createChangeLogStore(models);
    await models.counter.create([{ _id: models.feed, seq: 0 }]);
    // A holder that took the lease and died.
    await models.counter.updateOne(
      { _id: models.feed },
      { $set: { lockUntil: new Date(Date.now() + 4_000), lockBy: 'dead' } },
    );
    const started = Date.now();
    const appended = await store.append(entry('late'));
    expect(appended.cursor).not.toBe('');
    expect(Date.now() - started).toBeLessThan(4_000 + 1_000);
  });
});
