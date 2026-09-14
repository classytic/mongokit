/**
 * `countDistinctStrategy: 'grouped'` must return exactly what `'accumulator'`
 * returns — and stop accumulating while it does.
 *
 * The default collects every distinct value of a group in that group's
 * accumulator and takes the size, so memory grows with the DATA rather than
 * with the answer, and MongoDB caps a group accumulator at 100MB. `'grouped'`
 * pre-groups by the value so each distinct value becomes a row instead.
 *
 * These tests assert the two strategies AGREE rather than asserting expected
 * numbers, because the way this change goes wrong is that the new path is
 * internally consistent and quietly different. Two semantics had to be matched
 * exactly, and both were measured against `$addToSet` rather than reasoned
 * about — a missing field is not a distinct value, an explicit `null` is, and a
 * naive `$group` gets both wrong.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  g: string;
  f?: unknown;
  amount: number;
}

let Model: mongoose.Model<IRow>;
let repo: Repository<IRow>;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'DistinctStrategyRow',
    new mongoose.Schema<IRow>(
      {
        g: { type: String, required: true },
        f: { type: mongoose.Schema.Types.Mixed },
        amount: { type: Number, required: true },
      },
      { strict: false },
    ),
  );
  repo = new Repository<IRow>(Model);

  /**
   * Deliberately adversarial. A fixture of well-behaved strings would make
   * every difference between the two strategies unreachable, which is how the
   * missing-vs-null divergence would have shipped.
   */
  const rows: IRow[] = [
    // repeats, so distinct < count
    { g: 'a', f: 'x', amount: 10 },
    { g: 'a', f: 'x', amount: 20 },
    { g: 'a', f: 'y', amount: 30 },
    // explicit null IS a distinct value
    { g: 'a', f: null, amount: 40 },
    // missing is NOT — and still contributes to sum/min/max
    { g: 'a', amount: 50 },
    // mixed types must not collapse
    { g: 'b', f: 1, amount: 1 },
    { g: 'b', f: '1', amount: 2 },
    { g: 'b', f: true, amount: 3 },
    // a group whose field is ALWAYS missing → 0 distinct, not 1
    { g: 'c', amount: 7 },
    { g: 'c', amount: 8 },
    // a group with exactly one distinct value
    { g: 'd', f: 'solo', amount: 5 },
  ];
  // Plus volume, so the grouped path is exercised at more than toy size.
  for (let i = 0; i < 400; i++) {
    rows.push({ g: 'bulk', f: `u${i % 137}`, amount: i });
  }
  await Model.insertMany(rows);
}, 120_000);

afterAll(async () => {
  await disconnectDB();
});

type Row = Record<string, unknown>;

/** Run one request under both strategies and return both row sets, sorted. */
async function bothStrategies(req: Record<string, unknown>): Promise<[Row[], Row[]]> {
  const run = async (strategy: 'accumulator' | 'grouped') => {
    const res = (await repo.aggregatePaginate({
      ...req,
      countDistinctStrategy: strategy,
      limit: 200,
    })) as { data: Row[] };
    return [...res.data].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  };
  return [await run('accumulator'), await run('grouped')];
}

