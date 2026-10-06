/**
 * One filter language across every `where` surface.
 *
 * `AggRequest.filter`, `having` and `lookup.where` compile through
 * `compileFilterToMongo`, which expands query shorthand — so
 * `{ status: { ne: 'void' } }` works. A measure's `where` compiles through
 * `compileFilterToMongoExpr`, which did not, so the same expression written the
 * same way in the same request object behaved differently depending on which
 * field it sat in. Before that was noticed it was worse than inconsistent: a
 * plain object is TRUTHY as an aggregation condition, so the filter silently
 * matched every row and the filtered aggregate equalled the unfiltered one.
 *
 * The property these tests pin is PARITY, not any particular number: a
 * `where` and an equivalent top-level `filter` must select the same rows. That
 * catches a translation that is merely plausible, which a hand-written
 * expectation would not.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  g: string;
  status?: string;
  qty?: number;
  sku?: string;
}

let Model: mongoose.Model<IRow>;
let repo: Repository<IRow>;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'WhereParityRow',
    new mongoose.Schema<IRow>(
      {
        g: { type: String, required: true },
        status: { type: String },
        qty: { type: Number },
        sku: { type: String },
      },
      { strict: false },
    ),
  );
  repo = new Repository<IRow>(Model);
  await Model.insertMany([
    { g: 'a', status: 'paid', qty: 5, sku: 'AB-1' },
    { g: 'a', status: 'paid', qty: 15, sku: 'AB-2' },
    { g: 'a', status: 'void', qty: 25, sku: 'XY-1' },
    { g: 'a', qty: 35 }, // status missing
    { g: 'b', status: 'paid', qty: 45, sku: 'AB-3' },
    { g: 'b', status: 'draft', qty: 55, sku: 'XY-2' },
  ]);
}, 120_000);

afterAll(async () => {
  await disconnectDB();
});

/**
 * Count rows two ways: once by filtering the whole request, once by filtering
 * only the measure. Same predicate, same language — the answers must match.
 */
async function bothWays(predicate: Record<string, unknown>): Promise<[number, number]> {
  const viaFilter = (await repo.aggregatePaginate({
    filter: predicate,
    measures: { n: { op: 'count' } },
    limit: 10,
  })) as { data: { n: number }[] };

  const viaWhere = (await repo.aggregatePaginate({
    measures: { n: { op: 'count', where: predicate } },
    limit: 10,
  })) as { data: { n: number }[] };

  return [viaFilter.data[0]?.n ?? 0, viaWhere.data[0]?.n ?? 0];
}

describe('a predicate selects the same rows in `filter` and in `where`', () => {
  it.each([
    ['equality shorthand', { status: { eq: 'paid' } }],
    ['bare equality', { status: 'paid' }],
    ['inequality', { status: { ne: 'void' } }],
    ['range', { qty: { gte: 15, lte: 45 } }],
    ['greater than', { qty: { gt: 25 } }],
    ['membership', { status: { in: ['paid', 'draft'] } }],
    ['exclusion', { status: { nin: ['void'] } }],
    ['existence', { sku: { exists: true } }],
    ['absence', { sku: { exists: false } }],
    ['regex', { sku: { regex: '^AB' } }],
    ['dollar-prefixed operators', { qty: { $gte: 15, $lte: 45 } }],
    ['two fields conjoined', { status: 'paid', qty: { gt: 10 } }],
    ['explicit $and', { $and: [{ g: 'a' }, { qty: { gt: 10 } }] }],
    ['explicit $or', { $or: [{ status: 'void' }, { status: 'draft' }] }],
  ])('%s', async (_label, predicate) => {
    const [viaFilter, viaWhere] = await bothWays(predicate);

    expect(viaWhere).toBe(viaFilter);
    // And the predicate actually discriminates — a translation that matched
    // everything would otherwise pass every case above.
    expect(viaFilter).toBeGreaterThan(0);
    expect(viaFilter).toBeLessThan(6);
  });
});

describe('a `where` that cannot be expressed is refused, never widened', () => {
  const attempt = (where: unknown) =>
    repo.aggregatePaginate({ measures: { n: { op: 'count', where } }, limit: 10 });

  it('refuses `mod` — a shorthand with no expression form', async () => {
    await expect(attempt({ qty: { mod: [2, 0] } })).rejects.toThrow(/could not express/i);
  });

  it('refuses an operator it does not translate', async () => {
    await expect(attempt({ sku: { $text: 'AB' } })).rejects.toThrow(/could not express/i);
  });

  it('refuses a known operator sitting beside an unknown one', async () => {
    // The dangerous shape: translating the half it recognises and dropping the
    // rest would return a plausible, wrong count.
    await expect(attempt({ qty: { gte: 10, mod: [2, 0] } })).rejects.toThrow(/could not express/i);
  });

  it('names the accepted languages rather than just refusing', async () => {
    await expect(attempt({ qty: { mod: [2, 0] } })).rejects.toThrow(/Filter IR|query syntax/i);
  });
});

describe('the other accepted forms still work', () => {
  it('Filter IR', async () => {
    const res = (await repo.aggregatePaginate({
      measures: { n: { op: 'count', where: { op: 'eq', field: 'status', value: 'paid' } } },
      limit: 10,
    })) as { data: { n: number }[] };
    expect(res.data[0].n).toBe(3);
  });

  it('a raw aggregation expression', async () => {
    const res = (await repo.aggregatePaginate({
      measures: { n: { op: 'count', where: { $eq: ['$status', 'paid'] } } },
      limit: 10,
    })) as { data: { n: number }[] };
    expect(res.data[0].n).toBe(3);
  });

  it('a nested document is an equality match, not an operator object', async () => {
    // `{ address: { city: 'Dhaka' } }` must not be read as operators.
    const res = (await repo.aggregatePaginate({
      measures: { n: { op: 'count', where: { g: { eq: 'a' } } } },
      limit: 10,
    })) as { data: { n: number }[] };
    expect(res.data[0].n).toBe(4);
  });
});
