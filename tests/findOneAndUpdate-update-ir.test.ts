/**
 * findOneAndUpdate + updateMany — portable Update IR dispatch.
 *
 * Verifies that `Repository.findOneAndUpdate` (and the batch-plugin
 * `updateMany`) accept the repo-core `UpdateSpec` shape built via
 * `@classytic/repo-core/update` and compile it to Mongo operator records
 * before the hook pipeline sees the payload. Arc's infrastructure stores
 * (outbox, idempotency, audit) call mongokit this way — the dispatch must
 * be equivalent to hand-writing `$set` / `$inc` / `$unset` / `$setOnInsert`.
 */

import { setFields, update } from '@classytic/repo-core/update';
import type mongoose from 'mongoose';
import { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batchOperationsPlugin, methodRegistryPlugin, Repository } from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IUirDoc {
  _id: Types.ObjectId;
  status: string;
  lockedBy?: string | null;
  attempts?: number;
  createdAt?: Date;
}

const UirSchema = new Schema<IUirDoc>({
  status: { type: String, default: 'pending' },
  lockedBy: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  createdAt: Date,
});

describe('Update IR dispatch', () => {
  let Model: mongoose.Model<IUirDoc>;
  let repo: Repository<IUirDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel<IUirDoc>('UirDoc', UirSchema);
    repo = new Repository<IUirDoc>(Model, [methodRegistryPlugin(), batchOperationsPlugin()]);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  describe('findOneAndUpdate', () => {
    it('compiles UpdateSpec.set to $set', async () => {
      const doc = await Model.create({ status: 'pending' });

      const result = await repo.findOneAndUpdate({ _id: doc._id }, setFields({ status: 'active' }));

      expect(result).not.toBeNull();
      expect((result as IUirDoc).status).toBe('active');
    });

    it('compiles every bucket together — set, unset, inc, setOnInsert on existing doc', async () => {
      const doc = await Model.create({
        status: 'pending',
        lockedBy: 'old-worker',
        attempts: 5,
        createdAt: new Date('2025-01-01'),
      });

      const result = await repo.findOneAndUpdate(
        { _id: doc._id },
        update({
          set: { status: 'claimed' },
          unset: ['lockedBy'],
          setOnInsert: { createdAt: new Date('2026-01-01') }, // ignored — no insert
          inc: { attempts: 1 },
        }),
        { returnDocument: 'after' },
      );

      expect(result).not.toBeNull();
      const r = result as IUirDoc;
      expect(r.status).toBe('claimed');
      // $unset removed the field; reloading the doc confirms it's gone.
      // The in-memory return may still have the unset field until reread,
      // but the persisted state is what matters.
      const reread = await Model.findById(doc._id).lean();
      expect(reread?.lockedBy == null).toBe(true);
      expect(r.attempts).toBe(6); // 5 + 1
      // setOnInsert was ignored because this was an update, not insert.
      expect(r.createdAt).toEqual(new Date('2025-01-01'));
    });

    it('raw Mongo-operator records still pass through unchanged (back-compat)', async () => {
      const doc = await Model.create({ status: 'pending', attempts: 5 });

      const result = await repo.findOneAndUpdate(
        { _id: doc._id },
        { $inc: { attempts: 3 } },
        { returnDocument: 'after' },
      );

      expect((result as IUirDoc).attempts).toBe(8);
    });

    it('aggregation pipeline updates still pass through (Mongo escape hatch)', async () => {
      const doc = await Model.create({ status: 'pending' });

      const result = await repo.findOneAndUpdate(
        { _id: doc._id },
        [{ $set: { status: { $concat: ['$status', '-processed'] } } }],
        // mongokit requires explicit opt-in for pipeline form to avoid
        // accidental arrays-as-updates; UpdateInput preserves this.
        { returnDocument: 'after', updatePipeline: true } as unknown as Parameters<
          typeof repo.findOneAndUpdate
        >[2],
      );

      expect((result as IUirDoc).status).toBe('pending-processed');
    });
  });

  describe('updateMany', () => {
    it('compiles UpdateSpec.set to $set across all matched docs', async () => {
      await Model.insertMany([
        { status: 'pending', payload: 'a' },
        { status: 'pending', payload: 'b' },
        { status: 'done', payload: 'c' },
      ]);

      const result = await (
        repo as unknown as {
          updateMany: (
            q: unknown,
            d: unknown,
          ) => Promise<{ matchedCount: number; modifiedCount: number }>;
        }
      ).updateMany({ status: 'pending' }, setFields({ status: 'active' }));

      expect(result.matchedCount).toBe(2);
      expect(result.modifiedCount).toBe(2);
      const remaining = await Model.find({ status: 'active' }).lean();
      expect(remaining).toHaveLength(2);
    });

    it('raw Mongo-operator records still pass through', async () => {
      await Model.create({ status: 'pending', attempts: 0 });
      await Model.create({ status: 'pending', attempts: 0 });

      await (
        repo as unknown as {
          updateMany: (q: unknown, d: unknown) => Promise<unknown>;
        }
      ).updateMany({ status: 'pending' }, { $inc: { attempts: 1 } });

      const docs = await Model.find({}).lean();
      expect(docs.every((d) => d.attempts === 1)).toBe(true);
    });
  });
});
