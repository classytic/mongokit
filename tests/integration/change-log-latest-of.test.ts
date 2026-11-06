/**
 * `latestOf(scope, docId)` on the mongo change feed: a point read of one document's latest recorded
 * change across staged (deferred sequencing, not numbered yet) and numbered entries, without running
 * the sequencer. Before it, a writer needing a record's last recorded state read the entries and the
 * staged collections itself.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChangeLogModels, createChangeLogStore } from '../../src/sync/index.js';
import { withTransaction } from '../../src/transaction.js';
import { connectDB } from '../setup.js';

for (const sequencing of ['in-transaction', 'deferred'] as const) {
  describe(`mongo change-log store latestOf (${sequencing})`, () => {
    let feeds = 0;
    const made: Array<ReturnType<typeof createChangeLogModels>> = [];

    beforeAll(async () => {
      await connectDB();
    });
    afterAll(async () => {
      for (const m of made) {
        await m.entries.deleteMany({});
        await m.counter.deleteMany({});
        await m.horizons?.deleteMany({});
        await m.pending?.deleteMany({});
      }
    });

    const fresh = async () => {
      feeds += 1;
      const tag = `${sequencing === 'deferred' ? 'D' : 'T'}${feeds}`;
      const models = createChangeLogModels(mongoose.connection, {
        collection: `sync_latest_${tag}`,
        modelName: `SyncLatest${tag}`,
        sequencing,
      });
      await models.entries.syncIndexes();
      made.push(models);
      return { models, store: createChangeLogStore(models) };
    };

    const change = (docId: string, version: number, extra: Record<string, unknown> = {}) => ({
      scope: 'record',
      docId,
      op: 'upsert' as const,
      version,
      doc: { v: version },
      ...extra,
    });

    it('is null for a document with no entry', async () => {
      const { store } = await fresh();
      await store.append(change('other', 1));
      expect(await store.latestOf('record', 'none')).toBeNull();
      expect(await store.latestOf('elsewhere', 'other')).toBeNull();
    });

    it('returns the highest numbered entry of the document, with its cursor', async () => {
      const { store } = await fresh();
      await store.append(change('a', 1));
      await store.append(change('b', 1));
      const last = await store.append(change('a', 2));
      const latest = await store.latestOf('record', 'a');
      expect(latest).toMatchObject({
        scope: 'record',
        docId: 'a',
        op: 'upsert',
        version: 2,
        doc: { v: 2 },
      });
      expect(latest?.cursor).toBe(last.cursor);
    });

    it('reads a tombstone as the latest change', async () => {
      const { store } = await fresh();
      await store.append(change('a', 1));
      await store.append({ scope: 'record', docId: 'a', op: 'delete', version: 2 });
      expect(await store.latestOf('record', 'a')).toMatchObject({ op: 'delete', version: 2 });
    });

    it('a document is (tenantId, scope, docId): omitted tenant reads the untenanted one', async () => {
      const { store } = await fresh();
      await store.append(change('a', 1));
      await store.append(change('a', 5, { tenantId: 't1' }));
      await store.append(change('a', 7, { tenantId: 't2' }));
      expect(await store.latestOf('record', 'a')).toMatchObject({ version: 1 });
      expect((await store.latestOf('record', 'a'))?.tenantId).toBeUndefined();
      expect(await store.latestOf('record', 'a', { tenantId: null })).toMatchObject({ version: 1 });
      expect(await store.latestOf('record', 'a', { tenantId: 't1' })).toMatchObject({
        version: 5,
        tenantId: 't1',
      });
      expect(await store.latestOf('record', 'a', { tenantId: 't3' })).toBeNull();
    });

    it('sees what the caller wrote in its own transaction', async () => {
      const { store } = await fresh();
      await store.append(change('a', 1));
      await withTransaction(mongoose.connection, async (session) => {
        await store.stage(change('a', 2), { session });
        expect(await store.latestOf('record', 'a', { session })).toMatchObject({ version: 2 });
        // Outside the transaction the write is not visible yet.
        expect(await store.latestOf('record', 'a')).toMatchObject({ version: 1 });
      });
      expect(await store.latestOf('record', 'a')).toMatchObject({ version: 2 });
    });

    if (sequencing === 'deferred') {
      it('reads a staged entry before any numbered one, without numbering it', async () => {
        const { models, store } = await fresh();
        await store.append(change('a', 1));
        await store.stage(change('a', 2));
        await store.stage(change('a', 3));
        const latest = await store.latestOf('record', 'a');
        expect(latest).toMatchObject({ version: 3, doc: { v: 3 }, cursor: '' });
        // A read only: the staged rows are still waiting for the sequencer.
        expect(await models.pending?.countDocuments({ docId: 'a' })).toBe(2);
        await store.sequencePending();
        const numbered = await store.latestOf('record', 'a');
        expect(numbered).toMatchObject({ version: 3 });
        expect(numbered?.cursor).not.toBe('');
      });
    }
  });
}
