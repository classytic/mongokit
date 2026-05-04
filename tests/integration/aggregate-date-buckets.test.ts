/**
 * Integration tests for date-bucket grouping in the portable
 * `aggregate(req)` IR. Pins the canonical bucket label format
 * (`YYYY-MM-DD` / `YYYY-Www` / `YYYY-MM` / `YYYY-Qn` / `YYYY`) and
 * verifies the cross-kit shape: bucket aliases land as top-level
 * columns on the row, alongside groupBy fields and measures.
 *
 * The same input AggRequest produces the same output rows on
 * sqlitekit's parallel test file — that's what makes the IR portable.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrder {
  _id?: mongoose.Types.ObjectId;
  status: string;
  amount: number;
  createdAt: Date;
}

function makeSchema() {
  return new mongoose.Schema<IOrder>(
    {
      status: { type: String, required: true },
      amount: { type: Number, required: true },
      createdAt: { type: Date, required: true },
    },
    { timestamps: false },
  );
}

/** Helper — `2026-04-15T10:00:00Z` etc. */
const utc = (iso: string) => new Date(iso);

describe('aggregate (portable IR) — date buckets', () => {
  let Model: mongoose.Model<IOrder>;
  let repo: Repository<IOrder>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggDateBuckets', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IOrder>(Model);
    // Spread across Jan, Feb, Apr, Jul, and one in late Dec (testing
    // the ISO-week year quirk where 2025-12-30 lands in 2026-W01).
    await repo.createMany([
      { status: 'paid', amount: 100, createdAt: utc('2026-01-15T10:00:00Z') },
      { status: 'paid', amount: 200, createdAt: utc('2026-01-22T10:00:00Z') },
      { status: 'paid', amount: 300, createdAt: utc('2026-02-05T10:00:00Z') },
      { status: 'pending', amount: 50, createdAt: utc('2026-02-05T10:00:00Z') },
      { status: 'paid', amount: 400, createdAt: utc('2026-04-10T10:00:00Z') },
      { status: 'paid', amount: 500, createdAt: utc('2026-07-20T10:00:00Z') },
    ]);
  });

  it('month bucket emits YYYY-MM and groups correctly', async () => {
    const { rows } = await repo.aggregate<{ month: string; revenue: number }>({
      filter: { status: 'paid' },
      dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
      measures: { revenue: { op: 'sum', field: 'amount' } },
      sort: { month: 1 },
    });
    expect(rows).toEqual([
      { month: '2026-01', revenue: 300 },
      { month: '2026-02', revenue: 300 },
      { month: '2026-04', revenue: 400 },
      { month: '2026-07', revenue: 500 },
    ]);
  });

  it('day bucket emits YYYY-MM-DD', async () => {
    const { rows } = await repo.aggregate<{ day: string; n: number }>({
      filter: { status: 'paid' },
      dateBuckets: { day: { field: 'createdAt', interval: 'day' } },
      measures: { n: { op: 'count' } },
      sort: { day: 1 },
    });
    expect(rows.map((r) => r.day)).toEqual([
      '2026-01-15',
      '2026-01-22',
      '2026-02-05',
      '2026-04-10',
      '2026-07-20',
    ]);
  });

  it('quarter bucket emits YYYY-Qn', async () => {
    const { rows } = await repo.aggregate<{ q: string; revenue: number }>({
      filter: { status: 'paid' },
      dateBuckets: { q: { field: 'createdAt', interval: 'quarter' } },
      measures: { revenue: { op: 'sum', field: 'amount' } },
      sort: { q: 1 },
    });
    // Q1 = Jan/Feb (100+200+300), Q2 = Apr (400), Q3 = Jul (500)
    expect(rows).toEqual([
      { q: '2026-Q1', revenue: 600 },
      { q: '2026-Q2', revenue: 400 },
      { q: '2026-Q3', revenue: 500 },
    ]);
  });

  it('year bucket emits YYYY', async () => {
    const { rows } = await repo.aggregate<{ year: string; n: number }>({
      filter: { status: 'paid' },
      dateBuckets: { year: { field: 'createdAt', interval: 'year' } },
      measures: { n: { op: 'count' } },
    });
    expect(rows).toEqual([{ year: '2026', n: 5 }]);
  });

  it('combines bucket alias with groupBy column', async () => {
    const { rows } = await repo.aggregate<{
      month: string;
      status: string;
      n: number;
    }>({
      dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
      groupBy: 'status',
      measures: { n: { op: 'count' } },
      sort: { month: 1, status: 1 },
    });
    expect(rows).toEqual([
      { month: '2026-01', status: 'paid', n: 2 },
      { month: '2026-02', status: 'paid', n: 1 },
      { month: '2026-02', status: 'pending', n: 1 },
      { month: '2026-04', status: 'paid', n: 1 },
      { month: '2026-07', status: 'paid', n: 1 },
    ]);
  });

  it('throws when bucket alias collides with a groupBy field', async () => {
    await expect(
      repo.aggregate({
        groupBy: 'status',
        dateBuckets: { status: { field: 'createdAt', interval: 'month' } },
        measures: { n: { op: 'count' } },
      }),
    ).rejects.toThrow(/dateBuckets alias "status" collides/);
  });

  it('throws when bucket alias collides with a measure name', async () => {
    await expect(
      repo.aggregate({
        dateBuckets: { revenue: { field: 'createdAt', interval: 'month' } },
        measures: { revenue: { op: 'sum', field: 'amount' } },
      }),
    ).rejects.toThrow(/dateBuckets alias "revenue" collides/);
  });

  it('aggregatePaginate counts distinct buckets correctly', async () => {
    const result = await repo.aggregatePaginate<{ month: string; n: number }>({
      filter: { status: 'paid' },
      dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
      measures: { n: { op: 'count' } },
      sort: { month: 1 },
      limit: 2,
      page: 1,
    });
    expect(result.method).toBe('offset');
    if (result.method !== 'offset') throw new Error('expected offset envelope');
    expect(result.data.map((r) => r.month)).toEqual(['2026-01', '2026-02']);
    expect(result.total).toBe(4); // four distinct months
    expect(result.hasNext).toBe(true);
  });
});
