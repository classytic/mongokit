/**
 * The change rows changeLogPlugin writes, pinned byte-for-byte per verb. These goldens were captured
 * from the re-reading implementation; the read-free capture must reproduce them exactly.
 */
import { MemoryChangeLogStore } from '@classytic/repo-core/sync';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batchOperationsPlugin } from '../../src/plugins/batch-operations.plugin.js';
import { changeLogPlugin } from '../../src/plugins/change-log.plugin.js';
import { methodRegistryPlugin } from '../../src/plugins/method-registry.plugin.js';
import { softDeletePlugin } from '../../src/plugins/soft-delete.plugin.js';
import { Repository } from '../../src/repository.js';
import { createChangeLogModels, createChangeLogStore } from '../../src/sync/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface Doc {
  name: string;
  total: number;
  version?: number;
  organizationId?: string;
  deletedAt?: Date | null;
}

const oid = (n: number) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const A = oid(1);
const B = oid(2);
const C = oid(3);

/** Stable JSON: dates and _ids replaced, keys sorted — the row, not the clock. */
function normalise(value: unknown): unknown {
  if (value instanceof Date) return '<date>';
  if (value instanceof mongoose.Types.ObjectId) return `oid:${value.toHexString().replace(/^0+/, '') || '0'}`;
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => [k, normalise(v)]),
    );
  }
  return value;
}

