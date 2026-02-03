/**
 * QueryParser searchMode Tests
 *
 * Tests for the searchMode feature that supports:
 * - 'text': MongoDB $text search (requires text index)
 * - 'regex': Multi-field $regex search (no index required)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryParser } from '../src/index.js';

describe('QueryParser - searchMode', () => {
  describe('searchMode: text (default)', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser();
    });

    it('should return search string for $text search by default', () => {
      const result = parser.parse({ search: 'azure cloud' });

      expect(result.search).toBe('azure cloud');
      expect(result.filters.$or).toBeUndefined();
    });

    it('should preserve search when no searchMode specified', () => {
      const parser = new QueryParser({});
      const result = parser.parse({ search: 'test query' });

      expect(result.search).toBe('test query');
    });
  });

  describe('searchMode: regex', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['name', 'description', 'sku'],
      });
    });

    it('should build $or with regex for each searchField', () => {
      const result = parser.parse({ search: 'azure' });

      // search should be cleared so Repository doesn't add $text
      expect(result.search).toBeUndefined();

      // Should have $or with regex conditions
      expect(result.filters.$or).toBeDefined();
      expect(result.filters.$or).toHaveLength(3);

      // Verify each field has regex
      const orConditions = result.filters.$or as Record<string, unknown>[];
      expect(orConditions[0]).toHaveProperty('name');
      expect(orConditions[1]).toHaveProperty('description');
      expect(orConditions[2]).toHaveProperty('sku');

      // Verify regex is case-insensitive
      const nameCondition = orConditions[0].name as { $regex: RegExp };
      expect(nameCondition.$regex).toBeInstanceOf(RegExp);
      expect(nameCondition.$regex.flags).toContain('i');
    });

    it('should handle single searchField', () => {
      const singleFieldParser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['title'],
      });

      const result = singleFieldParser.parse({ search: 'test' });

      expect(result.search).toBeUndefined();
      expect(result.filters.$or).toHaveLength(1);
      expect((result.filters.$or as Record<string, unknown>[])[0]).toHaveProperty('title');
    });

    it('should handle multiple searchFields', () => {
      const multiFieldParser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['name', 'description', 'sku', 'tags', 'category'],
      });

      const result = multiFieldParser.parse({ search: 'product' });

      expect(result.filters.$or).toHaveLength(5);
    });

    it('should escape special regex characters in search term', () => {
      const result = parser.parse({ search: 'test.*+?^${}()|[]\\' });

      expect(result.filters.$or).toBeDefined();
      const orConditions = result.filters.$or as Record<string, unknown>[];
      const nameCondition = orConditions[0].name as { $regex: RegExp };

      // Should not throw when testing - pattern is escaped
      expect(() => nameCondition.$regex.test('test')).not.toThrow();
    });

    it('should preserve other filters alongside regex search', () => {
      const result = parser.parse({
        search: 'azure',
        status: 'active',
        'price[gte]': '100',
      });

      expect(result.filters.status).toBe('active');
      expect(result.filters.price).toEqual({ $gte: 100 });
      expect(result.filters.$or).toBeDefined();
    });

    it('should merge with existing $or from URL params', () => {
      const result = parser.parse({
        search: 'test',
        or: [{ status: 'active' }, { status: 'pending' }],
      });

      // Should use $and to combine both $or conditions
      expect(result.filters.$and).toBeDefined();
      expect(result.filters.$and).toHaveLength(2);
      expect(result.filters.$or).toBeUndefined();
    });

    it('should not create $or for empty search', () => {
      const result = parser.parse({ search: '' });

      expect(result.search).toBeUndefined();
      expect(result.filters.$or).toBeUndefined();
    });

    it('should not create $or for whitespace-only search', () => {
      const result = parser.parse({ search: '   ' });

      expect(result.search).toBeUndefined();
      expect(result.filters.$or).toBeUndefined();
    });

    it('should truncate long search queries', () => {
      const longSearch = 'a'.repeat(300);
      const parser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['name'],
        maxSearchLength: 100,
      });

      const result = parser.parse({ search: longSearch });

      expect(result.filters.$or).toBeDefined();
      const orConditions = result.filters.$or as Record<string, unknown>[];
      const nameCondition = orConditions[0].name as { $regex: RegExp };
      expect(nameCondition.$regex.source.length).toBeLessThanOrEqual(100);
    });
  });

  describe('searchMode: regex - validation', () => {
    it('should fallback to text mode when searchFields is missing', () => {
      const parser = new QueryParser({
        searchMode: 'regex',
        // searchFields not provided
      });

      const result = parser.parse({ search: 'test' });

      // Should fallback to text mode
      expect(result.search).toBe('test');
      expect(result.filters.$or).toBeUndefined();
    });

    it('should fallback to text mode when searchFields is empty array', () => {
      const parser = new QueryParser({
        searchMode: 'regex',
        searchFields: [],
      });

      const result = parser.parse({ search: 'test' });

      // Should fallback to text mode
      expect(result.search).toBe('test');
      expect(result.filters.$or).toBeUndefined();
    });
  });

  describe('searchMode: regex - integration with other features', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['name', 'description'],
        enableLookups: true,
      });
    });

    it('should work with pagination', () => {
      const result = parser.parse({
        search: 'test',
        page: 2,
        limit: 50,
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(50);
      expect(result.filters.$or).toBeDefined();
    });

    it('should work with sorting', () => {
      const result = parser.parse({
        search: 'test',
        sort: '-createdAt,name',
      });

      expect(result.sort).toEqual({ createdAt: -1, name: 1 });
      expect(result.filters.$or).toBeDefined();
    });

    it('should work with select/project', () => {
      const result = parser.parse({
        search: 'test',
        select: 'name,description,-password',
      });

      expect(result.select).toEqual({ name: 1, description: 1, password: 0 });
      expect(result.filters.$or).toBeDefined();
    });

    it('should work with cursor pagination', () => {
      const result = parser.parse({
        search: 'test',
        after: 'eyJfaWQiOiIxMjMifQ==',
      });

      expect(result.after).toBe('eyJfaWQiOiIxMjMifQ==');
      expect(result.filters.$or).toBeDefined();
    });
  });

  describe('searchMode: regex - real-world scenarios', () => {
    it('should support product search use case', () => {
      const productParser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['name', 'description', 'sku', 'tags'],
        maxLimit: 100,
      });

      const result = productParser.parse({
        search: 'laptop',
        'category': 'electronics',
        'price[gte]': '500',
        'price[lte]': '2000',
        'inStock': 'true',
        sort: '-rating',
        page: 1,
        limit: 20,
      });

      expect(result.filters.$or).toHaveLength(4);
      expect(result.filters.category).toBe('electronics');
      expect(result.filters.price).toEqual({ $gte: 500, $lte: 2000 });
      expect(result.filters.inStock).toBe(true);
      expect(result.sort).toEqual({ rating: -1 });
    });

    it('should support user search use case', () => {
      const userParser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['name', 'email', 'username'],
      });

      const result = userParser.parse({
        search: 'john',
        'role[in]': 'admin,moderator',
        'status': 'active',
      });

      expect(result.filters.$or).toHaveLength(3);
      expect(result.filters.role).toEqual({ $in: ['admin', 'moderator'] });
      expect(result.filters.status).toBe('active');
    });
  });
});
