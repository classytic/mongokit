/**
 * QueryParser getQuerySchema() Tests
 *
 * Tests for OpenAPI schema generation that Arc's defineResource() auto-detects.
 */

import { describe, it, expect } from 'vitest';
import { QueryParser } from '../src/index.js';

describe('QueryParser - getQuerySchema()', () => {
  describe('return type shape', () => {
    const parser = new QueryParser();

    it('should return an object with type "object" and properties', () => {
      const schema = parser.getQuerySchema();

      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(typeof schema.properties).toBe('object');
    });
  });

  describe('base query parameters', () => {
    const parser = new QueryParser();
    const schema = parser.getQuerySchema();

    it('should include page parameter', () => {
      expect(schema.properties.page).toBeDefined();
      expect(schema.properties.page).toMatchObject({
        type: 'integer',
        default: 1,
        minimum: 1,
      });
    });

    it('should include limit parameter with maxLimit', () => {
      expect(schema.properties.limit).toBeDefined();
      expect(schema.properties.limit).toMatchObject({
        type: 'integer',
        default: 20,
        minimum: 1,
        maximum: 1000,
      });
    });

    it('should include sort parameter', () => {
      expect(schema.properties.sort).toBeDefined();
      expect(schema.properties.sort).toMatchObject({
        type: 'string',
      });
    });

    it('should include search parameter', () => {
      expect(schema.properties.search).toBeDefined();
      expect(schema.properties.search).toMatchObject({
        type: 'string',
        maxLength: 200,
      });
    });

    it('should include select parameter', () => {
      expect(schema.properties.select).toBeDefined();
      expect(schema.properties.select).toMatchObject({
        type: 'string',
      });
    });

    it('should include populate parameter', () => {
      expect(schema.properties.populate).toBeDefined();
      expect(schema.properties.populate).toMatchObject({
        type: 'string',
      });
    });

    it('should include after parameter for keyset pagination', () => {
      expect(schema.properties.after).toBeDefined();
      expect(schema.properties.after).toMatchObject({
        type: 'string',
      });
    });
  });

  describe('respects maxLimit', () => {
    it('should reflect custom maxLimit in limit schema', () => {
      const parser = new QueryParser({ maxLimit: 50 });
      const schema = parser.getQuerySchema();

      expect(schema.properties.limit).toMatchObject({
        maximum: 50,
      });
    });
  });

  describe('respects maxSearchLength', () => {
    it('should reflect custom maxSearchLength in search schema', () => {
      const parser = new QueryParser({ maxSearchLength: 100 });
      const schema = parser.getQuerySchema();

      expect(schema.properties.search).toMatchObject({
        maxLength: 100,
      });
    });
  });

  describe('search mode description', () => {
    it('should describe text search by default', () => {
      const parser = new QueryParser();
      const schema = parser.getQuerySchema();

      expect((schema.properties.search as any).description).toContain('text');
    });

    it('should describe regex search when searchMode is regex', () => {
      const parser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['name', 'description'],
      });
      const schema = parser.getQuerySchema();

      expect((schema.properties.search as any).description).toContain('regex');
      expect((schema.properties.search as any).description).toContain('name');
      expect((schema.properties.search as any).description).toContain('description');
    });
  });

  describe('lookup and aggregation parameters', () => {
    it('should include lookup when enableLookups is true (default)', () => {
      const parser = new QueryParser();
      const schema = parser.getQuerySchema();

      expect(schema.properties.lookup).toBeDefined();
      expect(schema.properties.lookup).toMatchObject({
        type: 'object',
      });
    });

    it('should exclude lookup when enableLookups is false', () => {
      const parser = new QueryParser({ enableLookups: false });
      const schema = parser.getQuerySchema();

      expect(schema.properties.lookup).toBeUndefined();
    });

    it('should exclude aggregate by default (enableAggregations defaults to false)', () => {
      const parser = new QueryParser();
      const schema = parser.getQuerySchema();

      expect(schema.properties.aggregate).toBeUndefined();
    });

    it('should include aggregate when enableAggregations is true', () => {
      const parser = new QueryParser({ enableAggregations: true });
      const schema = parser.getQuerySchema();

      expect(schema.properties.aggregate).toBeDefined();
      expect(schema.properties.aggregate).toMatchObject({
        type: 'object',
      });
    });
  });

  describe('operator documentation', () => {
    it('should include _filterOperators description with all operators by default', () => {
      const parser = new QueryParser();
      const schema = parser.getQuerySchema();

      const filterOps = schema.properties._filterOperators as any;
      expect(filterOps).toBeDefined();
      expect(filterOps.description).toContain('gte');
      expect(filterOps.description).toContain('lte');
      expect(filterOps.description).toContain('in');
      expect(filterOps.description).toContain('regex');
      expect(filterOps.description).toContain('exists');
    });

    it('should only document allowed operators when allowedOperators is set', () => {
      const parser = new QueryParser({
        allowedOperators: ['eq', 'in'],
      });
      const schema = parser.getQuerySchema();

      const filterOps = schema.properties._filterOperators as any;
      expect(filterOps.description).toContain('eq');
      expect(filterOps.description).toContain('in');
      expect(filterOps.description).not.toContain('gte');
      expect(filterOps.description).not.toContain('regex');
    });
  });

  describe('with allowedFilterFields', () => {
    it('should generate explicit field[op] entries for each allowed field and operator', () => {
      const parser = new QueryParser({
        allowedFilterFields: ['price', 'status'],
      });
      const schema = parser.getQuerySchema();

      // Direct equality entries
      expect(schema.properties.price).toBeDefined();
      expect(schema.properties.status).toBeDefined();

      // Operator entries (all operators since no allowedOperators set)
      expect(schema.properties['price[gte]']).toBeDefined();
      expect(schema.properties['price[lte]']).toBeDefined();
      expect(schema.properties['price[gt]']).toBeDefined();
      expect(schema.properties['price[lt]']).toBeDefined();
      expect(schema.properties['price[in]']).toBeDefined();
      expect(schema.properties['status[ne]']).toBeDefined();
      expect(schema.properties['status[in]']).toBeDefined();
    });

    it('should not generate eq operator entry (eq is default via direct equality)', () => {
      const parser = new QueryParser({
        allowedFilterFields: ['status'],
      });
      const schema = parser.getQuerySchema();

      // eq is represented by direct field assignment, no need for status[eq]
      expect(schema.properties['status[eq]']).toBeUndefined();
      expect(schema.properties.status).toBeDefined();
    });

    it('should respect both allowedFilterFields and allowedOperators', () => {
      const parser = new QueryParser({
        allowedFilterFields: ['price', 'status'],
        allowedOperators: ['eq', 'gte', 'lte'],
      });
      const schema = parser.getQuerySchema();

      // Allowed combinations
      expect(schema.properties['price[gte]']).toBeDefined();
      expect(schema.properties['price[lte]']).toBeDefined();

      // Blocked operators should not generate entries
      expect(schema.properties['price[regex]']).toBeUndefined();
      expect(schema.properties['price[in]']).toBeUndefined();
      expect(schema.properties['status[contains]']).toBeUndefined();
    });

    it('should use correct schema types for different operators', () => {
      const parser = new QueryParser({
        allowedFilterFields: ['price', 'name', 'active'],
        allowedOperators: ['gte', 'lte', 'contains', 'exists', 'in'],
      });
      const schema = parser.getQuerySchema();

      // Numeric operators
      expect((schema.properties['price[gte]'] as any).type).toBe('number');
      expect((schema.properties['price[lte]'] as any).type).toBe('number');

      // String operators
      expect((schema.properties['name[contains]'] as any).type).toBe('string');
      expect((schema.properties['name[in]'] as any).type).toBe('string');

      // Boolean operators
      expect((schema.properties['active[exists]'] as any).type).toBe('boolean');
    });
  });

  describe('without allowedFilterFields', () => {
    it('should not generate explicit field entries (fields are unknown)', () => {
      const parser = new QueryParser();
      const schema = parser.getQuerySchema();

      // Should have base params + _filterOperators but no explicit field[op] entries
      const keys = Object.keys(schema.properties);
      const fieldOpKeys = keys.filter((k) => k.includes('[') && k !== '_filterOperators');
      expect(fieldOpKeys).toHaveLength(0);
    });
  });
});
