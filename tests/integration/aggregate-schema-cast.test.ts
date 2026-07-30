/**
 * Regression: schema-aware casting on the `aggregate()` → `$match` path.
 *
 * THE BUG. A `find()` query is cast against the schema by Mongoose, so a
 * string `'6a6a…'` becomes an `ObjectId` and everything matches. An
 * aggregation pipeline gets NONE of that casting — it goes straight to the
 * driver — and BSON compares by type, so a string bound against an
 * `ObjectId` (or `Date`, or `Number`) column matches NOTHING. Silently.
 *
 * This is the position a framework is always in: it can't know the column
 * type. arc's multi-tenant preset resolves the tenant id off the auth scope
 * (a STRING) and conjoins it into the caller filter as `_policyFilters`.
 * Against an `ObjectId`-typed tenant column that predicate matched zero rows
 * on EVERY aggregation — while the equivalent `find()` worked.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrd {
  _id?: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  amount: number;
  qty: number;
  active: boolean;
  createdAt: Date;
  note: string;
}

describe('aggregate() schema-aware $match casting', () => {
  let Model: mongoose.Model<IOrd>;
  let repo: Repository<IOrd>;
  const orgA = new mongoose.Types.ObjectId();
  const orgB = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'AggSchemaCastOrd',
      new Schema<IOrd>({
        organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
        ownerId: { type: Schema.Types.ObjectId, required: true },
        amount: { type: Number, required: true },
        qty: { type: Number, required: true },
        active: { type: Boolean, required: true },
        createdAt: { type: Date, required: true },
        note: { type: String, required: true },
      }),
    );
    repo = new Repository<IOrd>(Model);
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    await Model.create([
      {
        organizationId: orgA,
        ownerId: owner,
        amount: 100,
        qty: 2,
        active: true,
        createdAt: new Date(),
        note: 'a',
      },
      {
        organizationId: orgB,
        ownerId: owner,
        amount: 999,
        qty: 9,
        active: false,
        createdAt: new Date(),
        note: 'b',
      },
    ]);
  });

  const count = { c: { op: 'count' } } as const;

  it('casts a STRING ObjectId in an equality predicate — the arc _policyFilters shape', async () => {
    const res = await repo.aggregate({ measures: count, filter: { organizationId: String(orgA) } });
    expect(res.rows[0]?.c).toBe(1);
  });

  it('casts a STRING ObjectId nested under $and — policy scope conjoined with caller filter', async () => {
    const res = await repo.aggregate({
      measures: count,
      filter: { $and: [{ organizationId: String(orgA) }, { active: true }] },
    });
    expect(res.rows[0]?.c).toBe(1);
  });

  it('casts a STRING ObjectId inside $in / $ne', async () => {
    const inRes = await repo.aggregate({
      measures: count,
      filter: { organizationId: { $in: [String(orgA), String(orgB)] } },
    });
    expect(inRes.rows[0]?.c).toBe(2);

    const neRes = await repo.aggregate({
      measures: count,
      filter: { organizationId: { $ne: String(orgB) } },
    });
    expect(neRes.rows[0]?.c).toBe(1);
  });

  it('casts numeric and boolean strings on their typed columns', async () => {
    const numeric = await repo.aggregate({
      measures: count,
      filter: { qty: { $gte: '5' } },
    });
    expect(numeric.rows[0]?.c).toBe(1);
  });

  it('casts ISO date strings via the schema (Date column)', async () => {
    const res = await repo.aggregate({
      measures: count,
      filter: { createdAt: { $lte: new Date(Date.now() + 60_000).toISOString() } },
    });
    expect(res.rows[0]?.c).toBe(2);
  });

  it('groupBy still works with a cast tenant predicate', async () => {
    const res = await repo.aggregate({
      measures: count,
      groupBy: ['note'],
      filter: { organizationId: String(orgA) },
    });
    expect(res.rows).toEqual([{ note: 'a', c: 1 }]);
  });

  it('an un-castable value does NOT throw — the predicate just matches nothing', async () => {
    // Non-throwing by design: a CastError here would turn a previously
    // empty-but-working dashboard into a 500.
    const res = await repo.aggregate({
      measures: count,
      filter: { organizationId: 'definitely-not-an-objectid' },
    });
    expect(res.rows[0]?.c ?? 0).toBe(0);
  });

  it('leaves string columns and unknown paths untouched', async () => {
    const byNote = await repo.aggregate({ measures: count, filter: { note: 'a' } });
    expect(byNote.rows[0]?.c).toBe(1);

    // A path that isn't in the schema must pass through, not blow up.
    const unknownPath = await repo.aggregate({
      measures: count,
      filter: { nope: 'whatever' },
    });
    expect(unknownPath.rows[0]?.c ?? 0).toBe(0);
  });

  it('does not disturb $regex / $exists operators', async () => {
    const res = await repo.aggregate({
      measures: count,
      filter: { note: { $regex: '^a' }, organizationId: { $exists: true } },
    });
    expect(res.rows[0]?.c).toBe(1);
  });

  it('casts through aggregatePaginate as well (shared pipeline builder)', async () => {
    const res = (await repo.aggregatePaginate({
      measures: count,
      groupBy: ['note'],
      filter: { organizationId: String(orgA) },
      limit: 10,
    })) as { data: Array<Record<string, unknown>> };
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.note).toBe('a');
  });
});