describe('changeLogPlugin golden rows', () => {
  let Model: mongoose.Model<Doc>;
  let store: MemoryChangeLogStore;
  let repo: Repository<Doc>;
  const dump = (label: string, rows: unknown) => {
    if (process.env.CL_DUMP) console.log(`GOLDEN ${label} ${JSON.stringify(rows)}`);
  };

  const rows = async () => {
    const page = await store.since('');
    return page.changes.map((e) =>
      normalise({ scope: e.scope, docId: e.docId, op: e.op, version: e.version, tenantId: e.tenantId, doc: e.doc }),
    );
  };

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel<Doc>(
      'ClGolden',
      new mongoose.Schema<Doc>(
        { name: String, total: Number, version: Number, organizationId: String, deletedAt: Date },
        { timestamps: true },
      ),
    );
  });
  afterAll(async () => {
    await disconnectDB();
  });

  const seed = async () => {
    await Model.deleteMany({});
    await Model.create([
      { _id: A, name: 'open', total: 1, version: 1, organizationId: 'o1' },
      { _id: B, name: 'open', total: 1, version: 1, organizationId: 'o1' },
      { _id: C, name: 'open', total: 7, version: 1, organizationId: 'o1' },
    ]);
    store = new MemoryChangeLogStore();
  };

  beforeEach(async () => {
    await seed();
    repo = new Repository<Doc>(Model, [methodRegistryPlugin(), batchOperationsPlugin(), changeLogPlugin({ store, scope: 'g' })]);
  });

  const golden = async (label: string, expected: unknown) => {
    const got = await rows();
    dump(label, got);
    expect(got).toEqual(expected);
  };

  it('create / createMany', async () => {
    await repo.create({ _id: oid(10), name: 'n', total: 2, version: 1, organizationId: 'o2' });
    await repo.createMany([{ _id: oid(11), name: 'm', total: 3, version: 1 }]);
    await golden('create', GOLD.create);
  });

  it('update by id / update ifVersion / update with select', async () => {
    await repo.update(String(A), { total: 9 });
    await repo.update(String(B), { total: 9 }, { ifVersion: 0 });
    await repo.update(String(C), { total: 5 }, { select: 'total' });
    await golden('update', GOLD.update);
  });

  it('findOneAndUpdate: default, projected, returnDocument before, miss', async () => {
    await repo.findOneAndUpdate({ _id: A }, { $set: { total: 2 } });
    await repo.findOneAndUpdate({ _id: B }, { $set: { total: 3 } }, { select: 'total' } as never);
    await repo.findOneAndUpdate({ _id: C }, { $set: { total: 4 } }, { returnDocument: 'before' });
    await repo.findOneAndUpdate({ _id: oid(99) }, { $set: { total: 4 } });
    await golden('foau', GOLD.foau);
  });

  it('claim win, claim lost, claim assertion, applyTransition', async () => {
    await repo.claim(String(A), { field: 'name', from: 'open', to: 'paid' }, { total: 9 });
    await repo.claim(String(A), { field: 'name', from: 'open', to: 'paid' });
    await repo.claim(String(B), { field: 'name', from: 'open', to: 'open' });
    await repo.applyTransition(String(C), { name: 'm', assertTransition: () => {} }, { field: 'name', from: 'open', to: 'done', history: false });
    await golden('claim', GOLD.claim);
  });

  it('getOrCreate (existing and created)', async () => {
    await repo.getOrCreate({ _id: A }, { name: 'x' });
    await repo.getOrCreate({ _id: oid(20) }, { _id: oid(20), name: 'fresh', total: 1, version: 1 });
    await golden('getOrCreate', GOLD.getOrCreate);
  });

  it('delete / updateMany / deleteMany', async () => {
    await repo.updateMany({ total: 1 }, { $set: { total: 3 } });
    await repo.delete(String(C));
    await repo.deleteMany({ total: 3 });
    await golden('many', GOLD.many);
  });

  it('bulkWrite', async () => {
    await (repo as unknown as { bulkWrite: (ops: unknown[]) => Promise<unknown> }).bulkWrite([
      { insertOne: { document: { _id: oid(30), name: 'new', total: 4, version: 1 } } },
      { updateOne: { filter: { _id: A }, update: { $set: { total: 6 } } } },
      { deleteOne: { filter: { _id: B } } },
    ]);
    await golden('bulk', GOLD.bulk);
  });

  it('soft delete leaves an upsert carrying its flag', async () => {
    const soft = new Repository<Doc>(Model, [
      methodRegistryPlugin(),
      softDeletePlugin({ deletedField: 'deletedAt' }),
      changeLogPlugin({ store, scope: 'g' }),
    ]);
    await soft.delete(String(A));
    await soft.deleteMany({ _id: B });
    await soft.updateMany({ _id: C }, { $set: { total: 8 } });
    await golden('soft', GOLD.soft);
  });

  describe('in a transaction (mongo feed)', () => {
    const mongoRepo = async (name: string) => {
      const models = createChangeLogModels(mongoose.connection, { collection: `g_${name}`, modelName: `G${name}` });
      await models.entries.syncIndexes();
      const feed = createChangeLogStore(models);
      return {
        feed,
        repo: new Repository<Doc>(Model, [methodRegistryPlugin(), changeLogPlugin({ store: feed, scope: 'g' })]),
      };
    };
    const feedRows = async (feed: ReturnType<typeof createChangeLogStore>) =>
      (await feed.since('')).changes.map((e) =>
        normalise({ docId: e.docId, op: e.op, version: e.version, tenantId: e.tenantId, doc: e.doc }),
      );

    it('commit keeps every row', async () => {
      const { feed, repo: r } = await mongoRepo('commit');
      await r.withTransaction(async (tx) => {
        await tx.update(String(A), { total: 11 });
        await tx.claim(String(B), { field: 'name', from: 'open', to: 'paid' }, { total: 12 });
        await tx.findOneAndUpdate({ _id: C }, { $set: { total: 13 } });
        await tx.updateMany({ _id: { $in: [A, B] } }, { $set: { total: 14 } });
      });
      const got = await feedRows(feed);
      dump('txCommit', got);
      expect(got).toEqual(GOLD.txCommit);
    });

    it('rollback leaves no row and no write', async () => {
      const { feed, repo: r } = await mongoRepo('rollback');
      await expect(
        r.withTransaction(async (tx) => {
          await tx.update(String(A), { total: 21 });
          await tx.claim(String(B), { field: 'name', from: 'open', to: 'paid' }, { total: 22 });
          await tx.findOneAndUpdate({ _id: C }, { $set: { total: 23 } });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await feedRows(feed)).toEqual([]);
      expect((await Model.findById(A).lean())?.total).toBe(1);
    });
  });
});

