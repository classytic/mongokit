/**
 * Cache adapter failure resilience.
 *
 * The cache plugin SHOULD degrade to cache-miss + DB-hit when the adapter
 * is unhealthy — Redis reboots, connection pool exhaustion, timeouts.
 * A cache outage is never an application outage.
 *
 * Mongokit 3.13+ delegates cache wiring to `@classytic/repo-core/cache`,
 * which doesn't catch adapter errors itself — hosts wrap their adapter
 * with try/catch so the read path falls through to the DB on failure.
 * These tests cover that pattern: the adapter swallows its own faults
 * and the plugin sees a clean miss / no-op.
 */

import type { CacheAdapter } from '@classytic/repo-core/cache';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cachePlugin, Repository } from '../../src/index.js';
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
 * An adapter that swallows its own faults so the plugin never sees a
 * thrown error. Production-grade Redis adapters wrap their client this
 * way — a Redis reboot becomes a transparent miss + deferred write.
 */
function makeFailingAdapter() {
  const state = {
    throwOnGet: false,
    throwOnSet: false,
    throwOnDel: false,
    slowMs: 0,
    errors: 0,
  };
  const store = new Map<string, unknown>();
  const adapter: CacheAdapter = {
    async get(key: string) {
      if (state.slowMs) await new Promise((r) => setTimeout(r, state.slowMs));
      if (state.throwOnGet) {
        state.errors++;
        return undefined; // swallow; treat as miss
      }
      return store.get(key);
    },
    async set(key, value) {
      if (state.throwOnSet) {
        state.errors++;
        return; // swallow; cache simply not populated
      }
      store.set(key, value);
    },
    async delete(key) {
      if (state.throwOnDel) {
        state.errors++;
        return; // swallow
      }
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

  it('adapter.get throws (swallowed) → read falls through to DB, returns the doc', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [
      cachePlugin({ adapter, defaults: { staleTime: 60 } }),
    ]);
    const created = await repo.create({ slug: 'a', name: 'A' });
    const id = String((created as { _id: mongoose.Types.ObjectId })._id);

    state.throwOnGet = true;

    const doc = await repo.getById(id);
    expect(doc).toBeDefined();
    expect((doc as ICacheDoc).slug).toBe('a');
    expect(state.errors).toBeGreaterThan(0);
  });

  it('adapter.set throws (swallowed) → write still commits, read still succeeds', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [
      cachePlugin({ adapter, defaults: { staleTime: 60 } }),
    ]);

    state.throwOnSet = true;

    const created = await repo.create({ slug: 'b', name: 'B' });
    expect(created).toBeDefined();

    const id = String((created as { _id: mongoose.Types.ObjectId })._id);
    const fresh = await repo.getById(id);
    expect((fresh as ICacheDoc).slug).toBe('b');
  });

  it('adapter.delete throws (swallowed) → update still commits', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [
      cachePlugin({ adapter, defaults: { staleTime: 60 } }),
    ]);
    const created = await repo.create({ slug: 'c', name: 'C' });
    const id = String((created as { _id: mongoose.Types.ObjectId })._id);

    state.throwOnDel = true;

    await expect(repo.update(id, { name: 'C-updated' })).resolves.toBeDefined();
    const fresh = await repo.getById(id);
    expect((fresh as ICacheDoc).name).toBe('C-updated');
  });

  it('slow adapter (simulated timeout) does not hang the read beyond its latency', async () => {
    const { adapter, state } = makeFailingAdapter();
    const repo = new Repository<ICacheDoc>(Model, [
      cachePlugin({ adapter, defaults: { staleTime: 60 } }),
    ]);
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
    let hits = 0;
    const repo = new Repository<ICacheDoc>(Model, [
      cachePlugin({
        adapter,
        defaults: { staleTime: 60 },
        log: {
          onHit: () => {
            hits++;
          },
        },
      }),
    ]);
    const created = await repo.create({ slug: 'e', name: 'E' });
    const id = String((created as { _id: mongoose.Types.ObjectId })._id);

    // First read: cache miss + adapter swallows on set. Read still succeeds.
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

    expect(hits).toBeGreaterThan(0);
  });
});
