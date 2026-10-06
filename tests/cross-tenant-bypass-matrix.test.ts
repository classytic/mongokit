/**
 * Every repository operation, run the way a platform admin runs it:
 * `bypassTenant: true` and NO tenant, against a repository whose
 * `multiTenantPlugin` REQUIRES one.
 *
 * The cascade forwarded `organizationId` to its child deletes but never the
 * bypass, so a cross-tenant parent delete 500'd with "Missing
 * 'organizationId' in context" from inside the CHILD repo. That class of bug
 * lives wherever mongokit makes a SECOND repository call on the caller's
 * behalf (cascade, restrict, detach, soft-delete restore, pagination
 * helpers). This matrix drives each operation once with the parent AND its
 * cascade child tenant-required, so a hop that drops the bypass fails here by
 * name.
 *
 * It asserts the bypass WORKS (reaches both tenants' rows), not only that it
 * does not throw, and that the same call without the bypass is still refused.
 */
import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  batchOperationsPlugin,
  cascadePlugin,
  methodRegistryPlugin,
  multiTenantPlugin,
  Repository,
  softDeletePlugin,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IParent {
  _id: Types.ObjectId;
  name: string;
  status: string;
  version: number;
  organizationId: string;
  deletedAt?: Date | null;
}
interface IChild {
  _id: Types.ObjectId;
  parent: Types.ObjectId;
  organizationId: string;
  deletedAt?: Date | null;
}

const ParentSchema = new Schema<IParent>({
  name: String,
  status: { type: String, default: 'pending' },
  version: { type: Number, default: 0 },
  organizationId: { type: String, required: true },
  deletedAt: { type: Date, default: null },
});
const ChildSchema = new Schema<IChild>({
  parent: { type: Schema.Types.ObjectId, required: true, index: true },
  organizationId: { type: String, required: true },
  deletedAt: { type: Date, default: null },
});

const BYPASS = { bypassTenant: true } as const;
const MISSING_TENANT = /Missing 'organizationId'/;

