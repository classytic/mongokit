/**
 * `aggregatePipelinePaginate` offset pages: a pipeline whose sort is not provably total (no
 * unique key left in the sort for the rows it pages) warns ONCE per call site; `sortIsTotal: true`
 * states totality and silences it. A total sort over tied keys and `_id`-less rows pages with no
 * repeat and no skip.
 */

import { type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureLogger, Repository } from '../../src/index.js';
import { connectDB, createTestModel } from '../setup.js';

interface IEntry {
  date: Date;
  lines: { n: number }[];
}

describe('aggregate offset page: total sort', () => {
  let Entry: Model<IEntry>;
  let repo: Repository<IEntry>;
  const warnings: string[] = [];
  const day = new Date(Date.UTC(2026, 0, 1));
  // Rows WITHOUT _id (unwound + projected away); every row ties on `date`; (entry, n) is unique.
  const rowsPipeline = (sort: Record<string, 1 | -1>) => [
    { $unwind: '$lines' },
    { $project: { _id: 0, date: 1, entry: '$_id', n: '$lines.n' } },
    { $sort: sort },
  ];

  beforeAll(async () => {
    await connectDB();
    Entry = await createTestModel(
      'TotalSortEntry',
      new Schema<IEntry>({ date: Date, lines: [{ n: Number }] }),
    );
    await Entry.deleteMany({});
    await Entry.insertMany(
      Array.from({ length: 6 }, () => ({ date: day, lines: [{ n: 1 }, { n: 2 }, { n: 3 }] })),
    );
    repo = new Repository<IEntry>(Entry);
    configureLogger({ warn: (m: string) => warnings.push(m) });
  });
  afterAll(async () => {
    configureLogger({ warn: console.warn.bind(console) });
    await Entry.deleteMany({});
  });
  beforeEach(() => {
    warnings.length = 0;
  });

  const page = (sort: Record<string, 1 | -1>, n: number, sortIsTotal?: boolean) =>
    repo.aggregatePipelinePaginate({
      pipeline: rowsPipeline(sort),
      page: n,
      limit: 5,
      ...(sortIsTotal ? { sortIsTotal } : {}),
    });

  it('a tie-prone sort over _id-less rows warns, once per call site', async () => {
    await page({ date: 1 }, 1);
    await page({ date: 1 }, 2);
    await page({ date: 1 }, 3);
    const hits = warnings.filter((w) => w.includes('not provably total'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('TotalSortEntry');
    expect(hits[0]).toContain('sortIsTotal');
  });

  it('a sort whose _id the pipeline unwound away is not total either', async () => {
    await page({ date: 1, _id: 1 }, 1);
    expect(warnings.some((w) => w.includes('not provably total'))).toBe(true);
  });

  it('a total sort over tied keys pages with no repeat and no skip; declared, it does not warn', async () => {
    const seen: string[] = [];
    for (let n = 1; n <= 4; n++) {
      const r = await page({ date: 1, entry: 1, n: 1 }, n, true);
      // Projected rows are not IEntry: read them as plain JSON.
      const rows: Array<{ entry: string; n: number }> = JSON.parse(JSON.stringify(r.data));
      seen.push(...rows.map((d) => `${d.entry}:${d.n}`));
    }
    expect(seen).toHaveLength(18);
    expect(new Set(seen).size).toBe(18);
    expect(warnings.filter((w) => w.includes('not provably total'))).toHaveLength(0);
  });

  it('a plain document page sorted with _id needs no declaration', async () => {
    await repo.aggregatePipelinePaginate({
      pipeline: [{ $sort: { date: 1, _id: 1 } }],
      page: 1,
      limit: 5,
    });
    expect(warnings.filter((w) => w.includes('not provably total'))).toHaveLength(0);
  });

  it('a page with no sort at all warns', async () => {
    await repo.aggregatePipelinePaginate({ pipeline: [{ $match: {} }], page: 1, limit: 5 });
    expect(warnings.some((w) => w.includes('not provably total'))).toBe(true);
  });
});
