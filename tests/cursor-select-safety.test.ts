/**
 * Cursor + Select Safety Tests
 *
 * TDD for 3 bugs:
 * 1. HIGH: select excludes sort field → cursor encodes null → next page breaks
 * 2. MEDIUM: lookup path ignores hook-mutated context for lookups/countStrategy
 * 3. LOW: AggregatePaginationOptions.countStrategy type vs runtime mismatch
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, type Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';

// ── Schema ──

interface IArticle {
  _id: Types.ObjectId;
  title: string;
  status: string;
  views: number;
  category: string;
  createdAt: Date;
}

const ArticleSchema = new Schema<IArticle>({
  title: { type: String, required: true },
  status: { type: String, required: true },
  views: { type: Number, default: 0 },
  category: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
ArticleSchema.index({ createdAt: -1, _id: -1 });
ArticleSchema.index({ views: -1, _id: -1 });

interface ITag {
  _id: Types.ObjectId;
  name: string;
  slug: string;
}

const TagSchema = new Schema<ITag>({
  name: String,
  slug: { type: String, unique: true },
});

describe('Cursor + Select Safety', () => {
  let ArticleModel: mongoose.Model<IArticle>;
  let TagModel: mongoose.Model<ITag>;
  let repo: Repository<IArticle>;

  beforeAll(async () => {
    await connectDB();
    for (const n of ['CssArticle', 'CssTag']) {
      if (mongoose.models[n]) delete mongoose.models[n];
    }
    ArticleModel = mongoose.model<IArticle>('CssArticle', ArticleSchema);
    TagModel = mongoose.model<ITag>('CssTag', TagSchema);
    await ArticleModel.init();
    await TagModel.init();
    repo = new Repository(ArticleModel);
  });

  afterAll(async () => {
    await ArticleModel.deleteMany({});
    await TagModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await ArticleModel.deleteMany({});
    await TagModel.deleteMany({});

    const now = Date.now();
    await ArticleModel.create([
      { title: 'A', status: 'published', views: 100, category: 'tech', createdAt: new Date(now - 1000) },
      { title: 'B', status: 'published', views: 200, category: 'tech', createdAt: new Date(now - 2000) },
      { title: 'C', status: 'draft', views: 50, category: 'science', createdAt: new Date(now - 3000) },
      { title: 'D', status: 'published', views: 300, category: 'tech', createdAt: new Date(now - 4000) },
      { title: 'E', status: 'draft', views: 10, category: 'science', createdAt: new Date(now - 5000) },
      { title: 'F', status: 'published', views: 150, category: 'tech', createdAt: new Date(now - 6000) },
    ]);

    await TagModel.create([
      { name: 'Tech', slug: 'tech' },
      { name: 'Science', slug: 'science' },
    ]);
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug 1 (HIGH): select excludes sort field → broken cursor
  // ═══════════════════════════════════════════════════════════════

  describe('select excludes sort field — cursor must still work', () => {
    it('keyset: select=title with sort=createdAt paginates correctly', async () => {
      // select excludes createdAt, but cursor needs it
      const p1 = await repo.getAll({
        sort: { createdAt: -1, _id: -1 },
        select: 'title',
        limit: 3,
      });

      expect(p1.method).toBe('keyset');
      if (p1.method === 'keyset') {
        expect(p1.docs).toHaveLength(3);
        expect(p1.next).toBeTruthy();

        // Page 2 must not crash or return duplicates
        const p2 = await repo.getAll({
          sort: { createdAt: -1, _id: -1 },
          select: 'title',
          after: p1.next!,
          limit: 3,
        });

        if (p2.method === 'keyset') {
          expect(p2.docs).toHaveLength(3);

          // No overlap
          const ids1 = new Set(p1.docs.map((d: any) => d._id.toString()));
          for (const d of p2.docs) {
            expect(ids1.has((d as any)._id.toString())).toBe(false);
          }
        }
      }
    });

    it('keyset: select=title,views with sort=views paginates all docs', async () => {
      const allIds = new Set<string>();
      let cursor: string | null = null;

      for (let i = 0; i < 10; i++) {
        const result = await repo.getAll({
          sort: { views: -1, _id: -1 },
          select: 'title',  // views excluded from select but used in sort
          ...(cursor ? { after: cursor } : {}),
          limit: 2,
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

      expect(allIds.size).toBe(6);
    });

    it('lookup keyset: select excludes sort field still works', async () => {
      const p1 = await repo.getAll({
        sort: { views: -1, _id: -1 },
        select: 'title',
        limit: 3,
        lookups: [{
          from: 'csstags',
          localField: 'category',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
      });

      expect(p1.method).toBe('keyset');
      if (p1.method === 'keyset' && p1.next) {
        const p2 = await repo.getAll({
          sort: { views: -1, _id: -1 },
          select: 'title',
          after: p1.next,
          limit: 3,
          lookups: [{
            from: 'csstags',
            localField: 'category',
            foreignField: 'slug',
            as: 'tag',
            single: true,
          }],
        });

        if (p2.method === 'keyset') {
          expect(p2.docs.length).toBeGreaterThan(0);
          // No overlap
          const ids1 = new Set(p1.docs.map((d: any) => d._id.toString()));
          for (const d of p2.docs) {
            expect(ids1.has((d as any)._id.toString())).toBe(false);
          }
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug 2 (MEDIUM): lookup path honors context overrides
  // ═══════════════════════════════════════════════════════════════

  describe('lookup path respects hook-mutated context', () => {
    it('plugin can override countStrategy via context', async () => {
      const testRepo = new Repository(ArticleModel);
      testRepo.on('before:lookupPopulate', (ctx: any) => {
        ctx.countStrategy = 'none';
      });

      const result = await testRepo.getAll({
        lookups: [{
          from: 'csstags',
          localField: 'category',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
        page: 1,
        limit: 3,
      });

      // Should work without crashing regardless of countStrategy override
      expect(result.docs).toHaveLength(3);
    });

    it('context.lookups from plugin is used when params.lookups absent', async () => {
      const testRepo = new Repository(ArticleModel);
      testRepo.on('before:getAll', (ctx: any) => {
        ctx.lookups = [{
          from: 'csstags',
          localField: 'category',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }];
      });

      const result = await testRepo.getAll({
        page: 1,
        limit: 3,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        for (const d of result.docs) {
          expect((d as any).tag).toBeDefined();
        }
      }
    });

    it('lookupPopulate uses context.after to enter keyset mode', async () => {
      const testRepo = new Repository(ArticleModel);
      let nextCursor: string | null = null;

      testRepo.on('before:lookupPopulate', (ctx: any) => {
        if (ctx.injectAfter && nextCursor) {
          ctx.after = nextCursor;
        }
      });

      const p1 = await testRepo.lookupPopulate({
        lookups: [{
          from: 'csstags',
          localField: 'category',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
        sort: { views: -1, _id: -1 },
        limit: 2,
      });

      nextCursor = p1.next ?? null;
      expect(nextCursor).toBeTruthy();

      const p2 = await testRepo.lookupPopulate({
        lookups: [{
          from: 'csstags',
          localField: 'category',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
        sort: { views: -1, _id: -1 },
        limit: 2,
        injectAfter: true,
      } as any);

      expect(p2.next).toBeDefined();
      const ids1 = new Set((p1.data as any[]).map((d) => d._id.toString()));
      for (const d of p2.data as any[]) {
        expect(ids1.has(d._id.toString())).toBe(false);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug 3 (LOW): aggregatePaginate countStrategy type alignment
  // ═══════════════════════════════════════════════════════════════

  describe('aggregatePaginate countStrategy type', () => {
    it('accepts exact', async () => {
      const result = await repo._pagination.aggregatePaginate({
        pipeline: [],
        page: 1,
        limit: 3,
        countStrategy: 'exact',
      });
      expect(result.total).toBe(6);
    });

    it('accepts none', async () => {
      const result = await repo._pagination.aggregatePaginate({
        pipeline: [],
        page: 1,
        limit: 3,
        countStrategy: 'none',
      });
      expect(result.total).toBe(0);
      expect(result.hasNext).toBe(true);
    });

    it('accepts estimated (treated as exact at runtime)', async () => {
      // 'estimated' compiles and is treated as 'exact' at runtime
      const result = await repo._pagination.aggregatePaginate({
        pipeline: [],
        page: 1,
        limit: 3,
        countStrategy: 'estimated',
      });
      expect(result.total).toBe(6);
    });
  });
});
