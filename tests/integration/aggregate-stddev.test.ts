/**
 * Integration tests for `stddev` / `stddevPop` measures. Mongokit
 * uses native `$stdDevSamp` / `$stdDevPop` (numerically-stable
 * Welford). Cross-kit asymmetric — sqlitekit throws by design.
 */

import { eq } from '@classytic/repo-core/filter';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface ISample {
  _id?: mongoose.Types.ObjectId;
  group: string;
  value: number;
}

function makeSchema() {
  return new mongoose.Schema<ISample>(
    {
      group: { type: String, required: true },
      value: { type: Number, required: true },
    },
    { timestamps: false },
  );
}

describe('aggregate (portable IR) — stddev / stddevPop', () => {
  let Model: mongoose.Model<ISample>;
  let repo: Repository<ISample>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggStddev', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<ISample>(Model);
  });

  it('sample stddev (default) matches numpy.std(ddof=1) over [2, 4, 4, 4, 5, 5, 7, 9]', async () => {
    // Classic Wikipedia example. Sample stddev = 2.138...
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    await repo.createMany(values.map((v) => ({ group: 'a', value: v })));

    const { rows } = await repo.aggregate<{ s: number }>({
      measures: { s: { op: 'stddev', field: 'value' } },
    });
    expect(rows[0]?.s).toBeCloseTo(2.138, 2);
  });

  it('population stddev matches numpy.std(ddof=0) over [2, 4, 4, 4, 5, 5, 7, 9]', async () => {
    // Population stddev = 2.0 exactly.
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    await repo.createMany(values.map((v) => ({ group: 'a', value: v })));

    const { rows } = await repo.aggregate<{ s: number }>({
      measures: { s: { op: 'stddevPop', field: 'value' } },
    });
    expect(rows[0]?.s).toBeCloseTo(2.0, 6);
  });

  it('groupBy: stddev per group', async () => {
    await repo.createMany([
      { group: 'a', value: 1 },
      { group: 'a', value: 2 },
      { group: 'a', value: 3 },
      { group: 'b', value: 10 },
      { group: 'b', value: 20 },
      { group: 'b', value: 30 },
    ]);
    const { rows } = await repo.aggregate<{ group: string; s: number }>({
      groupBy: 'group',
      measures: { s: { op: 'stddev', field: 'value' } },
      sort: { group: 1 },
    });
    expect(rows[0]?.s).toBeCloseTo(1.0, 6); // sample stddev of [1,2,3]
    expect(rows[1]?.s).toBeCloseTo(10.0, 6); // sample stddev of [10,20,30]
  });

  it('filtered stddev: ignores non-matching rows', async () => {
    await repo.createMany([
      { group: 'a', value: 1 },
      { group: 'a', value: 2 },
      { group: 'a', value: 3 },
      { group: 'a', value: 999 }, // outlier — excluded by where
    ]);
    const { rows } = await repo.aggregate<{ s: number }>({
      measures: {
        s: { op: 'stddev', field: 'value', where: eq('group', 'a') },
      },
      filter: { value: { $lt: 100 } }, // excludes the 999 outlier from the input
    });
    expect(rows[0]?.s).toBeCloseTo(1.0, 6);
  });

  it('single value: stddev is 0 (or null) — no variance', async () => {
    await repo.create({ group: 'a', value: 42 });
    const { rows } = await repo.aggregate<{ s: number | null }>({
      measures: {
        sample: { op: 'stddev', field: 'value' },
        pop: { op: 'stddevPop', field: 'value' },
      },
    });
    // Sample stddev with n=1: undefined (divide by 0). Mongo returns null.
    // Population stddev with n=1: 0.
    const row = rows[0] as { sample: number | null; pop: number };
    expect(row.sample).toBeNull();
    expect(row.pop).toBe(0);
  });
});
