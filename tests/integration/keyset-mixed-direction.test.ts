/**
 * Keyset pagination must visit every document EXACTLY ONCE, under the shapes
 * that used to go wrong silently:
 *
 *  - a mixed-direction sort (`{ group: 1, n: -1 }`), previously rejected;
 *  - a caller filter carrying its own `$or`, previously dropped from page 2 on;
 *  - a caller `_id: { $in }` filter while paging by `_id`, same failure;
 *  - a nullable secondary sort field, previously ended early at the null.
 *
 * The invariant is asserted as a SET EQUALITY over the whole walk, because
 * every one of these bugs produced pages that looked fine on their own.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  n: number;
  group: string;
  tag: string;
  rank: number | null;
}

let Model: mongoose.Model<IRow>;
let repo: Repository<IRow>;

const TOTAL = 240;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'KeysetMixedRow',
    new mongoose.Schema<IRow>({
      n: { type: Number, required: true },
      group: { type: String, required: true },
      tag: { type: String, required: true },
      rank: { type: Number, default: null },
    }),
  );
  repo = new Repository<IRow>(Model);
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await Model.deleteMany({});
  await Model.insertMany(
    Array.from({ length: TOTAL }, (_, i) => ({
      n: i,
      group: ['a', 'b', 'c'][i % 3],
      tag: ['x', 'y', 'z'][i % 3 === 0 ? 0 : i % 2 === 0 ? 1 : 2],
      // Duplicates AND nulls on purpose: ties exercise the `_id` tiebreak,
      // nulls exercise the boundary.
      rank: i % 7 === 0 ? null : Math.floor(i / 10),
    })),
  );
});

/** Walk every page; return every `n` seen, in order. */
async function walk(
  opts: { filters?: Record<string, unknown>; sort: Record<string, 1 | -1>; limit: number },
  maxPages = 1000,
): Promise<number[]> {
  const seen: number[] = [];
  let after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await repo.getAll({ ...opts, after, mode: 'keyset' });
    if (page.method !== 'keyset') throw new Error('expected keyset envelope');
    seen.push(...page.data.map((d) => d.n));
    if (!page.hasMore || !page.next) return seen;
    after = page.next;
  }
  throw new Error('walk did not terminate');
}

const expectExactlyOnce = (seen: number[], expected: number[]) => {
  expect(new Set(seen).size).toBe(seen.length); // no duplicates
  expect([...seen].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
};

describe('mixed-direction keyset walks the whole collection once', () => {
  it('{ group: 1, n: -1 } — asc then desc', async () => {
    const seen = await walk({ sort: { group: 1, n: -1 }, limit: 17 });

    expectExactlyOnce(
      seen,
      Array.from({ length: TOTAL }, (_, i) => i),
    );
    // And in the order the sort promised: groups ascending, n descending within.
    const docs = await Model.find({}).sort({ group: 1, n: -1, _id: 1 }).lean();
    expect(seen).toEqual(docs.map((d) => d.n));
  });

  it('{ n: 1, _id: -1 } — the tiebreaker direction differs from the primary', async () => {
    const seen = await walk({ sort: { n: 1, _id: -1 }, limit: 23 });
    expectExactlyOnce(
      seen,
      Array.from({ length: TOTAL }, (_, i) => i),
    );
  });
});

describe("the caller's filter holds on EVERY page, not just the first", () => {
  it("a caller $or is not replaced by the position's $or", async () => {
    const filters = { $or: [{ tag: 'x' }, { tag: 'y' }] };
    const expected = (await Model.find(filters).lean()).map((d) => d.n);

    const seen = await walk({ filters, sort: { n: 1 }, limit: 11 });

    expectExactlyOnce(seen, expected);
    expect(seen.length).toBeLessThan(TOTAL); // the filter actually excluded something
  });

  it('a caller _id: { $in } is not replaced when paging by _id', async () => {
    const wanted = (await Model.find({ group: 'b' }).lean()).map((d) => d._id);
    const filters = { _id: { $in: wanted } };

    const seen = await walk({ filters, sort: { _id: 1 }, limit: 13 });

    expect(seen.length).toBe(wanted.length);
    expect(new Set(seen).size).toBe(wanted.length);
  });
});

describe('a nullable secondary sort field does not end the walk early', () => {
  it.each([
    [{ group: 1, rank: 1 }],
    [{ group: 1, rank: -1 }],
    [{ group: -1, rank: 1 }],
  ] as const)('sort %j', async (sort) => {
    const seen = await walk({ sort: { ...sort }, limit: 19 });
    expectExactlyOnce(
      seen,
      Array.from({ length: TOTAL }, (_, i) => i),
    );
  });
});
