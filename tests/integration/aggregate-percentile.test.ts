/**
 * Integration tests for percentile measure (`$percentile`).
 * Compiles to Mongo 7+'s `$percentile` accumulator with
 * `method: 'approximate'` — fast, low-memory, accurate enough for
 * dashboard P50/P95/P99 visualisations.
 *
 * Output is unwrapped from the array form `[value]` to a scalar via
 * post-group `$arrayElemAt`, matching SQL's scalar-percentile shape.
 */

import { gte } from '@classytic/repo-core/filter';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRequest {
  _id?: mongoose.Types.ObjectId;
  endpoint: string;
  durationMs: number;
}

function makeSchema() {
  return new mongoose.Schema<IRequest>(
    {
      endpoint: { type: String, required: true },
      durationMs: { type: Number, required: true },
    },
    { timestamps: false },
  );
}

describe('aggregate (portable IR) — percentile', () => {
  let Model: mongoose.Model<IRequest>;
  let repo: Repository<IRequest>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggPercentile', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<IRequest>(Model);
    // Latency samples: 100 evenly-distributed durations 1..100ms
    // for endpoint `/api`. P50 ≈ 50, P95 ≈ 95.
    const docs: IRequest[] = [];
    for (let i = 1; i <= 100; i++) {
      docs.push({ endpoint: '/api', durationMs: i });
    }
    await repo.createMany(docs);
  });

  it('p50 ~= median, p95 ~= 95th percentile', async () => {
    const { rows } = await repo.aggregate<{
      endpoint: string;
      p50: number;
      p95: number;
      p99: number;
    }>({
      groupBy: 'endpoint',
      measures: {
        p50: { op: 'percentile', field: 'durationMs', p: 0.5 },
        p95: { op: 'percentile', field: 'durationMs', p: 0.95 },
        p99: { op: 'percentile', field: 'durationMs', p: 0.99 },
      },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.endpoint).toBe('/api');
    // Approximate percentile — allow ±2ms tolerance for the t-digest
    // implementation Mongo uses.
    expect(row.p50).toBeGreaterThanOrEqual(48);
    expect(row.p50).toBeLessThanOrEqual(52);
    expect(row.p95).toBeGreaterThanOrEqual(93);
    expect(row.p95).toBeLessThanOrEqual(97);
    expect(row.p99).toBeGreaterThanOrEqual(97);
    expect(row.p99).toBeLessThanOrEqual(100);
  });

  it('scalar percentile (no groupBy)', async () => {
    const { rows } = await repo.aggregate<{ p90: number }>({
      measures: {
        p90: { op: 'percentile', field: 'durationMs', p: 0.9 },
      },
    });
    expect(rows[0]?.p90).toBeGreaterThanOrEqual(88);
    expect(rows[0]?.p90).toBeLessThanOrEqual(92);
  });

  it('filtered percentile: p95 only over slow requests', async () => {
    // Add some fast samples that should be excluded by the where clause.
    await repo.createMany([
      { endpoint: '/api', durationMs: 5 },
      { endpoint: '/api', durationMs: 10 },
    ]);

    const { rows } = await repo.aggregate<{ slowP95: number }>({
      measures: {
        slowP95: {
          op: 'percentile',
          field: 'durationMs',
          p: 0.95,
          where: gte('durationMs', 50),
        },
      },
    });
    // Only durations 50..100 contribute; p95 of that range ≈ 97.5
    expect(rows[0]?.slowP95).toBeGreaterThanOrEqual(95);
    expect(rows[0]?.slowP95).toBeLessThanOrEqual(100);
  });

  it('throws on out-of-range p', async () => {
    await expect(
      repo.aggregate({
        measures: {
          bad: { op: 'percentile', field: 'durationMs', p: 1.5 },
        },
      }),
    ).rejects.toThrow(/percentile.*p in \[0, 1\]/);
  });
});
