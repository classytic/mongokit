/**
 * G-PB06-1 follow-ups for the deferred change-log sequencer:
 *   - `createChangeLogStore(models, { now })`: an injected clock stamps every entry's `at`
 *     (staged and in-transaction), so a host's driven test clock and `prune(before)` agree;
 *   - `onSequenced`: called when THIS store numbered entries, and when a read of this store lost the
 *     sequencer lease and another holder numbered them meanwhile, so a replay hub can wake its tails
 *     instead of waiting for its next poll.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ChangeLogModels,
  type ChangeLogSequencedEvent,
  createChangeLogModels,
  createChangeLogStore,
} from '../../src/sync/index.js';
import { connectDB, disconnectDB } from '../setup.js';

let feeds = 0;
async function modelsOf(
  sequencing: 'deferred' | 'in-transaction',
  sequencerLeaseMs = 5_000,
): Promise<ChangeLogModels> {
  feeds += 1;
  const models = createChangeLogModels(mongoose.connection, {
    collection: `sync_hook_${feeds}`,
    modelName: `SyncHook${feeds}`,
    sequencing,
    sequencerLeaseMs,
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

/** The first insert of a pass stops until `resume()`: that pass holds the lease meanwhile. */
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

function recorder() {
  const events: ChangeLogSequencedEvent[] = [];
  let wake: (() => void) | undefined;
  return {
    events,
    onSequenced: (e: ChangeLogSequencedEvent) => {
      events.push(e);
      wake?.();
    },
    next: (timeoutMs: number) =>
      new Promise<ChangeLogSequencedEvent>((resolve, reject) => {
        const seen = events.length;
        const timer = setTimeout(
          () => reject(new Error(`no onSequenced within ${timeoutMs} ms`)),
          timeoutMs,
        );
        wake = () => {
          if (events.length > seen) {
            clearTimeout(timer);
            resolve(events[events.length - 1] as ChangeLogSequencedEvent);
          }
        };
      }),
  };
}

describe('mongo change-log store — injected clock and onSequenced', () => {
  beforeAll(async () => {
    await connectDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });

  it('`now` stamps `at` of staged and appended entries (both sequencings)', async () => {
    const fixed = new Date('2031-05-06T07:08:09.000Z');
    const deferred = createChangeLogStore(await modelsOf('deferred'), { now: () => fixed });
    await deferred.stage(entry('a'));
    const appended = await deferred.append(entry('b'));
    expect(appended.at).toEqual(fixed);
    const page = await deferred.since('');
    expect(page.changes.map((c) => [c.docId, c.at])).toEqual([
      ['a', fixed],
      ['b', fixed],
    ]);

    const inTx = createChangeLogStore(await modelsOf('in-transaction'), { now: () => fixed });
    expect((await inTx.append(entry('c'))).at).toEqual(fixed);
    expect((await inTx.since('')).changes[0]?.at).toEqual(fixed);
  });

  it('onSequenced reports what this store numbered, with the top cursor', async () => {
    const rec = recorder();
    const store = createChangeLogStore(await modelsOf('deferred'), {
      onSequenced: rec.onSequenced,
    });
    await store.stage(entry('a'));
    await store.stage(entry('b'));
    const page = await store.since('');
    expect(rec.events).toEqual([{ cursor: page.cursor, numbered: 2, by: 'self' }]);
    // Nothing staged: no call.
    await store.since(page.cursor);
    expect(rec.events).toHaveLength(1);
  });

  it('a read that lost the lease is woken when the other holder numbered the entry', async () => {
    const models = await modelsOf('deferred');
    const holder = createChangeLogStore(models);
    const rec = recorder();
    const reader = createChangeLogStore(models, { onSequenced: rec.onSequenced });
    await holder.stage(entry('x'));
    const hang = hangFirstInsert(models);
    const pass = holder.sequencePending();
    await hang.atInsert;

    // The reader loses the race: the entry is staged but not numbered yet.
    const busy = await reader.since('');
    expect(busy.changes).toEqual([]);
    expect(rec.events).toEqual([]);

    const woken = rec.next(3_000);
    hang.resume();
    expect(await pass).toBe(1);
    const event = await woken;
    expect(event).toMatchObject({ by: 'other', numbered: 1 });
    const page = await reader.since('');
    expect(page.changes.map((c) => c.docId)).toEqual(['x']);
    expect(page.cursor).toBe(event.cursor);
    hang.spy.mockRestore();
  });

  it('a holder that died mid-pass: the woken reader takes over within one lease and reports it', async () => {
    const models = await modelsOf('deferred', 300);
    const dead = createChangeLogStore(models);
    const rec = recorder();
    const reader = createChangeLogStore(models, { onSequenced: rec.onSequenced });
    await dead.stage(entry('y'));
    const hang = hangFirstInsert(models);
    const pass = dead.sequencePending();
    await hang.atInsert;

    const started = Date.now();
    const woken = rec.next(3_000);
    expect((await reader.since('')).changes).toEqual([]);
    const event = await woken;
    expect(event).toMatchObject({ by: 'self', numbered: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await reader.since('')).changes.map((c) => c.docId)).toEqual(['y']);

    // The dead pass wakes up fenced: it writes nothing.
    hang.resume();
    expect(await pass).toBe(0);
    expect(await models.entries.countDocuments({})).toBe(1);
    hang.spy.mockRestore();
  });

  it('a throwing hook never fails the read', async () => {
    const store = createChangeLogStore(await modelsOf('deferred'), {
      onSequenced: () => {
        throw new Error('hook failed');
      },
    });
    await store.stage(entry('z'));
    expect((await store.since('')).changes.map((c) => c.docId)).toEqual(['z']);
  });
});
