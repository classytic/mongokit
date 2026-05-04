/**
 * Unit tests for cache TTL jitter.
 *
 * Pure — no mongo, no adapter I/O. Exercises the unified cache engine's
 * jitter behavior (which sits in front of every adapter.set() call) by
 * invoking `engine.set()` with the resolved per-call options the plugin
 * would build internally.
 *
 * Mongokit 3.13+ delegates cache wiring to `@classytic/repo-core/cache`,
 * so jitter lives in the engine, not the plugin shim. The shape of this
 * test mirrors the previous mongokit-local jitter test — same scenarios,
 * same invariants, exercised through the new public surface.
 */

import { CacheEngine } from '@classytic/repo-core/cache';
import type { CacheAdapter } from '@classytic/repo-core/cache';
import type { ResolvedCacheOptions } from '@classytic/repo-core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

function makeSpyAdapter() {
  const store = new Map<string, { value: unknown; ttl: number | undefined }>();
  const setCalls: { key: string; ttl: number | undefined }[] = [];

  const adapter: CacheAdapter = {
    async get(key: string) {
      const hit = store.get(key);
      return hit ? hit.value : undefined;
    },
    async set(key, value, ttl) {
      setCalls.push({ key, ttl });
      store.set(key, { value, ttl });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async clear() {
      store.clear();
    },
  };
  return { adapter, setCalls, store };
}

/**
 * Build the resolved cache options for a `staleTime: 60` entry — the same
 * shape `resolveCacheOptions` produces inside the plugin. We hit the
 * engine directly so the test stays pure (no plugin wiring, no fake repo).
 */
function makeOpts(staleTime: number, gcTime = 60): ResolvedCacheOptions {
  return {
    staleTime,
    gcTime,
    tags: [],
    bypass: false,
    swr: false,
    enabled: true,
  };
}

describe('cache TTL jitter (unified engine)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to identity (no jitter) when jitter is unset', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const engine = new CacheEngine(adapter);
    for (let i = 0; i < 20; i++) {
      await engine.set(`k${i}`, { v: i }, makeOpts(60));
    }
    // Engine writes one entry per call; TTL == staleTime + gcTime = 60 + 60 = 120.
    const sets = setCalls.filter((c) => c.key.startsWith('k'));
    expect(sets.length).toBe(20);
    for (const call of sets) expect(call.ttl).toBe(120);
  });

  it('fractional jitter spreads TTL across the configured range', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const engine = new CacheEngine(adapter, { jitter: 0.2 });
    for (let i = 0; i < 200; i++) {
      await engine.set(`k${i}`, { v: i }, makeOpts(100, 0));
    }

    const sets = setCalls.filter((c) => c.key.startsWith('k'));
    const ttls = sets.map((c) => c.ttl ?? 0);
    const min = Math.min(...ttls);
    const max = Math.max(...ttls);

    // staleTime=100 + gcTime=0 → base TTL=100, jitter 0.2 → [80, 120].
    expect(min).toBeGreaterThanOrEqual(80);
    expect(max).toBeLessThanOrEqual(120);

    const unique = new Set(ttls).size;
    expect(unique).toBeGreaterThan(10);
  });

  it('function jitter delegates completely to the caller', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const calls: number[] = [];
    const engine = new CacheEngine(adapter, {
      jitter: (ttl) => {
        calls.push(ttl);
        return ttl * 2;
      },
    });
    await engine.set('k1', { v: 1 }, makeOpts(60, 0));

    expect(calls).toEqual([60]);
    const sets = setCalls.filter((c) => c.key === 'k1');
    expect(sets[0]?.ttl).toBe(120);
  });

  it('clamps jitter fraction above 1 to 1 (no negative TTL)', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const engine = new CacheEngine(adapter, { jitter: 5 });
    for (let i = 0; i < 100; i++) {
      await engine.set(`k${i}`, { v: i }, makeOpts(10, 0));
    }

    // With fraction=1 (clamped), range is [0, 20]; engine clamps to >=1.
    const sets = setCalls.filter((c) => c.key.startsWith('k'));
    for (const call of sets) {
      expect(call.ttl ?? 0).toBeGreaterThanOrEqual(1);
      expect(call.ttl ?? 0).toBeLessThanOrEqual(20);
    }
  });

  it('clamps function jitter returning < 1 to 1', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const engine = new CacheEngine(adapter, { jitter: () => 0 });
    await engine.set('k1', { v: 1 }, makeOpts(60, 0));
    const sets = setCalls.filter((c) => c.key === 'k1');
    expect(sets[0]?.ttl).toBe(1);
  });

  it('mitigates synchronized-expiry stampede — no single TTL dominates', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const engine = new CacheEngine(adapter, { jitter: 0.1 });
    // Simulate 500 concurrent readers populating the same logical entry
    // (e.g., 500 pods warming the same hot doc immediately after a deploy).
    for (let i = 0; i < 500; i++) {
      await engine.set(`k${i}`, { v: i }, makeOpts(60, 0));
    }

    const sets = setCalls.filter((c) => c.key.startsWith('k'));
    const ttls = sets.map((c) => c.ttl ?? 0);
    const histogram = new Map<number, number>();
    for (const t of ttls) histogram.set(t, (histogram.get(t) ?? 0) + 1);

    // No single integer-second bucket should hold more than ~15% of writes.
    // Without jitter, every write shares the same TTL → one bucket = 100%.
    // With 0.1 jitter spreading uniformly over ~12 integer seconds, worst
    // bucket ≈ 1/12 ≈ 8%; leave headroom for randomness.
    const maxBucketShare = Math.max(...Array.from(histogram.values())) / sets.length;
    expect(maxBucketShare).toBeLessThan(0.15);
  });

  it('honors per-call staleTime override and still applies jitter on top', async () => {
    const { adapter, setCalls } = makeSpyAdapter();
    const engine = new CacheEngine(adapter, { jitter: 0.5 });
    for (let i = 0; i < 30; i++) {
      // Per-call override: staleTime=200 → base TTL=200, jitter ±50% → [100, 300].
      await engine.set(`k${i}`, { v: i }, makeOpts(200, 0));
    }

    const sets = setCalls.filter((c) => c.key.startsWith('k'));
    for (const call of sets) {
      expect(call.ttl ?? 0).toBeGreaterThanOrEqual(100);
      expect(call.ttl ?? 0).toBeLessThanOrEqual(300);
    }
    const unique = new Set(sets.map((c) => c.ttl)).size;
    expect(unique).toBeGreaterThan(5);
  });
});
