/**
 * `prune(before)` on the mongo change feed: the `ChangeLogStore.prune` contract (repo-core
 * `src/sync`: "keeps the latest state and advertises its horizon; an older cursor gets
 * `CursorExpiredError`"). Before it, deleting old rows (a TTL index, `deleteMany` by age) left a
 * silent gap for a reader resuming from before them, and `since()` never threw.
 */
import { CursorExpiredError } from '@classytic/repo-core/sync';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createChangeLogModels,
  createChangeLogStore,
  type MongoChangeLogStore,
} from '../../src/sync/index.js';
import { connectDB } from '../setup.js';

const OLD = new Date('2026-10-01T00:00:00.000Z');
const CUTOFF = new Date('2026-10-02T00:00:00.000Z');

for (const sequencing of ['in-transaction', 'deferred'] as const) {
  describe(`mongo change-log store prune (${sequencing})`, () => {
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
        collection: `sync_prune_${tag}`,
        modelName: `SyncPrune${tag}`,
        sequencing,
      });
      await models.entries.syncIndexes();
      await models.horizons?.syncIndexes();
      made.push(models);
      return { models, store: createChangeLogStore(models) };
    };

    const put = (
      store: MongoChangeLogStore,
      docId: string,
      version: number,
      tenantId = 't',
      scope = 'alert',
    ) =>
      store.append({
        scope,
        docId,
        op: 'upsert',
        version,
        doc: { v: version },
        tenantId,
      });

    /** Backdate entries (cursor list) so they fall before the cutoff. */
    const age = async (models: ReturnType<typeof createChangeLogModels>, cursors: string[]) => {
      await models.entries.updateMany({ seq: { $in: cursors.map(Number) } }, { $set: { at: OLD } });
    };

    it('deletes old superseded entries, keeps each document latest (tombstones too), records the horizon', async () => {
      const { models, store } = await fresh();
      const a1 = await put(store, 'a', 1);
      const a2 = await put(store, 'a', 2);
      const b1 = await put(store, 'b', 1);
      const bDel = await store.append({
        scope: 'alert',
        docId: 'b',
        op: 'delete',
        version: 2,
        tenantId: 't',
      });
      const c1 = await put(store, 'c', 1); // old, but the latest of c
      const a3 = await put(store, 'a', 3); // recent: supersedes a1, a2
      await age(models, [a1.cursor, a2.cursor, b1.cursor, bDel.cursor, c1.cursor]);

      expect(await store.horizon()).toBe('');
      const horizon = await store.prune(CUTOFF);
      expect(horizon).toBe(b1.cursor); // highest deleted: a1, a2, b1 -> b1

      const left = (await models.entries.find({}).sort({ seq: 1 }).lean()) as Array<{
        seq: number;
      }>;
      expect(left.map((r) => r.seq)).toEqual([bDel, c1, a3].map((e) => Number(e.cursor)));
      expect(await store.horizon()).toBe(horizon);
      // A reader at or past the horizon still resumes.
      const page = await store.since(horizon);
      expect(page.changes.map((e) => e.cursor)).toEqual([bDel.cursor, c1.cursor, a3.cursor]);
      expect((await store.since(a3.cursor)).changes).toEqual([]);
      expect(await store.latestCursor()).toBe(a3.cursor);
    });

    it('since() below the horizon, "" included, throws CursorExpiredError(cursor, horizon)', async () => {
      const { models, store } = await fresh();
      const x1 = await put(store, 'x', 1);
      const x2 = await put(store, 'x', 2);
      await age(models, [x1.cursor]);
      const horizon = await store.prune(CUTOFF);
      expect(horizon).toBe(x1.cursor);

      for (const cursor of ['']) {
        const err = await store.since(cursor).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CursorExpiredError);
        expect((err as Error).name).toBe('CursorExpiredError');
        expect(err).toMatchObject({ cursor, horizon });
      }
      // The reader that resyncs from the head is fine.
      expect((await store.since(x1.cursor)).changes.map((e) => e.cursor)).toEqual([x2.cursor]);
    });

    it('nothing to prune: no horizon, no throw; idempotent; the horizon never goes down', async () => {
      const { models, store } = await fresh();
      const y1 = await put(store, 'y', 1); // old but latest
      const z1 = await put(store, 'z', 1);
      const z2 = await put(store, 'z', 2);
      await age(models, [y1.cursor]);
      expect(await store.prune(CUTOFF)).toBe('');
      expect((await store.since('')).changes).toHaveLength(3);
      expect(await models.entries.countDocuments({})).toBe(3);

      // Recent superseded entries are NOT pruned before their time.
      expect(await store.prune(CUTOFF)).toBe('');
      expect(await models.entries.countDocuments({ seq: Number(z1.cursor) })).toBe(1);

      // Later cutoff: z1 is now old enough.
      const h1 = await store.prune(new Date(Date.now() + 60_000));
      expect(h1).toBe(z1.cursor);
      expect(await store.prune(new Date(Date.now() + 60_000))).toBe(h1);
      expect((await store.since(z1.cursor)).changes.map((e) => e.cursor)).toEqual([z2.cursor]);
    });

    it('pruning tenant B never expires tenant A: A reads, resumes and re-heads without a livelock', async () => {
      const { models, store } = await fresh();
      const a1 = await put(store, 'a', 1, 'A');
      const b1 = await put(store, 'b', 1, 'B');
      const b2 = await put(store, 'b', 2, 'B');
      await age(models, [a1.cursor, b1.cursor]);
      expect(await store.prune(CUTOFF)).toBe(b1.cursor); // feed-wide horizon: b1

      const A = { tenantId: 'A' };
      const headA = await store.latestCursor(A);
      expect(headA).toBe(a1.cursor);
      expect((await store.since(headA, A)).changes).toEqual([]);
      expect((await store.since('', A)).changes.map((e) => e.cursor)).toEqual([a1.cursor]);
      expect(await store.horizon(A)).toBe('');
      // B lost b1: expired below its horizon, resumable from its own head.
      const B = { tenantId: 'B' };
      expect(await store.horizon(B)).toBe(b1.cursor);
      const err = await store.since('', B).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CursorExpiredError);
      expect(err).toMatchObject({ cursor: '', horizon: b1.cursor });
      expect(await store.latestCursor(B)).toBe(b2.cursor);
      expect((await store.since(b1.cursor, B)).changes.map((e) => e.cursor)).toEqual([b2.cursor]);
      // A scope narrowing that excludes the pruned scope is not expired; a shared scope that includes it is.
      expect((await store.since('', { tenantId: 'B', scopes: ['other'] })).changes).toEqual([]);
      await expect(
        store.since('', { tenantId: 'A', sharedScopes: ['alert'] }),
      ).rejects.toBeInstanceOf(CursorExpiredError);
      // Unfiltered readers keep the feed-wide horizon.
      await expect(store.since('')).rejects.toBeInstanceOf(CursorExpiredError);
      expect(await store.horizon()).toBe(b1.cursor);
    });

    it('a tenant with no entries reads "" without throwing, even after another tenant was pruned', async () => {
      const { models, store } = await fresh();
      const b1 = await put(store, 'b', 1, 'B');
      await put(store, 'b', 2, 'B');
      await age(models, [b1.cursor]);
      expect(await store.prune(CUTOFF)).toBe(b1.cursor);
      const C = { tenantId: 'C' };
      expect(await store.latestCursor(C)).toBe('');
      expect(await store.since('', C)).toEqual({ changes: [], cursor: '', hasMore: false });
    });

    it('latestCursor never re-heads a reader below its horizon', async () => {
      const { models, store } = await fresh();
      const b1 = await put(store, 'b', 1, 'B');
      const b2 = await put(store, 'b', 2, 'B');
      await age(models, [b1.cursor]);
      await store.prune(CUTOFF);
      // An entry removed outside prune (operator cleanup) leaves B with nothing but its horizon.
      await models.entries.deleteMany({ seq: Number(b2.cursor) });
      const head = await store.latestCursor({ tenantId: 'B' });
      expect(head).toBe(b1.cursor);
      expect((await store.since(head, { tenantId: 'B' })).changes).toEqual([]);
    });

    it('two tenants sharing a docId in one scope are different documents (prune and compactSuperseded)', async () => {
      const { models, store } = await fresh();
      const a1 = await put(store, 'same', 1, 'A'); // old, A's only entry
      const b1 = await put(store, 'same', 1, 'B'); // B's only entry, recent
      await age(models, [a1.cursor]);
      expect(await store.prune(CUTOFF)).toBe('');
      expect(await store.compactSuperseded()).toEqual({ removed: 0 });
      const left = (await models.entries.find({}).sort({ seq: 1 }).lean()) as Array<{
        seq: number;
      }>;
      expect(left.map((r) => r.seq)).toEqual([Number(a1.cursor), Number(b1.cursor)]);
      expect((await store.since('', { tenantId: 'A' })).changes.map((e) => e.cursor)).toEqual([
        a1.cursor,
      ]);
      // A real supersession inside one tenant is still pruned.
      const b2 = await put(store, 'same', 2, 'B');
      await age(models, [b1.cursor]);
      expect(await store.prune(CUTOFF)).toBe(b1.cursor);
      const after = (await models.entries.find({}).sort({ seq: 1 }).lean()) as Array<{
        seq: number;
      }>;
      expect(after.map((r) => r.seq)).toEqual([Number(a1.cursor), Number(b2.cursor)]);
      expect(await store.horizon({ tenantId: 'A' })).toBe('');
    });

    it('rejects an invalid cutoff', async () => {
      const { store } = await fresh();
      await expect(store.prune(new Date('nope'))).rejects.toThrow(/valid Date/);
    });

    it('never deletes past the horizon it records: entries appended mid-prune survive or expire the reader', async () => {
      const { models, store } = await fresh();
      // A concurrent writer whose entries are already older than the cutoff.
      const writer = createChangeLogStore(models, { now: () => OLD });
      const a1 = await put(store, 'a', 1);
      const a2 = await put(store, 'a', 2);
      await age(models, [a1.cursor, a2.cursor]);

      // Let prune take its "old entries" snapshot, then append a3 (old) and a4 before it
      // reads each document's latest entry: the snapshot says oldMax = a2, latest is a4.
      let a3: Awaited<ReturnType<typeof put>> | undefined;
      let a4: Awaited<ReturnType<typeof put>> | undefined;
      const realAggregate = models.entries.aggregate.bind(models.entries);
      const spy = vi.spyOn(models.entries, 'aggregate').mockImplementationOnce(((
        pipeline: never,
      ) => {
        const agg = realAggregate(pipeline);
        const realCursor = agg.cursor.bind(agg);
        (agg as { cursor: unknown }).cursor = (opts: never) => {
          const inner = realCursor(opts);
          return {
            async *[Symbol.asyncIterator]() {
              let first = true;
              for await (const group of inner) {
                if (first) {
                  first = false;
                  a3 = await put(writer, 'a', 3);
                  a4 = await put(writer, 'a', 4);
                }
                yield group;
              }
            },
          };
        };
        return agg;
      }) as never);
      const horizon = await store.prune(CUTOFF);
      spy.mockRestore();
      expect(a3 && a4).toBeTruthy();
      expect(horizon).toBe(a2.cursor);

      // A reader at the advertised horizon either reads everything after it, or is told to resync.
      const page = await store.since(horizon).catch((e: unknown) => e);
      if (page instanceof CursorExpiredError) return;
      expect((page as { changes: Array<{ cursor: string }> }).changes.map((e) => e.cursor)).toEqual(
        [a3?.cursor, a4?.cursor],
      );
    });
  });
}
