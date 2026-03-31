/**
 * Pagination at Scale — TDD Tests
 *
 * Tests for 4 production-scale improvements:
 * 1. Compound keyset sort (3+ fields)
 * 2. Collation support
 * 3. $facet 16MB fallback in lookupPopulate
 * 4. lookupPopulate keyset mode
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';
import { validateKeysetSort } from '../src/pagination/utils/sort.js';
import { buildKeysetFilter } from '../src/pagination/utils/filter.js';
import { encodeCursor, decodeCursor } from '../src/pagination/utils/cursor.js';

// ── Schemas ──

interface ITask {
  _id: Types.ObjectId;
  title: string;
  priority: number;
  status: string;
  assignee: string;
  createdAt: Date;
}

const TaskSchema = new Schema<ITask>({
  title: { type: String, required: true },
  priority: { type: Number, required: true },
  status: { type: String, required: true },
  assignee: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
TaskSchema.index({ priority: -1, createdAt: -1, _id: -1 });
TaskSchema.index({ status: 1, priority: -1, _id: -1 });

interface ITag {
  _id: Types.ObjectId;
  name: string;
  slug: string;
}
const TagSchema = new Schema<ITag>({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
});

describe('Pagination at Scale', () => {
  let TaskModel: mongoose.Model<ITask>;
  let TagModel: mongoose.Model<ITag>;
  let taskRepo: Repository<ITask>;

  beforeAll(async () => {
    await connectDB();
    for (const n of ['ScaleTask', 'ScaleTag']) {
      if (mongoose.models[n]) delete mongoose.models[n];
    }
    TaskModel = mongoose.model<ITask>('ScaleTask', TaskSchema);
    TagModel = mongoose.model<ITag>('ScaleTag', TagSchema);
    await TaskModel.init();
    await TagModel.init();
    taskRepo = new Repository(TaskModel);
  });

  afterAll(async () => {
    await TaskModel.deleteMany({});
    await TagModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await TaskModel.deleteMany({});
    await TagModel.deleteMany({});

    const now = new Date();
    await TaskModel.create([
      { title: 'Critical Bug', priority: 10, status: 'open', assignee: 'alice', createdAt: new Date(now.getTime() - 1000) },
      { title: 'Feature A', priority: 5, status: 'open', assignee: 'bob', createdAt: new Date(now.getTime() - 2000) },
      { title: 'Feature B', priority: 5, status: 'open', assignee: 'alice', createdAt: new Date(now.getTime() - 3000) },
      { title: 'Minor Fix', priority: 5, status: 'done', assignee: 'carol', createdAt: new Date(now.getTime() - 4000) },
      { title: 'Refactor', priority: 3, status: 'open', assignee: 'alice', createdAt: new Date(now.getTime() - 5000) },
      { title: 'Docs Update', priority: 1, status: 'done', assignee: 'bob', createdAt: new Date(now.getTime() - 6000) },
      { title: 'Urgent Hotfix', priority: 10, status: 'open', assignee: 'carol', createdAt: new Date(now.getTime() - 500) },
      { title: 'Polish UI', priority: 3, status: 'open', assignee: 'bob', createdAt: new Date(now.getTime() - 7000) },
    ]);

    await TagModel.create([
      { name: 'Bug', slug: 'bug' },
      { name: 'Feature', slug: 'feature' },
    ]);
  });

  // ═══════════════════════════════════════════════════════════════
  // 1. Compound keyset sort (3+ fields)
  // ═══════════════════════════════════════════════════════════════

  describe('Compound keyset sort', () => {
    describe('validateKeysetSort', () => {
      it('accepts 3 fields: priority + createdAt + _id', () => {
        const sort = validateKeysetSort({ priority: -1, createdAt: -1, _id: -1 });
        expect(sort).toEqual({ priority: -1, createdAt: -1, _id: -1 });
      });

      it('auto-adds _id when 2 non-id fields provided', () => {
        const sort = validateKeysetSort({ priority: -1, createdAt: -1 });
        expect(sort._id).toBe(-1);
        expect(Object.keys(sort)).toContain('priority');
        expect(Object.keys(sort)).toContain('createdAt');
      });

      it('_id must match direction of other fields', () => {
        expect(() =>
          validateKeysetSort({ priority: -1, createdAt: -1, _id: 1 }),
        ).toThrow();
      });

      it('_id is always last in normalized output', () => {
        const sort = validateKeysetSort({ _id: -1, priority: -1, createdAt: -1 });
        const keys = Object.keys(sort);
        expect(keys[keys.length - 1]).toBe('_id');
      });
    });

    describe('cursor encode/decode with compound sort', () => {
      it('encodes and decodes multiple sort field values', () => {
        const doc = {
          _id: new mongoose.Types.ObjectId(),
          priority: 5,
          createdAt: new Date('2026-01-15'),
        };
        const sort = { priority: -1 as const, createdAt: -1 as const, _id: -1 as const };

        const token = encodeCursor(doc, 'priority', sort, 1);
        const decoded = decodeCursor(token);

        expect(decoded.sort).toEqual(sort);
        expect(decoded.version).toBe(1);
      });
    });

    describe('compound sort pagination end-to-end', () => {
      it('paginates by priority desc, createdAt desc with cursor', async () => {
        // Page 1: top 3 by priority desc, then createdAt desc
        const p1 = await taskRepo.getAll({
          sort: { priority: -1, createdAt: -1, _id: -1 },
          limit: 3,
        });

        expect(p1.method).toBe('keyset');
        if (p1.method === 'keyset') {
          expect(p1.docs).toHaveLength(3);
          expect(p1.hasMore).toBe(true);

          // First two should be priority 10 (Urgent Hotfix newest, Critical Bug)
          expect((p1.docs[0] as any).priority).toBe(10);
          expect((p1.docs[1] as any).priority).toBe(10);
          expect((p1.docs[2] as any).priority).toBe(5);

          // Page 2
          const p2 = await taskRepo.getAll({
            sort: { priority: -1, createdAt: -1, _id: -1 },
            after: p1.next!,
            limit: 3,
          });

          if (p2.method === 'keyset') {
            expect(p2.docs).toHaveLength(3);
            // All should have priority <= last of page 1
            const lastP1Priority = (p1.docs[2] as any).priority;
            expect((p2.docs[0] as any).priority).toBeLessThanOrEqual(lastP1Priority);
          }
        }
      });

      it('exhausts all docs without duplicates using compound sort', async () => {
        const allIds = new Set<string>();
        let cursor: string | null = null;
        let iterations = 0;

        while (iterations < 10) {
          const result = await taskRepo.getAll({
            sort: { priority: -1, createdAt: -1, _id: -1 },
            ...(cursor ? { after: cursor } : {}),
            limit: 3,
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
          iterations++;
        }

        expect(allIds.size).toBe(8);
      });

      it('compound sort with filters works correctly', async () => {
        const p1 = await taskRepo.getAll({
          filters: { status: 'open' },
          sort: { priority: -1, createdAt: -1, _id: -1 },
          limit: 3,
        });

        if (p1.method === 'keyset') {
          expect(p1.docs).toHaveLength(3);
          // All should be status=open
          for (const d of p1.docs) {
            expect((d as any).status).toBe('open');
          }

          if (p1.next) {
            const p2 = await taskRepo.getAll({
              filters: { status: 'open' },
              sort: { priority: -1, createdAt: -1, _id: -1 },
              after: p1.next,
              limit: 10,
            });

            if (p2.method === 'keyset') {
              for (const d of p2.docs) {
                expect((d as any).status).toBe('open');
              }
              // Total open tasks = 6
              expect(p1.docs.length + p2.docs.length).toBe(6);
            }
          }
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. Collation support
  // ═══════════════════════════════════════════════════════════════

  describe('Collation support', () => {
    beforeEach(async () => {
      await TaskModel.deleteMany({});
      await TaskModel.create([
        { title: 'apple', priority: 1, status: 'open', assignee: 'alice' },
        { title: 'Banana', priority: 2, status: 'open', assignee: 'bob' },
        { title: 'cherry', priority: 3, status: 'open', assignee: 'carol' },
        { title: 'Date', priority: 4, status: 'open', assignee: 'alice' },
      ]);
    });

    it('offset pagination with case-insensitive collation', async () => {
      const result = await taskRepo.getAll({
        sort: { title: 1 },
        page: 1,
        limit: 10,
        collation: { locale: 'en', strength: 2 },
      });

      if (result.method === 'offset') {
        const titles = result.docs.map((d: any) => d.title);
        // Case-insensitive sort: apple, Banana, cherry, Date
        expect(titles).toEqual(['apple', 'Banana', 'cherry', 'Date']);
      }
    });

    it('keyset pagination with collation', async () => {
      const p1 = await taskRepo.getAll({
        sort: { title: 1, _id: 1 },
        limit: 2,
        collation: { locale: 'en', strength: 2 },
      });

      if (p1.method === 'keyset') {
        const titles1 = p1.docs.map((d: any) => d.title);
        expect(titles1).toEqual(['apple', 'Banana']);

        if (p1.next) {
          const p2 = await taskRepo.getAll({
            sort: { title: 1, _id: 1 },
            after: p1.next,
            limit: 2,
            collation: { locale: 'en', strength: 2 },
          });

          if (p2.method === 'keyset') {
            const titles2 = p2.docs.map((d: any) => d.title);
            expect(titles2).toEqual(['cherry', 'Date']);
          }
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. $facet 16MB fallback
  // ═══════════════════════════════════════════════════════════════

  describe('lookupPopulate countStrategy', () => {
    it('countStrategy=none skips count entirely', async () => {
      const result = await taskRepo.getAll({
        lookups: [{
          from: 'scaletags',
          localField: 'status',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
        page: 1,
        limit: 3,
        countStrategy: 'none',
      });

      if (result.method === 'offset') {
        expect(result.docs).toHaveLength(3);
        // With countStrategy=none, total may be 0 but hasNext should work
        expect(typeof result.hasNext).toBe('boolean');
      }
    });

    it('default countStrategy still returns correct total', async () => {
      const result = await taskRepo.getAll({
        lookups: [{
          from: 'scaletags',
          localField: 'status',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
        page: 1,
        limit: 3,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(8);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. lookupPopulate keyset mode
  // ═══════════════════════════════════════════════════════════════

  describe('lookupPopulate keyset mode', () => {
    it('lookup + keyset sort triggers keyset pagination', async () => {
      const result = await taskRepo.getAll({
        sort: { priority: -1, _id: -1 },
        limit: 3,
        lookups: [{
          from: 'scaletags',
          localField: 'status',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
      });

      expect(result.method).toBe('keyset');
      if (result.method === 'keyset') {
        expect(result.docs).toHaveLength(3);
        expect(result.hasMore).toBe(true);
        expect(result.next).toBeTruthy();

        // Lookup data should be present
        for (const d of result.docs) {
          expect((d as any)).toHaveProperty('tag');
        }
      }
    });

    it('lookup + keyset forward pagination with cursor', async () => {
      const p1 = await taskRepo.getAll({
        sort: { priority: -1, _id: -1 },
        limit: 3,
        lookups: [{
          from: 'scaletags',
          localField: 'status',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
      });

      if (p1.method === 'keyset' && p1.next) {
        const p2 = await taskRepo.getAll({
          sort: { priority: -1, _id: -1 },
          after: p1.next,
          limit: 3,
          lookups: [{
            from: 'scaletags',
            localField: 'status',
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

    it('lookup + keyset exhausts all docs without duplicates', async () => {
      const allIds = new Set<string>();
      let cursor: string | null = null;
      let iterations = 0;

      while (iterations < 10) {
        const result = await taskRepo.getAll({
          sort: { _id: 1 },
          ...(cursor ? { after: cursor } : {}),
          limit: 3,
          lookups: [{
            from: 'scaletags',
            localField: 'status',
            foreignField: 'slug',
            as: 'tag',
            single: true,
          }],
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
        iterations++;
      }

      expect(allIds.size).toBe(8);
    });

    it('lookup + keyset with select preserves lookup fields', async () => {
      const result = await taskRepo.getAll({
        sort: { _id: 1 },
        limit: 3,
        select: 'title,priority',
        lookups: [{
          from: 'scaletags',
          localField: 'status',
          foreignField: 'slug',
          as: 'tag',
          single: true,
          select: 'name',
        }],
      });

      if (result.method === 'keyset') {
        for (const d of result.docs) {
          const doc = d as any;
          expect(doc.title).toBeDefined();
          expect(doc.priority).toBeDefined();
          expect(doc).toHaveProperty('tag');
          expect(doc.assignee).toBeUndefined(); // excluded by select
        }
      }
    });

    it('lookup + keyset with filters', async () => {
      const p1 = await taskRepo.getAll({
        filters: { status: 'open' },
        sort: { priority: -1, _id: -1 },
        limit: 2,
        lookups: [{
          from: 'scaletags',
          localField: 'status',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
      });

      if (p1.method === 'keyset') {
        for (const d of p1.docs) {
          expect((d as any).status).toBe('open');
        }
      }
    });

    it('lookup + explicit offset mode still works', async () => {
      const result = await taskRepo.getAll({
        sort: { priority: -1 },
        page: 1,
        limit: 3,
        lookups: [{
          from: 'scaletags',
          localField: 'status',
          foreignField: 'slug',
          as: 'tag',
          single: true,
        }],
      });

      // page param forces offset
      expect(result.method).toBe('offset');
      if (result.method === 'offset') {
        expect(result.total).toBe(8);
        expect(result.docs).toHaveLength(3);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. Production safety: validation & edge cases
  // ═══════════════════════════════════════════════════════════════

  describe('Production safety', () => {
    describe('sort direction validation', () => {
      it('rejects invalid sort direction value (not 1 or -1)', () => {
        expect(() => validateKeysetSort({ priority: 2 as any })).toThrow('must be 1 or -1');
      });

      it('rejects 0 as sort direction', () => {
        expect(() => validateKeysetSort({ priority: 0 as any })).toThrow('must be 1 or -1');
      });

      it('accepts valid 1 and -1 values', () => {
        expect(() => validateKeysetSort({ priority: 1 })).not.toThrow();
        expect(() => validateKeysetSort({ priority: -1 })).not.toThrow();
      });

      it('rejects mixed directions in compound sort', () => {
        expect(() =>
          validateKeysetSort({ priority: -1, createdAt: 1 }),
        ).toThrow('same direction');
      });
    });

    describe('max lookups guard', () => {
      it('rejects more than 10 lookups', async () => {
        const lookups = Array.from({ length: 11 }, (_, i) => ({
          from: `collection_${i}`,
          localField: 'field',
          foreignField: '_id',
          as: `lookup_${i}`,
        }));

        await expect(
          taskRepo.getAll({ lookups, page: 1, limit: 10 }),
        ).rejects.toMatchObject({ status: 400, message: /Too many lookups/ });
      });

      it('accepts 10 lookups', async () => {
        const lookups = Array.from({ length: 10 }, (_, i) => ({
          from: 'scaletags',
          localField: 'status',
          foreignField: 'slug',
          as: `lookup_${i}`,
          single: true,
        }));

        // Should not throw (might return empty lookups but shouldn't error)
        const result = await taskRepo.getAll({ lookups, page: 1, limit: 2 });
        expect(result.docs.length).toBeGreaterThan(0);
      });
    });

    describe('cursor stability under data changes', () => {
      it('keyset cursor still works after new docs inserted', async () => {
        const p1 = await taskRepo.getAll({
          sort: { _id: 1 },
          limit: 3,
        });

        // Insert new docs between pages
        await TaskModel.create([
          { title: 'New Task 1', priority: 99, status: 'open', assignee: 'zack' },
          { title: 'New Task 2', priority: 99, status: 'open', assignee: 'zack' },
        ]);

        if (p1.method === 'keyset' && p1.next) {
          // Page 2 should still work — cursor is position-based
          const p2 = await taskRepo.getAll({
            sort: { _id: 1 },
            after: p1.next,
            limit: 3,
          });

          if (p2.method === 'keyset') {
            expect(p2.docs.length).toBeGreaterThan(0);
            // No overlap with page 1
            const ids1 = new Set(p1.docs.map((d: any) => d._id.toString()));
            for (const d of p2.docs) {
              expect(ids1.has((d as any)._id.toString())).toBe(false);
            }
          }
        }
      });

      it('keyset cursor works after docs deleted', async () => {
        const p1 = await taskRepo.getAll({
          sort: { _id: 1 },
          limit: 3,
        });

        // Delete a doc that was on page 1
        await TaskModel.deleteOne({ _id: (p1.docs[1] as any)._id });

        if (p1.method === 'keyset' && p1.next) {
          const p2 = await taskRepo.getAll({
            sort: { _id: 1 },
            after: p1.next,
            limit: 3,
          });

          if (p2.method === 'keyset') {
            // Should not crash or return duplicates
            expect(p2.docs.length).toBeGreaterThan(0);
          }
        }
      });
    });

    describe('null sort field handling', () => {
      it('handles keyset pagination sorting by field with duplicate values', async () => {
        // Multiple docs share priority=5 — cursor must handle ties correctly
        const result = await taskRepo.getAll({
          sort: { priority: -1, _id: -1 },
          limit: 100,
        });

        if (result.method === 'keyset') {
          // Should return all 8 docs despite many sharing priority=5
          expect(result.docs.length).toBe(8);

          // Verify sort is correct — priorities should be descending
          const priorities = result.docs.map((d: any) => d.priority);
          for (let i = 1; i < priorities.length; i++) {
            expect(priorities[i]).toBeLessThanOrEqual(priorities[i - 1]);
          }
        }
      });
    });

    describe('pagination boundary conditions', () => {
      it('limit=1 works correctly with keyset', async () => {
        const allIds = new Set<string>();
        let cursor: string | null = null;
        let iterations = 0;

        while (iterations < 20) {
          const result = await taskRepo.getAll({
            sort: { _id: 1 },
            ...(cursor ? { after: cursor } : {}),
            limit: 1,
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
          iterations++;
        }

        expect(allIds.size).toBe(8);
      });

      it('maxLimit is enforced', async () => {
        const repo = new Repository(TaskModel, [], { maxLimit: 5 });
        const result = await repo.getAll({ page: 1, limit: 999 });

        if (result.method === 'offset') {
          expect(result.limit).toBe(5);
          expect(result.docs.length).toBeLessThanOrEqual(5);
        }
      });
    });
  });
});
