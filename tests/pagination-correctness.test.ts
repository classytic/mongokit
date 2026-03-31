/**
 * Pagination Correctness — E2E with seed data
 *
 * Validates 4 bugs + clean structural assertions:
 * 1. $lookup pipeline form auto-correlates when localField/foreignField given
 * 2. countStrategy:'estimated' warns/falls back for filtered queries
 * 3. lookupPopulate countStrategy:'none' preserves hasNext through getAll
 * 4. aggregatePaginate countStrategy:'estimated' behaves consistently
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Repository } from '../src/index.js';
import { LookupBuilder } from '../src/query/LookupBuilder.js';
import { connectDB, disconnectDB } from './setup.js';
import {
  seedAll,
  getModels,
  TOTAL_PRODUCTS,
  ACTIVE_PRODUCTS,
  type IProduct,
  type ICategory,
} from './fixtures/seed-products.js';
import type mongoose from 'mongoose';

describe('Pagination correctness (E2E)', () => {
  let ProductModel: mongoose.Model<IProduct>;
  let CategoryModel: mongoose.Model<ICategory>;
  let repo: Repository<IProduct>;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    const { CategoryModel: C, ProductModel: P } = getModels();
    await C.deleteMany({});
    await P.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    const seeded = await seedAll();
    ProductModel = seeded.ProductModel;
    CategoryModel = seeded.CategoryModel;
    repo = new Repository(ProductModel);
  });

  // ═══════════════════════════════════════════════════════════════
  // Seed data sanity
  // ═══════════════════════════════════════════════════════════════

  describe('seed data', () => {
    it('has expected counts', async () => {
      expect(await ProductModel.countDocuments()).toBe(TOTAL_PRODUCTS);
      expect(await ProductModel.countDocuments({ status: 'active' })).toBe(ACTIVE_PRODUCTS);
      expect(await CategoryModel.countDocuments()).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug 1: $lookup pipeline form must auto-correlate
  // ═══════════════════════════════════════════════════════════════

  describe('$lookup pipeline correlation', () => {
    it('custom pipeline with localField/foreignField auto-generates join', () => {
      // When user provides pipeline + localField/foreignField but no let,
      // LookupBuilder should auto-add let + $match.$expr so it's NOT a cartesian join
      const stages = new LookupBuilder('categories')
        .localField('categorySlug')
        .foreignField('slug')
        .pipeline([{ $project: { name: 1 } }])
        .as('cat')
        .build();

      const lookup = (stages[0] as any).$lookup;
      // Must have let for correlation
      expect(lookup.let).toBeDefined();
      // Pipeline must start with $match.$expr for the join
      expect(lookup.pipeline[0].$match.$expr).toBeDefined();
      // User's $project must still be present
      const hasProject = lookup.pipeline.some((s: any) => s.$project);
      expect(hasProject).toBe(true);
    });

    it('custom pipeline join returns correct data (not cartesian)', async () => {
      const result = await repo.getAll({
        filters: { name: 'Laptop' },
        lookups: [{
          from: 'seedcats',
          localField: 'categorySlug',
          foreignField: 'slug',
          as: 'cat',
          single: true,
          pipeline: [{ $project: { name: 1 } }],
          sanitize: false, // trust server-side pipeline
        }],
      });

      expect(result.docs).toHaveLength(1);
      const laptop = result.docs[0] as any;
      expect(laptop.cat).toBeDefined();
      expect(laptop.cat.name).toBe('Electronics');
      // Must NOT be an array of all categories (cartesian)
    });

    it('$expr is NOT stripped from auto-generated join pipelines', () => {
      // The select shorthand auto-generates let + $match.$expr internally
      // sanitize=false is set by the builder for auto-generated pipelines
      const stages = LookupBuilder.multiple([{
        from: 'categories',
        localField: 'categorySlug',
        foreignField: 'slug',
        as: 'cat',
        select: 'name',
      }]);

      const lookup = (stages[0] as any).$lookup;
      // The auto-generated $match.$expr must survive (not be sanitized)
      const matchStage = lookup.pipeline[0];
      expect(matchStage.$match.$expr).toBeDefined();
    });

    it('user-provided $expr in custom pipeline is preserved (not dangerous)', () => {
      const stages = new LookupBuilder('categories')
        .localField('categorySlug')
        .foreignField('slug')
        .pipeline([
          { $match: { $expr: { $eq: ['$slug', '$$categorySlug'] } } },
        ])
        .as('cat')
        .build();

      const lookup = (stages[0] as any).$lookup;
      // pipeline[0] = auto-generated join
      // pipeline[1] = user's $match.$expr — preserved since $expr is safe
      expect(lookup.pipeline[0].$match.$expr).toBeDefined();
      expect(lookup.pipeline[1].$match.$expr).toBeDefined();
    });

    it('user can opt out of sanitization with sanitize: false', () => {
      const stages = new LookupBuilder('categories')
        .localField('categorySlug')
        .foreignField('slug')
        .pipeline([
          { $match: { $expr: { $eq: ['$slug', '$$categorySlug'] } } },
        ])
        .as('cat')
        .sanitize(false)
        .build();

      const lookup = (stages[0] as any).$lookup;
      const matchStage = lookup.pipeline[0];
      expect(matchStage.$match.$expr).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug 2: countStrategy:'estimated' with filters
  // ═══════════════════════════════════════════════════════════════

  describe('countStrategy: estimated + filters', () => {
    it('estimated without filters returns approximate total', async () => {
      const result = await repo.getAll({
        page: 1,
        limit: 5,
        countStrategy: 'estimated',
      });

      if (result.method === 'offset') {
        // estimatedDocumentCount returns ~12 (total collection)
        expect(result.total).toBeGreaterThanOrEqual(TOTAL_PRODUCTS - 1);
        expect(result.total).toBeLessThanOrEqual(TOTAL_PRODUCTS + 1);
      }
    });

    it('estimated WITH filters falls back to exact count', async () => {
      // This is the bug: estimated + filters should NOT use estimatedDocumentCount
      // because that ignores filters entirely
      const result = await repo.getAll({
        filters: { status: 'active' },
        page: 1,
        limit: 5,
        countStrategy: 'estimated',
      });

      if (result.method === 'offset') {
        // Must return filtered count (8), NOT total collection count (12)
        expect(result.total).toBe(ACTIVE_PRODUCTS);
      }
    });

    it('exact with filters returns correct count', async () => {
      const result = await repo.getAll({
        filters: { status: 'active' },
        page: 1,
        limit: 5,
        countStrategy: 'exact',
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(ACTIVE_PRODUCTS);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug 3: lookupPopulate countStrategy:'none' + hasNext
  // ═══════════════════════════════════════════════════════════════

  describe('lookupPopulate countStrategy:none hasNext', () => {
    const catLookup = {
      from: 'seedcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'cat',
      single: true,
    };

    it('hasNext is true when more pages exist', async () => {
      const result = await repo.getAll({
        lookups: [catLookup],
        page: 1,
        limit: 5,
        countStrategy: 'none',
      });

      // 12 products, page 1 limit 5 → hasNext must be true
      expect(result.method).toBe('offset');
      if (result.method === 'offset') {
        expect(result.docs).toHaveLength(5);
        expect(result.hasNext).toBe(true);
      }
    });

    it('hasNext is false on last page', async () => {
      const result = await repo.getAll({
        lookups: [catLookup],
        sort: { _id: 1 },
        page: 3,
        limit: 5,
        countStrategy: 'none',
      });

      if (result.method === 'offset') {
        // Page 3 of 12 items at limit 5 = 2 items
        expect(result.docs).toHaveLength(2);
        expect(result.hasNext).toBe(false);
      }
    });

    it('lookup data is present with countStrategy:none', async () => {
      const result = await repo.getAll({
        lookups: [catLookup],
        page: 1,
        limit: 3,
        countStrategy: 'none',
      });

      if (result.method === 'offset') {
        for (const doc of result.docs) {
          expect((doc as any).cat).toBeDefined();
          expect((doc as any).cat.name).toBeDefined();
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug 4: aggregatePaginate countStrategy consistency
  // ═══════════════════════════════════════════════════════════════

  describe('aggregatePaginate countStrategy', () => {
    it('exact returns real count', async () => {
      const engine = repo._pagination;
      const result = await engine.aggregatePaginate({
        pipeline: [{ $match: { status: 'active' } }],
        page: 1,
        limit: 5,
        countStrategy: 'exact',
      });

      expect(result.total).toBe(ACTIVE_PRODUCTS);
    });

    it('none skips count and detects hasNext', async () => {
      const engine = repo._pagination;
      const result = await engine.aggregatePaginate({
        pipeline: [{ $match: { status: 'active' } }],
        page: 1,
        limit: 5,
        countStrategy: 'none',
      });

      expect(result.total).toBe(0);
      expect(result.docs).toHaveLength(5);
      expect(result.hasNext).toBe(true); // 8 active, page 1 of 5 = more
    });

    it('aggregate countStrategy only accepts exact or none', async () => {
      const engine = repo._pagination;
      // 'exact' works
      const exact = await engine.aggregatePaginate({
        pipeline: [{ $match: { status: 'active' } }],
        page: 1, limit: 5,
        countStrategy: 'exact',
      });
      expect(exact.total).toBe(ACTIVE_PRODUCTS);

      // 'none' works
      const none = await engine.aggregatePaginate({
        pipeline: [{ $match: { status: 'active' } }],
        page: 1, limit: 5,
        countStrategy: 'none',
      });
      expect(none.total).toBe(0);
      expect(none.hasNext).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // E2E: full pagination traversal with seed data
  // ═══════════════════════════════════════════════════════════════

  describe('full traversal', () => {
    it('offset: all pages return all docs exactly once', async () => {
      const allIds = new Set<string>();

      for (let page = 1; page <= 4; page++) {
        const result = await repo.getAll({
          sort: { _id: 1 },
          page,
          limit: 4,
        });

        if (result.method === 'offset') {
          for (const d of result.docs) {
            const id = (d as any)._id.toString();
            expect(allIds.has(id)).toBe(false);
            allIds.add(id);
          }
        }
      }

      expect(allIds.size).toBe(TOTAL_PRODUCTS);
    });

    it('keyset: all cursors return all docs exactly once', async () => {
      const allIds = new Set<string>();
      let cursor: string | null = null;

      for (let i = 0; i < 10; i++) {
        const result = await repo.getAll({
          sort: { price: -1, _id: -1 },
          ...(cursor ? { after: cursor } : {}),
          limit: 4,
        });

        if (result.method === 'keyset') {
          for (const d of result.docs) {
            const id = (d as any)._id.toString();
            expect(allIds.has(id)).toBe(false);
            allIds.add(id);
          }
          if (!result.hasMore) break;
          cursor = result.next;
        }
      }

      expect(allIds.size).toBe(TOTAL_PRODUCTS);
    });

    it('keyset + lookup: all cursors with joins', async () => {
      const allIds = new Set<string>();
      let cursor: string | null = null;

      for (let i = 0; i < 10; i++) {
        const result = await repo.getAll({
          sort: { price: -1, _id: -1 },
          ...(cursor ? { after: cursor } : {}),
          limit: 4,
          lookups: [{
            from: 'seedcats',
            localField: 'categorySlug',
            foreignField: 'slug',
            as: 'cat',
            single: true,
          }],
        });

        if (result.method === 'keyset') {
          for (const d of result.docs) {
            const id = (d as any)._id.toString();
            expect(allIds.has(id)).toBe(false);
            allIds.add(id);
            // Join data present on every doc
            expect((d as any).cat).toBeDefined();
          }
          if (!result.hasMore) break;
          cursor = result.next;
        }
      }

      expect(allIds.size).toBe(TOTAL_PRODUCTS);
    });

    it('filtered offset: correct total across pages', async () => {
      const p1 = await repo.getAll({
        filters: { status: 'active' },
        sort: { price: -1 },
        page: 1,
        limit: 3,
      });
      const p2 = await repo.getAll({
        filters: { status: 'active' },
        sort: { price: -1 },
        page: 2,
        limit: 3,
      });

      if (p1.method === 'offset' && p2.method === 'offset') {
        expect(p1.total).toBe(ACTIVE_PRODUCTS);
        expect(p2.total).toBe(ACTIVE_PRODUCTS);
        expect(p1.docs).toHaveLength(3);
      }
    });
  });
});
