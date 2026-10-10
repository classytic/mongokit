/**
 * repo-core `runDataAccessConformance` against mongokit: every group whose capability
 * MONGOKIT_CAPABILITIES declares must pass here.
 */

import { runDataAccessConformance } from '@classytic/repo-core/testing';
import mongoose, { type Model, Schema } from 'mongoose';
import { beforeAll } from 'vitest';
import {
  MONGOKIT_CAPABILITIES,
  multiTenantPlugin,
  Repository,
  softDeletePlugin,
} from '../../src/index.js';
import { connectDB, createTestModel } from '../setup.js';

interface INamed {
  name: string;
}
interface IBase {
  organizationId: string;
  key: string;
}
interface IJoined {
  organizationId: string;
  key: string;
  qty: number;
  deletedAt?: Date | null;
}

let Named: Model<INamed>;
let Base: Model<IBase>;
let Joined: Model<IJoined>;

beforeAll(async () => {
  await connectDB();
  Named = await createTestModel('DacNamed', new Schema<INamed>({ name: String }));
  Base = await createTestModel('DacBase', new Schema<IBase>({ organizationId: String, key: String }));
  Joined = await createTestModel(
    'DacJoined',
    new Schema<IJoined>({ organizationId: String, key: String, qty: Number, deletedAt: { type: Date, default: null } }),
  );
});

runDataAccessConformance({
  name: 'mongokit',
  features: MONGOKIT_CAPABILITIES,
  orderedIds: async () => {
    const repo = new Repository<INamed>(Named);
    await Named.deleteMany({});
    return {
      insert: async (names) => (await repo.createMany(names.map((name) => ({ name })))).map((d) => String(d._id)),
      getOrdered: (ids, { chunkSize }) => repo.getByIds(ids, { preserveOrder: true, chunkSize }),
      missingId: String(new mongoose.Types.ObjectId()),
      cleanup: async () => {
        await Named.deleteMany({});
      },
    };
  },
  scopedJoin: async () => {
    const base = new Repository<IBase>(Base, [multiTenantPlugin({ tenantField: 'organizationId' })]);
    new Repository<IJoined>(Joined, [multiTenantPlugin({ tenantField: 'organizationId' }), softDeletePlugin()]);
    await Promise.all([Base.deleteMany({}), Joined.deleteMany({})]);
    return {
      aggregate: (req, scope) => base.aggregate(req, scope),
      joined: Joined.collection.collectionName,
      seedBase: async (tenant, keys) => {
        await Base.insertMany(keys.map((key) => ({ organizationId: tenant, key })));
      },
      seedJoined: async (tenant, rows) => {
        await Joined.insertMany(
          rows.map((r) => ({ organizationId: tenant, key: r.key, qty: r.qty, deletedAt: r.deleted ? new Date() : null })),
        );
      },
      scope: (tenant) => ({ organizationId: tenant }),
      cleanup: async () => {
        await Promise.all([Base.deleteMany({}), Joined.deleteMany({})]);
      },
    };
  },
});
