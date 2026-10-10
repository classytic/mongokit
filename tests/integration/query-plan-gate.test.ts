/**
 * `assertQueryPlan` (testkit): passes on an indexed read, and fails on a COLLSCAN (the fixture
 * index dropped), an unindexed SORT, a wrong leading index, an undersized fixture, an
 * unmonitored connection, or a run that issued no plannable command.
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { assertQueryPlan } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface IDoc {
  status: string;
  at: Date;
  amount: number;
}

const DOCS = 2000;
const INDEX = 'status_1_at_-1';

describe('assertQueryPlan', () => {
  let conn: Connection;
  let DocModel: Model<IDoc>;
  let repo: Repository<IDoc>;

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
    const schema = new Schema<IDoc>({ status: String, at: Date, amount: Number });
    schema.index({ status: 1, at: -1 }, { name: INDEX });
    DocModel = conn.model<IDoc>('QueryPlanGateDoc', schema);
    await DocModel.deleteMany({});
    await DocModel.syncIndexes();
    await DocModel.insertMany(
      Array.from({ length: DOCS }, (_, i) => ({
        status: ['open', 'paid', 'void', 'held'][i % 4],
        at: new Date(2026, 0, 1 + (i % 300)),
        amount: i,
      })),
    );
    repo = new Repository<IDoc>(DocModel);
  }, 60_000);
  afterAll(async () => {
    await DocModel.deleteMany({});
    await conn.close();
  });

  const listOpen = () => repo.findAll({ status: 'open' }, { sort: { at: -1 }, limit: 20 });
  const gate = { connection: () => conn, minDocs: 1000 };

  it('passes an indexed, index-sorted read and reports the index it used', async () => {
    const { plans } = await assertQueryPlan(listOpen, {
      connection: gate.connection(),
      minDocs: gate.minDocs,
      leadingKeys: ['status', 'at'],
    });
    expect(plans[0]?.stages).toContain('IXSCAN');
    expect(plans[0]?.indexes[0]).toEqual(['status', 'at']);
  });

  it('passes the portable aggregate over the same filter', async () => {
    await assertQueryPlan(
      () => repo.aggregate({ filter: { status: 'paid' }, measures: { s: { op: 'sum', field: 'amount' } } }),
      { connection: gate.connection(), minDocs: gate.minDocs, leadingKeys: ['status'] },
    );
  });

  it('FAILS on a COLLSCAN once the fixture index is dropped (the falsification)', async () => {
    await DocModel.collection.dropIndex(INDEX);
    try {
      await expect(
        assertQueryPlan(listOpen, { connection: gate.connection(), minDocs: gate.minDocs }),
      ).rejects.toMatchObject({ code: 'mongokit.testkit.query_plan', message: expect.stringMatching(/COLLSCAN/) });
    } finally {
      await DocModel.syncIndexes();
    }
  });

  it('FAILS on an unindexed SORT', async () => {
    await expect(
      assertQueryPlan(() => repo.findAll({ status: 'open' }, { sort: { amount: 1 }, limit: 5 }), {
        connection: gate.connection(),
        minDocs: gate.minDocs,
      }),
    ).rejects.toThrow(/plan contains SORT/);
  });

  it('FAILS when the winning index does not lead with the declared keys', async () => {
    await expect(
      assertQueryPlan(listOpen, { connection: gate.connection(), minDocs: gate.minDocs, leadingKeys: ['amount'] }),
    ).rejects.toThrow(/does not lead with \(amount\)/);
  });

  it('refuses an undersized fixture, an unmonitored connection, and a run with nothing to plan', async () => {
    await expect(assertQueryPlan(listOpen, { connection: gate.connection(), minDocs: DOCS + 1 })).rejects.toThrow(
      /below minDocs/,
    );
    await expect(assertQueryPlan(listOpen, { connection: mongoose.connection, minDocs: 1 })).rejects.toThrow(
      /monitorCommands/,
    );
    await expect(
      assertQueryPlan(async () => repo.create({ status: 'x', at: new Date(), amount: 0 }), {
        connection: gate.connection(),
        minDocs: 1,
      }),
    ).rejects.toThrow(/no plannable command/);
  });
});
