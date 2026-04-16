/**
 * Unit tests for cache TTL jitter.
 *
 * Pure — no mongo, no adapter I/O. Exercises the jitter resolver that sits in
 * front of every adapter.set() call.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// The jitter resolver is an internal helper. We exercise it through the
// public cachePlugin by intercepting adapter.set() calls and reading the
// actual TTL that was persisted.
import { cachePlugin } from '../../src/plugins/cache.plugin.js';
import type { CacheAdapter } from '../../src/types.js';

function makeSpyAdapter() {
  const store = new Map<string, { value: unknown; ttl: number }>();
  const setCalls: { key: string; ttl: number }[] = [];

  const adapter: CacheAdapter = {
    async get<T>(key: string) {
      const hit = store.get(key);
      return (hit ? (hit.value as T) : null) as T | null;
    },
    async set(key, value, ttl) {
      setCalls.push({ key, ttl });
      store.set(key, { value, ttl });
    },
    async del(key: string) {
      store.delete(key);
    },
    async clear() {
      store.clear();
    },
  };
  return { adapter, setCalls, store };
}

/**
 * The cache plugin exposes TTL behavior through adapter.set() calls. We
 * register the plugin against a minimal fake repo, then trigger the
 * after:getById hook directly to observe the TTL that lands at the adapter.
 */
function applyAndTriggerAfterGetById(
  plugin: ReturnType<typeof cachePlugin>,
  getIdTtl = 60,
  cacheTtlOverride?: number,
) {
  const hooks = new Map<
    string,
    ((payload: { context: Record<string, unknown>; result: unknown }) => Promise<void>)[]
  >();
  const repo = {
    model: 'JitterFakeModel',
    on(
      event: string,
      listener: (payload: { context: Record<string, unknown>; result: unknown }) => Promise<void>,
    ) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event)!.push(listener);
      return repo;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin.apply(repo as any);

  const hook = hooks.get('after:getById')![0];
  return async () => {
    await hook({
      context: { id: 'doc_1', cacheTtl: cacheTtlOverride },
      result: { _id: 'doc_1' },
    });
  };
}

describe('cache TTL jitter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to identity (no jitter) when jitter is unset', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const trigger = applyAndTriggerAfterGetById(cachePlugin({ adapter, ttl: 60, byIdTtl: 60 }));
    for (let i = 0; i < 20; i++) await trigger();

    expect(setCalls.length).toBe(20);
    for (const call of setCalls) expect(call.ttl).toBe(60);
  });

  it('fractional jitter spreads TTL within [ttl*(1-f), ttl*(1+f)]', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const trigger = applyAndTriggerAfterGetById(
      cachePlugin({ adapter, ttl: 100, byIdTtl: 100, jitter: 0.2 }),
    );
    for (let i = 0; i < 200; i++) await trigger();

    const ttls = setCalls.map((c) => c.ttl);
    const min = Math.min(...ttls);
    const max = Math.max(...ttls);

    expect(min).toBeGreaterThanOrEqual(80);
    expect(max).toBeLessThanOrEqual(120);

    // Variance check — with 200 samples and 0.2 jitter, we expect wide spread.
    const unique = new Set(ttls).size;
    expect(unique).toBeGreaterThan(10);
  });

  it('function jitter delegates completely to the caller', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const calls: number[] = [];
    const trigger = applyAndTriggerAfterGetById(
      cachePlugin({
        adapter,
        ttl: 60,
        byIdTtl: 60,
        jitter: (ttl) => {
          calls.push(ttl);
          return ttl * 2;
        },
      }),
    );
    await trigger();

    expect(calls).toEqual([60]);
    expect(setCalls[0].ttl).toBe(120);
  });

  it('clamps jitter fraction above 1 to 1 (no negative TTL)', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const trigger = applyAndTriggerAfterGetById(
      cachePlugin({ adapter, ttl: 10, byIdTtl: 10, jitter: 5 }),
    );
    for (let i = 0; i < 100; i++) await trigger();

    // With fraction=1, range is [0, 20], but the clamp promises min 1 second.
    for (const call of setCalls) {
      expect(call.ttl).toBeGreaterThanOrEqual(1);
      expect(call.ttl).toBeLessThanOrEqual(20);
    }
  });

  it('clamps function jitter returning < 1 to 1', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const trigger = applyAndTriggerAfterGetById(
      cachePlugin({ adapter, ttl: 60, byIdTtl: 60, jitter: () => 0 }),
    );
    await trigger();
    expect(setCalls[0].ttl).toBe(1);
  });

  it('mitigates synchronized-expiry stampede — no single TTL dominates', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const trigger = applyAndTriggerAfterGetById(
      cachePlugin({ adapter, ttl: 60, byIdTtl: 60, jitter: 0.1 }),
    );
    // Simulate 500 concurrent readers setting the same logical entry (e.g.,
    // 500 pods warming the same hot doc immediately after a deploy).
    for (let i = 0; i < 500; i++) await trigger();

    const ttls = setCalls.map((c) => c.ttl);
    const histogram = new Map<number, number>();
    for (const t of ttls) histogram.set(t, (histogram.get(t) ?? 0) + 1);

    // No single second bucket should contain more than ~15% of the writes.
    // Without jitter, every write shares the same TTL → one bucket = 100%.
    // With 0.1 jitter spreading uniformly over ~12 integer seconds, worst
    // case bucket ≈ 1/12 ≈ 8%; leave headroom for randomness.
    const maxBucketShare = Math.max(...Array.from(histogram.values())) / 500;
    expect(maxBucketShare).toBeLessThan(0.15);
  });

  it('honors per-call cacheTtl override and still applies jitter on top', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const plugin = cachePlugin({ adapter, ttl: 60, byIdTtl: 60, jitter: 0.5 });
    const trigger = applyAndTriggerAfterGetById(plugin, 60, 200);
    for (let i = 0; i < 30; i++) await trigger();

    // Baseline is 200 (override), jitter ±50% → [100, 300].
    for (const call of setCalls) {
      expect(call.ttl).toBeGreaterThanOrEqual(100);
      expect(call.ttl).toBeLessThanOrEqual(300);
    }
    const unique = new Set(setCalls.map((c) => c.ttl)).size;
    expect(unique).toBeGreaterThan(5);
  });
});
