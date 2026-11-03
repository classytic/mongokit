/**
 * `createSequenceCounter({ collection })` — the atomic counter API bound to
 * a host-named collection, with a session on every call.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSequenceCounter,
  dateSequentialId,
  getNextSequence,
  sequentialId,
  withTransaction,
} from '../../src/index.js';
import { connectDB, disconnectDB } from '../setup.js';

const COLL = 'app_counters_seqtest';
const KEY = 'SeqCollTest:stream';

beforeAll(async () => {
  await connectDB();
});
afterAll(async () => {
  await disconnectDB();
});
beforeEach(async () => {
  await mongoose.connection.collection(COLL).deleteMany({});
  await mongoose.connection.collection('_mongokit_counters').deleteMany({ _id: KEY as never });
});

describe('createSequenceCounter', () => {
  it('writes to the named collection, isolated from _mongokit_counters', async () => {
    const counters = createSequenceCounter({ collection: COLL });
    expect(await counters.read(KEY)).toBeNull();
    expect(await counters.next(KEY)).toBe(1);
    expect(await counters.next(KEY, 5)).toBe(6);
    expect(await counters.read(KEY)).toBe(6);
    expect(await mongoose.connection.collection(COLL).countDocuments({ _id: KEY as never })).toBe(
      1,
    );
    // The default collection is untouched and independent.
    expect(await getNextSequence(KEY)).toBe(1);
  });

  it('ensureAtLeast raises, never lowers', async () => {
    const counters = createSequenceCounter({ collection: COLL });
    expect(await counters.ensureAtLeast(KEY, 40)).toBe(40);
    expect(await counters.ensureAtLeast(KEY, 10)).toBe(40);
    expect(await counters.next(KEY)).toBe(41);
    await expect(counters.ensureAtLeast(KEY, -1)).rejects.toThrow(/non-negative integer/);
  });

  it('two factories on the same collection share one model and one counter', async () => {
    const a = createSequenceCounter({ collection: COLL });
    const b = createSequenceCounter({ collection: COLL });
    await a.next(KEY);
    expect(await b.next(KEY)).toBe(2);
  });

  it('a bump inside an aborted transaction does not advance the counter', async () => {
    const counters = createSequenceCounter({ collection: COLL, connection: mongoose.connection });
    await counters.ensureAtLeast(KEY, 0);
    try {
      await withTransaction(mongoose.connection, async (session) => {
        expect(await counters.next(KEY, 1, session)).toBe(1);
        expect(await counters.read(KEY, session)).toBe(1);
        throw new Error('abort');
      }).catch((err: Error) => {
        if (err.message !== 'abort') throw err;
      });
    } catch (err) {
      if ((err as Error).message?.includes('Transaction numbers')) return;
      throw err;
    }
    expect(await counters.read(KEY)).toBe(0);
  });

  it('rejects an empty collection name', () => {
    expect(() => createSequenceCounter({ collection: '' })).toThrow(/non-empty/);
  });

  it('sequentialId / dateSequentialId honour counterCollection', async () => {
    const model = { modelName: 'SeqCollTest' } as unknown as mongoose.Model<unknown>;
    const gen = sequentialId({ prefix: 'S', model, counterKey: KEY, counterCollection: COLL });
    expect(await gen({} as never)).toBe('S-0001');
    expect(await createSequenceCounter({ collection: COLL }).read(KEY)).toBe(1);
    expect(
      await mongoose.connection
        .collection('_mongokit_counters')
        .countDocuments({ _id: KEY as never }),
    ).toBe(0);

    const dgen = dateSequentialId({
      prefix: 'D',
      model,
      partition: 'yearly',
      timezone: 'utc',
      counterCollection: COLL,
    });
    expect(await dgen({} as never)).toMatch(/^D-\d{4}-0001$/);
    const year = new Date().getUTCFullYear();
    expect(
      await mongoose.connection
        .collection(COLL)
        .countDocuments({ _id: `SeqCollTest:${year}` as never }),
    ).toBe(1);
    await mongoose.connection.collection(COLL).deleteMany({});
    expect(() => sequentialId({ prefix: 'S', model, counterCollection: '' })).toThrow(/non-empty/);
  });
});
