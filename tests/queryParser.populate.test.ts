/**
 * QueryParser Populate Options Tests
 *
 * Tests for advanced populate options support:
 * - Simple string populate: ?populate=author,category
 * - Advanced object populate: ?populate[author][select]=name,email
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryParser } from '../src/index.js';

describe('QueryParser - Populate Options', () => {
  describe('Simple populate (string)', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser();
    });

    it('should handle simple string populate', () => {
      const result = parser.parse({ populate: 'author' });

      expect(result.populate).toBe('author');
    });

    it('should handle comma-separated populate fields', () => {
      const result = parser.parse({ populate: 'author,category,tags' });

      expect(result.populate).toBe('author,category,tags');
    });

    it('should return undefined when no populate specified', () => {
      const result = parser.parse({ status: 'active' });

      expect(result.populate).toBeUndefined();
    });
  });

  describe('Advanced populate (object with options)', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser();
    });

    it('should parse populate with select option', () => {
      // URL: ?populate[author][select]=name,email
      const result = parser.parse({
        populate: {
          author: { select: 'name,email' },
        },
      });

      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions).toHaveLength(1);
      expect(result.populateOptions![0]).toEqual({
        path: 'author',
        select: 'name email',
      });
    });

    it('should parse multiple populate paths with options', () => {
      // URL: ?populate[author][select]=name&populate[category][select]=title,slug
      const result = parser.parse({
        populate: {
          author: { select: 'name,email' },
          category: { select: 'title,slug' },
        },
      });

      expect(result.populateOptions).toHaveLength(2);
      expect(result.populateOptions).toContainEqual({
        path: 'author',
        select: 'name email',
      });
      expect(result.populateOptions).toContainEqual({
        path: 'category',
        select: 'title slug',
      });
    });

    it('should parse populate with match option', () => {
      // URL: ?populate[comments][match][status]=approved
      const result = parser.parse({
        populate: {
          comments: {
            match: { status: 'approved' },
          },
        },
      });

      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions![0]).toEqual({
        path: 'comments',
        match: { status: 'approved' },
      });
    });

    it('should parse populate with limit option', () => {
      // URL: ?populate[comments][limit]=10
      const result = parser.parse({
        populate: {
          comments: { limit: '10' },
        },
      });

      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions![0]).toEqual({
        path: 'comments',
        options: { limit: 10 },
      });
    });

    it('should parse populate with sort option', () => {
      // URL: ?populate[comments][sort]=-createdAt
      const result = parser.parse({
        populate: {
          comments: { sort: '-createdAt' },
        },
      });

      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions![0]).toEqual({
        path: 'comments',
        options: { sort: { createdAt: -1 } },
      });
    });

    it('should parse populate with combined options', () => {
      // URL: ?populate[author][select]=name,email&populate[author][match][active]=true
      const result = parser.parse({
        populate: {
          author: {
            select: 'name,email',
            match: { active: 'true' },
            limit: '5',
            sort: '-createdAt',
          },
        },
      });

      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions![0]).toEqual({
        path: 'author',
        select: 'name email',
        match: { active: true },
        options: {
          limit: 5,
          sort: { createdAt: -1 },
        },
      });
    });

    it('should handle nested populate (populate within populate)', () => {
      // URL: ?populate[author][populate][department][select]=name
      const result = parser.parse({
        populate: {
          author: {
            select: 'name',
            populate: {
              department: { select: 'name,code' },
            },
          },
        },
      });

      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions![0]).toEqual({
        path: 'author',
        select: 'name',
        populate: {
          path: 'department',
          select: 'name code',
        },
      });
    });

    it('should clear simple populate when advanced options are used', () => {
      const result = parser.parse({
        populate: {
          author: { select: 'name' },
        },
      });

      // Simple populate should be undefined when advanced options are used
      expect(result.populate).toBeUndefined();
      expect(result.populateOptions).toBeDefined();
    });
  });

  describe('Mixed populate handling', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser();
    });

    it('should handle empty populate object', () => {
      const result = parser.parse({
        populate: {},
      });

      expect(result.populate).toBeUndefined();
      expect(result.populateOptions).toBeUndefined();
    });

    it('should handle populate path without options (shorthand)', () => {
      // URL: ?populate[author]=true (shorthand for just populating)
      const result = parser.parse({
        populate: {
          author: 'true',
        },
      });

      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions![0]).toEqual({
        path: 'author',
      });
    });
  });

  describe('Integration with other query features', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser();
    });

    it('should work alongside filters and pagination', () => {
      const result = parser.parse({
        status: 'active',
        page: 2,
        limit: 20,
        sort: '-createdAt',
        populate: {
          author: { select: 'name,email' },
        },
      });

      expect(result.filters.status).toBe('active');
      expect(result.page).toBe(2);
      expect(result.limit).toBe(20);
      expect(result.sort).toEqual({ createdAt: -1 });
      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions![0].path).toBe('author');
    });

    it('should work with select/project', () => {
      const result = parser.parse({
        select: 'title,content,author',
        populate: {
          author: { select: 'name' },
        },
      });

      expect(result.select).toEqual({ title: 1, content: 1, author: 1 });
      expect(result.populateOptions![0]).toEqual({
        path: 'author',
        select: 'name',
      });
    });
  });

  describe('Repository integration', () => {
    it('should produce populateOptions compatible with Repository', () => {
      const parser = new QueryParser();

      // Parse advanced populate URL
      const result = parser.parse({
        populate: {
          author: { select: 'name,email', limit: '10' },
          category: { select: 'title' },
        },
      });

      // populateOptions should be defined and compatible with Mongoose
      expect(result.populateOptions).toBeDefined();
      expect(result.populateOptions).toHaveLength(2);

      // Should be usable directly with Repository.getAll options
      // repo.getAll(params, { populateOptions: result.populateOptions })
      const authorPopulate = result.populateOptions!.find(p => p.path === 'author');
      expect(authorPopulate).toEqual({
        path: 'author',
        select: 'name email',
        options: { limit: 10 },
      });
    });

    it('should allow simple populate fallback', () => {
      const parser = new QueryParser();

      // Simple string populate
      const result = parser.parse({ populate: 'author,category' });

      expect(result.populate).toBe('author,category');
      expect(result.populateOptions).toBeUndefined();

      // Can use: repo.getAll(params, { populate: result.populate })
    });
  });

  describe('Security and validation', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser();
    });

    it('should sanitize populate path names', () => {
      const result = parser.parse({
        populate: {
          '$where': { select: 'name' },
        },
      });

      // Should skip dangerous paths
      expect(result.populateOptions).toBeUndefined();
    });

    it('should handle invalid limit values', () => {
      const result = parser.parse({
        populate: {
          author: { limit: 'invalid' },
        },
      });

      // Should ignore invalid limit
      expect(result.populateOptions![0]).toEqual({
        path: 'author',
      });
    });

    it('should handle deeply nested populate safely', () => {
      const result = parser.parse({
        populate: {
          author: {
            populate: {
              department: {
                populate: {
                  company: {
                    populate: {
                      country: { select: 'name' },
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Should handle nested populates (depth may be limited)
      expect(result.populateOptions).toBeDefined();
    });
  });
});
