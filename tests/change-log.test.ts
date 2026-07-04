/**
 * changeLogPlugin — capture side of @classytic/repo-core/sync.
 * Proves the contract against a REAL repository pipeline: upserts on
 * create/update, TOMBSTONE on delete, tenant + scope stamping, version
 * derivation, skipPlugins opt-out, and a client converging via `since`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MemoryChangeLogStore } from '@classytic/repo-core/sync';
import { Repository } from '../src/repository.js';
import { changeLogPlugin } from '../src/plugins/change-log.plugin.js';
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
    expect(e).toMatchObject({ scope: 'pos-order', docId: String(doc._id), op: 'upsert', version: 1, tenantId: 'org1' });
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

  it('honors skipPlugins hot-path opt-out', async () => {
    await repo.create({ name: 'silent', total: 0 }, { skipPlugins: ['changeLog'] } as never);
    expect((await store.since('')).changes).toHaveLength(0);
  });
});
