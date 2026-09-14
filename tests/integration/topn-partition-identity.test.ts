/**
 * A compound `topN` partition must identify a TUPLE, not a string built from
 * one.
 *
 * The identity was `$toString` per value joined with U+0001, with null mapped
 * to the literal `'__NULL__'`. Both halves throw information away, and the loss
 * merges partitions that are not the same — so `topN` returned rows that were
 * not the top N of anything, ranked against neighbours from another partition.
 * Nothing errored; the numbers simply came back wrong.
 *
 * Every case below is a value a real dataset can hold: a string containing a
 * control character (pasted from a binary export), the literal text
 * `'__NULL__'` (a CSV import's null placeholder), a number beside a string, a
 * missing field. Fixtures that use only well-behaved values make this bug
 * unreachable, which is exactly why it survived.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

/** The separator the old implementation joined with. */
const SEP = String.fromCharCode(1);

interface IRow {
  _id?: mongoose.Types.ObjectId;
  a?: string | number | null;
  b?: string | number | null;
  v: number;
}

let Model: mongoose.Model<IRow>;
let repo: Repository<IRow>;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'TopNPartitionRow',
    new mongoose.Schema<IRow>(
      {
        a: { type: mongoose.Schema.Types.Mixed },
        b: { type: mongoose.Schema.Types.Mixed },
        v: { type: Number, required: true },
      },
      { strict: false },
    ),
  );
  repo = new Repository<IRow>(Model);
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

/**
 * Take the top row of every `(a, b)` partition and report how many partitions
 * the engine believed there were.
 */
async function topPerPartition(): Promise<number> {
  const res = (await repo.aggregatePaginate({
    groupBy: ['a', 'b'],
    measures: { total: { op: 'sum', field: 'v' } },
    topN: { partitionBy: ['a', 'b'], sortBy: { total: -1 }, limit: 1 },
    limit: 100,
  })) as { data: unknown[] };
  return res.data.length;
}

describe('a value containing the old separator does not merge partitions', () => {
  it('keeps ("xy<SEP>z", "q") apart from ("xy", "z<SEP>q")', async () => {
    // Both joined to the identical key "xy<SEP>z<SEP>q" and ranked as one
    // partition of four rows.
    await Model.insertMany([
      { a: `xy${SEP}z`, b: 'q', v: 1 },
      { a: `xy${SEP}z`, b: 'q', v: 2 },
      { a: 'xy', b: `z${SEP}q`, v: 3 },
      { a: 'xy', b: `z${SEP}q`, v: 4 },
    ]);

    expect(await topPerPartition()).toBe(2);
  });
});

describe('a real "__NULL__" string is not the same tuple as a null', () => {
  it('keeps ("__NULL__", "r") apart from (null, "r") and from a missing field', async () => {
    await Model.insertMany([
      { a: '__NULL__', b: 'r', v: 1 },
      { a: null, b: 'r', v: 2 },
      { b: 'r', v: 3 },
    ]);

    // A missing field and an explicit null partition TOGETHER — that is SQL's
    // `PARTITION BY` behaviour and what `$ifNull` preserves. The literal
    // string is its own partition.
    expect(await topPerPartition()).toBe(2);
  });
});

describe('mixed types are distinct tuples', () => {
  it('does not merge the number 1 with the string "1"', async () => {
    // `$toString` collapsed these; a document expression compares by BSON
    // value, which keeps the types apart.
    await Model.insertMany([
      { a: 1, b: 'x', v: 1 },
      { a: '1', b: 'x', v: 2 },
    ]);

    expect(await topPerPartition()).toBe(2);
  });
});

describe('ordinary partitions still work', () => {
  it('ranks within each partition independently', async () => {
    await Model.insertMany([
      { a: 'p', b: 'q', v: 10 },
      { a: 'p', b: 'q', v: 30 },
      { a: 'p', b: 'r', v: 20 },
      { a: 'p', b: 'r', v: 5 },
    ]);

    const res = (await repo.aggregatePaginate({
      groupBy: ['a', 'b'],
      measures: { total: { op: 'sum', field: 'v' } },
      topN: { partitionBy: ['a', 'b'], sortBy: { total: -1 }, limit: 1 },
      limit: 100,
    })) as { data: { b: string; total: number }[] };

    expect(res.data).toHaveLength(2);
    // Each partition contributes its own winner, not a cross-partition one.
    expect([...res.data].sort((x, y) => x.b.localeCompare(y.b)).map((r) => r.total)).toEqual([
      40, 25,
    ]);
  });

  it('a single-key partition is unaffected', async () => {
    await Model.insertMany([
      { a: 'p', b: 'q', v: 10 },
      { a: 'p', b: 'r', v: 30 },
      { a: 'z', b: 'q', v: 20 },
    ]);

    const res = (await repo.aggregatePaginate({
      groupBy: ['a', 'b'],
      measures: { total: { op: 'sum', field: 'v' } },
      topN: { partitionBy: 'a', sortBy: { total: -1 }, limit: 1 },
      limit: 100,
    })) as { data: unknown[] };

    expect(res.data).toHaveLength(2);
  });
});
