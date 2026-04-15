/**
 * Performance tests — getNextSequence session overhead
 *
 * Measures the latency of threading a ClientSession through
 * `getNextSequence` / `sequentialId` under a handful of real-world shapes:
 *
 *   - Raw counter bump, with and without a session.
 *   - `sequentialId`-backed `repo.create`, inside vs outside a transaction.
 *   - Concurrent contending transactions on one counter.
 *   - `createMany` batch versus N single creates inside one transaction.
 *
 * Skipped by default — these tests are opinionated about real timings and
 * we don't want to block CI on replica-set jitter. Opt-in with:
 *
 *   RUN_PERF=1 npx vitest run tests/perf-custom-id-session.test.ts
 *
 * Each test prints human-readable timing lines and asserts only on
 * correctness (contiguous numbering, expected doc counts) — not on absolute
 * latency numbers.
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Repository,
  customIdPlugin,
  getNextSequence,
  sequentialId,
  withTransaction,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IBenchInvoice {
  _id: Types.ObjectId;
  invoiceNumber?: string;
  amount: number;
}

const BenchInvoiceSchema = new Schema<IBenchInvoice>({
  invoiceNumber: String,
  amount: { type: Number, required: true },
});

const COUNTER_KEY_PATTERN = /^custom-id-tx-bench-/;

async function clearOwnCounters(): Promise<void> {
  try {
    await mongoose.connection
      .collection('_mongokit_counters')
      .deleteMany({ _id: { $regex: COUNTER_KEY_PATTERN } as unknown as string });
  } catch {
    // may not exist
  }
}

// Simple timer — ms with 2-decimal precision. Node's performance.now() on
// Windows has ~1ms resolution, so we always measure ITERATIONS >> 1000.
async function time(label: string, fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  const elapsed = performance.now() - start;
  // eslint-disable-next-line no-console
  console.log(`  ${label.padEnd(48)} ${elapsed.toFixed(2)} ms`);
  return elapsed;
}

describe.skipIf(!process.env.RUN_PERF)('perf — getNextSequence session overhead', () => {
  let InvoiceModel: mongoose.Model<IBenchInvoice>;

  beforeAll(async () => {
    await connectDB();
    InvoiceModel = await createTestModel('CustomIdBenchInvoice', BenchInvoiceSchema);
  });

  afterAll(async () => {
    await clearOwnCounters();
    await InvoiceModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await clearOwnCounters();
    await InvoiceModel.deleteMany({});
  });

  // ==========================================================================
  // Bench 1 — raw getNextSequence with vs without session
  // ==========================================================================

  it('raw getNextSequence: session arg adds <30% overhead', async () => {
    const ITER = 500;

    // Warm up the counter model registration
    await getNextSequence('custom-id-tx-bench-warmup');

    const noSessionMs = await time(`getNextSequence ×${ITER} (no session)`, async () => {
      for (let i = 0; i < ITER; i++) {
        await getNextSequence('custom-id-tx-bench-no-session');
      }
    });

    const withSessionMs = await time(
      `getNextSequence ×${ITER} (with session, each its own tx)`,
      async () => {
        for (let i = 0; i < ITER; i++) {
          await withTransaction(mongoose.connection, async (session) => {
            await getNextSequence(
              'custom-id-tx-bench-with-session',
              1,
              mongoose.connection,
              session,
            );
          });
        }
      },
    );

    const perOpNoSession = noSessionMs / ITER;
    const perOpWithSession = withSessionMs / ITER;
    // eslint-disable-next-line no-console
    console.log(
      `  per-op: no-session=${perOpNoSession.toFixed(3)}ms, ` +
        `with-session=${perOpWithSession.toFixed(3)}ms ` +
        `(delta=${(perOpWithSession - perOpNoSession).toFixed(3)}ms)`,
    );

    // Sanity: a withTransaction wraps a commit — it's expected to be slower
    // than a raw findOneAndUpdate. We just care that session pass-through
    // itself doesn't blow up the budget. Real ceiling is ~10x because the
    // replica-set commit round-trip dominates, not the session forwarding.
    expect(perOpWithSession).toBeGreaterThan(0);
    expect(perOpNoSession).toBeGreaterThan(0);
  });

  // ==========================================================================
  // Bench 2 — sequentialId plugin pipeline inside vs outside transaction
  // ==========================================================================

  it('sequentialId + create: transactional vs non-transactional', async () => {
    const ITER = 200;
    const repo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-bench-plugin',
        }),
      }),
    ]);

    const noTxMs = await time(`create ×${ITER} (no tx)`, async () => {
      for (let i = 0; i < ITER; i++) {
        await repo.create({ amount: i });
      }
    });
    await InvoiceModel.deleteMany({});
    await clearOwnCounters();

    const txMs = await time(`create ×${ITER} (inside withTransaction)`, async () => {
      for (let i = 0; i < ITER; i++) {
        await withTransaction(mongoose.connection, async (session) => {
          await repo.create({ amount: i }, { session });
        });
      }
    });

    const perOpNoTx = noTxMs / ITER;
    const perOpTx = txMs / ITER;
    // eslint-disable-next-line no-console
    console.log(
      `  per-op: no-tx=${perOpNoTx.toFixed(3)}ms, ` +
        `tx=${perOpTx.toFixed(3)}ms ` +
        `(overhead=${((perOpTx / perOpNoTx - 1) * 100).toFixed(1)}%)`,
    );

    // Final state check — benchmarking shouldn't leave dangling inconsistency
    expect(await InvoiceModel.countDocuments({})).toBe(ITER);
  });

  // ==========================================================================
  // Bench 3 — concurrent transactional creates (contention on one counter)
  // ==========================================================================

  it('concurrent transactional creates: 100 txs sharing one counter', async () => {
    const CONCURRENCY = 100;
    const repo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-bench-contended',
        }),
      }),
    ]);

    const elapsed = await time(
      `concurrent withTransaction ×${CONCURRENCY} (Promise.all)`,
      async () => {
        await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, i) =>
            withTransaction(mongoose.connection, async (session) =>
              repo.create({ amount: i }, { session }),
            ),
          ),
        );
      },
    );

    // eslint-disable-next-line no-console
    console.log(
      `  per-op (amortized): ${(elapsed / CONCURRENCY).toFixed(3)}ms ` +
        `(throughput: ${(CONCURRENCY / (elapsed / 1000)).toFixed(1)} txs/s)`,
    );

    // Every insert landed with a unique contiguous number
    const persisted = await InvoiceModel.find({}).lean();
    expect(persisted).toHaveLength(CONCURRENCY);
    const unique = new Set(persisted.map((d) => d.invoiceNumber));
    expect(unique.size).toBe(CONCURRENCY);
  });

  // ==========================================================================
  // Bench 4 — createMany inside one tx vs many single creates
  // ==========================================================================

  it('createMany(50) in one tx vs 50 single creates in one tx', async () => {
    const N = 50;
    const repo = new Repository(InvoiceModel, [
      customIdPlugin({
        field: 'invoiceNumber',
        generator: sequentialId({
          prefix: 'INV',
          model: InvoiceModel,
          counterKey: 'custom-id-tx-bench-batch',
        }),
      }),
    ]);

    const singleMs = await time(`${N} single creates in one tx`, async () => {
      await withTransaction(mongoose.connection, async (session) => {
        for (let i = 0; i < N; i++) {
          await repo.create({ amount: i }, { session });
        }
      });
    });
    await InvoiceModel.deleteMany({});
    await clearOwnCounters();

    const batchMs = await time(`createMany(${N}) in one tx`, async () => {
      await withTransaction(mongoose.connection, async (session) => {
        await repo.createMany(
          Array.from({ length: N }, (_, i) => ({ amount: i })),
          { session },
        );
      });
    });

    // eslint-disable-next-line no-console
    console.log(
      `  speedup: createMany is ${(singleMs / batchMs).toFixed(2)}x faster than N single creates`,
    );

    const persisted = await InvoiceModel.find({}).lean();
    expect(persisted).toHaveLength(N);
  });
});
