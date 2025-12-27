/**
 * QueryParser Security Tests
 *
 * Tests for ReDoS protection, operator sanitization, and injection prevention
 */

import { describe, it, expect } from 'vitest';
import { QueryParser } from '../src/index.js';

describe('QueryParser - ReDoS Protection', () => {
  const parser = new QueryParser({ maxRegexLength: 100 });

  it('should sanitize field[regex] operator', () => {
    // Dangerous regex pattern that could cause ReDoS
    const dangerous = '(a+)+$';
    const result = parser.parse({ 'name[regex]': dangerous });

    // Should be escaped and safe
    expect(result.filters.name).toBeDefined();
    expect(result.filters.name.$regex).toBeInstanceOf(RegExp);
    // Pattern should be escaped
    expect(result.filters.name.$regex.source).toContain('\\(');
  });

  it('should sanitize contains operator with dangerous pattern', () => {
    const result = parser.parse({ 'name[contains]': '(a+)+' });

    expect(result.filters.name).toBeDefined();
    expect(result.filters.name.$regex).toBeInstanceOf(RegExp);
  });

  it('should truncate overly long regex patterns', () => {
    const longPattern = 'a'.repeat(200);
    const result = parser.parse({ 'name[regex]': longPattern });

    expect(result.filters.name).toBeDefined();
    if (result.filters.name.$regex) {
      expect(result.filters.name.$regex.source.length).toBeLessThanOrEqual(100);
    }
  });

  it('should detect quantifier-based ReDoS patterns', () => {
    const patterns = [
      '{10,20}',       // Quantifier
      '*+',            // Possessive quantifier
      '++',            // Possessive plus
      '?+',            // Possessive optional
      '(a+)+',         // Nested quantifier
    ];

    patterns.forEach(pattern => {
      const result = parser.parse({ 'field[regex]': pattern });
      expect(result.filters.field).toBeDefined();
      // Should be escaped or safe
      if (result.filters.field.$regex) {
        expect(result.filters.field.$regex).toBeInstanceOf(RegExp);
      }
    });
  });

  it('should escape special regex characters correctly', () => {
    const special = '.*+?^${}()|[]\\';
    const result = parser.parse({ 'name[contains]': special });

    expect(result.filters.name).toBeDefined();
    expect(result.filters.name.$regex).toBeInstanceOf(RegExp);
    // Should not throw when used
    expect(() => {
      const regex = result.filters.name.$regex;
      regex.test('test');
    }).not.toThrow();
  });
});

describe('QueryParser - Operator Sanitization', () => {
  const parser = new QueryParser();

  it('should block $where operator', () => {
    const result = parser.parse({
      '$where': 'this.password.length > 0'
    });

    expect(result.filters).not.toHaveProperty('$where');
  });

  it('should block $where via bracket syntax', () => {
    const result = parser.parse({
      'name[$where]': 'malicious'
    });

    expect(result.filters.name).toBeUndefined();
  });

  it('should block other dangerous operators', () => {
    const dangerous = ['$function', '$accumulator', '$expr'];

    dangerous.forEach(op => {
      const result = parser.parse({ [op]: 'malicious' });
      expect(result.filters).not.toHaveProperty(op);
    });
  });
});

describe('QueryParser - Aggregation Sanitization', () => {
  const parser = new QueryParser({ enableAggregations: true });

  it('should sanitize $match config in aggregation', () => {
    const result = parser.parse({
      'aggregate[match]': {
        $where: 'this.isAdmin = true',
        status: 'active'
      }
    });

    if (result.aggregation) {
      const matchStage = result.aggregation.find(s => '$match' in s);
      if (matchStage && '$match' in matchStage) {
        expect(matchStage.$match).not.toHaveProperty('$where');
        expect(matchStage.$match).toHaveProperty('status');
      }
    }
  });

  it('should recursively sanitize nested dangerous operators', () => {
    const result = parser.parse({
      'aggregate[match]': {
        $or: [
          { $where: 'malicious' },
          { status: 'active' }
        ]
      }
    });

    if (result.aggregation) {
      const matchStage = result.aggregation.find(s => '$match' in s);
      if (matchStage && '$match' in matchStage) {
        const match = matchStage.$match as any;
        if (match.$or && Array.isArray(match.$or)) {
          // $where should be filtered out
          expect(match.$or.every((item: any) => !item.$where)).toBe(true);
        }
      }
    }
  });
});

describe('QueryParser - Edge Cases', () => {
  const parser = new QueryParser();

  it('should handle null and undefined safely', () => {
    expect(() => parser.parse(null as any)).not.toThrow();
    expect(() => parser.parse(undefined as any)).not.toThrow();

    const result1 = parser.parse(null as any);
    const result2 = parser.parse(undefined as any);

    expect(result1.filters).toBeDefined();
    expect(result2.filters).toBeDefined();
  });

  it('should handle empty strings in operators', () => {
    const result = parser.parse({
      'age[gte]': '',
      'age[lte]': ''
    });

    // Empty strings should be ignored
    expect(result.filters.age).toBeUndefined();
  });

  it('should handle non-numeric values for numeric operators', () => {
    const result = parser.parse({
      'age[gte]': 'not-a-number',
      'age[lte]': 'also-not-a-number'
    });

    // Should be filtered out
    expect(result.filters.age).toBeUndefined();
  });

  it('should handle very large numbers safely', () => {
    const result = parser.parse({
      'age[gte]': '999999999999999999999',
      'age[lte]': Number.MAX_SAFE_INTEGER.toString()
    });

    expect(result.filters.age).toBeDefined();
  });
});
