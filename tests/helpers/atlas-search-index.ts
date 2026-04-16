/**
 * Programmatic Atlas Vector Search index management for e2e tests.
 *
 * Atlas exposes `createSearchIndex` / `listSearchIndexes` / `dropSearchIndex`
 * on every Collection in the native driver. Index builds are asynchronous —
 * the returned promise resolves quickly but the index only becomes queryable
 * when its `status` transitions to `READY` (or the equivalent
 * `queryable: true`).
 *
 * This helper:
 *   - creates the index (idempotent — reuses an existing one by name)
 *   - polls for readiness with a deadline
 *   - exposes a dropper for afterAll teardown
 *
 * Only used by `tests/e2e/**`. Never runs against memory-server — Atlas Search
 * is Atlas-only.
 */

import type { Collection } from 'mongodb';

export interface VectorSearchIndexSpec {
  name: string;
  /** Embedding field path, e.g. 'embedding'. */
  path: string;
  /** Embedding dimensions, e.g. 8 (tests) or 1536 (OpenAI text-embedding-3-small). */
  numDimensions: number;
  /** Cosine is the default for normalized vectors. */
  similarity?: 'cosine' | 'euclidean' | 'dotProduct';
  /**
   * Paths listed here become `filter` fields — required for any
   * $vectorSearch that passes `filter: { tenantId, ... }`. Atlas rejects
   * filters on paths not listed as filter fields at index build time.
   */
  filterPaths?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCollection = Collection<any>;

/**
 * Create a vectorSearch index on the collection if it doesn't already exist.
 * Waits until it reports queryable/READY or the deadline fires.
 *
 * Returns when the index is ready. Throws on timeout with a clear message.
 */
export async function ensureVectorSearchIndex(
  collection: AnyCollection,
  spec: VectorSearchIndexSpec,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 4 * 60_000; // 4 minutes — Atlas index builds are slow
  const pollMs = opts.pollMs ?? 3_000;

  const definition = {
    fields: [
      {
        type: 'vector' as const,
        path: spec.path,
        numDimensions: spec.numDimensions,
        similarity: spec.similarity ?? 'cosine',
      },
      ...((spec.filterPaths ?? []).map((p) => ({ type: 'filter' as const, path: p }))),
    ],
  };

  const existing = await listSearchIndexSafe(collection, spec.name);
  if (!existing) {
    // Create. Atlas returns the index name; the build runs asynchronously.
    await collection.createSearchIndex({
      name: spec.name,
      type: 'vectorSearch',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      definition: definition as any,
    });
  }

  // Poll until queryable.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idx = await listSearchIndexSafe(collection, spec.name);
    if (idx && isReady(idx)) return;
    await sleep(pollMs);
  }

  throw new Error(
    `[mongokit:e2e] Vector search index "${spec.name}" did not become queryable within ${timeoutMs}ms. ` +
      `Check Atlas cluster tier supports Vector Search, or widen timeoutMs.`,
  );
}

/**
 * Drop the search index by name. Swallows "index not found" — teardown
 * should never block on a missing artifact.
 */
export async function dropVectorSearchIndex(
  collection: AnyCollection,
  name: string,
): Promise<void> {
  try {
    await collection.dropSearchIndex(name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Ignore "index not found" / "ns not found" — teardown is best-effort.
    if (!/not found|ns not found|does not exist/i.test(msg)) throw err;
  }
}

async function listSearchIndexSafe(
  collection: AnyCollection,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const cursor = collection.listSearchIndexes(name);
    const all = await cursor.toArray();
    return all.find((i) => (i as { name?: string }).name === name) as
      | Record<string, unknown>
      | undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "ns does not exist" happens before the collection is materialized;
    // treat as "no index yet, not an error".
    if (/ns does not exist|ns not found/i.test(msg)) return undefined;
    throw err;
  }
}

function isReady(idx: Record<string, unknown>): boolean {
  // Atlas reports both `status` and `queryable`. "READY" is the target state;
  // "queryable: true" is the authoritative signal the index is usable.
  if (idx.queryable === true) return true;
  const status = typeof idx.status === 'string' ? idx.status.toUpperCase() : '';
  return status === 'READY';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
