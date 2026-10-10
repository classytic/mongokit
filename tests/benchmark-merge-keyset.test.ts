/**
 * Benchmark (not in the default suite): a merged list over two 100k-row collections.
 * mergeKeysetPages (two indexed keyset reads per page) vs the offset alternative, which must read
 * skip+limit rows from EACH source to merge correctly at depth. Median of 5, page 50.
 * Run: copy into tests/integration/ and run with --silent=false (the default suite skips benchmark-*).
 */

import { mergeKeysetPages } from '@classytic/repo-core/pagination';
import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keysetSource, Repository } from '../src/index.js';
import { connectDB, getMongoUri } from './setup.js';

interface IDoc {
  at: Date;
}
const N = 100_000;
const LIMIT = 50;
const sort = { at: -1 as const, _id: -1 as const };

describe('merged list at depth: mergeKeysetPages vs offset', () => {
  let conn: Connection;
  let A: Model<IDoc>;
  let B: Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri()).asPromise();
    const schema = () => {
      const s = new Schema<IDoc>({ at: Date });
      s.index({ at: -1, _id: -1 });
      return s;
    };
    A = conn.model<IDoc>('BenchMergeA', schema());
    B = conn.model<IDoc>('BenchMergeB', schema());
    for (const M of [A, B]) {
      await M.deleteMany({});
      await M.syncIndexes();
      for (let i = 0; i < N; i += 20_000) {
        await M.insertMany(
          Array.from({ length: 20_000 }, (_, j) => ({ at: new Date(1_700_000_000_000 + (i + j) * 1000 + (M === B ? 500 : 0)) })),
          { lean: true },
        );
      }
    }
  }, 900_000);
  afterAll(async () => {
    await A.deleteMany({});
    await B.deleteMany({});
    await conn.close();
  });

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  async function time(fn: () => Promise<unknown>): Promise<number> {
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await fn();
      runs.push(performance.now() - t);
    }
    return median(runs);
  }

  it('reports latency by merged depth', async () => {
    const sources = [keysetSource(new Repository<IDoc>(A), { name: 'a', sort }), keysetSource(new Repository<IDoc>(B), { name: 'b', sort })];
    const rows: string[] = [];
    for (const depth of [0, 10_000, 100_000]) {
      // Walk to the depth once to obtain the cursor (not timed).
      let cursor: string | undefined;
      for (let d = 0; d < depth; ) {
        const page = await mergeKeysetPages(sources, { sort, limit: 1000, ...(cursor ? { cursor } : {}) });
        d += page.docs.length;
        cursor = page.next ?? undefined;
      }
      const keysetMs = await time(() => mergeKeysetPages(sources, { sort, limit: LIMIT, ...(cursor ? { cursor } : {}) }));
      // Correct offset merge at depth d: read the top d+limit of EACH source, merge, slice.
      const offsetMs = await time(async () => {
        const [a, b] = await Promise.all([
          A.find().sort(sort).limit(depth + LIMIT).lean(),
          B.find().sort(sort).limit(depth + LIMIT).lean(),
        ]);
        return [...a, ...b].sort((x, y) => y.at.getTime() - x.at.getTime()).slice(depth, depth + LIMIT);
      });
      rows.push(`depth ${depth}: mergeKeysetPages ${keysetMs.toFixed(1)} ms | offset merge ${offsetMs.toFixed(1)} ms`);
    }
    // eslint-disable-next-line no-console
    console.log(`\n[bench] 2 x ${N} rows, page ${LIMIT}\n${rows.join('\n')}`);
    expect(rows).toHaveLength(3);
  }, 900_000);
});
