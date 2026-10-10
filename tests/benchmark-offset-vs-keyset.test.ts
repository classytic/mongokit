/**
 * Benchmark (not in the default suite): deep offset vs keyset on a 200k-row fixture.
 * Prints the median ms of a page at increasing depth, plus docs/keys examined from explain.
 * Run: npx vitest run tests/benchmark-offset-vs-keyset.test.ts --project integration --exclude ''
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configurePaginationDefaults, Repository, resetPaginationDefaults } from '../src/index.js';
import { encodeCursor } from '../src/pagination/utils/cursor.js';
import { cursorScope } from '../src/pagination/utils/guards.js';
import { connectDB, getMongoUri } from './setup.js';

interface IDoc {
  status: string;
  at: Date;
}

const N = 200_000;
const LIMIT = 50;

describe('offset vs keyset at 200k rows', () => {
  let conn: Connection;
  let Doc: Model<IDoc>;
  let repo: Repository<IDoc>;

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri()).asPromise();
    const schema = new Schema<IDoc>({ status: String, at: Date });
    schema.index({ status: 1, at: -1, _id: -1 });
    Doc = conn.model<IDoc>('BenchOffsetKeysetDoc', schema);
    await Doc.deleteMany({});
    await Doc.syncIndexes();
    for (let i = 0; i < N; i += 20_000) {
      await Doc.insertMany(
        Array.from({ length: 20_000 }, (_, j) => ({ status: 'open', at: new Date(1_700_000_000_000 + (i + j) * 1000) })),
        { lean: true },
      );
    }
    configurePaginationDefaults({ maxOffset: N, maxPage: N });
    repo = new Repository<IDoc>(Doc);
  }, 600_000);
  afterAll(async () => {
    resetPaginationDefaults();
    await Doc.deleteMany({});
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

  it('reports offset and keyset page latency by depth', async () => {
    const rows: string[] = [];
    for (const depth of [0, 10_000, 100_000, 190_000]) {
      const page = depth / LIMIT + 1;
      const offsetMs = await time(() =>
        repo.getAll({ filters: { status: 'open' }, sort: { at: -1 }, page, limit: LIMIT, countStrategy: 'none' }),
      );
      // The keyset cursor for the same depth: minted at the row just before it.
      const [anchor] = await Doc.find({ status: 'open' }).sort({ at: -1, _id: -1 }).skip(Math.max(0, depth - 1)).limit(1).lean();
      const after =
        depth > 0 && anchor
          ? encodeCursor(anchor, 'at', { at: -1, _id: -1 }, 1, cursorScope(Doc.collection.collectionName, { status: 'open' }, undefined))
          : undefined;
      const keysetMs = await time(() =>
        repo.getAll({ filters: { status: 'open' }, sort: { at: -1 }, limit: LIMIT, mode: 'keyset', ...(after ? { after } : {}) }),
      );
      // Plain JSON, read field by field: the explain document has no static type.
      const explained = JSON.parse(
        JSON.stringify(await Doc.find({ status: 'open' }).sort({ at: -1, _id: -1 }).skip(depth).limit(LIMIT).explain('executionStats')),
      );
      rows.push(
        `depth ${depth}: offset ${offsetMs.toFixed(1)} ms (keys examined ${explained.executionStats.totalKeysExamined}) | keyset ${keysetMs.toFixed(1)} ms`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\n[bench] ${N} rows, page ${LIMIT}\n${rows.join('\n')}`);
    expect(rows).toHaveLength(4);
  }, 600_000);
});
