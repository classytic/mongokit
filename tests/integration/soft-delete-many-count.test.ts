/**
 * Regression: soft `deleteMany` returned `deletedCount: 0` even when
 * rows were soft-deleted.
 *
 * The soft-delete plugin's `before:deleteMany` hook ran `Model.updateMany`
 * to flip `deletedAt`, set `context.softDeleted = true`, and discarded the
 * update result. `Repository.deleteMany` then returned a hard-coded
 * `{ acknowledged: true, deletedCount: 0, soft: true }` envelope. Audit
 * logs and UI counters relying on `deletedCount` saw zero whenever soft
 * delete was active — a silent disagreement with the cross-kit
 * `DeleteManyResult` contract.
 *
 * Fix: capture the updateMany's `modifiedCount` on the context and bubble
 * it into the envelope's `deletedCount`.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import {
  batchOperationsPlugin,
  methodRegistryPlugin,
} from '../../src/plugins/index.js';
import { softDeletePlugin } from '../../src/plugins/soft-delete.plugin.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  _id?: mongoose.Types.ObjectId;
  name: string;
  status: 'draft' | 'published';
  deletedAt?: Date | null;
}

function makeSchema() {
  return new mongoose.Schema<IDoc>(
    {
      name: { type: String, required: true },
      status: { type: String, required: true },
      deletedAt: { type: Date, default: null },
    },
    { timestamps: false },
  );
}

describe('soft deleteMany propagates real count (regression)', () => {
  let Model: mongoose.Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('SoftDeleteManyCount', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  it('reports the number of newly soft-deleted rows', async () => {
    const repo = new Repository<IDoc>(Model, [
      methodRegistryPlugin(),
      softDeletePlugin({ deletedField: 'deletedAt' }),
      batchOperationsPlugin(),
    ]);

    await repo.createMany([
      { name: 'A', status: 'draft' },
      { name: 'B', status: 'draft' },
      { name: 'C', status: 'published' },
      { name: 'D', status: 'draft' },
    ]);

    const result = await repo.deleteMany({ status: 'draft' });

    expect(result.acknowledged).toBe(true);
    expect(result.soft).toBe(true);
    // Three drafts → three soft-deletes. Pre-fix this returned 0.
    expect(result.deletedCount).toBe(3);

    // And the rows really are soft-deleted (not hard-deleted).
    const remaining = await Model.find({ deletedAt: null }).lean();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe('C');
  });

  it('reports 0 when no rows match (not just because the count was discarded)', async () => {
    const repo = new Repository<IDoc>(Model, [
      methodRegistryPlugin(),
      softDeletePlugin({ deletedField: 'deletedAt' }),
      batchOperationsPlugin(),
    ]);

    await repo.createMany([
      { name: 'X', status: 'published' },
      { name: 'Y', status: 'published' },
    ]);

    const result = await repo.deleteMany({ status: 'draft' });

    expect(result.soft).toBe(true);
    expect(result.deletedCount).toBe(0);
  });

  it('hard mode still returns the physical count', async () => {
    const repo = new Repository<IDoc>(Model, [
      methodRegistryPlugin(),
      softDeletePlugin({ deletedField: 'deletedAt' }),
      batchOperationsPlugin(),
    ]);

    await repo.createMany([
      { name: 'P', status: 'draft' },
      { name: 'Q', status: 'draft' },
    ]);

    const result = await repo.deleteMany({ status: 'draft' }, { mode: 'hard' });

    expect(result.deletedCount).toBe(2);
    // Hard delete must not flag soft.
    expect(result.soft).toBeUndefined();

    const remaining = await Model.find({}).lean();
    expect(remaining).toHaveLength(0);
  });
});
