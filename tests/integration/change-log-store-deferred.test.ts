/**
 * `sequencing: 'deferred'` passes the same `ChangeLogStore` contract, and removes the hot counter from the writer's
 * transaction: two overlapping transactions that both append no longer conflict on one document.
 */
import { runChangeLogStoreConformance } from '@classytic/repo-core/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChangeLogModels, createChangeLogStore } from '../../src/sync/index.js';
import { connectDB, disconnectDB } from '../setup.js';

let feeds = 0;
async function deferredStore() {
  feeds += 1;
  const models = createChangeLogModels(mongoose.connection, {
    collection: `sync_deferred_${feeds}`,
    modelName: `SyncDeferred${feeds}`,
    sequencing: 'deferred',
  });
  await models.entries.syncIndexes();
  await models.pending?.syncIndexes();
  await models.counter.syncIndexes();
  return { store: createChangeLogStore(models), models };
}

const entry = (docId: string) => ({ scope: 'order', docId, op: 'upsert' as const, version: 1, doc: { docId }, tenantId: 'b' });

describe('mongo change-log store — deferred sequencing', () => {
  beforeAll(async () => {
    await connectDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });

  runChangeLogStoreConformance({
    async createStore() {
      return (await deferredStore()).store;
    },
    async transaction(work) {
      const session = await mongoose.startSession();
      try {
        let result: Awaited<ReturnType<typeof work>> | undefined;
        await session.withTransaction(async () => {
          result = await work(session);
        });
        return result as Awaited<ReturnType<typeof work>>;
      } finally {
        await session.endSession();
      }
    },
  });

  it('two overlapping transactions both append without a write conflict, and both entries are delivered', async () => {
    const { store } = await deferredStore();
    const a = await mongoose.startSession();
    const b = await mongoose.startSession();
    try {
      a.startTransaction();
      b.startTransaction();
      await store.append(entry('from-a'), { session: a });
      // Under in-transaction sequencing this second append targets the same counter row and throws WriteConflict.
      await store.append(entry('from-b'), { session: b });
      await b.commitTransaction();
      await a.commitTransaction();
    } finally {
      await a.endSession();
      await b.endSession();
    }
    const page = await store.since('');
    expect(page.changes.map((c) => c.docId).sort()).toEqual(['from-a', 'from-b']);
    expect(new Set(page.changes.map((c) => c.cursor)).size).toBe(2);
  });

  it('an entry staged in a transaction is not visible before the commit, and gets a cursor above a reader checkpoint', async () => {
    const { store } = await deferredStore();
    await store.append(entry('first'));
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await store.append(entry('late'), { session });
      const checkpoint = (await store.since('')).cursor;
      expect((await store.since('')).changes.map((c) => c.docId)).toEqual(['first']);
      await session.commitTransaction();
      expect((await store.since(checkpoint)).changes.map((c) => c.docId)).toEqual(['late']);
    } finally {
      await session.endSession();
    }
  });

  it('stage records without numbering; the next read numbers and delivers it', async () => {
    const { store, models } = await deferredStore();
    await store.stage(entry('staged'));
    expect(await models.entries.countDocuments({})).toBe(0);
    expect(await models.pending?.countDocuments({})).toBe(1);
    const page = await store.since('');
    expect(page.changes.map((c) => c.docId)).toEqual(['staged']);
    expect(await models.pending?.countDocuments({})).toBe(0);
  });

  it('a read with nothing staged costs no sequencer work beyond one existence check', async () => {
    const { store } = await deferredStore();
    expect(await store.sequencePending()).toBe(0);
  });
});
