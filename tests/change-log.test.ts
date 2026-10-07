/**
 * changeLogPlugin — capture side of @classytic/repo-core/sync.
 * Proves the contract against a REAL repository pipeline: upserts on
 * create/update, TOMBSTONE on delete, tenant + scope stamping, version
 * derivation, skipPlugins opt-out, and a client converging via `since`.
 */

import { MemoryChangeLogStore } from '@classytic/repo-core/sync';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batchOperationsPlugin } from '../src/plugins/batch-operations.plugin.js';
import { changeLogPlugin } from '../src/plugins/change-log.plugin.js';
import { methodRegistryPlugin } from '../src/plugins/method-registry.plugin.js';
import { Repository } from '../src/repository.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface PosOrder {
  name: string;
  total: number;
  version?: number;
  organizationId?: string;
}

let Model: mongoose.Model<PosOrder>;
let store: MemoryChangeLogStore;
let repo: Repository<PosOrder>;

describe('changeLogPlugin', () => {
  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel<PosOrder>(
      'ClPosOrder',
      new mongoose.Schema<PosOrder>(
        {
          name: String,
          total: Number,
          version: Number,
          organizationId: String,
        },
        { timestamps: true },
      ),
    );
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    store = new MemoryChangeLogStore();
    repo = new Repository<PosOrder>(Model, [changeLogPlugin({ store, scope: 'pos-order' })]);
  });

  it('create → upsert entry with doc, scope, tenant, version', async () => {
    const doc = await repo.create({ name: 'A', total: 100, version: 1, organizationId: 'org1' });
    const page = await store.since('');
    expect(page.changes).toHaveLength(1);
    const e = page.changes[0]!;
    expect(e).toMatchObject({
      scope: 'pos-order',
      docId: String(doc._id),
      op: 'upsert',
      version: 1,
      tenantId: 'org1',
    });
    expect((e.doc as PosOrder).name).toBe('A');
  });

  it('update → upsert; delete → TOMBSTONE without doc', async () => {
    const doc = await repo.create({ name: 'B', total: 1, version: 1 });
    await repo.update(String(doc._id), { total: 2, version: 2 });
    await repo.delete(String(doc._id));

    const page = await store.since('');
    expect(page.changes.map((c) => c.op)).toEqual(['upsert', 'upsert', 'delete']);
    const tomb = page.changes[2]!;
    expect(tomb.doc).toBeUndefined();
    expect(tomb.docId).toBe(String(doc._id));
  });

  it('a client converges from its checkpoint (exclusive since, tombstones included)', async () => {
    const a = await repo.create({ name: 'A', total: 1, version: 1 });
    const checkpoint = (await store.since('')).cursor; // client synced through create(A)

    await repo.update(String(a._id), { total: 9, version: 2 });
    const b = await repo.create({ name: 'B', total: 5, version: 1 });
    await repo.delete(String(a._id));

    const delta = await store.since(checkpoint);
    expect(delta.changes.map((c) => `${c.docId === String(a._id) ? 'A' : 'B'}:${c.op}`)).toEqual([
      'A:upsert',
      'B:upsert',
      'A:delete',
    ]);
    expect(String(b._id)).toBeTruthy();
  });

  it('falls back to __v then updatedAt when no version field', async () => {
    const doc = await repo.create({ name: 'NoV', total: 1 }); // no version set
    const e = (await store.since('')).changes[0]!;
    // __v exists on mongoose docs (0) — monotonic-enough floor.
    expect(typeof e.version).toBe('number');
    expect(String(doc._id)).toBe(e.docId);
  });

  it('refuses a second capture on the same repository', () => {
    expect(() => repo.use(changeLogPlugin({ store, scope: 'again' }) as never)).toThrow(/already capturing/);
    expect(() => repo.use(changeLogPlugin({ store: new MemoryChangeLogStore(), scope: 'pos-order' }) as never)).toThrow(
      /already capturing/,
    );
  });

  it('the same capture again is already in place: each change is written once', async () => {
    repo.use(changeLogPlugin({ store, scope: 'pos-order' }) as never);
    await repo.create({ name: 'once', total: 1 });
    expect((await store.since('')).changes).toHaveLength(1);
  });

  it('honors skipPlugins hot-path opt-out', async () => {
    await repo.create({ name: 'silent', total: 0 }, { skipPlugins: ['changeLog'] } as never);
    expect((await store.since('')).changes).toHaveLength(0);
  });
});

