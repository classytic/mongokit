/**
 * repo-core `runPaginationPropertyConformance` against mongokit (fast-check):
 * keyset walks equal an in-memory sort, survive concurrent writes, offset pages never repeat.
 */

import { runPaginationPropertyConformance } from '@classytic/repo-core/testing';
import { type Model, Schema } from 'mongoose';
import { beforeAll } from 'vitest';
import { MONGOKIT_CAPABILITIES, Repository } from '../../src/index.js';
import { connectDB, createTestModel } from '../setup.js';

interface IProp {
  k: number | null;
  s: string;
}

let Prop: Model<IProp>;

beforeAll(async () => {
  await connectDB();
  Prop = await createTestModel('PagPropRow', new Schema<IProp>({ k: { type: Number, default: null }, s: String }));
});

type Row = IProp & { _id: unknown };
const toRow = (d: Row) => ({ id: String(d._id), k: d.k ?? null, s: d.s });

runPaginationPropertyConformance({
  name: 'mongokit',
  features: MONGOKIT_CAPABILITIES,
  numRuns: 30,
  fixture: async () => {
    const repo = new Repository<IProp>(Prop);
    return {
      insert: async (rows) => (await Prop.insertMany(rows.map((r) => ({ ...r })))).map((d) => String(d._id)),
      update: async (id, k) => {
        await Prop.updateOne({ _id: id }, { $set: { k } });
      },
      remove: async (id) => {
        await Prop.deleteOne({ _id: id });
      },
      keysetPage: async ({ sort, limit, after }) => {
        const r = await repo.getAll({ sort, limit, mode: 'keyset', ...(after ? { after } : {}) });
        if (r.method !== 'keyset') throw new Error('expected a keyset page');
        return { data: (r.data as Row[]).map(toRow), next: r.next };
      },
      offsetPage: async ({ sort, page, limit }) => {
        const r = await repo.getAll({ sort, page, limit, mode: 'offset' });
        return { data: (r.data as Row[]).map(toRow) };
      },
      reset: async () => {
        await Prop.deleteMany({});
      },
      cleanup: async () => {
        await Prop.deleteMany({});
      },
    };
  },
});
