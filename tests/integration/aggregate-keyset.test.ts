/**
 * Integration tests for keyset (cursor) pagination on the portable
 * `aggregatePaginate(req)` IR.
 *
 * Keyset pagination scales to arbitrary group counts because each
 * page's filter is a row-tuple comparison against the prior page's
 * last row, never a `$skip N` over rejected rows. These tests pin
 * the contract: cursors round-trip, pages don't overlap or miss,
 * `hasMore` flips correctly at the tail, and ascending vs
 * descending sort directions resolve to the right comparison op.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('aggregatePaginate (portable IR) — keyset pagination', () => {
  let Model: mongoose.Model<IUser>;
  let repo: Repository<IUser>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggKeyset', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IUser>(Model);
    // 5 distinct roles → 5 grouped rows for keyset to walk through.
    await repo.createMany([
      { name: 'a1', role: 'alpha', age: 10 },
      { name: 'a2', role: 'alpha', age: 11 },
      { name: 'b1', role: 'beta', age: 20 },
      { name: 'c1', role: 'gamma', age: 30 },
      { name: 'd1', role: 'delta', age: 40 },
      { name: 'e1', role: 'epsilon', age: 50 },
    ]);
  });

  it('walks all rows page-by-page using returned cursor', async () => {
    type Row = { role: string; n: number };
    const seen: Row[] = [];
    let cursor: string | null = null;

    for (let i = 0; i < 10; i++) {
      const result = await repo.aggregatePaginate<Row>({
        groupBy: 'role',
        measures: { n: { op: 'count' } },
        sort: { role: 1 },
        pagination: 'keyset',
        limit: 2,
        ...(cursor ? { after: cursor } : {}),
      });
      expect(result.method).toBe('keyset');
      if (result.method !== 'keyset') throw new Error('expected keyset envelope');
      seen.push(...result.data);
      cursor = result.next;
      if (!result.hasMore) break;
    }
    // 5 distinct roles → walked all 5
    expect(seen.map((r) => r.role)).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
  });

  it('respects descending sort direction in the cursor predicate', async () => {
    type Row = { role: string; n: number };
    const first = await repo.aggregatePaginate<Row>({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: -1 },
      pagination: 'keyset',
      limit: 2,
    });
    expect(first.method).toBe('keyset');
    if (first.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(first.data.map((r) => r.role)).toEqual(['gamma', 'epsilon']);
    expect(first.hasMore).toBe(true);

    const second = await repo.aggregatePaginate<Row>({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: -1 },
      pagination: 'keyset',
      limit: 2,
      after: first.next ?? '',
    });
    if (second.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(second.data.map((r) => r.role)).toEqual(['delta', 'beta']);
  });

  it('hasMore is false on the final page; next is null', async () => {
    const result = await repo.aggregatePaginate<{ role: string; n: number }>({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: 1 },
      pagination: 'keyset',
      limit: 100, // larger than the 5 distinct roles
    });
    if (result.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(result.data).toHaveLength(5);
    expect(result.hasMore).toBe(false);
    expect(result.next).toBeNull();
  });

  it('paginates by measure alias (sum descending)', async () => {
    type Row = { role: string; total: number };
    const first = await repo.aggregatePaginate<Row>({
      groupBy: 'role',
      measures: { total: { op: 'sum', field: 'age' } },
      sort: { total: -1 },
      pagination: 'keyset',
      limit: 2,
    });
    if (first.method !== 'keyset') throw new Error('expected keyset envelope');
    // Highest sum first: epsilon(50), delta(40), gamma(30), alpha(21), beta(20)
    expect(first.data.map((r) => r.role)).toEqual(['epsilon', 'delta']);

    const second = await repo.aggregatePaginate<Row>({
      groupBy: 'role',
      measures: { total: { op: 'sum', field: 'age' } },
      sort: { total: -1 },
      pagination: 'keyset',
      limit: 2,
      after: first.next ?? '',
    });
    if (second.method !== 'keyset') throw new Error('expected keyset envelope');
    expect(second.data.map((r) => r.role)).toEqual(['gamma', 'alpha']);
  });

  it('throws when keyset mode is requested without sort', async () => {
    await expect(
      repo.aggregatePaginate({
        groupBy: 'role',
        measures: { n: { op: 'count' } },
        pagination: 'keyset',
        limit: 2,
      }),
    ).rejects.toThrow(/keyset pagination requires `sort`/);
  });

  it('rejects malformed cursor', async () => {
    await expect(
      repo.aggregatePaginate({
        groupBy: 'role',
        measures: { n: { op: 'count' } },
        sort: { role: 1 },
        pagination: 'keyset',
        after: 'not-a-base64-cursor!@#',
      }),
    ).rejects.toThrow(/malformed keyset cursor/);
  });

  it('passing `after` implies keyset mode without explicit `pagination`', async () => {
    // Run a first page in offset mode so we don't have a cursor; then
    // craft one and pass it through `after`. The presence of `after`
    // alone should switch the response shape to keyset.
    const seedCursor = Buffer.from(JSON.stringify({ role: 'beta' }), 'utf8').toString('base64url');
    const result = await repo.aggregatePaginate<{ role: string; n: number }>({
      groupBy: 'role',
      measures: { n: { op: 'count' } },
      sort: { role: 1 },
      after: seedCursor,
      limit: 10,
    });
    expect(result.method).toBe('keyset');
    if (result.method !== 'keyset') throw new Error('expected keyset envelope');
    // Roles strictly > 'beta' alphabetically: delta, epsilon, gamma
    expect(result.data.map((r) => r.role)).toEqual(['delta', 'epsilon', 'gamma']);
  });
});
