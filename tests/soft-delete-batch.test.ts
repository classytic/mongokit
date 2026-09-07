/**
 * Soft Delete + Batch Operations Integration Tests
 *
 * Verifies that softDeletePlugin properly hooks into batch operations:
 * - deleteMany should soft-delete (not hard-delete) when soft-delete is active
 * - updateMany should exclude soft-deleted documents from the filter
 * - bulkWrite deleteOne/deleteMany ops should inject soft-delete filters
 */

import type mongoose from 'mongoose';
import { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  Repository,
  softDeletePlugin,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface ISoftBatchDoc {
  _id: Types.ObjectId;
  name: string;
  status: string;
  deletedAt?: Date | null;
}

describe('Soft Delete + Batch Operations', () => {
  let Model: mongoose.Model<ISoftBatchDoc>;
  let repo: InstanceType<typeof Repository<ISoftBatchDoc>> & {
    updateMany: (
      query: Record<string, unknown>,
      data: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<{ matchedCount: number; modifiedCount: number }>;
    deleteMany: (
      query: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<{ acknowledged: boolean; deletedCount: number }>;
  };

  beforeAll(async () => {
    await connectDB();
    const SoftBatchSchema = new Schema<ISoftBatchDoc>({
      name: { type: String, required: true },
      status: { type: String, default: 'active' },
      deletedAt: { type: Date, default: null },
    });
    Model = await createTestModel('SoftBatchTest', SoftBatchSchema);
    repo = new Repository(Model, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
    ]) as typeof repo;
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  // ==========================================================================
  // deleteMany should soft-delete
  // ==========================================================================

  describe('deleteMany with soft-delete', () => {
    it('should soft-delete documents instead of hard-deleting', async () => {
      await Model.create([
        { name: 'A', status: 'draft' },
        { name: 'B', status: 'draft' },
        { name: 'C', status: 'published' },
      ]);

      await repo.deleteMany({ status: 'draft' });

      // Documents should still exist in DB
      const allDocs = await Model.find({}).lean();
      expect(allDocs).toHaveLength(3);

      // But the "deleted" ones should have deletedAt set
      const softDeleted = allDocs.filter((d) => d.deletedAt !== null);
      expect(softDeleted).toHaveLength(2);
      expect(softDeleted.every((d) => d.status === 'draft')).toBe(true);

      // And the non-matching one should be untouched
      const alive = allDocs.filter((d) => d.deletedAt === null);
      expect(alive).toHaveLength(1);
      expect(alive[0].status).toBe('published');
    });

    it('should not re-soft-delete already soft-deleted documents', async () => {
      const pastDate = new Date('2020-01-01');
      await Model.create([
        { name: 'A', status: 'old', deletedAt: pastDate },
        { name: 'B', status: 'old', deletedAt: null },
      ]);

      await repo.deleteMany({ status: 'old' });

      const data = await Model.find({}).lean();
      // A was already deleted — should keep its original deletedAt
      const docA = data.find((d) => d.name === 'A')!;
      expect(docA.deletedAt!.getTime()).toBe(pastDate.getTime());

      // B should now be soft-deleted with a recent timestamp
      const docB = data.find((d) => d.name === 'B')!;
      expect(docB.deletedAt).not.toBeNull();
      expect(docB.deletedAt!.getTime()).toBeGreaterThan(pastDate.getTime());
    });
  });

  // ==========================================================================
  // updateMany should exclude soft-deleted docs
  // ==========================================================================

  describe('updateMany with soft-delete', () => {
    it('should not update soft-deleted documents', async () => {
      await Model.create([
        { name: 'A', status: 'draft', deletedAt: null },
        { name: 'B', status: 'draft', deletedAt: new Date() }, // soft-deleted
        { name: 'C', status: 'draft', deletedAt: null },
      ]);

      const result = await repo.updateMany({ status: 'draft' }, { $set: { status: 'published' } });

      // Should only match the 2 non-deleted docs
      expect(result.matchedCount).toBe(2);
      expect(result.modifiedCount).toBe(2);

      // B should still be draft (untouched because it's soft-deleted)
      const docB = await Model.findOne({ name: 'B' }).lean();
      expect(docB!.status).toBe('draft');
    });
  });
  // ==========================================================================
  // bulkWrite — the case this file's header always claimed and never covered
  // ==========================================================================

  describe('bulkWrite with soft-delete', () => {
    it('does not update a row that is already soft-deleted', async () => {
      await Model.create([
        { name: 'A', status: 'draft' },
        { name: 'B', status: 'draft' },
      ]);
      await repo.delete(String((await Model.findOne({ name: 'A' }).lean())!._id));

      await repo.bulkWrite([
        { updateMany: { filter: { status: 'draft' }, update: { $set: { status: 'published' } } } },
      ]);

      // The deleted row must be untouched: a soft delete that a batch write walks straight
      // through is not a delete at all.
      const a = await Model.findOne({ name: 'A' }).lean();
      const b = await Model.findOne({ name: 'B' }).lean();
      expect(a!.status).toBe('draft');
      expect(b!.status).toBe('published');
    });

    it('SOFT-deletes through a deleteOne sub-op instead of destroying the row', async () => {
      await Model.create([{ name: 'A', status: 'draft' }]);

      await repo.bulkWrite([{ deleteOne: { filter: { name: 'A' } } }]);

      const doc = await Model.findOne({ name: 'A' }).lean();
      expect(doc).not.toBeNull();
      expect(doc!.deletedAt).toBeTruthy();
    });

    it('SOFT-deletes through a deleteMany sub-op', async () => {
      await Model.create([
        { name: 'A', status: 'draft' },
        { name: 'B', status: 'draft' },
        { name: 'C', status: 'published' },
      ]);

      await repo.bulkWrite([{ deleteMany: { filter: { status: 'draft' } } }]);

      expect(await Model.countDocuments({})).toBe(3);
      expect(await Model.countDocuments({ deletedAt: { $ne: null } })).toBe(2);
      const c = await Model.findOne({ name: 'C' }).lean();
      expect(c!.deletedAt ?? null).toBeNull();
    });

    it('leaves insertOne alone — a new row is not a deleted one', async () => {
      await repo.bulkWrite([{ insertOne: { document: { name: 'New', status: 'draft' } } }]);

      const doc = await Model.findOne({ name: 'New' }).lean();
      expect(doc).not.toBeNull();
      expect(doc!.deletedAt ?? null).toBeNull();
    });
  });
});
