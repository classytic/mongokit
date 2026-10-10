/**
 * Keyset pages are index-served: `assertQueryPlan` sees an IXSCAN on the declared
 * `{ status, at, _id }` index and no COLLSCAN / blocking SORT, on the first page and after a
 * cursor; the same request without the index fails the gate.
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { assertQueryPlan } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface IDoc {
  status: string;
  at: Date;
}

const INDEX = 'status_1_at_-1__id_-1';

describe('keyset page plan', () => {
  let conn: Connection;
  let Doc: Model<IDoc>;
  let repo: Repository<IDoc>;

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
    const schema = new Schema<IDoc>({ status: String, at: Date });
    schema.index({ status: 1, at: -1, _id: -1 }, { name: INDEX });
    Doc = conn.model<IDoc>('PagPlanDoc', schema);
    await Doc.deleteMany({});
    await Doc.syncIndexes();
    await Doc.insertMany(
      Array.from({ length: 3000 }, (_, i) => ({ status: i % 3 ? 'open' : 'paid', at: new Date(2026, 0, 1, 0, i) })),
    );
    repo = new Repository<IDoc>(Doc);
  }, 60_000);
  afterAll(async () => {
    await Doc.deleteMany({});
    await conn.close();
  });

  const page = (after?: string) =>
    repo.getAll({ filters: { status: 'open' }, sort: { at: -1 }, limit: 50, mode: 'keyset', ...(after ? { after } : {}) });
  const gate = () => ({ connection: conn, minDocs: 1000, leadingKeys: ['status', 'at'] });

  it('page one and a cursor page both use the index, with no SORT stage', async () => {
    const first = await assertQueryPlan(() => page(), gate());
    const next = (first.result as { next: string | null }).next;
    expect(next).toBeTruthy();
    await assertQueryPlan(() => page(next as string), gate());
  });

  it('without the index the same page fails the gate', async () => {
    await Doc.collection.dropIndex(INDEX);
    try {
      await expect(assertQueryPlan(() => page(), { connection: conn, minDocs: 1000 })).rejects.toThrow(/COLLSCAN|SORT/);
    } finally {
      await Doc.syncIndexes();
    }
  });
});