/**
 * Rows captured from the re-reading implementation (dates and ids normalised). Two entries are the
 * deliberate corrections: `update` with `select` used to write the PROJECTED document (no tenant, version 0),
 * and `getOrCreate` was never captured at all.
 */
const GOLD: Record<string, unknown> = { "create": [ { "doc": { "__v": 0, "_id": "oid:a", "createdAt": "<date>", "name": "n", "organizationId": "o2", "total": 2, "updatedAt": "<date>", "version": 1 }, "docId": "00000000000000000000000a", "op": "upsert", "scope": "g", "tenantId": "o2", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:b", "createdAt": "<date>", "name": "m", "total": 3, "updatedAt": "<date>", "version": 1 }, "docId": "00000000000000000000000b", "op": "upsert", "scope": "g", "version": 1 } ], "update": [ { "doc": { "__v": 0, "_id": "oid:1", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 9, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000001", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 1, "_id": "oid:2", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 9, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000002", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:3", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 5, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000003", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 } ], "foau": [ { "doc": { "__v": 0, "_id": "oid:1", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 2, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000001", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:2", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 3, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000002", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:3", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 4, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000003", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 } ], "claim": [ { "doc": { "__v": 0, "_id": "oid:1", "createdAt": "<date>", "name": "paid", "organizationId": "o1", "total": 9, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000001", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:2", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 1, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000002", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:3", "createdAt": "<date>", "name": "done", "organizationId": "o1", "total": 7, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000003", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 } ], "getOrCreate": [ { "doc": { "__v": 0, "_id": "oid:1", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 1, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000001", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:14", "createdAt": "<date>", "name": "fresh", "total": 1, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000014", "op": "upsert", "scope": "g", "version": 1 } ], "many": [ { "doc": { "__v": 0, "_id": "oid:1", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 3, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000001", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:2", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 3, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000002", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "docId": "000000000000000000000003", "op": "delete", "scope": "g", "version": 0 }, { "docId": "000000000000000000000001", "op": "delete", "scope": "g", "version": 0 }, { "docId": "000000000000000000000002", "op": "delete", "scope": "g", "version": 0 } ], "bulk": [ { "doc": { "__v": 0, "_id": "oid:1e", "createdAt": "<date>", "name": "new", "total": 4, "updatedAt": "<date>", "version": 1 }, "docId": "00000000000000000000001e", "op": "upsert", "scope": "g", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:1", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 6, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000001", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "docId": "000000000000000000000002", "op": "delete", "scope": "g", "version": 0 } ], "soft": [ { "docId": "000000000000000000000001", "op": "delete", "scope": "g", "version": 0 }, { "doc": { "__v": 0, "_id": "oid:2", "createdAt": "<date>", "deletedAt": "<date>", "name": "open", "organizationId": "o1", "total": 1, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000002", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:3", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 8, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000003", "op": "upsert", "scope": "g", "tenantId": "o1", "version": 1 } ], "txCommit": [ { "doc": { "__v": 0, "_id": "oid:1", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 11, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000001", "op": "upsert", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:2", "createdAt": "<date>", "name": "paid", "organizationId": "o1", "total": 12, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000002", "op": "upsert", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:3", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 13, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000003", "op": "upsert", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:1", "createdAt": "<date>", "name": "open", "organizationId": "o1", "total": 14, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000001", "op": "upsert", "tenantId": "o1", "version": 1 }, { "doc": { "__v": 0, "_id": "oid:2", "createdAt": "<date>", "name": "paid", "organizationId": "o1", "total": 14, "updatedAt": "<date>", "version": 1 }, "docId": "000000000000000000000002", "op": "upsert", "tenantId": "o1", "version": 1 } ] };