describe('cross-tenant bypass reaches every operation', () => {
  let Parent: mongoose.Model<IParent>;
  let Child: mongoose.Model<IChild>;
  // biome-ignore lint/suspicious/noExplicitAny: plugin-registered methods
  let repo: any;
  let a: IParent;
  let b: IParent;

  beforeAll(async () => {
    await connectDB();
    Parent = await createTestModel('BypassMatrixParent', ParentSchema);
    Child = await createTestModel('BypassMatrixChild', ChildSchema);

    const childRepo = new Repository<IChild>(Child, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
    ]);
    repo = new Repository<IParent>(Parent, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
      cascadePlugin({ relations: [{ repo: childRepo, foreignKey: 'parent' }], parallel: false }),
    ]);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Parent.deleteMany({});
    await Child.deleteMany({});
    a = (await Parent.create({ name: 'A', organizationId: 'org_a' })).toObject();
    b = (await Parent.create({ name: 'B', organizationId: 'org_b' })).toObject();
    await Child.create({ parent: a._id, organizationId: 'org_a' });
    await Child.create({ parent: b._id, organizationId: 'org_b' });
  });

  it('control: without the bypass a tenant-less call is refused', async () => {
    await expect(repo.findAll({})).rejects.toThrow(MISSING_TENANT);
  });

  describe('reads', () => {
    it('getById', async () => {
      expect((await repo.getById(String(b._id), BYPASS))?.name).toBe('B');
    });
    it('getByQuery / getOne', async () => {
      expect((await repo.getByQuery({ name: 'B' }, BYPASS))?.name).toBe('B');
      expect((await repo.getOne({ name: 'A' }, BYPASS))?.name).toBe('A');
    });
    it('findAll sees both tenants', async () => {
      expect(await repo.findAll({}, BYPASS)).toHaveLength(2);
    });
    it('count / exists / distinct', async () => {
      expect(await repo.count({}, BYPASS)).toBe(2);
      expect(await repo.exists({ name: 'B' }, BYPASS)).not.toBeNull();
      expect((await repo.distinct('organizationId', {}, BYPASS)).sort()).toEqual([
        'org_a',
        'org_b',
      ]);
    });
    it('getAll, offset pagination', async () => {
      const page = await repo.getAll({ filters: {}, page: 1, limit: 10 }, BYPASS);
      expect(page.data ?? page.docs).toHaveLength(2);
    });
    it('getAll, keyset pagination', async () => {
      const page = await repo.getAll(
        { filters: {}, sort: { _id: 1 }, limit: 1, after: undefined },
        BYPASS,
      );
      expect((page.data ?? page.docs).length).toBe(1);
    });
    it('cursor streams both tenants', async () => {
      const seen: unknown[] = [];
      for await (const doc of repo.cursor({}, BYPASS)) seen.push(doc);
      expect(seen).toHaveLength(2);
    });
    it('aggregate (portable IR) counts both tenants', async () => {
      const { rows } = await repo.aggregate({ measures: { n: { op: 'count' } } }, BYPASS);
      expect(rows[0]?.n).toBe(2);
    });
    it('aggregatePaginate groups both tenants', async () => {
      const res = await repo.aggregatePaginate(
        {
          groupBy: 'organizationId',
          measures: { n: { op: 'count' } },
          sort: { organizationId: 1 },
          page: 1,
          limit: 10,
        },
        BYPASS,
      );
      expect(res.data).toHaveLength(2);
    });
    it('aggregatePipeline (raw)', async () => {
      const rows = await repo.aggregatePipeline(
        [{ $group: { _id: null, n: { $sum: 1 } } }],
        BYPASS,
      );
      expect(rows[0]?.n).toBe(2);
    });
    it('aggregatePipelinePaginate (raw)', async () => {
      const res = await repo.aggregatePipelinePaginate({
        pipeline: [{ $sort: { name: 1 } }],
        page: 1,
        limit: 10,
        ...BYPASS,
      });
      expect(res.docs ?? res.data).toHaveLength(2);
    });
  });

  describe('writes', () => {
    it('update', async () => {
      expect((await repo.update(String(b._id), { name: 'B2' }, BYPASS))?.name).toBe('B2');
    });
    it('findOneAndUpdate', async () => {
      const res = await repo.findOneAndUpdate(
        { _id: b._id },
        { $set: { name: 'B3' } },
        { ...BYPASS, returnDocument: 'after' },
      );
      expect(res?.name).toBe('B3');
    });
    it('updateMany reaches both tenants', async () => {
      await repo.updateMany({}, { $set: { status: 'x' } }, BYPASS);
      expect(await Parent.countDocuments({ status: 'x' })).toBe(2);
    });
    it('claim', async () => {
      const res = await repo.claim(
        String(b._id),
        { field: 'status', from: 'pending', to: 'done' },
        {},
        BYPASS,
      );
      expect(res?.status).toBe('done');
    });
    it('claimVersion', async () => {
      const res = await repo.claimVersion(
        String(b._id),
        { from: 0 },
        { $set: { name: 'v' } },
        BYPASS,
      );
      expect(res).not.toBeNull();
    });
    it('create: the bypass carries no tenant, so a create must name one', async () => {
      const doc = await repo.create({ name: 'C', organizationId: 'org_c' }, BYPASS);
      expect(doc.organizationId).toBe('org_c');
    });
    it('bulkWrite', async () => {
      await repo.bulkWrite(
        [{ updateOne: { filter: { _id: b._id }, update: { $set: { name: 'bw' } } } }],
        BYPASS,
      );
      expect((await Parent.findById(b._id).lean())?.name).toBe('bw');
    });
  });

  describe('deletes, which make a SECOND repository call (the cascade)', () => {
    it('delete (soft) cascades soft to the child', async () => {
      await repo.delete(String(b._id), BYPASS);
      expect((await Parent.findById(b._id).lean())?.deletedAt).toBeTruthy();
      expect((await Child.findOne({ parent: b._id }).lean())?.deletedAt).toBeTruthy();
      expect((await Child.findOne({ parent: a._id }).lean())?.deletedAt).toBeNull();
    });
    it('delete (hard) cascades hard to the child', async () => {
      await repo.delete(String(b._id), { ...BYPASS, mode: 'hard' });
      expect(await Parent.countDocuments({ _id: b._id })).toBe(0);
      expect(await Child.countDocuments({ parent: b._id })).toBe(0);
      expect(await Child.countDocuments({ parent: a._id })).toBe(1);
    });
    it('deleteMany cascades across tenants', async () => {
      await repo.deleteMany({ name: { $in: ['A', 'B'] } }, { ...BYPASS, mode: 'hard' });
      expect(await Parent.countDocuments({})).toBe(0);
      expect(await Child.countDocuments({})).toBe(0);
    });
    it('restore', async () => {
      await repo.delete(String(b._id), BYPASS);
      await repo.restore(String(b._id), BYPASS);
      expect((await Parent.findById(b._id).lean())?.deletedAt).toBeNull();
    });
  });
});
