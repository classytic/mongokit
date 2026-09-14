/**
 * `aggregatePaginate` returns page + count as two pipelines, not one `$facet`.
 *
 * `$facet` puts every returned document AND the count inside one output
 * document, and no aggregation stage may exceed 16MB — so a page of large
 * documents failed outright with `BSONObjectTooLarge`. The regression test is
 * therefore a page that WOULD have breached 16MB: 40 documents of ~600KB each
 * is ~24MB, comfortably past the limit and impossible to serve under `$facet`.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IFat {
  _id?: mongoose.Types.ObjectId;
  n: number;
  group: string;
  blob: string;
}

let Model: mongoose.Model<IFat>;
let repo: Repository<IFat>;

const DOCS = 60;
const BLOB = 'x'.repeat(600_000); // ~600KB per document

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IFat>(
    'FacetSplitFat',
    new mongoose.Schema<IFat>({
      n: { type: Number, required: true },
      group: { type: String, required: true },
      blob: { type: String, required: true },
    }),
  );
  repo = new Repository<IFat>(Model);
}, 120_000);

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await Model.deleteMany({});
  await Model.insertMany(
    Array.from({ length: DOCS }, (_, i) => ({ n: i, group: ['a', 'b'][i % 2], blob: BLOB })),
  );
}, 120_000);

describe('a page larger than 16MB is servable', () => {
  it('returns 40 x ~600KB documents (~24MB) with an exact total', async () => {
    const res = await repo.aggregatePipelinePaginate({
      pipeline: [{ $sort: { n: 1 } }],
      page: 1,
      limit: 40,
    });

    // Under `$facet` this threw BSONObjectTooLarge before returning anything.
    expect(res.data).toHaveLength(40);
    expect(res.total).toBe(DOCS);
    expect(res.pages).toBe(2);
    expect(res.hasNext).toBe(true);
    expect((res.data[0] as IFat).blob.length).toBe(BLOB.length);
  }, 120_000);

  it('paginates to the second page correctly', async () => {
    const res = await repo.aggregatePipelinePaginate({
      pipeline: [{ $sort: { n: 1 } }],
      page: 2,
      limit: 40,
    });

    expect(res.data).toHaveLength(20);
    expect(res.hasNext).toBe(false);
    expect(res.hasPrev).toBe(true);
  }, 120_000);
});

describe('the split preserves every count strategy', () => {
  it('exact still counts the filtered pipeline output', async () => {
    const res = await repo.aggregatePipelinePaginate({
      pipeline: [{ $match: { group: 'a' } }],
      page: 1,
      limit: 5,
      countStrategy: 'exact',
    });

    expect(res.total).toBe(DOCS / 2);
  }, 120_000);

  it("none runs a single pipeline and reports total 0 with a working hasNext", async () => {
    const res = await repo.aggregatePipelinePaginate({
      pipeline: [{ $sort: { n: 1 } }],
      page: 1,
      limit: 5,
      countStrategy: 'none',
    });

    expect(res.total).toBe(0);
    expect(res.pages).toBe(0);
    expect(res.data).toHaveLength(5);
    expect(res.hasNext).toBe(true);
  }, 120_000);

  it('capped bounds the count and flags it as a floor', async () => {
    const res = await repo.aggregatePipelinePaginate({
      pipeline: [{ $sort: { n: 1 } }],
      page: 1,
      limit: 5,
      countStrategy: 'capped',
      countLimit: 20,
    });

    expect(res.total).toBe(20);
    expect((res as { totalIsLowerBound?: boolean }).totalIsLowerBound).toBe(true);
    expect(res.hasNext).toBe(true);
  }, 120_000);

  it('an empty result reports zero rather than crashing on the absent $count row', async () => {
    // `$count` emits NO document when nothing matches — reading `[0].count`
    // off an empty array is the shape that would throw.
    const res = await repo.aggregatePipelinePaginate({
      pipeline: [{ $match: { group: 'nonexistent' } }],
      page: 1,
      limit: 5,
    });

    expect(res.data).toHaveLength(0);
    expect(res.total).toBe(0);
    expect(res.hasNext).toBe(false);
  }, 120_000);
});
