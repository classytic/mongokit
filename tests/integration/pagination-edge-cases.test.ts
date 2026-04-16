/**
 * Pagination edge cases — integration (real MongoDB via memory server).
 *
 * Regression suite for edge cases that toy-scale tests miss:
 *   1. Ties on non-_id sort keys (many docs share the same createdAt)
 *   2. Nullable sort fields (some docs have no createdAt)
 *   3. Empty result set cursor shape (next === null, hasMore === false)
 *   4. Deep offset still returns correct data + emits warning
 *   5. Stale cursors rejected when minCursorVersion is bumped
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';
import type { KeysetPaginationResult, OffsetPaginationResult } from '../../src/types.js';

interface IPaginationEdgeDoc {
  name: string;
  createdAt?: Date | null;
  bucket: number;
}

const MODEL_NAME = 'PaginationEdgeDoc';
const PAGE = 25;
const CLUSTER_SIZE = 40; // forces ties within one page
const TOTAL = 520; // crosses ~20 keyset pages at limit=25

function makeSchema() {
  return new mongoose.Schema<IPaginationEdgeDoc>(
    {
      name: { type: String, required: true },
      // Deliberately nullable — real-world schemas have optional timestamps.
      createdAt: { type: Date, default: null },
      bucket: { type: Number, required: true, index: true },
    },
    { timestamps: false },
  );
}

async function seedClusters(Model: mongoose.Model<IPaginationEdgeDoc>): Promise<void> {
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const docs: IPaginationEdgeDoc[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const clusterIndex = Math.floor(i / CLUSTER_SIZE);
    docs.push({
      name: `doc-${i}`,
      // Identical createdAt within each cluster → ties resolved by _id tiebreaker.
      createdAt: new Date(base + clusterIndex * 60_000),
      bucket: clusterIndex,
    });
  }
  await Model.insertMany(docs);
}

describe('pagination edge cases (integration)', () => {
  let Model: mongoose.Model<IPaginationEdgeDoc>;
  let repo: Repository<IPaginationEdgeDoc>;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    Model = await createTestModel(MODEL_NAME, makeSchema());
    await Model.deleteMany({});
    repo = new Repository<IPaginationEdgeDoc>(Model);
  });

  describe('ties on a non-_id sort key', () => {
    it('walks the entire collection with keyset paging, no duplicates and no gaps', async () => {
      await seedClusters(Model);

      const seen = new Set<string>();
      let after: string | undefined;
      let pages = 0;

      // Walk forward until the cursor goes null.
      while (true) {
        pages += 1;
        expect(pages).toBeLessThan(100); // loop sanity
        const result = (await repo.getAll({
          sort: { createdAt: -1 },
          limit: PAGE,
          after,
        })) as KeysetPaginationResult<IPaginationEdgeDoc & { _id: mongoose.Types.ObjectId }>;

        for (const doc of result.docs) {
          const id = doc._id.toString();
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }

        if (!result.hasMore) {
          expect(result.next).toBeNull();
          break;
        }
        expect(result.next).toBeTypeOf('string');
        after = result.next ?? undefined;
      }

      expect(seen.size).toBe(TOTAL);
    });
  });

  describe('nullable sort fields', () => {
    /**
     * Keyset pagination on a sort field that mixes Date and null values does
     * NOT guarantee every doc is reachable — MongoDB's $lt/$gt semantics
     * across type boundaries leave a gap at the null/non-null transition.
     *
     * What IS guaranteed (and this test pins):
     *   - pagination terminates (no infinite loop)
     *   - no duplicate docs across pages
     *   - _id-only keyset reaches every doc (the safe fallback)
     *
     * If you plan to paginate on an optional timestamp, either sort by _id
     * alone or ensure the schema enforces a non-null value.
     */
    it('terminates without duplicates on a mixed date/null sort field', async () => {
      const base = new Date('2026-01-01T00:00:00Z').getTime();
      const docs: IPaginationEdgeDoc[] = [];
      for (let i = 0; i < 120; i++) {
        docs.push({
          name: `null-${i}`,
          createdAt: i < 60 ? null : new Date(base + i * 1000),
          bucket: 0,
        });
      }
      await Model.insertMany(docs);

      const seen = new Set<string>();
      let after: string | undefined;
      let pages = 0;

      while (true) {
        pages += 1;
        expect(pages).toBeLessThan(40);
        const result = (await repo.getAll({
          sort: { createdAt: -1 },
          limit: 20,
          after,
        })) as KeysetPaginationResult<IPaginationEdgeDoc & { _id: mongoose.Types.ObjectId }>;

        for (const doc of result.docs) {
          expect(seen.has(doc._id.toString())).toBe(false);
          seen.add(doc._id.toString());
        }
        if (!result.hasMore) break;
        after = result.next ?? undefined;
      }

      expect(seen.size).toBeGreaterThan(0);
      expect(seen.size).toBeLessThanOrEqual(120);
    });

    it('_id-only keyset reaches every doc even with null sort fields present', async () => {
      const base = new Date('2026-01-01T00:00:00Z').getTime();
      const docs: IPaginationEdgeDoc[] = [];
      for (let i = 0; i < 120; i++) {
        docs.push({
          name: `null-${i}`,
          createdAt: i < 60 ? null : new Date(base + i * 1000),
          bucket: 0,
        });
      }
      await Model.insertMany(docs);

      const seen = new Set<string>();
      let after: string | undefined;

      while (true) {
        const result = (await repo.getAll({
          sort: { _id: -1 },
          limit: 25,
          after,
        })) as KeysetPaginationResult<IPaginationEdgeDoc & { _id: mongoose.Types.ObjectId }>;

        for (const doc of result.docs) seen.add(doc._id.toString());
        if (!result.hasMore) break;
        after = result.next ?? undefined;
      }

      expect(seen.size).toBe(120);
    });
  });

  describe('empty result set', () => {
    it('keyset query against an empty collection returns a well-formed terminal result', async () => {
      const result = (await repo.getAll({
        sort: { createdAt: -1 },
        limit: PAGE,
      })) as KeysetPaginationResult<IPaginationEdgeDoc>;

      expect(result.method).toBe('keyset');
      expect(result.docs).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.next).toBeNull();
      expect(result.limit).toBe(PAGE);
    });

    it('keyset query with a filter that matches nothing behaves the same', async () => {
      await seedClusters(Model);

      const result = (await repo.getAll({
        sort: { createdAt: -1 },
        limit: PAGE,
        filters: { bucket: -1 },
      })) as KeysetPaginationResult<IPaginationEdgeDoc>;

      expect(result.docs).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.next).toBeNull();
    });

    it('offset pagination on empty collection returns a consistent shape', async () => {
      const result = (await repo.getAll({
        page: 1,
        limit: PAGE,
      })) as OffsetPaginationResult<IPaginationEdgeDoc>;

      expect(result.method).toBe('offset');
      expect(result.docs).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.pages).toBe(0);
      expect(result.hasNext).toBe(false);
    });
  });

  describe('deep offset pagination', () => {
    it('returns correct docs and surfaces a deep-page warning', async () => {
      await seedClusters(Model);

      // PaginationEngine's default deepPageThreshold is 100.
      const repoSmallThreshold = new Repository<IPaginationEdgeDoc>(Model, [], {
        deepPageThreshold: 5,
      });

      const result = (await repoSmallThreshold.getAll({
        page: 10,
        limit: 10,
        sort: { _id: 1 },
      })) as OffsetPaginationResult<IPaginationEdgeDoc>;

      expect(result.method).toBe('offset');
      expect(result.docs.length).toBe(10);
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/Deep pagination/i);
    });
  });

  describe('stale cursor rejection via minCursorVersion', () => {
    it('rejects a cursor older than the configured minCursorVersion', async () => {
      await seedClusters(Model);

      const repoV1 = new Repository<IPaginationEdgeDoc>(Model, [], { cursorVersion: 1 });
      const page1 = (await repoV1.getAll({
        sort: { createdAt: -1 },
        limit: 10,
      })) as KeysetPaginationResult<IPaginationEdgeDoc>;
      expect(page1.next).toBeTypeOf('string');

      // Simulate a breaking format bump: server now requires v2, rejects v1.
      const repoV2 = new Repository<IPaginationEdgeDoc>(Model, [], {
        cursorVersion: 2,
        minCursorVersion: 2,
      });

      await expect(
        repoV2.getAll({
          sort: { createdAt: -1 },
          limit: 10,
          after: page1.next ?? undefined,
        }),
      ).rejects.toThrow(/older than minimum supported|Pagination must restart/i);
    });
  });
});
