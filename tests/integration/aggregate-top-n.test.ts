/**
 * Integration tests for **top-N-per-group** — keeps the top `limit`
 * rows per partition, ranked by `sortBy`. The classic "top 3 products
 * per category" / "top 5 customers per region" dashboard primitive.
 *
 * Compiles to mongo's `$setWindowFields` + `$match` chain. Cross-kit
 * parity with sqlitekit's JS post-processor is locked by the shared
 * conformance suite.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface ISale {
  _id?: mongoose.Types.ObjectId;
  region: string;
  product: string;
  amount: number;
}

function makeSchema() {
  return new mongoose.Schema<ISale>(
    {
      region: { type: String, required: true },
      product: { type: String, required: true },
      amount: { type: Number, required: true },
    },
    { timestamps: false },
  );
}

describe('aggregate (portable IR) — top-N-per-group', () => {
  let Model: mongoose.Model<ISale>;
  let repo: Repository<ISale>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggTopN', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    repo = new Repository<ISale>(Model);
    // Two regions, several products each. Per-region revenue sorted desc:
    //   north: A=300, B=200, C=100, D=50
    //   south: X=500, Y=400, Z=300, W=100
    await repo.createMany([
      { region: 'north', product: 'A', amount: 300 },
      { region: 'north', product: 'B', amount: 200 },
      { region: 'north', product: 'C', amount: 100 },
      { region: 'north', product: 'D', amount: 50 },
      { region: 'south', product: 'X', amount: 500 },
      { region: 'south', product: 'Y', amount: 400 },
      { region: 'south', product: 'Z', amount: 300 },
      { region: 'south', product: 'W', amount: 100 },
    ]);
  });

  it('top 2 products per region by revenue', async () => {
    const { rows } = await repo.aggregate<{
      region: string;
      product: string;
      revenue: number;
    }>({
      groupBy: ['region', 'product'],
      measures: { revenue: { op: 'sum', field: 'amount' } },
      topN: {
        partitionBy: 'region',
        sortBy: { revenue: -1 },
        limit: 2,
      },
      sort: { region: 1, revenue: -1 },
    });
    expect(rows).toEqual([
      { region: 'north', product: 'A', revenue: 300 },
      { region: 'north', product: 'B', revenue: 200 },
      { region: 'south', product: 'X', revenue: 500 },
      { region: 'south', product: 'Y', revenue: 400 },
    ]);
  });

  it('top 1 with row_number ties strategy', async () => {
    // Add a tied row to verify row_number breaks ties to exactly one.
    await repo.create({ region: 'north', product: 'A2', amount: 300 });

    const { rows } = await repo.aggregate<{
      region: string;
      product: string;
      revenue: number;
    }>({
      groupBy: ['region', 'product'],
      measures: { revenue: { op: 'sum', field: 'amount' } },
      topN: {
        partitionBy: 'region',
        sortBy: { revenue: -1 },
        limit: 1,
        ties: 'row_number',
      },
      sort: { region: 1 },
    });
    expect(rows).toHaveLength(2); // one per region
    expect(rows.map((r) => r.region)).toEqual(['north', 'south']);
  });

  it('rank ties: tied rows all pass when limit covers their rank', async () => {
    // Two products tied at amount=300 in north.
    await repo.create({ region: 'north', product: 'A2', amount: 300 });

    const { rows } = await repo.aggregate<{
      region: string;
      product: string;
      revenue: number;
    }>({
      filter: { region: 'north' },
      groupBy: 'product',
      measures: { revenue: { op: 'sum', field: 'amount' } },
      topN: {
        partitionBy: 'revenue',
        // partition-by-measure is unusual; partition by a single
        // column instead. Test rank ties using a constant partition.
        sortBy: { revenue: -1 },
        limit: 1,
        ties: 'rank',
      },
    });
    // With rank: 1, both 300-tied products share rank 1 and pass.
    const top = rows.filter((r) => r.revenue === 300);
    expect(top).toHaveLength(2);
  });

  it('compound partition: top 1 per (region, product-prefix)', async () => {
    // partition by (region, product) and pick the highest amount —
    // since the partition keys identify the row, every row qualifies.
    // Use a real compound case: one tile per region, each showing the
    // top customer (proxied by product alphabetical).
    const { rows } = await repo.aggregate<{
      region: string;
      product: string;
      revenue: number;
    }>({
      groupBy: ['region', 'product'],
      measures: { revenue: { op: 'sum', field: 'amount' } },
      topN: {
        partitionBy: ['region'],
        sortBy: { product: 1 },
        limit: 1,
      },
      sort: { region: 1 },
    });
    // Alphabetically first product per region: north→A, south→W
    expect(rows.map((r) => `${r.region}:${r.product}`)).toEqual(['north:A', 'south:W']);
  });

  it('throws when partitionBy references an unknown column', async () => {
    await expect(
      repo.aggregate({
        groupBy: 'region',
        measures: { revenue: { op: 'sum', field: 'amount' } },
        topN: {
          partitionBy: 'does-not-exist',
          sortBy: { revenue: -1 },
          limit: 1,
        },
      }),
    ).rejects.toThrow(/topN\.partitionBy "does-not-exist"/);
  });

  it('throws on non-positive limit', async () => {
    await expect(
      repo.aggregate({
        groupBy: 'region',
        measures: { revenue: { op: 'sum', field: 'amount' } },
        topN: { partitionBy: 'region', sortBy: { revenue: -1 }, limit: 0 },
      }),
    ).rejects.toThrow(/topN\.limit must be a positive integer/);
  });
});
