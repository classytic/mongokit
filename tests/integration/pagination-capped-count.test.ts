/**
 * `countStrategy: 'capped'` — a bounded row count for collections that have
 * outgrown an exact one.
 *
 * The two strategies that existed before this were both wrong at scale in
 * opposite directions: `exact` walks every matching index key on EVERY page,
 * and `none` gives a list header nothing to show. `capped` stops the scan at a
 * ceiling and reports the ceiling as a FLOOR.
 *
 * What these tests actually pin, in order of what would hurt most if it broke:
 *
 *  1. the ceiling is honoured (otherwise it is `exact` wearing a new name);
 *  2. `totalIsLowerBound` is set at the ceiling and ABSENT below it — a
 *     consumer that cannot tell a bound from a total renders `10,000+` over an
 *     exact 10,000 forever;
 *  3. `hasNext` stays correct PAST the ceiling, which is the one a naive
 *     implementation gets wrong: derived from `page < pages` it reports "no
 *     more results" in the middle of a collection;
 *  4. a page's `data` is unchanged by the strategy — counting is not allowed to
 *     alter what is returned.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import {
  configurePaginationDefaults,
  resetPaginationDefaults,
} from '../../src/pagination/defaults.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  n: number;
  group: string;
}

const TOTAL = 500;
const IN_GROUP_A = 250;

let Model: mongoose.Model<IRow>;
let repo: Repository<IRow>;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'CappedCountRow',
    new mongoose.Schema<IRow>({
      n: { type: Number, required: true },
      group: { type: String, required: true, index: true },
    }),
  );
  repo = new Repository<IRow>(Model);
});

afterAll(async () => {
  resetPaginationDefaults();
  await disconnectDB();
});

beforeEach(async () => {
  resetPaginationDefaults();
  await Model.deleteMany({});
  await Model.insertMany(
    Array.from({ length: TOTAL }, (_, i) => ({ n: i, group: i < IN_GROUP_A ? 'a' : 'b' })),
  );
});

describe('the ceiling is real', () => {
  it('stops counting at countLimit instead of walking every matching row', async () => {
    const page = await repo.getAll({ page: 1, limit: 10, countStrategy: 'capped', countLimit: 50 });

    expect(page.total).toBe(50);
    expect(page.data).toHaveLength(10);
  });

  it('counts EXACTLY when the collection sits below the ceiling', async () => {
    // The strategy must be free to leave on for a small collection — otherwise
    // nobody turns it on until it is already too late to measure the change.
    const page = await repo.getAll({
      page: 1,
      limit: 10,
      countStrategy: 'capped',
      countLimit: 10_000,
    });

    expect(page.total).toBe(TOTAL);
  });

  it('counts the FILTERED set, not the collection', async () => {
    const page = await repo.getAll({
      filters: { group: 'a' },
      page: 1,
      limit: 10,
      countStrategy: 'capped',
      countLimit: 10_000,
    });

    expect(page.total).toBe(IN_GROUP_A);
  });
});

describe('a capped total says that it is a floor', () => {
  it('flags totalIsLowerBound when the count hit the ceiling', async () => {
    const page = await repo.getAll({ page: 1, limit: 10, countStrategy: 'capped', countLimit: 50 });

    expect(page.totalIsLowerBound).toBe(true);
  });

  it('does NOT flag it when the count finished under the ceiling', async () => {
    const page = await repo.getAll({
      page: 1,
      limit: 10,
      countStrategy: 'capped',
      countLimit: 10_000,
    });

    // Absent, not `false` — the field is omitted on an ordinary page so every
    // existing consumer of the envelope sees exactly what it saw before.
    expect(page.totalIsLowerBound).toBeUndefined();
  });

  it('never flags it for the other strategies', async () => {
    for (const countStrategy of ['exact', 'estimated', 'none'] as const) {
      const page = await repo.getAll({ page: 1, limit: 10, countStrategy });
      expect(page.totalIsLowerBound).toBeUndefined();
    }
  });
});

describe('hasNext survives past the ceiling', () => {
  it('reports a further page even when total is pinned at the cap', async () => {
    // The trap: `pages` here is ceil(50/10) = 5, so a `page < pages` derivation
    // says there is nothing after page 5 — while 450 rows are still unread.
    const atTheCap = await repo.getAll({
      page: 5,
      limit: 10,
      countStrategy: 'capped',
      countLimit: 50,
    });

    expect(atTheCap.total).toBe(50);
    expect(atTheCap.pages).toBe(5);
    expect(atTheCap.hasNext).toBe(true);
  });

  it('reports the true end of the collection', async () => {
    const lastPage = await repo.getAll({
      page: TOTAL / 10,
      limit: 10,
      countStrategy: 'capped',
      countLimit: 50,
    });

    expect(lastPage.data).toHaveLength(10);
    expect(lastPage.hasNext).toBe(false);
  });

  it('does not leak the limit+1 peek into the returned page', async () => {
    const page = await repo.getAll({ page: 1, limit: 10, countStrategy: 'capped', countLimit: 50 });

    // The extra document is fetched to answer hasNext and must be trimmed —
    // an off-by-one here shows the user a row that belongs to the next page.
    expect(page.data).toHaveLength(10);
    expect(page.limit).toBe(10);
  });
});

describe('counting does not change what is returned', () => {
  it('returns the same documents as an exact count would', async () => {
    const sort = { n: 1 as const };
    const exact = await repo.getAll({ page: 3, limit: 10, sort, countStrategy: 'exact' });
    const capped = await repo.getAll({
      page: 3,
      limit: 10,
      sort,
      countStrategy: 'capped',
      countLimit: 50,
    });

    expect(capped.data.map((d) => d.n)).toEqual(exact.data.map((d) => d.n));
  });
});

describe('the ceiling refuses a value that cannot mean what it says', () => {
  it.each([0, -1, 1.5, Number.NaN])(
    'falls back to the library ceiling for countLimit=%p',
    async (countLimit) => {
      // Every one of these reaches `.limit()` as "no limit" somewhere in the
      // driver stack, so honouring them would produce the UNBOUNDED scan the
      // strategy exists to prevent — while looking like it had been configured.
      const page = await repo.getAll({ page: 1, limit: 10, countStrategy: 'capped', countLimit });

      expect(page.total).toBe(TOTAL);
      expect(page.totalIsLowerBound).toBeUndefined();
    },
  );
});

describe('the deployment policy reaches a repository that was never configured', () => {
  it('applies configurePaginationDefaults to a repo built before the call', async () => {
    // The whole point of the policy seam: in a kernel-composed app nobody
    // constructs the repositories, so a host can only reach them globally.
    const built = new Repository<IRow>(Model);
    configurePaginationDefaults({ defaultCountStrategy: 'capped', defaultCountLimit: 50 });

    const page = await built.getAll({ page: 1, limit: 10 });

    expect(page.total).toBe(50);
    expect(page.totalIsLowerBound).toBe(true);
  });

  it('lets an explicit per-call strategy override the policy', async () => {
    configurePaginationDefaults({ defaultCountStrategy: 'capped', defaultCountLimit: 50 });

    const page = await repo.getAll({ page: 1, limit: 10, countStrategy: 'exact' });

    expect(page.total).toBe(TOTAL);
    expect(page.totalIsLowerBound).toBeUndefined();
  });
});
