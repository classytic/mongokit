import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';
import * as updateActions from '../src/actions/update.js';
import * as createActions from '../src/actions/create.js';
import * as readActions from '../src/actions/read.js';
import * as deleteActions from '../src/actions/delete.js';

// ─── Test Schema ──────────────────────────────────────────────────────
interface IItem {
  _id: Types.ObjectId;
  name: string;
  status: string;
  count: number;
  deleted?: boolean;
  deletedAt?: Date | null;
  deletedBy?: string | null;
}

const ItemSchema = new Schema<IItem>({
  name: { type: String, required: true },
  status: { type: String, default: 'active' },
  count: { type: Number, default: 0 },
  deleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: String, default: null },
});

// ─── Subdocument test schema ──────────────────────────────────────────
interface IComment {
  _id: Types.ObjectId;
  text: string;
}

interface IPost {
  _id: Types.ObjectId;
  title: string;
  comments: IComment[];
}

const PostSchema = new Schema<IPost>({
  title: { type: String, required: true },
  comments: [{ text: { type: String, required: true } }],
});

// ─── Pipeline guard tests (unit, no DB needed) ───────────────────────
describe('Mongoose 9 compatibility guards', () => {
  it('throws on update pipeline arrays unless updatePipeline=true (updateMany)', async () => {
    const Model = {} as any;

    await expect(
      updateActions.updateMany(Model, { _id: 'x' }, [{ $set: { name: 'x' } }] as any)
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('allows update pipeline arrays when updatePipeline=true (updateMany)', async () => {
    const Model = {
      updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    } as any;

    await expect(
      updateActions.updateMany(Model, { _id: 'x' }, [{ $set: { name: 'x' } }] as any, { updatePipeline: true })
    ).resolves.toEqual({ matchedCount: 1, modifiedCount: 1 });
  });

  it('throws on update pipeline arrays unless updatePipeline=true (updateByQuery)', async () => {
    const Model = {
      findOneAndUpdate: () => {
        throw new Error('should not be called');
      },
    } as any;

    await expect(
      updateActions.updateByQuery(Model, { _id: 'x' }, [{ $set: { name: 'x' } }] as any)
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

// ─── returnDocument: 'after' integration tests ──────────────────────
describe('returnDocument: after (Mongoose 9 migration)', () => {
  let ItemModel: mongoose.Model<IItem>;
  let PostModel: mongoose.Model<IPost>;

  beforeAll(async () => {
    await connectDB();
    ItemModel = await createTestModel('M9Item', ItemSchema);
    PostModel = await createTestModel('M9Post', PostSchema);
  });

  afterAll(async () => {
    await ItemModel.deleteMany({});
    await PostModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await ItemModel.deleteMany({});
    await PostModel.deleteMany({});
  });

  // ── actions/update.ts ──────────────────────────────────────────────

  describe('update()', () => {
    it('returns the updated document, not the original', async () => {
      const doc = await ItemModel.create({ name: 'original', status: 'active', count: 0 });

      const result = await updateActions.update(ItemModel, doc._id, { $set: { name: 'updated' } });

      expect(result).toBeDefined();
      expect((result as any).name).toBe('updated');
    });

    it('returns updated document with $inc', async () => {
      const doc = await ItemModel.create({ name: 'counter', count: 5 });

      const result = await updateActions.update(ItemModel, doc._id, { $inc: { count: 3 } });

      expect((result as any).count).toBe(8);
    });
  });

  describe('updateWithConstraints()', () => {
    it('returns the updated document when constraints match', async () => {
      const doc = await ItemModel.create({ name: 'constrained', status: 'active', count: 0 });

      const result = await updateActions.updateWithConstraints(
        ItemModel,
        doc._id,
        { $set: { name: 'passed' } },
        { status: 'active' }
      );

      expect(result).not.toBeNull();
      expect((result as any).name).toBe('passed');
    });

    it('returns null when constraints do not match', async () => {
      const doc = await ItemModel.create({ name: 'constrained', status: 'inactive', count: 0 });

      const result = await updateActions.updateWithConstraints(
        ItemModel,
        doc._id,
        { $set: { name: 'should-not-apply' } },
        { status: 'active' }
      );

      expect(result).toBeNull();
    });
  });

  describe('updateByQuery()', () => {
    it('returns the updated document', async () => {
      await ItemModel.create({ name: 'queryTarget', status: 'active', count: 0 });

      const result = await updateActions.updateByQuery(
        ItemModel,
        { name: 'queryTarget' },
        { $set: { status: 'done' } }
      );

      expect(result).toBeDefined();
      expect((result as any).status).toBe('done');
    });
  });

  describe('increment()', () => {
    it('returns the document with incremented value', async () => {
      const doc = await ItemModel.create({ name: 'inc-test', count: 10 });

      const result = await updateActions.increment(ItemModel, doc._id, 'count', 5);

      expect((result as any).count).toBe(15);
    });
  });

  describe('pushToArray()', () => {
    it('returns the document with pushed value', async () => {
      const post = await PostModel.create({ title: 'push-test', comments: [] });

      const result = await updateActions.pushToArray(PostModel, post._id, 'comments', { text: 'hello' });

      expect((result as any).comments).toHaveLength(1);
      expect((result as any).comments[0].text).toBe('hello');
    });
  });

  describe('pullFromArray()', () => {
    it('returns the document with pulled value', async () => {
      const post = await PostModel.create({ title: 'pull-test', comments: [{ text: 'remove-me' }, { text: 'keep' }] });
      const commentId = (post as any).comments[0]._id;

      const result = await updateActions.pullFromArray(PostModel, post._id, 'comments', { _id: commentId });

      expect((result as any).comments).toHaveLength(1);
      expect((result as any).comments[0].text).toBe('keep');
    });
  });

  // ── actions/create.ts ──────────────────────────────────────────────

  describe('upsert()', () => {
    it('creates and returns the new document on insert', async () => {
      const result = await createActions.upsert(
        ItemModel,
        { name: 'upsert-new' },
        { name: 'upsert-new', status: 'created', count: 1 }
      );

      expect(result).toBeDefined();
      expect((result as any).name).toBe('upsert-new');
      expect((result as any).status).toBe('created');
    });

    it('returns existing document without modifying on match', async () => {
      await ItemModel.create({ name: 'upsert-existing', status: 'original', count: 99 });

      const result = await createActions.upsert(
        ItemModel,
        { name: 'upsert-existing' },
        { name: 'upsert-existing', status: 'overwritten', count: 0 }
      );

      expect(result).toBeDefined();
      // $setOnInsert doesn't modify existing — original values preserved
      expect((result as any).status).toBe('original');
      expect((result as any).count).toBe(99);
    });
  });

  // ── actions/read.ts ────────────────────────────────────────────────

  describe('getOrCreate()', () => {
    it('creates and returns the new document', async () => {
      const result = await readActions.getOrCreate(
        ItemModel,
        { name: 'getorcreate-new' },
        { name: 'getorcreate-new', status: 'fresh', count: 42 }
      );

      expect(result).toBeDefined();
      expect((result as any).name).toBe('getorcreate-new');
      expect((result as any).count).toBe(42);
    });

    it('returns existing document on match', async () => {
      await ItemModel.create({ name: 'getorcreate-existing', status: 'kept', count: 7 });

      const result = await readActions.getOrCreate(
        ItemModel,
        { name: 'getorcreate-existing' },
        { name: 'getorcreate-existing', status: 'replaced', count: 0 }
      );

      expect(result).toBeDefined();
      expect((result as any).status).toBe('kept');
      expect((result as any).count).toBe(7);
    });
  });

  // ── actions/delete.ts ──────────────────────────────────────────────

  describe('softDelete()', () => {
    it('returns success after marking document as deleted', async () => {
      const doc = await ItemModel.create({ name: 'soft-del', count: 0 });

      const result = await deleteActions.softDelete(ItemModel, doc._id, { userId: 'user-1' });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Soft deleted successfully');

      // Verify the document was actually soft-deleted in DB
      const updated = await ItemModel.findById(doc._id).lean();
      expect(updated!.deleted).toBe(true);
      expect(updated!.deletedAt).toBeDefined();
      expect(updated!.deletedBy).toBe('user-1');
    });

    it('throws 404 for non-existent document', async () => {
      const fakeId = new Types.ObjectId();

      await expect(
        deleteActions.softDelete(ItemModel, fakeId)
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('restore()', () => {
    it('clears deleted flags and returns success', async () => {
      const doc = await ItemModel.create({
        name: 'to-restore',
        deleted: true,
        deletedAt: new Date(),
        deletedBy: 'user-1',
        count: 0,
      });

      const result = await deleteActions.restore(ItemModel, doc._id);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Restored successfully');

      // Verify DB state
      const restored = await ItemModel.findById(doc._id).lean();
      expect(restored!.deleted).toBe(false);
      expect(restored!.deletedAt).toBeNull();
      expect(restored!.deletedBy).toBeNull();
    });

    it('throws 404 for non-existent document', async () => {
      const fakeId = new Types.ObjectId();

      await expect(
        deleteActions.restore(ItemModel, fakeId)
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  // ── Repository-level integration ──────────────────────────────────

  describe('Repository.update() integration', () => {
    it('returns updated document through Repository', async () => {
      const repo = new Repository(ItemModel);
      const doc = await repo.create({ name: 'repo-update', status: 'active', count: 0 });

      const updated = await repo.update(doc._id.toString(), { $set: { name: 'repo-updated', count: 10 } });

      expect((updated as any).name).toBe('repo-updated');
      expect((updated as any).count).toBe(10);
    });
  });

  // ── subdocument plugin ─────────────────────────────────────────────

  describe('subdocument.plugin updateSubdocument()', () => {
    it('returns parent with updated subdocument', async () => {
      const post = await PostModel.create({
        title: 'subdoc-test',
        comments: [{ text: 'original' }],
      });
      const commentId = (post as any).comments[0]._id;

      const result = await PostModel.findOneAndUpdate(
        { _id: post._id, 'comments._id': commentId },
        { $set: { 'comments.$': { text: 'updated', _id: commentId } } },
        { returnDocument: 'after', runValidators: true }
      ).exec();

      expect(result).toBeDefined();
      expect((result as any).comments[0].text).toBe('updated');
    });
  });
});
