/**
 * Integration tests for the portable `aggregate(req)` /
 * `aggregatePaginate(req)` IR surface on mongokit.
 *
 * Mirrors sqlitekit's `aggregate.test.ts` — same `AggRequest` shape in,
 * same row shape out. The whole point of the portable IR is that code
 * written against one kit runs unchanged against the other; the mongo
 * and sqlite tests should produce identical results for equivalent
 * data.
 */

import { gt } from '@classytic/repo-core/filter';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IUser {
  _id?: mongoose.Types.ObjectId;
  name: string;
  role: string;
  age: number;
}

function makeSchema() {
  return new mongoose.Schema<IUser>(
    {
      name: { type: String, required: true },
      role: { type: String, required: true },
      age: { type: Number, required: true },
    },
    { timestamps: false },
  );
}

describe('aggregate (portable IR) — scalar', () => {
  let Model: mongoose.Model<IUser>;
  let repo: Repository<IUser>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggIrScalar', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IUser>(Model);
    await repo.createMany([
      { name: 'A', role: 'admin', age: 25 },
      { name: 'B', role: 'admin', age: 30 },
      { name: 'C', role: 'reader', age: 45 },
    ]);
  });

  it('count + sum + avg in one call — single row', async () => {
    const { rows } = await repo.aggregate<{
      count: number;
      totalAge: number;
      avgAge: number;
    }>({
      measures: {
        count: { op: 'count' },
        totalAge: { op: 'sum', field: 'age' },
        avgAge: { op: 'avg', field: 'age' },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.totalAge).toBe(100);
    expect(Math.round(rows[0]?.avgAge ?? 0)).toBe(33);
  });

  it('filter scopes the aggregate to matching rows', async () => {
    const { rows } = await repo.aggregate<{ count: number }>({
      filter: gt('age', 28),
      measures: { count: { op: 'count' } },
    });
    expect(rows[0]?.count).toBe(2);
  });

  it('min/max track extremes', async () => {
    const { rows } = await repo.aggregate<{ youngest: number; oldest: number }>({
      measures: {
        youngest: { op: 'min', field: 'age' },
        oldest: { op: 'max', field: 'age' },
      },
    });
    expect(rows[0]?.youngest).toBe(25);
    expect(rows[0]?.oldest).toBe(45);
  });

  it('empty measures bag is a wiring bug', async () => {
    await expect(repo.aggregate({ measures: {} })).rejects.toThrow(/at least one measure/);
  });
});

describe('aggregate (portable IR) — groupBy', () => {
  let Model: mongoose.Model<IUser>;
  let repo: Repository<IUser>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggIrGroup', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IUser>(Model);
    await repo.createMany([
      { name: 'A', role: 'admin', age: 30 },
      { name: 'B', role: 'admin', age: 40 },
      { name: 'C', role: 'reader', age: 25 },
      { name: 'D', role: 'reader', age: 35 },
      { name: 'E', role: 'reader', age: 45 },
    ]);
  });

  it('groups by a single column with count + avg', async () => {
    const { rows } = await repo.aggregate<{ role: string; count: number; avgAge: number }>({
      groupBy: 'role',
      measures: {
        count: { op: 'count' },
        avgAge: { op: 'avg', field: 'age' },
      },
      sort: { role: 1 },
    });

    // Output row shape is flat — no `_id` key. Matches sqlitekit exactly.
    expect(rows).toEqual([
      { role: 'admin', count: 2, avgAge: 35 },
      { role: 'reader', count: 3, avgAge: 35 },
    ]);
  });

  it('filter applies pre-aggregation (WHERE, not HAVING)', async () => {
    const { rows } = await repo.aggregate<{ role: string; count: number }>({
      filter: gt('age', 30),
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      sort: { role: 1 },
    });

    expect(rows).toEqual([
      { role: 'admin', count: 1 },
      { role: 'reader', count: 2 },
    ]);
  });

  it('having filters post-aggregation on a measure alias', async () => {
    const { rows } = await repo.aggregate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      having: gt('count', 2),
    });

    expect(rows).toEqual([{ role: 'reader', count: 3 }]);
  });

  it('sorts by a measure alias', async () => {
    const { rows } = await repo.aggregate<{ role: string; totalAge: number }>({
      groupBy: 'role',
      measures: { totalAge: { op: 'sum', field: 'age' } },
      sort: { totalAge: -1 },
    });

    expect(rows.map((r) => r.role)).toEqual(['reader', 'admin']);
  });

  it('countDistinct counts unique values inside each group', async () => {
    const { rows } = await repo.aggregate<{ role: string; uniqueAges: number }>({
      groupBy: 'role',
      measures: { uniqueAges: { op: 'countDistinct', field: 'age' } },
      sort: { role: 1 },
    });

    expect(rows).toEqual([
      { role: 'admin', uniqueAges: 2 },
      { role: 'reader', uniqueAges: 3 },
    ]);
  });
});

describe('aggregatePaginate (portable IR)', () => {
  let Model: mongoose.Model<IUser>;
  let repo: Repository<IUser>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggIrPage', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IUser>(Model);
    await repo.createMany([
      { name: 'A', role: 'a', age: 10 },
      { name: 'B', role: 'b', age: 10 },
      { name: 'C', role: 'c', age: 10 },
      { name: 'D', role: 'd', age: 10 },
      { name: 'E', role: 'e', age: 10 },
      { name: 'F', role: 'a', age: 10 },
      { name: 'G', role: 'b', age: 10 },
    ]);
  });

  it('returns offset envelope with total = distinct group count', async () => {
    const result = await repo.aggregatePaginate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      sort: { role: 1 },
      page: 1,
      limit: 2,
    });

    expect(result.method).toBe('offset');
    expect(result.total).toBe(5);
    expect(result.pages).toBe(3);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(false);
    expect(result.docs.map((d) => d.role)).toEqual(['a', 'b']);
  });

  it('follows-on page yields the next slice', async () => {
    const result = await repo.aggregatePaginate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      sort: { role: 1 },
      page: 2,
      limit: 2,
    });

    expect(result.docs.map((d) => d.role)).toEqual(['c', 'd']);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(true);
  });

  it('countStrategy: "none" skips the count query and uses N+1 peek', async () => {
    const result = await repo.aggregatePaginate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      sort: { role: 1 },
      page: 1,
      limit: 2,
      countStrategy: 'none',
    });

    expect(result.total).toBe(0);
    expect(result.pages).toBe(0);
    expect(result.hasNext).toBe(true);
    expect(result.docs).toHaveLength(2);
  });

  it('scalar aggregation paginates to a single-row first page', async () => {
    const result = await repo.aggregatePaginate<{ count: number }>({
      measures: { count: { op: 'count' } },
      page: 1,
      limit: 10,
    });

    expect(result.total).toBe(1);
    expect(result.pages).toBe(1);
    expect(result.docs).toEqual([{ count: 7 }]);
  });

  it('respects having in count + data', async () => {
    const result = await repo.aggregatePaginate<{ role: string; count: number }>({
      groupBy: 'role',
      measures: { count: { op: 'count' } },
      having: gt('count', 1),
      sort: { role: 1 },
      page: 1,
      limit: 10,
    });

    // Only roles 'a' and 'b' have count > 1.
    expect(result.total).toBe(2);
    expect(result.docs.map((d) => d.role)).toEqual(['a', 'b']);
  });
});
