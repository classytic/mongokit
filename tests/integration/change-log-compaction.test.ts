/**
 * `compactSuperseded` drops every entry a LATER entry of the same document replaced, and nothing else.
 * A client resuming from ANY cursor taken before compaction ends in the same state as without it;
 * tombstones and the latest upsert of every document stay.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeEntry, ChangeLogStore } from '@classytic/repo-core/sync';
import { createChangeLogModels, createChangeLogStore } from '../../src/sync/index.js';
import { connectDB, disconnectDB } from '../setup.js';

/** What a client holds after applying every page from `cursor`: latest version per doc, tombstones remove. */
async function stateFrom(store: ChangeLogStore, cursor: string, tenantId?: string): Promise<Record<string, unknown>> {
  const state: Record<string, { version: number; doc: unknown }> = {};
  let at = cursor;
  for (;;) {
    const page = await store.since(at, { limit: 2, ...(tenantId ? { tenantId } : {}) });
    for (const e of page.changes as readonly ChangeEntry[]) {
      const key = `${e.scope}/${e.docId}`;
      if ((state[key]?.version ?? -1) >= e.version) continue;
      state[key] = { version: e.version, doc: e.op === 'delete' ? null : e.doc };
    }
    at = page.cursor;
    if (!page.hasMore) break;
  }
  return Object.fromEntries(Object.entries(state).filter(([, v]) => v.doc !== null).map(([k, v]) => [k, v.doc]));
}

describe('change-log compaction', () => {
  let feeds = 0;
  beforeAll(async () => {
    await connectDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });

  async function freshStore() {
    feeds += 1;
    const models = createChangeLogModels(mongoose.connection, { collection: `sync_compact_${feeds}`, modelName: `SyncCompact${feeds}` });
    await models.entries.syncIndexes();
    return { store: createChangeLogStore(models), models };
  }

  it('keeps the latest entry per document and every client converges from every old cursor', async () => {
    const { store, models } = await freshStore();
    const cursors: string[] = [''];
    const write = async (scope: string, docId: string, version: number, op: 'upsert' | 'delete', qty?: number) => {
      const e = await store.append({ scope, docId, version, op, tenantId: 'b1', ...(op === 'upsert' ? { doc: { qty } } : {}) });
      cursors.push(e.cursor);
    };
    await write('stock', 'X', 1, 'upsert', 5);
    await write('stock', 'Y', 1, 'upsert', 2);
    await write('stock', 'X', 2, 'upsert', 4);
    await write('products', 'X', 1, 'upsert', 9);
    await write('stock', 'Y', 2, 'delete');
    await write('stock', 'X', 3, 'upsert', 3);
    await write('stock', 'Z', 1, 'upsert', 7);

    const before = await Promise.all(cursors.map((c) => stateFrom(store, c, 'b1')));
    const { removed } = await store.compactSuperseded();
    const after = await Promise.all(cursors.map((c) => stateFrom(store, c, 'b1')));

    expect(removed).toBe(3);
    expect(after).toEqual(before);
    const left = await models.entries.find({}, { _id: 0, scope: 1, docId: 1, op: 1, version: 1 }).sort({ seq: 1 }).lean();
    expect(left).toEqual([
      { scope: 'products', docId: 'X', op: 'upsert', version: 1 },
      { scope: 'stock', docId: 'Y', op: 'delete', version: 2 },
      { scope: 'stock', docId: 'X', op: 'upsert', version: 3 },
      { scope: 'stock', docId: 'Z', op: 'upsert', version: 1 },
    ]);
  });

  it('is idempotent and leaves the head cursor where it was', async () => {
    const { store } = await freshStore();
    await store.append({ scope: 'stock', docId: 'A', version: 1, op: 'upsert', doc: { qty: 1 } });
    await store.append({ scope: 'stock', docId: 'A', version: 2, op: 'upsert', doc: { qty: 2 } });
    const head = await store.latestCursor();
    expect((await store.compactSuperseded()).removed).toBe(1);
    expect((await store.compactSuperseded()).removed).toBe(0);
    expect(await store.latestCursor()).toBe(head);
    const next = await store.append({ scope: 'stock', docId: 'A', version: 3, op: 'upsert', doc: { qty: 3 } });
    expect(next.cursor > head).toBe(true);
  });
});
