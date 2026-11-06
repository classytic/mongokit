/**
 * `snapshot()` on the mongo change feed: the bootstrap a reader `since()` expired uses. Snapshot to
 * `upTo`, then `since(upTo)`, must rebuild exactly the state of a reader that never missed an entry.
 */
import type { ChangeEntry } from '@classytic/repo-core/sync';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createChangeLogModels,
  createChangeLogStore,
  type MongoChangeLogStore,
} from '../../src/sync/index.js';
import { connectDB } from '../setup.js';

const OLD = new Date('2026-10-01T00:00:00.000Z');
const CUTOFF = new Date('2026-10-02T00:00:00.000Z');

type View = { tenantId?: string; scopes?: string[]; sharedScopes?: string[] };

/** A reader's state: per document, the highest version seen (a tombstone removes the doc). */
function fold(
  state: Map<string, { version: number; doc?: unknown }>,
  changes: readonly ChangeEntry[],
) {
  for (const e of changes) {
    const key = `${e.tenantId ?? ''}/${e.scope}/${e.docId}`;
    const held = state.get(key);
    if (e.op === 'upsert' && held && held.version >= e.version) continue; // a tombstone always applies
    state.set(key, e.op === 'delete' ? { version: e.version } : { version: e.version, doc: e.doc });
  }
  return state;
}
const live = (state: Map<string, { version: number; doc?: unknown }>) =>
  new Map([...state].filter(([, v]) => v.doc !== undefined).map(([k, v]) => [k, v.doc]));

async function readAll(store: MongoChangeLogStore, from: string, view: View) {
  const all: ChangeEntry[] = [];
  let cursor = from;
  for (;;) {
    const page = await store.since(cursor, { ...view, limit: 2 });
    all.push(...page.changes);
    cursor = page.cursor;
    if (!page.hasMore) return { changes: all, cursor };
  }
}

