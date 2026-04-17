/**
 * Repository.findOneAndUpdate — atomic CAS primitive.
 *
 * Validates the new public method exposes mongoose's findOneAndUpdate
 * through the full Repository hook pipeline (multi-tenant, soft-delete,
 * timestamps, hook ordering).
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Repository,
  multiTenantPlugin,
  softDeletePlugin,
  timestampPlugin,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IFoauJob {
  _id: Types.ObjectId;
  status: 'pending' | 'processing' | 'done';
  payload: string;
  organizationId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
  attempts?: number;
}

const FoauJobSchema = new Schema<IFoauJob>({
  status: { type: String, enum: ['pending', 'processing', 'done'], default: 'pending' },
  payload: { type: String, required: true },
  organizationId: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  deletedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
});

describe('Repository.findOneAndUpdate', () => {
  let JobModel: mongoose.Model<IFoauJob>;
  let repo: Repository<IFoauJob>;

  beforeAll(async () => {
    await connectDB();
    JobModel = await createTestModel('FoauJob', FoauJobSchema);
    repo = new Repository(JobModel);
  });

  afterAll(async () => {
    await JobModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await JobModel.deleteMany({});
  });

  // -------------------------------------------------------------------------
  // Basic semantics
  // -------------------------------------------------------------------------

  it('returns the post-update document by default', async () => {
    const seed = await JobModel.create({ payload: 'one' });

    const result = await repo.findOneAndUpdate(
      { _id: seed._id },
      { $set: { status: 'processing' } },
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe('processing');
  });

  it('returnDocument: "before" returns the pre-update doc', async () => {
    const seed = await JobModel.create({ payload: 'two', status: 'pending' });

    const result = await repo.findOneAndUpdate(
      { _id: seed._id },
      { $set: { status: 'done' } },
      { returnDocument: 'before' },
    );

    expect(result?.status).toBe('pending');
    const reread = await JobModel.findById(seed._id).lean();
    expect(reread?.status).toBe('done');
  });

  it('returns null when no doc matches and upsert is false', async () => {
    const result = await repo.findOneAndUpdate(
      { payload: 'never-exists' },
      { $set: { status: 'done' } },
    );
    expect(result).toBeNull();
  });

  it('inserts and returns the new doc when upsert: true and no match', async () => {
    const result = await repo.findOneAndUpdate(
      { payload: 'fresh' },
      { $set: { payload: 'fresh', status: 'processing' } },
      { upsert: true },
    );

    expect(result).not.toBeNull();
    expect(result?.payload).toBe('fresh');
    expect(result?.status).toBe('processing');
  });

  // -------------------------------------------------------------------------
  // FIFO claim semantics — sort
  // -------------------------------------------------------------------------

  it('sort orders candidates oldest-first (claim semantics)', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-02T00:00:00Z');
    const t2 = new Date('2026-01-03T00:00:00Z');
    await JobModel.create([
      { payload: 'newest', status: 'pending', createdAt: t2 },
      { payload: 'oldest', status: 'pending', createdAt: t0 },
      { payload: 'middle', status: 'pending', createdAt: t1 },
    ]);

    const claimed = await repo.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing' } },
      { sort: { createdAt: 1 } },
    );

    expect(claimed?.payload).toBe('oldest');
    expect(claimed?.status).toBe('processing');
  });

  // -------------------------------------------------------------------------
  // Aggregation pipeline form
  // -------------------------------------------------------------------------

  it('accepts aggregation pipeline updates when updatePipeline is enabled', async () => {
    const seed = await JobModel.create({ payload: 'pipe', attempts: 2 });

    const result = await repo.findOneAndUpdate(
      { _id: seed._id },
      [{ $set: { attempts: { $add: ['$attempts', 1] } } }],
      { updatePipeline: true },
    );

    expect(result?.attempts).toBe(3);
  });

  it('rejects aggregation pipeline updates by default', async () => {
    const seed = await JobModel.create({ payload: 'pipe-blocked', attempts: 0 });
    await expect(
      repo.findOneAndUpdate({ _id: seed._id }, [{ $set: { attempts: 99 } }]),
    ).rejects.toThrow(/pipeline/i);
  });

  // -------------------------------------------------------------------------
  // Hook lifecycle
  // -------------------------------------------------------------------------

  it('fires hooks in order: before → op → after', async () => {
    const order: string[] = [];
    const seed = await JobModel.create({ payload: 'hooks' });

    repo.on('before:findOneAndUpdate', () => {
      order.push('before');
    });
    repo.on('after:findOneAndUpdate', () => {
      order.push('after');
    });

    await repo.findOneAndUpdate({ _id: seed._id }, { $set: { status: 'done' } });

    expect(order).toEqual(['before', 'after']);
    repo.removeAllListeners('before:findOneAndUpdate');
    repo.removeAllListeners('after:findOneAndUpdate');
  });

  it('fires error:findOneAndUpdate on driver errors', async () => {
    const errors: Error[] = [];
    repo.on('error:findOneAndUpdate', ({ error }: { error: Error }) => {
      errors.push(error);
    });

    // CastError on a non-ObjectId — mongoose throws synchronously inside the op.
    await expect(
      repo.findOneAndUpdate({ _id: 'not-an-objectid' }, { $set: { status: 'done' } }),
    ).rejects.toThrow();

    expect(errors.length).toBeGreaterThan(0);
    repo.removeAllListeners('error:findOneAndUpdate');
  });
});

// ---------------------------------------------------------------------------
// Plugin integration
// ---------------------------------------------------------------------------

describe('Repository.findOneAndUpdate — plugin integration', () => {
  let JobModel: mongoose.Model<IFoauJob>;

  beforeAll(async () => {
    await connectDB();
    JobModel = await createTestModel('FoauJobPluginScoped', FoauJobSchema);
  });

  afterAll(async () => {
    await JobModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await JobModel.deleteMany({});
  });

  it('multi-tenant plugin scopes the filter (cross-tenant doc does not match)', async () => {
    const repo = new Repository(JobModel, [multiTenantPlugin()]);

    await JobModel.create([
      { payload: 'org1-job', organizationId: 'org_1', status: 'pending' },
      { payload: 'org2-job', organizationId: 'org_2', status: 'pending' },
    ]);

    const result = await repo.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing' } },
      { organizationId: 'org_1' },
    );

    expect(result?.payload).toBe('org1-job');

    // The org_2 doc must remain untouched.
    const other = await JobModel.findOne({ organizationId: 'org_2' }).lean();
    expect(other?.status).toBe('pending');
  });

  it('soft-delete plugin excludes deleted docs from match', async () => {
    const repo = new Repository(JobModel, [softDeletePlugin()]);

    const live = await JobModel.create({ payload: 'live', status: 'pending' });
    await JobModel.create({
      payload: 'deleted',
      status: 'pending',
      deletedAt: new Date(),
    });

    const result = await repo.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing' } },
    );

    expect(result?._id.toString()).toBe(live._id.toString());
  });

  it('timestamp plugin stamps updatedAt on operator-style updates', async () => {
    const repo = new Repository(JobModel, [timestampPlugin()]);

    const seed = await JobModel.create({
      payload: 'stamp',
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    });
    const before = (await JobModel.findById(seed._id).lean())?.updatedAt?.getTime() ?? 0;

    const result = await repo.findOneAndUpdate(
      { _id: seed._id },
      { $set: { status: 'done' } },
    );

    const after = result?.updatedAt?.getTime() ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('timestamp plugin stamps createdAt via $setOnInsert on upsert', async () => {
    const repo = new Repository(JobModel, [timestampPlugin()]);

    const result = await repo.findOneAndUpdate(
      { payload: 'upsert-stamp' },
      { $set: { payload: 'upsert-stamp', status: 'pending' } },
      { upsert: true },
    );

    expect(result?.createdAt).toBeInstanceOf(Date);
    expect(result?.updatedAt).toBeInstanceOf(Date);
  });
});
