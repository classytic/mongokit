/**
 * Cache adapter failure resilience.
 *
 * The cache plugin MUST degrade to cache-miss + DB-hit when the adapter is
 * unhealthy — Redis reboots, connection pool exhaustion, timeouts. A cache
 * outage is never an application outage.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Repository, cachePlugin } from '../../src/index.js';
import type { CacheAdapter } from '../../src/types.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface ICacheDoc {
  slug: string;
  name: string;
}

function makeSchema() {
  return new mongoose.Schema<ICacheDoc>(
    {
      slug: { type: String, required: true, unique: true },
      name: { type: String, required: true },
    },
    { timestamps: true },
  );
}

/**
 * An adapter where each method throws / times out / returns garbage on demand.
 * Toggleable per-test.
 */
function makeFailingAdapter() {
  const state = {
    throwOnGet: false,
    throwOnSet: false,
    throwOnDel: false,
    slowMs: 0,
  };
  const store = new Map<string, unknown>();
  const adapter: CacheAdapter = {
    async get<T>(key: string) {
      if (state.slowMs) await new Promise((r) => setTimeout(r, state.slowMs));
      if (state.throwOnGet) throw new Error('adapter.get exploded');
      return (store.get(key) as T | undefined) ?? null;
    },
    async set(key, value) {
      if (state.throwOnSet) throw new Error('adapter.set exploded');
      store.set(key, value);
    },
    async delete(key) {
      if (state.throwOnDel) throw new Error('adapter.delete exploded');
      store.delete(key);
    },
    async clear() {
      store.clear();
    },
  };
  return { adapter, state };
}

describe('cache adapter failure resilience (integration)', () => {
  let Model: mongoose.Model<ICacheDoc>;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    Model = await createTestModel('CacheResilienceDoc', makeSchema());
    await Model.deleteMany({});
  });

  it('adapter.get throws → read falls through to DB, returns the doc', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [cachePlugin({ adapter, ttl: 60 })]);
    const created = await repo.create({ slug: 'a', name: 'A' });
    const id = String((created as { _id: mongoose.Types.ObjectId })._id);

    state.throwOnGet = true;

    const doc = await repo.getById(id);
    expect(doc).toBeDefined();
    expect((doc as ICacheDoc).slug).toBe('a');

    const stats = (repo as unknown as { getCacheStats: () => { errors: number } }).getCacheStats();
    expect(stats.errors).toBeGreaterThan(0);
  });

  it('adapter.set throws → write still commits, read still succeeds', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [cachePlugin({ adapter, ttl: 60 })]);

    state.throwOnSet = true;

    const created = await repo.create({ slug: 'b', name: 'B' });
    expect(created).toBeDefined();

    const id = String((created as { _id: mongoose.Types.ObjectId })._id);
    const fresh = await repo.getById(id);
    expect((fresh as ICacheDoc).slug).toBe('b');
  });

  it('adapter.delete throws → update still commits', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [cachePlugin({ adapter, ttl: 60 })]);
    const created = await repo.create({ slug: 'c', name: 'C' });
    const id = String((created as { _id: mongoose.Types.ObjectId })._id);

    state.throwOnDel = true;

    await expect(repo.update(id, { name: 'C-updated' })).resolves.toBeDefined();
    const fresh = await repo.getById(id);
    expect((fresh as ICacheDoc).name).toBe('C-updated');
  });

  it('slow adapter (simulated timeout) does not hang the read beyond its latency', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [cachePlugin({ adapter, ttl: 60 })]);
    const created = await repo.create({ slug: 'd', name: 'D' });
    const id = String((created as { _id: mongoose.Types.ObjectId })._id);

    state.slowMs = 150; // simulated Redis latency spike

    const start = Date.now();
    const doc = await repo.getById(id);
    const elapsed = Date.now() - start;

    expect(doc).toBeDefined();
    // Slow adapter adds latency but doesn't multiply — one get per call.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('flip-flop: adapter throws, then recovers; cache still serves on later calls', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [cachePlugin({ adapter, ttl: 60 })]);
    const created = await repo.create({ slug: 'e', name: 'E' });
    const id = String((created as { _id: mongoose.Types.ObjectId })._id);

    // First read: cache miss + adapter throws on set. Read still succeeds.
    state.throwOnSet = true;
    const first = await repo.getById(id);
    expect((first as ICacheDoc).slug).toBe('e');

    // Adapter recovers; next read can populate the cache normally.
    state.throwOnSet = false;
    const second = await repo.getById(id);
    expect((second as ICacheDoc).slug).toBe('e');

    // Third read should be a cache hit now.
    const third = await repo.getById(id);
    expect((third as ICacheDoc).slug).toBe('e');

    const stats = (repo as unknown as { getCacheStats: () => { hits: number; errors: number } }).getCacheStats();
    expect(stats.hits).toBeGreaterThan(0);
  });
});
