/**
 * Cross-kit conformance — mongokit side.
 *
 * Wires the shared scenario suite from `@classytic/repo-core/testing`
 * to a mongoose-backed harness. Identical scenarios run against
 * sqlitekit; when both stay green, the `StandardRepo<TDoc>` contract
 * holds across both kits and application code can swap backends.
 *
 * Non-goals for this file: exercising MongoDB-specific power features
 * (`$lookup`, `$facet`, change streams, vector search). Those live in
 * mongokit-native tests. The conformance contract is the lowest common
 * denominator across every kit.
 */

import { createMemoryCacheAdapter } from '@classytic/repo-core/cache';
import {
  type ConformanceDoc,
  type ConformanceHarness,
  runStandardRepoConformance,
} from '@classytic/repo-core/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';
import { cachePlugin, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

/**
 * Mongoose schema mirroring the `ConformanceDoc` shape. `email` is
 * unique so the duplicate-key scenario fires on the second insert with
 * the same value. `id` is intentionally a plain string field — the
 * harness uses mongo's native `_id`, but the conformance type carries
 * `id?` for sqlite parity.
 */
function makeSchema(): mongoose.Schema<ConformanceDoc> {
  return new mongoose.Schema<ConformanceDoc>(
    {
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      category: { type: String, default: null },
      count: { type: Number, default: 0 },
      active: { type: Boolean, default: true },
      notes: { type: String, default: null },
      createdAt: { type: String, required: true },
    },
    { _id: true, versionKey: false },
  );
}

// One shared model + connection across the whole suite. `harness.setup`
// just clears the collection per test, which is much faster than
// dropping and re-registering on every spec.
let Model: mongoose.Model<ConformanceDoc>;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel('Conformance', makeSchema());
});

afterAll(async () => {
  if (Model) await Model.deleteMany({});
  await disconnectDB();
});

const harness: ConformanceHarness<ConformanceDoc> = {
  name: 'mongokit (mongoose)',
  idField: '_id',
  features: {
    // `_shared/global-setup.ts` boots a single-node MongoMemoryReplSet,
    // so multi-document transactions are available — if the caller
    // passes `MONGODB_URI` that points at a standalone mongod instead,
    // `withTransaction` will throw 263 and these scenarios will fail
    // loudly; that's the right signal.
    transactions: true,
    // Mongo supports nested `withTransaction` via session reuse, but
    // mongokit's wrapper doesn't rebind the inner call to the same
    // session. Leave this off until mongokit gains explicit support —
    // the scenarios that exercise nesting stay skipped on both kits.
    nestedTransactions: false,
    upsert: true,
    duplicateKeyError: true,
    distinct: true,
    aggregate: true,
    aggregateOps: {
      // Mongo 7+ ships `$percentile` as an approximate (t-digest)
      // accumulator — fast, low-memory, accurate enough for
      // dashboard P50/P95/P99.
      percentile: true,
      // Native `$stdDevSamp` / `$stdDevPop` (numerically stable Welford).
      stddev: true,
      // `$setWindowFields` (Mongo 5+) gives in-engine top-N.
      topN: true,
      // `$dateTrunc` (Mongo 5+) handles `{ every, unit }` bins.
      customDateBuckets: true,
      // `$dateToString` with `%H:%M` / `%H:00` formats.
      dateBucketSubMinute: true,
      // Per-request `cache?` slot routes through repo-core's SWR engine
      // when `aggregateCache` is wired on the Repository constructor.
      cache: true,
    },
    getOrCreate: true,
    countAndExists: true,
    // Compliance-grade tenant cleanup primitive. mongokit chunks via
    // `_id`-keyed batches through `deleteMany` / `updateMany`, so audit
    // / cache plugins compose automatically.
    purgeByField: true,
  },
  async setup() {
    // Clear the shared collection between tests — fresh state per spec
    // without re-registering the model.
    await Model.deleteMany({});
    const repo = new Repository<ConformanceDoc>(Model);
    // Cache scenarios use a separate repo with the unified cache plugin
    // wired. State is fresh per setup() (new adapter instance) so the
    // cache scenarios are hermetic.
    const cachedRepo = new Repository<ConformanceDoc>(Model, [
      cachePlugin({ adapter: createMemoryCacheAdapter() }),
    ]);
    return {
      repo: repo as unknown as import('@classytic/repo-core/testing').ConformanceContext<ConformanceDoc>['repo'],
      cachedRepo:
        cachedRepo as unknown as import('@classytic/repo-core/testing').ConformanceContext<ConformanceDoc>['cachedRepo'],
      cleanup: async () => {
        // Cleanup is a no-op — the shared model + connection survive,
        // and the next setup() clears state with deleteMany.
      },
    };
  },
  makeDoc(overrides = {}) {
    const suffix = Math.random().toString(36).slice(2, 10);
    return {
      // Don't seed `_id` — mongoose generates ObjectIds. Scenarios that
      // care about ids project them via `harness.idField`.
      name: overrides.name ?? `n_${suffix}`,
      email: overrides.email ?? `e_${suffix}@example.com`,
      category: overrides.category !== undefined ? overrides.category : 'default',
      count: overrides.count ?? 0,
      active: overrides.active ?? true,
      notes: overrides.notes !== undefined ? overrides.notes : null,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      ...overrides,
    };
  },
};

runStandardRepoConformance(harness);
