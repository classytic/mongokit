/**
 * Integration test for `Repository.watch()` against REAL Mongo change
 * streams. The shared global-setup boots a single-node MongoMemoryReplSet
 * (change streams require an oplog), and stamps
 * `MONGOKIT_TEST_REPLICA_SET=1` — the same gate the transaction tests
 * rely on. When an external standalone `MONGODB_URI` is supplied
 * instead, these specs are skipped.
 */

import type { ChangeEvent } from '@classytic/repo-core/repository';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IWatched {
  name: string;
  status: string;
}

const onReplicaSet = process.env.MONGOKIT_TEST_REPLICA_SET === '1';

describe.skipIf(!onReplicaSet)('Repository.watch (real change streams)', () => {
  let Model: mongoose.Model<IWatched>;
  let repo: Repository<IWatched>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'WatchChangeStreamDoc',
      new mongoose.Schema<IWatched>({
        name: { type: String, required: true },
        status: { type: String, required: true },
      }),
    );
    repo = new Repository<IWatched>(Model);
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  it('streams create/update events, honors the filter, and ends on abort', async () => {
    const ac = new AbortController();
    const events: ChangeEvent<IWatched>[] = [];

    const consumer = (async () => {
      for await (const event of repo.watch({ status: 'pending' }, { signal: ac.signal })) {
        events.push(event);
        if (events.length >= 2) break;
      }
    })();

    // Give the change stream a moment to establish before writing —
    // events written before the stream opens are not replayed.
    await new Promise((r) => setTimeout(r, 500));

    // Non-matching write first: must NOT appear in the filtered feed.
    await repo.create({ name: 'ignored', status: 'done' });
    const doc = await repo.create({ name: 'job-1', status: 'pending' });
    await repo.update(String((doc as IWatched & { _id: unknown })._id), { name: 'job-1b' });

    await consumer;

    expect(events).toHaveLength(2);
    expect(events[0].operation).toBe('create');
    expect(events[0].doc?.name).toBe('job-1');
    expect(String(events[0].id)).toBe(String((doc as IWatched & { _id: unknown })._id));
    expect(events[0].timestamp).toBeInstanceOf(Date);

    expect(events[1].operation).toBe('update');
    // fullDocument: 'updateLookup' — post-image carried on updates.
    expect(events[1].doc?.name).toBe('job-1b');
    expect(events[1].doc?.status).toBe('pending');

    ac.abort();
  }, 30_000);

  it('ends iteration when the signal aborts', async () => {
    const ac = new AbortController();
    const events: ChangeEvent<IWatched>[] = [];

    const consumer = (async () => {
      for await (const event of repo.watch(undefined, { signal: ac.signal })) {
        events.push(event);
      }
    })();

    await new Promise((r) => setTimeout(r, 500));
    ac.abort();

    // The contract: the iterator ENDS (no throw) when the signal aborts.
    await expect(consumer).resolves.toBeUndefined();
  }, 30_000);
});
