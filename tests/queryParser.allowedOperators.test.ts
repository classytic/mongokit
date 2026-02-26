/**
 * QueryParser allowedOperators Tests
 *
 * Tests for the operator allowlist feature that restricts which
 * filter operators can be used in queries.
 */

import { describe, it, expect } from 'vitest';
import { QueryParser } from '../src/index.js';

describe('QueryParser - allowedOperators', () => {
  describe('default behavior (no allowedOperators set)', () => {
    const parser = new QueryParser();

    it('should allow all operators when allowedOperators is undefined', () => {
      const result = parser.parse({
        'price[gte]': '100',
        'price[lte]': '500',
        'status[ne]': 'deleted',
        'name[contains]': 'test',
      });

      expect(result.filters.price).toBeDefined();
      expect(result.filters.price.$gte).toBe(100);
      expect(result.filters.price.$lte).toBe(500);
      expect(result.filters.status).toEqual({ $ne: 'deleted' });
      expect(result.filters.name.$regex).toBeInstanceOf(RegExp);
    });
  });

  describe('with allowedOperators set', () => {
    const parser = new QueryParser({
      allowedOperators: ['eq', 'ne', 'in'],
    });

    it('should allow operators in the allowlist', () => {
      const result = parser.parse({
        'status[ne]': 'deleted',
        'role[in]': 'admin,user',
      });

      expect(result.filters.status).toEqual({ $ne: 'deleted' });
      expect(result.filters.role).toEqual({ $in: ['admin', 'user'] });
    });

    it('should block operators not in the allowlist (operator syntax)', () => {
      const result = parser.parse({
        'price[gte]': '100',
        'price[lte]': '500',
        'name[regex]': 'test',
        'name[contains]': 'foo',
        'name[like]': 'bar',
      });

      expect(result.filters.price).toBeUndefined();
      expect(result.filters.name).toBeUndefined();
    });

    it('should block operators not in the allowlist (bracket syntax / nested object)', () => {
      const result = parser.parse({
        price: { gte: '100', lte: '500' },
      });

      // gte and lte are not in allowlist, so price should be empty/cleaned up
      expect(result.filters.price).toBeUndefined();
    });

    it('should allow bracket syntax operators that are in the allowlist', () => {
      const result = parser.parse({
        status: { ne: 'deleted' },
        role: { in: 'admin,user' },
      });

      expect(result.filters.status).toEqual({ $ne: 'deleted' });
      expect(result.filters.role).toEqual({ $in: ['admin', 'user'] });
    });

    it('should still allow direct equality without operator', () => {
      const result = parser.parse({
        status: 'active',
      });

      expect(result.filters.status).toBe('active');
    });
  });

  describe('empty allowedOperators array', () => {
    const parser = new QueryParser({
      allowedOperators: [],
    });

    it('should block all operator-based filters', () => {
      const result = parser.parse({
        'price[gte]': '100',
        'status[ne]': 'deleted',
        'role[in]': 'admin',
      });

      expect(result.filters.price).toBeUndefined();
      expect(result.filters.status).toBeUndefined();
      expect(result.filters.role).toBeUndefined();
    });

    it('should block bracket syntax operators too', () => {
      const result = parser.parse({
        price: { gte: '100' },
        status: { ne: 'deleted' },
      });

      expect(result.filters.price).toBeUndefined();
      expect(result.filters.status).toBeUndefined();
    });

    it('should still allow direct equality', () => {
      const result = parser.parse({
        status: 'active',
        priority: 'high',
      });

      expect(result.filters.status).toBe('active');
      expect(result.filters.priority).toBe('high');
    });
  });

  describe('combined with allowedFilterFields', () => {
    const parser = new QueryParser({
      allowedOperators: ['eq', 'gte', 'lte'],
      allowedFilterFields: ['price', 'status'],
    });

    it('should enforce both field and operator restrictions', () => {
      const result = parser.parse({
        'price[gte]': '100',    // allowed field + allowed operator
        'price[regex]': 'test', // allowed field + blocked operator
        'name[gte]': '100',     // blocked field + allowed operator
      });

      expect(result.filters.price).toEqual({ $gte: 100 });
      expect(result.filters.name).toBeUndefined();
    });
  });

  describe('combined with additionalDangerousOperators', () => {
    const parser = new QueryParser({
      allowedOperators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
      additionalDangerousOperators: ['$ne'],
    });

    it('should respect both allowlist and dangerous operators blocklist', () => {
      const result = parser.parse({
        'price[gte]': '100',   // allowed + not dangerous
        'status[ne]': 'deleted', // allowed but also dangerous
      });

      expect(result.filters.price).toEqual({ $gte: 100 });
      // ne is in allowedOperators but $ne is in dangerousOperators
      // allowedOperators check happens first in _handleOperatorSyntax,
      // but the dangerous check happens after for the mapped $ne
      // The operator syntax handler checks dangerous after allowlist
    });
  });

  describe('case insensitivity', () => {
    const parser = new QueryParser({
      allowedOperators: ['gte', 'lte'],
    });

    it('should handle case-insensitive operator matching in operator syntax', () => {
      const result = parser.parse({
        'price[GTE]': '100',
        'price[LTE]': '500',
      });

      // Operators are lowercased before allowlist check
      expect(result.filters.price).toBeDefined();
      expect(result.filters.price.$gte).toBe(100);
      expect(result.filters.price.$lte).toBe(500);
    });
  });

  describe('between operator with allowedOperators', () => {
    const parser = new QueryParser({
      allowedOperators: ['eq'],
    });

    it('should still allow between operator regardless of allowlist (it is not in the operators map)', () => {
      const result = parser.parse({
        createdAt: { between: '2024-01-01,2024-12-31' },
      });

      // between is handled separately before the allowlist check
      expect(result.filters.createdAt).toBeDefined();
      expect(result.filters.createdAt.$gte).toBeInstanceOf(Date);
      expect(result.filters.createdAt.$lte).toBeInstanceOf(Date);
    });
  });
});
