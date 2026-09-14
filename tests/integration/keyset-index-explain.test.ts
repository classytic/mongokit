/**
 * The keyset index-adequacy check, judged by the query planner rather than by
 * assertion.
 *
 * `hasCompatibleKeysetIndex` decides whether to warn a developer that their
 * index cannot serve a keyset sort. It used to strip the `_id` tiebreaker
 * before deciding, on the stated grounds that an index covering the primary
 * sort field "is still efficient in practice — the planner uses the index for
 * ordering and only pays an in-memory tiebreak on duplicate primary values".
 *
 * That is false. `$sort` is satisfied by an index or it is not; there is no
 * partial credit for getting the leading field right. The test below proves it
 * the only way worth proving it — by asking MongoDB.
 *
 * This is the "cross-check with a tool that measures differently" rule: the
 * unit test asserts what the function returns, and this asserts what the
 * database does with the index that function blessed. A unit test alone would
 * have kept passing for the entire life of the bug.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasCompatibleKeysetIndex } from '../../src/pagination/utils/index-hint.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  tenantId: string;
  createdAt: Date;
  n: number;
}

const ROWS = 20_000;
const DISTINCT_TIMESTAMPS = 10; // → 2000 rows share each value
const SORT = { createdAt: -1 as const, _id: -1 as const };
const FILTER = { tenantId: 't1' };

let Model: mongoose.Model<IRow>;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'KeysetExplainRow',
    new mongoose.Schema<IRow>({
      tenantId: { type: String, required: true },
      createdAt: { type: Date, required: true },
      n: { type: Number, required: true },
    }),
  );

  const base = new Date('2024-01-01').getTime();
  await Model.insertMany(
    Array.from({ length: ROWS }, (_, i) => ({
      tenantId: 't1',
      // Heavy ties are the whole point: with distinct values the tiebreaker
      // never has to break anything and the bug is unreachable.
      createdAt: new Date(base + Math.floor(i / (ROWS / DISTINCT_TIMESTAMPS)) * 1000),
      n: i,
    })),
  );
}, 180_000);

afterAll(async () => {
  await disconnectDB();
});

/** Swap to exactly one index and report what the planner did with it. */
async function planWith(index: Record<string, 1 | -1>) {
  await Model.collection.dropIndexes().catch(() => {});
  await Model.collection.createIndex(index);
  const explained = (await Model.find(FILTER)
    .sort(SORT)
    .limit(20)
    .explain('executionStats')) as unknown as {
    executionStats: { totalDocsExamined: number; nReturned: number; executionStages: unknown };
  };
  const stats = explained.executionStats;
  return {
    blockingSort: JSON.stringify(stats.executionStages).includes('"stage":"SORT"'),
    examined: stats.totalDocsExamined,
    returned: stats.nReturned,
  };
}

describe('an index that stops before the tiebreaker cannot serve the sort', () => {
  it('produces a BLOCKING SORT scanning the whole matching range', async () => {
    const plan = await planWith({ tenantId: 1, createdAt: -1 });

    expect(plan.blockingSort).toBe(true);
    // Every matching row, to return one page of twenty — and again next page.
    expect(plan.examined).toBe(ROWS);
    expect(plan.returned).toBe(20);
  }, 180_000);

  it('is REPORTED as inadequate, so the developer is told', async () => {
    // The check and the planner must agree. They did not before: this index
    // was blessed while producing the plan above.
    expect(hasCompatibleKeysetIndex([[{ tenantId: 1, createdAt: -1 }]], ['tenantId'], SORT)).toBe(
      false,
    );
  });
});

describe('an index covering the whole sort serves it from the index', () => {
  it('has no blocking sort and examines only the page it returns', async () => {
    const plan = await planWith({ tenantId: 1, createdAt: -1, _id: -1 });

    expect(plan.blockingSort).toBe(false);
    expect(plan.examined).toBe(20);
    expect(plan.returned).toBe(20);
  }, 180_000);

  it('is REPORTED as adequate', () => {
    expect(
      hasCompatibleKeysetIndex([[{ tenantId: 1, createdAt: -1, _id: -1 }]], ['tenantId'], SORT),
    ).toBe(true);
  });
});

describe('the gap between the two is the reason the check matters', () => {
  it('the inadequate index examines 1000x the documents of the adequate one', async () => {
    const bad = await planWith({ tenantId: 1, createdAt: -1 });
    const good = await planWith({ tenantId: 1, createdAt: -1, _id: -1 });

    // Stated as a ratio so the test survives a change in ROWS, and so the
    // number in the docblock has something keeping it honest.
    expect(bad.examined / good.examined).toBeGreaterThan(100);
  }, 180_000);
});
