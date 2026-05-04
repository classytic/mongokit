/**
 * Integration tests for aggregate caching via the unified cache plugin.
 *
 * Mongokit 3.13+ delegates cache wiring to `@classytic/repo-core/cache`,
 * which subscribes to `before:aggregate` / `after:aggregate` (and the
 * paginated counterparts) — same hook integration as CRUD ops, no
 * special wiring needed.
 *
 * Cross-kit parity: same scenarios run on sqlitekit's parallel test
 * file. Same input AggRequest + same cache options → same hit/miss
 * behaviour on both backends.
 */

import { createMemoryCacheAdapter } from '@classytic/repo-core/cache';
import type { CacheAdapter, RepositoryCacheHandle } from '@classytic/repo-core/cache';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cachePlugin, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrder {
  _id?: mongoose.Types.ObjectId;
  category: string;
  amount: number;
}

function makeSchema() {
  return new mongoose.Schema<IOrder>(
    {
      category: { type: String, required: true },
      amount: { type: Number, required: true },
    },
    { timestamps: false },
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('aggregate (portable IR) — cache (unified plugin)', () => {
  let Model: mongoose.Model<IOrder>;
  let cache: CacheAdapter;
  let repo: Repository<IOrder>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('AggCache', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    cache = createMemoryCacheAdapter();
    repo = new Repository<IOrder>(Model, [cachePlugin({ adapter: cache })]);
    await repo.createMany([
      { category: 'books', amount: 100 },
      { category: 'books', amount: 200 },
      { category: 'toys', amount: 50 },
    ]);
  });

  it('cache hit: second call within staleTime returns cached result without hitting DB', async () => {
    const first = await repo.aggregate<{ category: string; total: number }>({
      groupBy: 'category',
      measures: { total: { op: 'sum', field: 'amount' } },
      sort: { category: 1 },
      cache: { staleTime: 60 },
    });
    expect(first.rows).toEqual([
      { category: 'books', total: 300 },
      { category: 'toys', total: 50 },
    ]);

    // Mutate the underlying data via raw Model.create to bypass the cache
    // plugin's `after:create` invalidation hook — otherwise the version
    // bump would orphan the cached entry and the next read would miss.
    await Model.create({ category: 'books', amount: 999 });

    const second = await repo.aggregate<{ category: string; total: number }>({
      groupBy: 'category',
      measures: { total: { op: 'sum', field: 'amount' } },
      sort: { category: 1 },
      cache: { staleTime: 60 },
    });
    expect(second.rows).toEqual([
      { category: 'books', total: 300 },
      { category: 'toys', total: 50 },
    ]);
  });

  it('cache miss after staleTime expires: re-reads DB', async () => {
    const first = await repo.aggregate<{ category: string; total: number }>({
      groupBy: 'category',
      measures: { total: { op: 'sum', field: 'amount' } },
      sort: { category: 1 },
      cache: { staleTime: 1, gcTime: 0 },
    });
    expect(first.rows[0]?.total).toBe(300);

    await Model.create({ category: 'books', amount: 50 });
    await sleep(1100); // expire the 1s staleTime + 0 gcTime

    const second = await repo.aggregate<{ category: string; total: number }>({
      groupBy: 'category',
      measures: { total: { op: 'sum', field: 'amount' } },
      sort: { category: 1 },
      cache: { staleTime: 1, gcTime: 0 },
    });
    expect(second.rows[0]?.total).toBe(350);
  });

  it('bypass: forces a fresh fetch + overwrites the cached entry', async () => {
    await repo.aggregate({
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60 },
    });
    await Model.create({ category: 'toys', amount: 1000 });

    // Without bypass — cached.
    const cached = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60 },
    });
    expect(cached.rows[0]?.sum).toBe(350);

    // With bypass — fresh fetch.
    const fresh = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60, bypass: true },
    });
    expect(fresh.rows[0]?.sum).toBe(1350);

    // The bypass overwrote the cache — next non-bypass call sees the new value.
    const next = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60 },
    });
    expect(next.rows[0]?.sum).toBe(1350);
  });

  it('SWR: serves stale data immediately while refreshing in background', async () => {
    const req = {
      measures: { sum: { op: 'sum' as const, field: 'amount' } },
      cache: { staleTime: 1, gcTime: 60, swr: true },
    };
    const first = await repo.aggregate<{ sum: number }>(req);
    expect(first.rows[0]?.sum).toBe(350);

    await Model.create({ category: 'books', amount: 50 });
    await sleep(1100); // past staleTime but within staleTime + gcTime

    // Stale-serve: returns 350 (the cached value), kicks off refresh.
    const staleRead = await repo.aggregate<{ sum: number }>(req);
    expect(staleRead.rows[0]?.sum).toBe(350);

    // Wait for the background refresh to land.
    await sleep(50);

    const fresh = await repo.aggregate<{ sum: number }>(req);
    expect(fresh.rows[0]?.sum).toBe(400);
  });

  it('disabled (no cache slot): bypasses cache entirely, runs uncached', async () => {
    const first = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'amount' } },
    });
    expect(first.rows[0]?.sum).toBe(350);

    await Model.create({ category: 'toys', amount: 100 });

    // No cache slot → reads DB again, sees the new total.
    const second = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'amount' } },
    });
    expect(second.rows[0]?.sum).toBe(450);
  });

  it('tag-based invalidation: clears matching entries via repo.cache.invalidateByTags', async () => {
    // Two distinct cached queries; both tagged 'orders', second also tagged 'detailed'.
    await repo.aggregate({
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60, tags: ['orders'] },
    });
    await repo.aggregate({
      groupBy: 'category',
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60, tags: ['orders', 'detailed'] },
    });

    await Model.create({ category: 'toys', amount: 100 });

    // Invalidate just the 'detailed' tag. The first query (tagged
    // only 'orders') should still be cached; the second is gone.
    const handle = (repo as unknown as { cache?: RepositoryCacheHandle }).cache;
    expect(handle).toBeDefined();
    const cleared = await handle?.invalidateByTags(['detailed']);
    expect(cleared).toBeGreaterThanOrEqual(1);

    const stillCached = await repo.aggregate<{ sum: number }>({
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60, tags: ['orders'] },
    });
    expect(stillCached.rows[0]?.sum).toBe(350); // pre-create value

    const refreshed = await repo.aggregate<{ category: string; sum: number }>({
      groupBy: 'category',
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60, tags: ['orders', 'detailed'] },
    });
    expect(refreshed.rows.find((r) => r.category === 'toys')?.sum).toBe(150);
  });

  it('no cache plugin wired: aggregate runs through cleanly, no caching', async () => {
    const repoNoCache = new Repository<IOrder>(Model);
    // Without cache plugin, the `cache:` slot is silently ignored — the
    // aggregate runs as a plain DB call. This is the v3.13 behavior shift
    // from the prior "throws when adapter missing" contract: a missing
    // plugin is no longer a runtime error, just no caching happens.
    const result = await repoNoCache.aggregate({
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60 },
    });
    expect(result.rows[0]?.sum).toBe(350);
  });

  it('cross-tenant isolation: different filters → different cache keys', async () => {
    const booksOnly = await repo.aggregate<{ sum: number }>({
      filter: { category: 'books' },
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60 },
    });
    expect(booksOnly.rows[0]?.sum).toBe(300);

    const toysOnly = await repo.aggregate<{ sum: number }>({
      filter: { category: 'toys' },
      measures: { sum: { op: 'sum', field: 'amount' } },
      cache: { staleTime: 60 },
    });
    expect(toysOnly.rows[0]?.sum).toBe(50);
    // Different filters bucketed to different keys — no cross-tenant
    // cache poisoning. The books query didn't return toys data.
  });

  it('aggregatePaginate caches the full envelope per-page', async () => {
    for (let i = 0; i < 10; i++) {
      await Model.create({ category: `cat${i}`, amount: i * 10 });
    }

    const page1 = await repo.aggregatePaginate({
      groupBy: 'category',
      measures: { n: { op: 'count' } },
      sort: { category: 1 },
      page: 1,
      limit: 5,
      cache: { staleTime: 60 },
    });
    expect(page1.method).toBe('offset');
    if (page1.method !== 'offset') throw new Error('expected offset');
    expect(page1.data).toHaveLength(5);

    // Page 2 = different cache key (page param differs in the hash).
    const page2 = await repo.aggregatePaginate({
      groupBy: 'category',
      measures: { n: { op: 'count' } },
      sort: { category: 1 },
      page: 2,
      limit: 5,
      cache: { staleTime: 60 },
    });
    if (page2.method !== 'offset') throw new Error('expected offset');
    expect(page2.data).toHaveLength(5);
    // No overlap with page 1.
    const page1Cats = new Set(page1.data.map((r) => r.category));
    for (const r of page2.data) expect(page1Cats.has(r.category as string)).toBe(false);
  });
});
