/**
 * Integration tests for **filtered measures** — per-measure `where`
 * predicates that scope the aggregate to a subset of rows within
 * each group, equivalent to SQL's
 * `SUM(amount) FILTER (WHERE status = 'paid')`.
 *
 * The killer use case: dashboard tiles that need `paid_revenue` +
 * `total_revenue` + `refund_count` side-by-side. Without filtered
 * measures, that's three separate pre-filtered aggregates the
 * caller stitches together. With them, one query, one round-trip,
 * one row per group.
 */

import { eq, gt } from '@classytic/repo-core/filter';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrder {
  _id?: mongoose.Types.ObjectId;
  category: string;
  status: string;
  amount: number;
}

function makeSchema() {
  return new mongoose.Schema<IOrder>(
    {
      category: { type: String, required: true },
      status: { type: String, required: true },
      amount: { type: Number, required: true },
    },
    { timestamps: false },
  );
}

describe('aggregate (portable IR) — filtered measures', () => {
  let Model: mongoose.Model<IOrder>;
  let repo: Repository<IOrder>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggFilteredMeasures', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IOrder>(Model);
    await repo.createMany([
      // books — 2 paid (300 total), 1 refunded (50)
      { category: 'books', status: 'paid', amount: 100 },
      { category: 'books', status: 'paid', amount: 200 },
      { category: 'books', status: 'refunded', amount: 50 },
      // toys — 1 paid (40), 1 pending (60)
      { category: 'toys', status: 'paid', amount: 40 },
      { category: 'toys', status: 'pending', amount: 60 },
    ]);
  });

  it('filtered sum: paid_revenue per category', async () => {
    const { rows } = await repo.aggregate<{
      category: string;
      paid: number;
      total: number;
    }>({
      groupBy: 'category',
      measures: {
        paid: { op: 'sum', field: 'amount', where: eq('status', 'paid') },
        total: { op: 'sum', field: 'amount' },
      },
      sort: { category: 1 },
    });
    expect(rows).toEqual([
      { category: 'books', paid: 300, total: 350 },
      { category: 'toys', paid: 40, total: 100 },
    ]);
  });

  it('filtered count: paid_count + refund_count side-by-side', async () => {
    const { rows } = await repo.aggregate<{
      category: string;
      paidN: number;
      refundN: number;
    }>({
      groupBy: 'category',
      measures: {
        paidN: { op: 'count', where: eq('status', 'paid') },
        refundN: { op: 'count', where: eq('status', 'refunded') },
      },
      sort: { category: 1 },
    });
    expect(rows).toEqual([
      { category: 'books', paidN: 2, refundN: 1 },
      { category: 'toys', paidN: 1, refundN: 0 },
    ]);
  });

  it('filtered avg ignores non-matching rows (does not drag down)', async () => {
    // books has 2 paid orders averaging 150; refund of 50 must NOT
    // count toward the paid-only average.
    const { rows } = await repo.aggregate<{ category: string; avgPaid: number }>({
      groupBy: 'category',
      measures: {
        avgPaid: { op: 'avg', field: 'amount', where: eq('status', 'paid') },
      },
      sort: { category: 1 },
    });
    expect(rows).toEqual([
      { category: 'books', avgPaid: 150 },
      { category: 'toys', avgPaid: 40 },
    ]);
  });

  it('filtered min/max scope extremes to the predicate', async () => {
    const { rows } = await repo.aggregate<{
      category: string;
      maxPaid: number;
      minPaid: number;
    }>({
      groupBy: 'category',
      measures: {
        maxPaid: { op: 'max', field: 'amount', where: eq('status', 'paid') },
        minPaid: { op: 'min', field: 'amount', where: eq('status', 'paid') },
      },
      sort: { category: 1 },
    });
    expect(rows).toEqual([
      { category: 'books', maxPaid: 200, minPaid: 100 },
      { category: 'toys', maxPaid: 40, minPaid: 40 },
    ]);
  });

  it('filtered countDistinct: distinct categories among non-paid rows', async () => {
    const { rows } = await repo.aggregate<{ nDistinctNonPaidStatus: number }>({
      measures: {
        nDistinctNonPaidStatus: {
          op: 'countDistinct',
          field: 'status',
          where: gt('amount', 40),
        },
      },
    });
    // amounts > 40: 100/200/refunded(50)/pending(60). statuses: paid (>40 books), refunded, pending → 3 distinct.
    expect(rows[0]?.nDistinctNonPaidStatus).toBe(3);
  });

  it('top-level filter + per-measure where compose', async () => {
    // Top-level filter narrows to only books; per-measure where
    // further partitions inside that.
    const { rows } = await repo.aggregate<{
      paid: number;
      total: number;
    }>({
      filter: eq('category', 'books'),
      measures: {
        paid: { op: 'sum', field: 'amount', where: eq('status', 'paid') },
        total: { op: 'sum', field: 'amount' },
      },
    });
    expect(rows[0]).toEqual({ paid: 300, total: 350 });
  });

  it('scalar aggregate (no groupBy) with a filtered measure', async () => {
    const { rows } = await repo.aggregate<{ refundedRevenue: number }>({
      measures: {
        refundedRevenue: {
          op: 'sum',
          field: 'amount',
          where: eq('status', 'refunded'),
        },
      },
    });
    expect(rows).toEqual([{ refundedRevenue: 50 }]);
  });
});
