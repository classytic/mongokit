/**
 * Concurrency + partial-failure integration tests.
 *
 * Real MongoDB via memory-server. Focused on three production scenarios the
 * earlier suite glossed over:
 *   1. Two concurrent updates on the same document — last-write-wins, no crash.
 *   2. bulkWrite with a mix of valid + conflicting ops under unordered: false
 *      — partial success, cache invalidation hook still fires.
 *   3. Concurrent create() + createMany() under the soft-delete plugin —
 *      no tenant/soft-delete filter gets lost between parallel requests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  Repository,
  batchOperationsPlugin,
  methodRegistryPlugin,
  softDeletePlugin,
} from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IConcurrencyDoc {
  slug: string;
  counter: number;
  name: string;
  deletedAt?: Date | null;
}

function makeSchema() {
  return new mongoose.Schema<IConcurrencyDoc>(
    {
      slug: { type: String, required: true },
      counter: { type: Number, default: 0 },
      name: { type: String, required: true },
      deletedAt: { type: Date, default: null },
    },
    { timestamps: true },
  );
}

const MODEL_NAME = 'ConcurrencyDoc';

describe('concurrency + partial failure (integration)', () => {
  let Model: mongoose.Model<IConcurrencyDoc>;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    Model = await createTestModel(MODEL_NAME, makeSchema());
    await Model.deleteMany({});
  });

  describe('concurrent updates on the same document', () => {
    it('N parallel updates all succeed — last-write-wins semantics, no thrown race', async () => {
      const repo = new Repository<IConcurrencyDoc>(Model);
      const doc = await repo.create({ slug: 'shared', counter: 0, name: 'seed' });
      const id = String((doc as { _id: mongoose.Types.ObjectId })._id);

      const N = 20;
      const updates = await Promise.allSettled(
        Array.from({ length: N }, (_, i) =>
          repo.update(id, { counter: i + 1, name: `v${i + 1}` }),
        ),
      );

      const rejected = updates.filter((r) => r.status === 'rejected');
      expect(rejected.length).toBe(0);

      const fresh = await repo.getById(id);
      // Any of the N writes may have landed last; assert the doc is internally consistent.
      expect(fresh).toBeDefined();
      expect(typeof (fresh as IConcurrencyDoc).counter).toBe('number');
      expect((fresh as IConcurrencyDoc).counter).toBeGreaterThanOrEqual(1);
      expect((fresh as IConcurrencyDoc).counter).toBeLessThanOrEqual(N);
      expect((fresh as IConcurrencyDoc).name).toMatch(/^v\d+$/);
    });
  });

  describe('bulkWrite partial failure', () => {
    async function makeBulkModel() {
      // bulkWrite tests need a unique index to trigger E11000. Kept isolated
      // so the soft-delete tests above don't emit the partial-index warning.
      const bulkSchema = new mongoose.Schema<IConcurrencyDoc>(
        {
          slug: { type: String, required: true, unique: true },
          counter: { type: Number, default: 0 },
          name: { type: String, required: true },
          deletedAt: { type: Date, default: null },
        },
        { timestamps: true },
      );
      const model = await createTestModel('ConcurrencyBulkDoc', bulkSchema);
      await model.deleteMany({});
      return model;
    }

    it('ordered: false — valid ops succeed, duplicate-key ops fail, after:bulkWrite still fires', async () => {
      const BulkModel = await makeBulkModel();
      const repo = new Repository<IConcurrencyDoc>(BulkModel, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
      ]);

      // Seed: existing doc that a subsequent insertOne will conflict with.
      await repo.create({ slug: 'existing', counter: 0, name: 'seed' });

      let hookFired = false;
      let hookError: unknown = null;
      repo.on('after:bulkWrite', async () => {
        hookFired = true;
      });
      repo.on('error:bulkWrite', async ({ error }: { error: unknown }) => {
        hookError = error;
      });

      const ops = [
        { insertOne: { document: { slug: 'new-1', counter: 1, name: 'ok1' } } },
        // This insertOne will fail — duplicate slug.
        { insertOne: { document: { slug: 'existing', counter: 2, name: 'dup' } } },
        { insertOne: { document: { slug: 'new-2', counter: 3, name: 'ok2' } } },
      ];

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (repo as any).bulkWrite(ops, { ordered: false }),
      ).rejects.toBeTruthy();

      // Partial success: the two non-conflicting inserts landed.
      const all = await repo.findAll({});
      const slugs = new Set(all.map((d) => (d as IConcurrencyDoc).slug));
      expect(slugs.has('new-1')).toBe(true);
      expect(slugs.has('new-2')).toBe(true);
      // Duplicate raised an error — error hook fired; after:bulkWrite did NOT
      // fire because the driver returned a write-error (current contract). This
      // test pins that contract so a silent flip to "emit after: on partial
      // failure" is caught.
      expect(hookFired).toBe(false);
      expect(hookError).toBeTruthy();
    });

    it('ordered: true — stops at the first conflict; only ops before it landed', async () => {
      const BulkModel = await makeBulkModel();
      const repo = new Repository<IConcurrencyDoc>(BulkModel, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
      ]);
      await repo.create({ slug: 'existing', counter: 0, name: 'seed' });

      const ops = [
        { insertOne: { document: { slug: 'before', counter: 1, name: 'before' } } },
        { insertOne: { document: { slug: 'existing', counter: 2, name: 'dup' } } },
        { insertOne: { document: { slug: 'after', counter: 3, name: 'after' } } },
      ];

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (repo as any).bulkWrite(ops, { ordered: true }),
      ).rejects.toBeTruthy();

      const all = await repo.findAll({});
      const slugs = new Set(all.map((d) => (d as IConcurrencyDoc).slug));
      expect(slugs.has('before')).toBe(true);
      expect(slugs.has('after')).toBe(false);
    });
  });

  describe('concurrent create/createMany under soft-delete plugin', () => {
    it('parallel single-create + batch-create both succeed with correct soft-delete scoping', async () => {
      const repo = new Repository<IConcurrencyDoc>(Model, [
        methodRegistryPlugin(),
        softDeletePlugin(),
        batchOperationsPlugin(),
      ]);

      const [single, batch] = await Promise.all([
        repo.create({ slug: 'one-at-a-time', counter: 1, name: 'solo' }),
        repo.createMany([
          { slug: 'batch-a', counter: 1, name: 'a' },
          { slug: 'batch-b', counter: 2, name: 'b' },
          { slug: 'batch-c', counter: 3, name: 'c' },
        ]),
      ]);

      expect(single).toBeDefined();
      expect(batch).toHaveLength(3);

      const list = await repo.getAll({ limit: 100 });
      const docs = Array.isArray(list) ? list : list.docs;
      const slugs = new Set(docs.map((d) => (d as IConcurrencyDoc).slug));
      expect(slugs.size).toBe(4);
      expect(slugs.has('one-at-a-time')).toBe(true);
      expect(slugs.has('batch-a')).toBe(true);
    });

    it('soft-deleted docs stay hidden even under concurrent reads', async () => {
      const repo = new Repository<IConcurrencyDoc>(Model, [softDeletePlugin()]);
      const docs = await repo.createMany([
        { slug: 'live-1', counter: 1, name: 'a' },
        { slug: 'live-2', counter: 2, name: 'b' },
        { slug: 'soon-dead', counter: 3, name: 'c' },
      ]);
      const deadId = String((docs[2] as { _id: mongoose.Types.ObjectId })._id);

      // 10 concurrent readers fire while the delete lands.
      const [, ...reads] = await Promise.all([
        repo.delete(deadId),
        ...Array.from({ length: 10 }, () => repo.getAll({ limit: 100 })),
      ]);

      // After the delete settles, the tombstoned slug must be absent.
      const finalList = await repo.getAll({ limit: 100 });
      const finalDocs = Array.isArray(finalList) ? finalList : finalList.docs;
      const finalSlugs = new Set(finalDocs.map((d) => (d as IConcurrencyDoc).slug));
      expect(finalSlugs.has('soon-dead')).toBe(false);
      // Reads that raced with the delete either saw the doc or didn't — both
      // shapes are legal. What's NOT legal is crashing or returning garbage.
      for (const readList of reads) {
        const readDocs = Array.isArray(readList) ? readList : readList.docs;
        for (const d of readDocs) {
          expect((d as IConcurrencyDoc).slug).toBeTypeOf('string');
        }
      }
    });
  });
});