/** Every verb that changes a document reaches the feed, as the whole document. */
describe('changeLogPlugin — verb coverage', () => {
  const after = async (cursor: string) => (await store.since(cursor)).changes;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    store = new MemoryChangeLogStore();
    repo = new Repository<PosOrder>(Model, [methodRegistryPlugin(), batchOperationsPlugin(), changeLogPlugin({ store, scope: 'pos-order' })]);
  });

  it('claim captures the whole document; a lost claim captures nothing', async () => {
    const doc = await repo.create({ name: 'open', total: 5, organizationId: 'org1' });
    const head = await store.latestCursor();
    await repo.claim(String(doc._id), { field: 'name', from: 'open', to: 'paid' }, { total: 9 });
    const [won] = await after(head);
    expect(won).toMatchObject({ op: 'upsert', docId: String(doc._id), tenantId: 'org1', doc: { name: 'paid', total: 9 } });

    const head2 = await store.latestCursor();
    expect(await repo.claim(String(doc._id), { field: 'name', from: 'open', to: 'paid' })).toBeNull();
    expect(await after(head2)).toHaveLength(0);
  });

  it('findOneAndUpdate with a projection still captures the whole document', async () => {
    const doc = await repo.create({ name: 'A', total: 1, organizationId: 'org1' });
    const head = await store.latestCursor();
    await repo.findOneAndUpdate({ _id: doc._id }, { $set: { total: 2 } }, { projection: { total: 1 } } as never);
    const [e] = await after(head);
    expect(e?.doc).toMatchObject({ name: 'A', total: 2, organizationId: 'org1' });
  });

  it('updateMany captures every matched document, and only those', async () => {
    const [a, b] = await repo.createMany([
      { name: 'a', total: 1 },
      { name: 'b', total: 1 },
      { name: 'c', total: 7 },
    ]);
    const head = await store.latestCursor();
    await repo.updateMany({ total: 1 }, { $set: { total: 3 } });
    const entries = await after(head);
    expect(entries.map((e) => e.docId).sort()).toEqual([String(a!._id), String(b!._id)].sort());
    expect(entries.every((e) => (e.doc as PosOrder).total === 3)).toBe(true);
  });

  it('deleteMany tombstones every matched document', async () => {
    const [a, b] = await repo.createMany([
      { name: 'a', total: 1 },
      { name: 'b', total: 1 },
      { name: 'c', total: 7 },
    ]);
    const head = await store.latestCursor();
    await repo.deleteMany({ total: 1 });
    const entries = await after(head);
    expect(entries.map((e) => [e.op, e.docId]).sort()).toEqual([
      ['delete', String(a!._id)],
      ['delete', String(b!._id)],
    ].sort());
  });

  it('bulkWrite captures inserts, updates, upserts and deletes', async () => {
    const [kept, gone] = await repo.createMany([
      { name: 'kept', total: 1 },
      { name: 'gone', total: 1 },
    ]);
    const insertedId = new mongoose.Types.ObjectId();
    const head = await store.latestCursor();
    const result = (await (repo as unknown as { bulkWrite: (ops: unknown[]) => Promise<{ upsertedIds?: Record<string, unknown> }> }).bulkWrite([
      { insertOne: { document: { _id: insertedId, name: 'new', total: 4 } } },
      { updateOne: { filter: { _id: kept!._id }, update: { $set: { total: 8 } } } },
      { updateOne: { filter: { name: 'fresh' }, update: { $set: { total: 6 } }, upsert: true } },
      { deleteOne: { filter: { _id: gone!._id } } },
    ]));
    const upsertedId = String(Object.values(result.upsertedIds ?? {})[0]);
    const byId = new Map((await after(head)).map((e) => [e.docId, e]));
    expect(byId.get(String(insertedId))).toMatchObject({ op: 'upsert', doc: { name: 'new' } });
    expect(byId.get(String(kept!._id))).toMatchObject({ op: 'upsert', doc: { total: 8 } });
    expect(byId.get(upsertedId)).toMatchObject({ op: 'upsert', doc: { name: 'fresh', total: 6 } });
    expect(byId.get(String(gone!._id))).toMatchObject({ op: 'delete' });
  });

  it('purge anonymize captures each anonymised document', async () => {
    const [a] = await repo.createMany([
      { name: 'Rahim', total: 1 },
      { name: 'Karim', total: 2 },
    ]);
    const head = await store.latestCursor();
    await repo.purgeByFilter({ total: 1 }, { type: 'anonymize', fields: { name: (d: Record<string, unknown>) => `anon-${String(d.total)}` } } as never);
    const entries = await after(head);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: 'upsert', docId: String(a!._id), doc: { name: 'anon-1' } });
  });
});

describe('changeLogPlugin — project', () => {
  beforeAll(async () => {
    await connectDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });

  it('writes the projected document, keeping tenant and version from the whole one', async () => {
    await Model.deleteMany({});
    const projected = new MemoryChangeLogStore();
    const shaped = new Repository<PosOrder>(Model, [
      changeLogPlugin({ store: projected, scope: 'pos-order', project: ({ _id, name }) => ({ _id, name }) }),
    ]);
    const doc = await shaped.create({ name: 'Mug', total: 999, version: 3, organizationId: 'org1' });
    const [entry] = (await projected.since('')).changes;
    expect(entry).toMatchObject({ docId: String(doc._id), version: 3, tenantId: 'org1', doc: { name: 'Mug' } });
    expect(entry!.doc).not.toHaveProperty('total');
  });
});
