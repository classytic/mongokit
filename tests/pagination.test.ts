/**
 * Pagination Integration Tests
 * 
 * Tests offset, keyset, and aggregate pagination
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository, PaginationEngine } from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

// Test Schema
interface IPaginatedUser {
  _id: Types.ObjectId;
  name: string;
  email: string;
  age: number;
  status: 'active' | 'inactive';
  score: number;
  category: string;
  createdAt: Date;
}

const PaginatedUserSchema = new Schema<IPaginatedUser>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  age: { type: Number, required: true },
  status: { type: String, enum: ['active', 'inactive'], required: true },
  score: { type: Number, required: true },
  category: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// Create compound indexes for keyset pagination
PaginatedUserSchema.index({ createdAt: -1, _id: -1 });
PaginatedUserSchema.index({ score: -1, _id: -1 });
PaginatedUserSchema.index({ age: 1, _id: 1 });

describe('Pagination', () => {
  let PaginatedUser: mongoose.Model<IPaginatedUser>;
  let repo: Repository<IPaginatedUser>;
  const testData: IPaginatedUser[] = [];

  beforeAll(async () => {
    await connectDB();
    PaginatedUser = await createTestModel('PaginatedUser', PaginatedUserSchema);
    repo = new Repository(PaginatedUser, [], {
      maxLimit: 100,
      defaultLimit: 10,
      maxPage: 1000,
      deepPageThreshold: 50,
    });

    // Clear and create test data
    await PaginatedUser.deleteMany({});

    // Create 100 test users with predictable data
    const baseTime = new Date('2024-01-01T00:00:00Z');
    const users: Partial<IPaginatedUser>[] = [];

    for (let i = 0; i < 100; i++) {
      users.push({
        name: `User ${i.toString().padStart(3, '0')}`,
        email: `user${i}@test.com`,
        age: 20 + (i % 50), // Ages 20-69
        status: i % 3 === 0 ? 'active' : 'inactive',
        score: Math.floor(i / 10) * 100, // 0, 0, ..., 100, 100, ..., 900, 900
        category: ['A', 'B', 'C'][i % 3],
        createdAt: new Date(baseTime.getTime() + i * 60000), // 1 minute apart
      });
    }

    const created = await repo.createMany(users);
    testData.push(...(created as IPaginatedUser[]));
  });

  afterAll(async () => {
    await PaginatedUser.deleteMany({});
    await disconnectDB();
  });

  // ============================================================
  // OFFSET PAGINATION TESTS
  // ============================================================

  describe('Offset Pagination', () => {
    it('should return offset pagination result', async () => {
      const result = await repo.getAll({ page: 1, limit: 10 });

      expect(result.method).toBe('offset');
      expect(result.docs).toHaveLength(10);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(100);
      expect(result.pages).toBe(10);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
    });

    it('should paginate through pages correctly', async () => {
      const page1 = await repo.getAll({ page: 1, limit: 20 });
      const page2 = await repo.getAll({ page: 2, limit: 20 });
      const page5 = await repo.getAll({ page: 5, limit: 20 });

      expect(page1.method).toBe('offset');
      expect(page1.docs).toHaveLength(20);
      expect(page1.page).toBe(1);
      expect(page1.hasPrev).toBe(false);
      expect(page1.hasNext).toBe(true);

      expect(page2.docs).toHaveLength(20);
      expect(page2.page).toBe(2);
      expect(page2.hasPrev).toBe(true);
      expect(page2.hasNext).toBe(true);

      expect(page5.docs).toHaveLength(20);
      expect(page5.page).toBe(5);
      expect(page5.hasPrev).toBe(true);
      expect(page5.hasNext).toBe(false); // Last page

      // Ensure no duplicates between pages
      const page1Ids = page1.docs.map(d => d._id.toString());
      const page2Ids = page2.docs.map(d => d._id.toString());
      const intersection = page1Ids.filter(id => page2Ids.includes(id));
      expect(intersection).toHaveLength(0);
    });

    it('should apply filters', async () => {
      const result = await repo.getAll({
        page: 1,
        limit: 50,
        filters: { status: 'active' },
      });

      expect(result.method).toBe('offset');
      expect(result.docs.every(u => u.status === 'active')).toBe(true);
      expect(result.total).toBeLessThan(100); // Some are inactive
    });

    it('should apply sort', async () => {
      const result = await repo.getAll({
        page: 1,
        limit: 20,
        sort: { age: 1 }, // Ascending
      });

      expect(result.method).toBe('offset');
      for (let i = 1; i < result.docs.length; i++) {
        expect(result.docs[i].age).toBeGreaterThanOrEqual(result.docs[i - 1].age);
      }
    });

    it('should cap limit at maxLimit', async () => {
      const result = await repo.getAll({ page: 1, limit: 9999 });

      expect(result.limit).toBe(100); // maxLimit from config
    });

    it('should warn on deep pagination', async () => {
      const result = await repo.getAll({ page: 51, limit: 1 });

      expect(result.method).toBe('offset');
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('Deep pagination');
    });

    it('should enforce maxPage', async () => {
      await expect(repo.getAll({ page: 1001 }))
        .rejects.toThrow('exceeds max');
    });

    it('should support pagination param object', async () => {
      const result = await repo.getAll({
        pagination: { page: 2, limit: 15 },
      });

      expect(result.method).toBe('offset');
      expect(result.page).toBe(2);
      expect(result.limit).toBe(15);
    });

    it('should default to page 1 when no pagination specified', async () => {
      const result = await repo.getAll({ filters: { status: 'active' } });

      expect(result.method).toBe('offset');
      expect(result.page).toBe(1);
    });
  });

  // ============================================================
  // KEYSET PAGINATION TESTS
  // ============================================================

  describe('Keyset Pagination', () => {
    it('should return keyset pagination result', async () => {
      const result = await repo.getAll({
        sort: { createdAt: -1 },
        limit: 10,
      });

      expect(result.method).toBe('keyset');
      expect(result.docs).toHaveLength(10);
      expect(result.limit).toBe(10);
      expect(result.hasMore).toBe(true);
      expect(result.next).toBeDefined();
      expect(typeof result.next).toBe('string');
    });

    it('should paginate forward using cursor', async () => {
      // First page
      const page1 = await repo.getAll({
        sort: { createdAt: -1 },
        limit: 20,
      });

      expect(page1.method).toBe('keyset');
      expect(page1.docs).toHaveLength(20);
      expect(page1.next).toBeDefined();

      // Second page
      const page2 = await repo.getAll({
        after: page1.next!,
        sort: { createdAt: -1 },
        limit: 20,
      });

      expect(page2.method).toBe('keyset');
      expect(page2.docs).toHaveLength(20);

      // Ensure no duplicates
      const page1Ids = page1.docs.map(d => d._id.toString());
      const page2Ids = page2.docs.map(d => d._id.toString());
      const intersection = page1Ids.filter(id => page2Ids.includes(id));
      expect(intersection).toHaveLength(0);

      // Ensure createdAt is descending
      for (let i = 1; i < page1.docs.length; i++) {
        expect(page1.docs[i - 1].createdAt.getTime())
          .toBeGreaterThanOrEqual(page1.docs[i].createdAt.getTime());
      }
    });

    it('should handle ascending sort', async () => {
      const page1 = await repo.getAll({
        sort: { age: 1 },
        limit: 20,
      });

      const page2 = await repo.getAll({
        after: page1.next!,
        sort: { age: 1 },
        limit: 20,
      });

      // Check ascending order
      for (let i = 1; i < page1.docs.length; i++) {
        expect(page1.docs[i].age).toBeGreaterThanOrEqual(page1.docs[i - 1].age);
      }

      // Page 2 should continue where page 1 left off
      const lastAge1 = page1.docs[page1.docs.length - 1].age;
      const firstAge2 = page2.docs[0].age;
      expect(firstAge2).toBeGreaterThanOrEqual(lastAge1);
    });

    it('should handle descending sort', async () => {
      const page1 = await repo.getAll({
        sort: { score: -1 },
        limit: 20,
      });

      const page2 = await repo.getAll({
        after: page1.next!,
        sort: { score: -1 },
        limit: 20,
      });

      // Check descending order
      for (let i = 1; i < page1.docs.length; i++) {
        expect(page1.docs[i].score).toBeLessThanOrEqual(page1.docs[i - 1].score);
      }
    });

    it('should handle ties with _id tie-breaker', async () => {
      // Score has ties (10 users share each score value)
      const allDocs: IPaginatedUser[] = [];
      let cursor: string | null = null;

      // Fetch all pages
      for (let i = 0; i < 10; i++) {
        const page = await repo.getAll({
          after: cursor || undefined,
          sort: { score: -1 },
          limit: 15,
        });

        allDocs.push(...(page.docs as IPaginatedUser[]));
        cursor = page.next;

        if (!page.hasMore) break;
      }

      // Should have fetched all 100 documents with no duplicates
      const uniqueIds = new Set(allDocs.map(d => d._id.toString()));
      expect(uniqueIds.size).toBe(allDocs.length);
      expect(allDocs.length).toBe(100);
    });

    it('should apply filters with keyset pagination', async () => {
      const result = await repo.getAll({
        filters: { status: 'active' },
        sort: { createdAt: -1 },
        limit: 50,
      });

      expect(result.method).toBe('keyset');
      expect(result.docs.every(u => u.status === 'active')).toBe(true);
    });

    it('should indicate hasMore correctly', async () => {
      const smallPage = await repo.getAll({
        sort: { createdAt: -1 },
        limit: 10,
      });
      expect(smallPage.hasMore).toBe(true);

      const largePage = await repo.getAll({
        sort: { createdAt: -1 },
        limit: 200, // More than total
      });
      expect(largePage.hasMore).toBe(false);
      expect(largePage.next).toBeNull();
    });

    it('should reject invalid cursor', async () => {
      await expect(repo.getAll({
        after: 'invalid-cursor-token',
        sort: { createdAt: -1 },
        limit: 10,
      })).rejects.toThrow('Invalid cursor');
    });

    it('should reject sort mismatch with cursor', async () => {
      const page1 = await repo.getAll({
        sort: { createdAt: -1 },
        limit: 10,
      });

      // Try to use cursor with different sort
      await expect(repo.getAll({
        after: page1.next!,
        sort: { age: 1 }, // Different sort
        limit: 10,
      })).rejects.toThrow('sort does not match');
    });

    it('should support cursor param alias', async () => {
      const page1 = await repo.getAll({
        sort: { createdAt: -1 },
        limit: 10,
      });

      const page2 = await repo.getAll({
        cursor: page1.next!, // Using 'cursor' instead of 'after'
        sort: { createdAt: -1 },
        limit: 10,
      });

      expect(page2.method).toBe('keyset');
      expect(page2.docs).toHaveLength(10);
    });
  });

  // ============================================================
  // AGGREGATE PAGINATION TESTS
  // ============================================================

  describe('Aggregate Pagination', () => {
    it('should return aggregate pagination result', async () => {
      const result = await repo.aggregatePaginate({
        pipeline: [{ $match: { status: 'active' } }],
        page: 1,
        limit: 10,
      });

      expect(result.method).toBe('aggregate');
      expect(result.docs).toBeDefined();
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.total).toBeDefined();
      expect(result.pages).toBeDefined();
      expect(result.hasNext).toBeDefined();
      expect(result.hasPrev).toBe(false);
    });

    it('should paginate aggregate results', async () => {
      const pipeline = [
        { $match: { status: 'active' } },
        { $project: { name: 1, age: 1, score: 1 } },
      ];

      const page1 = await repo.aggregatePaginate({ pipeline, page: 1, limit: 10 });
      const page2 = await repo.aggregatePaginate({ pipeline, page: 2, limit: 10 });

      expect(page1.page).toBe(1);
      expect(page2.page).toBe(2);
      expect(page1.docs[0]._id.toString()).not.toBe(page2.docs[0]._id.toString());
    });

    it('should handle grouping in pipeline', async () => {
      const result = await repo.aggregatePaginate({
        pipeline: [
          { $group: { _id: '$category', count: { $sum: 1 }, avgAge: { $avg: '$age' } } },
          { $sort: { count: -1 } },
        ],
        page: 1,
        limit: 10,
      });

      expect(result.method).toBe('aggregate');
      expect(result.docs.length).toBeGreaterThan(0);
      expect(result.docs[0]).toHaveProperty('count');
      expect(result.docs[0]).toHaveProperty('avgAge');
    });

    it('should handle empty results', async () => {
      const result = await repo.aggregatePaginate({
        pipeline: [{ $match: { status: 'nonexistent' } }],
        page: 1,
        limit: 10,
      });

      expect(result.docs).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.pages).toBe(0);
    });

    it('should warn on deep pagination', async () => {
      const result = await repo.aggregatePaginate({
        pipeline: [{ $match: {} }],
        page: 51,
        limit: 1,
      });

      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('Deep pagination');
    });
  });

  // ============================================================
  // PAGINATION ENGINE DIRECT TESTS
  // ============================================================

  describe('PaginationEngine', () => {
    let engine: PaginationEngine<IPaginatedUser>;

    beforeAll(() => {
      engine = new PaginationEngine(PaginatedUser, {
        defaultLimit: 10,
        maxLimit: 50,
        maxPage: 100,
        deepPageThreshold: 20,
      });
    });

    it('should use config defaults', async () => {
      const result = await engine.paginate({});

      expect(result.limit).toBe(10); // defaultLimit
    });

    it('should enforce maxLimit', async () => {
      const result = await engine.paginate({ limit: 1000 });

      expect(result.limit).toBe(50); // maxLimit
    });

    it('paginate() returns offset result', async () => {
      const result = await engine.paginate({ page: 1, limit: 10 });

      expect(result.method).toBe('offset');
      expect(result.page).toBe(1);
    });

    it('stream() returns keyset result', async () => {
      const result = await engine.stream({ sort: { createdAt: -1 }, limit: 10 });

      expect(result.method).toBe('keyset');
      expect(result.hasMore).toBeDefined();
    });

    it('stream() requires sort', async () => {
      await expect(engine.stream({ limit: 10 } as Parameters<typeof engine.stream>[0]))
        .rejects.toThrow('sort is required');
    });

    it('aggregatePaginate() returns aggregate result', async () => {
      const result = await engine.aggregatePaginate({
        pipeline: [{ $match: {} }],
        page: 1,
        limit: 10,
      });

      expect(result.method).toBe('aggregate');
    });
  });

  // ============================================================
  // AUTO-DETECTION TESTS
  // ============================================================

  describe('Auto-detection of Pagination Mode', () => {
    it('should use offset mode when page is specified', async () => {
      const result = await repo.getAll({ page: 1 });
      expect(result.method).toBe('offset');
    });

    it('should use offset mode when pagination object is specified', async () => {
      const result = await repo.getAll({ pagination: { page: 1, limit: 10 } });
      expect(result.method).toBe('offset');
    });

    it('should use keyset mode when after is specified', async () => {
      const result = await repo.getAll({ sort: { createdAt: -1 }, limit: 10 });
      const result2 = await repo.getAll({ after: result.next!, sort: { createdAt: -1 } });
      expect(result2.method).toBe('keyset');
    });

    it('should use keyset mode when cursor is specified', async () => {
      const result = await repo.getAll({ sort: { createdAt: -1 }, limit: 10 });
      const result2 = await repo.getAll({ cursor: result.next!, sort: { createdAt: -1 } });
      expect(result2.method).toBe('keyset');
    });

    it('should use keyset mode when explicit sort without page', async () => {
      const result = await repo.getAll({ sort: { age: 1 }, limit: 10 });
      expect(result.method).toBe('keyset');
    });

    it('should prioritize page over sort for mode detection', async () => {
      // If both page and sort are provided, page takes precedence
      const result = await repo.getAll({ page: 1, sort: { age: 1 }, limit: 10 });
      expect(result.method).toBe('offset');
    });
  });
});