/** Snapshot (paged) then since(upTo) — what a resyncing reader does. */
async function bootstrap(store: MongoChangeLogStore, view: View, limit = 2) {
  const snap: ChangeEntry[] = [];
  let cursor = '';
  let upTo: string | undefined;
  const bounds = new Set<string>();
  for (;;) {
    const page = await store.snapshot(cursor, {
      ...view,
      limit,
      ...(upTo === undefined ? {} : { upTo }),
    });
    snap.push(...page.changes);
    bounds.add(page.upTo);
    upTo = page.upTo;
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  const tail = await readAll(store, upTo ?? '', view);
  return { snap, upTo: upTo ?? '', bounds, state: fold(fold(new Map(), snap), tail.changes) };
}

for (const sequencing of ['in-transaction', 'deferred'] as const) {
  describe(`mongo change-log store snapshot (${sequencing})`, () => {
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
        collection: `sync_snap_${tag}`,
        modelName: `SyncSnap${tag}`,
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
      scope = 'item',
    ) =>
      store.append({ scope, docId, op: 'upsert', version, doc: { docId, v: version }, tenantId });
    const del = (
      store: MongoChangeLogStore,
      docId: string,
      version: number,
      tenantId = 't',
      scope = 'item',
    ) => store.append({ scope, docId, op: 'delete', version, tenantId });
    const ageAll = (models: ReturnType<typeof createChangeLogModels>, upToSeq: number) =>
      models.entries.updateMany({ seq: { $lte: upToSeq } }, { $set: { at: OLD } });

    /** Old history (aged), then recent writes; returns the store, pruned. */
    const history = async () => {
      const { models, store } = await fresh();
      await put(store, 'kept', 1); // old and the latest of its doc: stays below the horizon
      await put(store, 'edited', 1);
      await put(store, 'edited', 2);
      await put(store, 'gone', 1);
      await del(store, 'gone', 2); // deleted long ago: must stay deleted after a bootstrap
      await put(store, 'late-del', 1);
      await put(store, 'superseded', 1);
      // Recent, superseded, yet below the horizon (another scope's prune raised it): the snapshot sends n/2 only.
      const n1 = await put(store, 'n', 1, 't', 'note');
      const n2 = await put(store, 'n', 2, 't', 'note');
      // changeLogPlugin's tombstone is version 0, below the upsert it deletes: it still wins.
      await put(store, 'zeroed', 7);
      await store.append({
        scope: 'item',
        docId: 'zeroed',
        op: 'delete',
        version: 0,
        tenantId: 't',
      });
      await put(store, 'reborn', 4);
      await store.append({
        scope: 'item',
        docId: 'reborn',
        op: 'delete',
        version: 0,
        tenantId: 't',
      });
      await put(store, 'reborn', 2); // re-created after the delete, at a lower version: it is live
      // Versions need not follow the feed (branch stock stamps its read time): the higher one wins.
      await put(store, 'racing', 200);
      await put(store, 'racing', 100);
      const lastOld = await put(store, 'superseded', 2);
      await ageAll(models, Number(lastOld.cursor));
      await models.entries.updateMany(
        { seq: { $in: [Number(n1.cursor), Number(n2.cursor)] } },
        { $set: { at: new Date() } },
      );
      await put(store, 'superseded', 3); // recent: supersedes the old ones
      await del(store, 'late-del', 2); // deleted after the horizon: arrives through since(upTo)
      await put(store, 'new', 1);
      await put(store, 'other', 1, 'u'); // another tenant
      return { models, store };
    };

    it('snapshot then since(upTo) rebuilds the state of a reader that never missed an entry', async () => {
      const { store } = await history();
      const view = { tenantId: 't' };
      const truth = live(fold(new Map(), (await readAll(store, '', view)).changes));
      const horizon = await store.prune(CUTOFF);
      expect(horizon).not.toBe('');
      await expect(store.since('', view)).rejects.toMatchObject({ name: 'CursorExpiredError' });

      const { snap, upTo, bounds, state } = await bootstrap(store, view);
      expect(upTo).toBe(await store.horizon(view));
      expect([...bounds]).toEqual([upTo]); // one bound for every page
      expect(live(state)).toEqual(truth);
      // The snapshot holds each document's latest entry once, and never a tombstone.
      const keys = snap.map((e) => e.docId);
      expect(new Set(keys).size).toBe(keys.length);
      expect(snap.every((e) => e.op === 'upsert')).toBe(true);
      expect(keys).toContain('kept');
      expect(keys).not.toContain('gone');
      expect(live(state).has('t/item/zeroed')).toBe(false);
      expect(live(state).get('t/item/reborn')).toEqual({ docId: 'reborn', v: 2 });
      expect(live(state).has('t/item/gone')).toBe(false);
      expect(live(state).has('t/item/late-del')).toBe(false);
      // Tenant isolation: the other tenant's document never reaches this reader.
      expect([...state.keys()].some((k) => k.startsWith('u/'))).toBe(false);
    });

    it('retention keeps the highest version, not the last cursor (prune and compactSuperseded)', async () => {
      const { models, store } = await history();
      await put(store, 'racing2', 9);
      await put(store, 'racing2', 3); // recorded later, lower version: a reader ignores it
      await store.compactSuperseded();
      const left = (await models.entries
        .find({ docId: { $in: ['racing', 'racing2'] } })
        .lean()) as Array<{
        docId: string;
        version: number;
      }>;
      expect(left.map((r) => `${r.docId}@${r.version}`).sort()).toEqual([
        'racing2@9',
        'racing@200',
      ]);
      await store.prune(CUTOFF);
      const { state } = await bootstrap(store, { tenantId: 't' });
      expect(live(state).get('t/item/racing')).toEqual({ docId: 'racing', v: 200 });
      expect(live(state).get('t/item/racing2')).toEqual({ docId: 'racing2', v: 9 });
    });

    it('page size never changes the answer; the bound is fixed by the first page', async () => {
      const { store } = await history();
      await store.prune(CUTOFF);
      const view = { tenantId: 't' };
      const one = await bootstrap(store, view, 1);
      const many = await bootstrap(store, view, 500);
      expect(live(one.state)).toEqual(live(many.state));
      expect(one.snap.map((e) => e.cursor)).toEqual(many.snap.map((e) => e.cursor));
      // A prune raising the horizon mid-snapshot does not move a bound the reader already holds.
      const first = await store.snapshot('', { ...view, limit: 1 });
      const next = await store.snapshot(first.cursor, { ...view, limit: 1, upTo: first.upTo });
      expect(next.upTo).toBe(first.upTo);
    });

    it('a feed never pruned has an empty snapshot and resumes from ""', async () => {
      const { store } = await fresh();
      await put(store, 'a', 1);
      const page = await store.snapshot('', { tenantId: 't' });
      expect(page).toEqual({ changes: [], cursor: '', hasMore: false, upTo: '' });
      expect((await store.since('', { tenantId: 't' })).changes).toHaveLength(1);
    });

    it('a shared scope reaches every tenant snapshot; a narrowing `scopes` is honoured', async () => {
      const { models, store } = await fresh();
      await put(store, 'p', 1, 'hq', 'product');
      await put(store, 'p', 2, 'hq', 'product');
      await put(store, 'o', 1, 't', 'order');
      await put(store, 'o', 2, 't', 'order');
      const last = await put(store, 'x', 1, 't', 'note');
      await ageAll(models, Number(last.cursor));
      await put(store, 'tick', 1, 't', 'note');
      await store.prune(CUTOFF);
      const view = { tenantId: 't', sharedScopes: ['product'], scopes: ['product', 'order'] };
      const { snap, state } = await bootstrap(store, view);
      expect(snap.map((e) => `${e.scope}/${e.docId}/${e.version}`)).toEqual(['product/p/2']); // o/2 sits above upTo
      expect([...live(state).keys()].sort()).toEqual(['hq/product/p', 't/order/o']);
      expect(live(state).get('t/order/o')).toEqual({ docId: 'o', v: 2 });
    });
  });
}
