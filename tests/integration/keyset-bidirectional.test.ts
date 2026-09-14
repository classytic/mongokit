/**
 * Bidirectional keyset — `before` walks backwards.
 *
 * The property that matters is SYMMETRY: paging forward to page N and then
 * back again must land on the page you came from, with the rows in the order
 * you asked for (not reversed) and no row gained, lost or repeated at the
 * seam. Every bug in a backward walk shows up there — an off-by-one in the
 * limit+1 trim, a forgotten reverse, a cursor minted under the inverted sort.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  n: number;
  group: string;
}

let Model: mongoose.Model<IRow>;
let repo: Repository<IRow>;

const TOTAL = 100;
const LIMIT = 10;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'KeysetBidiRow',
    new mongoose.Schema<IRow>({
      n: { type: Number, required: true },
      group: { type: String, required: true },
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
    Array.from({ length: TOTAL }, (_, i) => ({ n: i, group: ['a', 'b'][i % 2] })),
  );
});

type Page = {
  method: string;
  data: IRow[];
  hasMore: boolean;
  next: string | null;
  prev?: string | null;
  hasPrev?: boolean;
};

const page = async (opts: Record<string, unknown>): Promise<Page> => {
  const r = (await repo.getAll({
    sort: { n: 1 },
    limit: LIMIT,
    mode: 'keyset',
    ...opts,
  })) as unknown as Page;
  if (r.method !== 'keyset') throw new Error('expected a keyset envelope');
  return r;
};

const ns = (p: Page) => p.data.map((d) => d.n);

describe('walking forward then back lands where it started', () => {
  it('page 1 → 2 → 3 → back → back returns exactly pages 2 and 1', async () => {
    const p1 = await page({});
    const p2 = await page({ after: p1.next });
    const p3 = await page({ after: p2.next });

    expect(ns(p1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ns(p2)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(ns(p3)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);

    const back2 = await page({ before: p3.prev });
    expect(ns(back2)).toEqual(ns(p2));

    const back1 = await page({ before: back2.prev });
    expect(ns(back1)).toEqual(ns(p1));
  });

  it('rows come back in the REQUESTED order, not the order they were walked', async () => {
    const p1 = await page({});
    const p2 = await page({ after: p1.next });
    const back = await page({ before: p2.prev });

    // Ascending, as asked — a missing `.reverse()` would hand back 9..0.
    expect(ns(back)).toEqual([...ns(back)].sort((a, b) => a - b));
  });

  it('holds for a descending sort too', async () => {
    const p1 = await page({ sort: { n: -1 } });
    const p2 = await page({ sort: { n: -1 }, after: p1.next });
    const back = await page({ sort: { n: -1 }, before: p2.prev });

    expect(ns(p1)).toEqual([99, 98, 97, 96, 95, 94, 93, 92, 91, 90]);
    expect(ns(back)).toEqual(ns(p1));
  });

  it('holds for a MIXED-direction compound sort', async () => {
    const sort = { group: 1, n: -1 } as const;
    const p1 = await page({ sort });
    const p2 = await page({ sort, after: p1.next });
    const back = await page({ sort, before: p2.prev });

    expect(ns(back)).toEqual(ns(p1));
  });
});

describe('the edges report themselves honestly', () => {
  it('the first page has no previous', async () => {
    const p1 = await page({});
    expect(p1.hasPrev).toBe(false);
    expect(p1.prev).toBeNull();
    expect(p1.hasMore).toBe(true);
  });

  it('a page reached by `after` knows a previous page exists', async () => {
    const p2 = await page({ after: (await page({})).next });
    expect(p2.hasPrev).toBe(true);
    expect(p2.prev).not.toBeNull();
  });

  it('the last page has no next', async () => {
    let p = await page({});
    for (let i = 0; i < 20 && p.hasMore; i++) p = await page({ after: p.next });

    expect(ns(p)).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
    expect(p.hasMore).toBe(false);
    expect(p.next).toBeNull();
  });

  it('walking back to the very start reports no previous', async () => {
    const p1 = await page({});
    const p2 = await page({ after: p1.next });
    const back = await page({ before: p2.prev });

    expect(ns(back)).toEqual(ns(p1));
    expect(back.hasPrev).toBe(false);
    // We got here from page 2, so a next page certainly exists.
    expect(back.hasMore).toBe(true);
  });
});

describe('a backward walk respects the caller filter and covers the set', () => {
  it('walking all the way forward then all the way back sees every row once', async () => {
    const forward: number[] = [];
    let p = await page({});
    forward.push(...ns(p));
    while (p.hasMore) {
      p = await page({ after: p.next });
      forward.push(...ns(p));
    }
    expect(forward).toHaveLength(TOTAL);

    const backward: number[] = [];
    while (p.hasPrev) {
      p = await page({ before: p.prev });
      backward.unshift(...ns(p));
    }
    // Everything except the final page, which we never paged away from.
    expect(backward).toEqual(forward.slice(0, TOTAL - LIMIT));
  });

  it('keeps a filter that carries its own $or', async () => {
    const filters = { $or: [{ group: 'a' }, { n: { $lt: 5 } }] };
    const p1 = await page({ filters });
    const p2 = await page({ filters, after: p1.next });
    const back = await page({ filters, before: p2.prev });

    expect(ns(back)).toEqual(ns(p1));
    for (const n of [...ns(p1), ...ns(p2)]) {
      expect(n % 2 === 0 || n < 5).toBe(true);
    }
  });
});

describe('two anchors is a caller error, not a guess', () => {
  it('rejects after and before together', async () => {
    const p1 = await page({});
    await expect(
      repo.getAll({ sort: { n: 1 }, mode: 'keyset', after: p1.next, before: p1.next }),
    ).rejects.toThrow(/not both/i);
  });
});
