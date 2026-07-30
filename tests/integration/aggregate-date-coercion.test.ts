/**
 * Regression: ISO-date coercion on the `aggregate()` → `$match` path.
 *
 * THE BUG (fixed via repo-core `coerceFilterDates`). An aggregation
 * `$match` stage receives NO Mongoose query casting — that only runs on
 * `find`-family calls. BSON type ordering makes Date (type 9) and String
 * (type 2) non-comparable, so a string bound against a Date column matches
 * NOTHING, silently, with no error.
 *
 * `compileFilterToMongo` already coerced ISO strings, but only for BARE
 * shorthand (`{ gte: … }`) at the TOP level. Two shapes slipped through:
 *
 *   1. `$`-prefixed operators — `{ createdAt: { $gte: '…' } }`
 *   2. anything nested under `$and` / `$or` / `$nor`
 *
 * (2) is the one that bit production: when a policy/tenant scope is merged
 * with a caller filter the result is `$and`-wrapped, so EVERY date-range
 * aggregation on a tenant-scoped resource returned zero rows.
 *
 * The `fieldType: 'objectId'` tenant config is included because that is the
 * real-world pairing (Better-Auth stores `organization._id` as an ObjectId)
 * and the pre-existing `aggregate-multi-tenant.test.ts` only covers the
 * default `'string'`.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { multiTenantPlugin, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrd {
  _id?: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  amount: number;
  createdAt: Date;
}

describe('aggregate() ISO-date coercion into $match', () => {
  let Model: mongoose.Model<IOrd>;
  const orgA = new mongoose.Types.ObjectId();
  const orgB = new mongoose.Types.ObjectId();

  const isoFrom = () => new Date(Date.now() - 86_400_000).toISOString();
  const isoTo = () => new Date(Date.now() + 86_400_000).toISOString();

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'AggDateCoercionOrd',
      new Schema<IOrd>({
        organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
        amount: { type: Number, required: true },
        createdAt: { type: Date, required: true },
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    await Model.create([
      { organizationId: orgA, amount: 100, createdAt: new Date() },
      { organizationId: orgB, amount: 999, createdAt: new Date() },
    ]);
  });

  function scopedRepo() {
    return new Repository<IOrd>(Model, [
      multiTenantPlugin({ tenantField: 'organizationId', required: false, fieldType: 'objectId' }),
    ]);
  }

  it('coerces ISO strings on $-prefixed range operators', async () => {
    const res = await scopedRepo().aggregate(
      {
        measures: { count: { op: 'count' } },
        filter: { createdAt: { $gte: isoFrom(), $lte: isoTo() } },
      },
      { organizationId: String(orgA) },
    );
    expect(res.rows[0]?.count).toBe(1);
  });

  it('coerces ISO strings nested under $and — the tenant-scope merge shape', async () => {
    // This is what a policy/tenant scope conjoined with a caller filter
    // looks like by the time it reaches the compiler. Pre-fix: `rows: []`.
    const res = await scopedRepo().aggregate(
      {
        measures: { count: { op: 'count' }, total: { op: 'sum', field: 'amount' } },
        filter: {
          $and: [{ createdAt: { $gte: isoFrom() } }, { createdAt: { $lte: isoTo() } }],
        },
      },
      { organizationId: String(orgA) },
    );
    expect(res.rows[0]?.count).toBe(1);
    expect(res.rows[0]?.total).toBe(100);
  });

  it('coerces ISO strings nested under $or', async () => {
    const res = await scopedRepo().aggregate(
      {
        measures: { count: { op: 'count' } },
        filter: { $or: [{ createdAt: { $gte: isoFrom() } }] },
      },
      { organizationId: String(orgA) },
    );
    expect(res.rows[0]?.count).toBe(1);
  });

  it('still coerces BARE shorthand (arc bracket-syntax URL params)', async () => {
    const res = await scopedRepo().aggregate(
      {
        measures: { count: { op: 'count' } },
        filter: { createdAt: { gte: isoFrom(), lte: isoTo() } },
      },
      { organizationId: String(orgA) },
    );
    expect(res.rows[0]?.count).toBe(1);
  });

  it('expands bare shorthand nested under $and (no literal `gte` field reaches $match)', async () => {
    const res = await scopedRepo().aggregate(
      {
        measures: { count: { op: 'count' } },
        filter: { $and: [{ createdAt: { gte: isoFrom() } }] },
      },
      { organizationId: String(orgA) },
    );
    expect(res.rows[0]?.count).toBe(1);
  });

  it('a range that EXCLUDES the rows still returns nothing (coercion is not a no-op filter)', async () => {
    // Guards against "fixed by dropping the predicate" — the range must
    // still be enforced, just with correctly-typed bounds.
    const res = await scopedRepo().aggregate(
      {
        measures: { count: { op: 'count' } },
        filter: {
          $and: [{ createdAt: { $gte: new Date(Date.now() + 3_600_000).toISOString() } }],
        },
      },
      { organizationId: String(orgA) },
    );
    expect(res.rows[0]?.count ?? 0).toBe(0);
  });

  it('leaves a non-date string predicate untouched (no false coercion)', async () => {
    // A date-SHAPED prefix must not become a Date — the anchored pattern in
    // repo-core exists for exactly this (`2026-01-01-ORDER-1` is a string id).
    const res = await scopedRepo().aggregate(
      {
        measures: { count: { op: 'count' } },
        filter: { $and: [{ createdAt: { $gte: isoFrom() } }] },
        groupBy: ['organizationId'],
      },
      { organizationId: String(orgA) },
    );
    expect(res.rows).toHaveLength(1);
  });
});