describe('the two strategies agree', () => {
  it('on a plain grouped countDistinct', async () => {
    const [acc, grp] = await bothStrategies({
      groupBy: ['g'],
      measures: { users: { op: 'countDistinct', field: 'f' } },
    });

    expect(grp).toEqual(acc);
    // And the fixture actually exercises the interesting cases.
    const byGroup = Object.fromEntries(acc.map((r) => [r.g, r.users]));
    expect(byGroup.a).toBe(3); // x, y, null — missing excluded
    expect(byGroup.b).toBe(3); // 1, '1', true — types distinct
    expect(byGroup.c).toBe(0); // always missing
    expect(byGroup.bulk).toBe(137);
  });

  it('alongside re-aggregatable measures', async () => {
    const [acc, grp] = await bothStrategies({
      groupBy: ['g'],
      measures: {
        users: { op: 'countDistinct', field: 'f' },
        rows: { op: 'count' },
        total: { op: 'sum', field: 'amount' },
        smallest: { op: 'min', field: 'amount' },
        largest: { op: 'max', field: 'amount' },
      },
    });

    expect(grp).toEqual(acc);
    // Splitting the group by distinct value must not change the sums.
    const a = acc.find((r) => r.g === 'a') as Row;
    expect(a.rows).toBe(5);
    expect(a.total).toBe(150);
    expect(a.largest).toBe(50); // the row whose field is MISSING still counts
  });

  it('with a `where`-filtered distinct count', async () => {
    const [acc, grp] = await bothStrategies({
      groupBy: ['g'],
      measures: {
        // Filter IR — `{ op, field, value }`. Query syntax (`{ f: { ne: 'x' } }`)
        // is a different surface and is refused here; see the case below.
        notX: { op: 'countDistinct', field: 'f', where: { op: 'ne', field: 'f', value: 'x' } },
        total: { op: 'sum', field: 'amount' },
      },
    });

    expect(grp).toEqual(acc);

    // `where` bites on the COUNT and leaves the other measures alone.
    const a = acc.find((r) => r.g === 'a') as Row;
    expect(a.notX).toBe(1); // x excluded; `ne` also excludes null (SQL parity)
    expect(a.total).toBe(150); // every row still sums, filtered or not
  });

  it('a `where` written in QUERY syntax is refused, not silently ignored', async () => {
    /**
     * `{ f: { ne: 'x' } }` is what `AggRequest.filter` accepts, so reaching for
     * it here is the obvious mistake. As an aggregation expression a plain
     * object is TRUTHY, so it used to match every row: the filtered aggregate
     * came back equal to the unfiltered one, with nothing raised. Measured
     * before the fix — all=3, where ne:x=3, where eq:x=3.
     */
    await expect(
      repo.aggregatePaginate({
        groupBy: ['g'],
        measures: { n: { op: 'countDistinct', field: 'f', where: { f: { ne: 'x' } } } },
        limit: 10,
      }),
    ).rejects.toThrow(/always TRUE|must be Filter IR/i);
  });

  it('with no groupBy at all (scalar aggregation)', async () => {
    const [acc, grp] = await bothStrategies({
      measures: { users: { op: 'countDistinct', field: 'f' }, rows: { op: 'count' } },
    });

    expect(grp).toEqual(acc);
    expect(acc).toHaveLength(1);
  });

  it('with a compound groupBy', async () => {
    const [acc, grp] = await bothStrategies({
      groupBy: ['g', 'f'],
      measures: { n: { op: 'countDistinct', field: 'f' }, total: { op: 'sum', field: 'amount' } },
    });

    expect(grp).toEqual(acc);
  });

  it('with a prefilter', async () => {
    const [acc, grp] = await bothStrategies({
      filter: { g: { in: ['a', 'b'] } },
      groupBy: ['g'],
      measures: { users: { op: 'countDistinct', field: 'f' } },
    });

    expect(grp).toEqual(acc);
    expect(acc).toHaveLength(2);
  });
});

describe('it refuses what it cannot recombine, instead of answering wrongly', () => {
  const attempt = (measures: Record<string, unknown>) =>
    repo.aggregatePaginate({
      groupBy: ['g'],
      measures,
      countDistinctStrategy: 'grouped',
      limit: 10,
    });

  it.each([
    ['avg', { op: 'avg', field: 'amount' }],
    ['percentile', { op: 'percentile', field: 'amount', p: 0.5 }],
  ])('refuses to combine with %s', async (_label, measure) => {
    // The mean of means is not the mean. Refusing is the only honest answer
    // once the group has been split by the distinct value.
    await expect(
      attempt({ users: { op: 'countDistinct', field: 'f' }, bad: measure }),
    ).rejects.toThrow(/cannot combine with/i);
  });

  it('refuses a second countDistinct', async () => {
    await expect(
      attempt({
        a: { op: 'countDistinct', field: 'f' },
        b: { op: 'countDistinct', field: 'g' },
      }),
    ).rejects.toThrow(/one countDistinct per request/i);
  });

  it('names the alternative rather than just saying no', async () => {
    await expect(
      attempt({ users: { op: 'countDistinct', field: 'f' }, m: { op: 'avg', field: 'amount' } }),
    ).rejects.toThrow(/accumulator/);
  });
});

describe('the default is unchanged', () => {
  it('omitting the option behaves exactly as accumulator', async () => {
    const plain = (await repo.aggregatePaginate({
      groupBy: ['g'],
      measures: { users: { op: 'countDistinct', field: 'f' } },
      limit: 200,
    })) as { data: Row[] };
    const explicit = (await repo.aggregatePaginate({
      groupBy: ['g'],
      measures: { users: { op: 'countDistinct', field: 'f' } },
      countDistinctStrategy: 'accumulator',
      limit: 200,
    })) as { data: Row[] };

    // Sorted before comparing: an aggregation with no `sort` makes no ordering
    // promise, so comparing the raw arrays tests the server's mood.
    const byKey = (rows: Row[]) =>
      [...rows].sort((a, b) => String(a.g).localeCompare(String(b.g)));
    expect(byKey(plain.data)).toEqual(byKey(explicit.data));
  });

  it('accumulator still accepts the measures grouped refuses', async () => {
    const res = (await repo.aggregatePaginate({
      groupBy: ['g'],
      measures: {
        users: { op: 'countDistinct', field: 'f' },
        mean: { op: 'avg', field: 'amount' },
      },
      limit: 200,
    })) as { data: Row[] };

    expect(res.data.length).toBeGreaterThan(0);
  });
});
