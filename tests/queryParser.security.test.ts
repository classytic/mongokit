/**
 * QueryParser Security Tests
 *
 * Tests for ReDoS protection, operator sanitization, and injection prevention
 */

import { describe, expect, it } from 'vitest';
import { QueryParser } from '../src/index.js';

describe('QueryParser - ReDoS Protection', () => {
  const parser = new QueryParser({ invalidInput: 'drop', maxRegexLength: 100 });
  const strict = new QueryParser({ maxRegexLength: 100 });
  const asRegExp = (condition: { $regex: string; $options?: string }) =>
    new RegExp(condition.$regex, condition.$options);

  it('refuses an unsafe field[regex] — 400 strict, dropped in drop mode, never rewritten', () => {
    expect(() => strict.parse({ 'name[regex]': '(a+)+$' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(parser.parse({ 'name[regex]': '(a+)+$' }).filters.name).toBeUndefined();
  });

  it('treats contains as literal text — a dangerous-looking value is matched as characters', () => {
    const re = asRegExp(parser.parse({ 'name[contains]': '(a+)+' }).filters.name);
    expect(re.test('x(a+)+y')).toBe(true);
    expect(re.test('aaaa')).toBe(false);
  });

  it('refuses a regex longer than maxRegexLength rather than truncating it', () => {
    expect(parser.parse({ 'name[regex]': 'a'.repeat(200) }).filters.name).toBeUndefined();
  });

  it('refuses invalid and quantifier-based ReDoS patterns', () => {
    for (const pattern of ['{10,20}', '*+', '++', '?+', '(a+)+']) {
      expect(parser.parse({ 'field[regex]': pattern }).filters.field, pattern).toBeUndefined();
    }
  });

  it('escapes every regex metacharacter in contains', () => {
    const special = '.*+?^${}()|[]\\';
    const re = asRegExp(parser.parse({ 'name[contains]': special }).filters.name);
    expect(re.test(`prefix${special}suffix`)).toBe(true);
    expect(re.test('prefix-suffix')).toBe(false);
  });
});

describe('QueryParser - Operator Sanitization', () => {
  const parser = new QueryParser({ invalidInput: 'drop' });

  it('should block $where operator', () => {
    const result = parser.parse({
      $where: 'this.password.length > 0',
    });

    expect(result.filters).not.toHaveProperty('$where');
  });

  it('should block $where via bracket syntax', () => {
    const result = parser.parse({
      'name[$where]': 'malicious',
    });

    expect(result.filters.name).toBeUndefined();
  });

  it('should block other dangerous operators', () => {
    const dangerous = ['$function', '$accumulator', '$expr'];

    dangerous.forEach((op) => {
      const result = parser.parse({ [op]: 'malicious' });
      expect(result.filters).not.toHaveProperty(op);
    });
  });
});

/**
 * `$or` and `$and` are the two keys exempted from the `$`-prefix block, because both are
 * legitimate compounds. `$or` is routed to `parseOr`, which re-parses each branch; `$and` was
 * not routed anywhere, so its branches were assigned to the filter verbatim and every check in
 * this file could be stepped around by wrapping the payload in one.
 *
 * A branch is dropped once it parses to `{}`, exactly as `parseOr` does: a branch holding only
 * a blocked operator would otherwise become match-all.
 */
describe('QueryParser - compound operators do not bypass sanitization', () => {
  const drop = new QueryParser({ invalidInput: 'drop' });
  const strict = new QueryParser();

  it.each(['$where', '$expr', '$function', '$accumulator'])(
    'strips %s smuggled inside a $and branch',
    (op) => {
      const result = drop.parse({ $and: [{ [op]: 'malicious' }, { status: 'active' }] });

      expect(JSON.stringify(result.filters)).not.toContain(op);
      expect(result.filters.$and).toEqual([{ status: 'active' }]);
    },
  );

  it('throws on a $and-smuggled operator when invalidInput is throw (the default)', () => {
    expect(() => strict.parse({ $and: [{ $where: 'sleep(1000)' }] })).toThrow(/not part of the query grammar/i);
  });

  it('reaches operators nested a second level down', () => {
    const result = drop.parse({ $and: [{ $or: [{ $where: 'x' }] }] });
    expect(JSON.stringify(result.filters)).not.toContain('$where');
  });

  it('omits $and entirely when every branch was stripped — an empty $and is a driver error', () => {
    const result = drop.parse({ $and: [{ $where: 'x' }] });
    expect(result.filters).not.toHaveProperty('$and');
  });

  it('still allows a legitimate $and, and coerces inside it', () => {
    const result = drop.parse({ $and: [{ status: 'active' }, { 'qty[gte]': '5' }] });

    // The coercion is the tell that branches now go through the parser: before, `'5'` stayed a
    // string and the comparison silently matched nothing.
    expect(result.filters.$and).toEqual([{ status: 'active' }, { qty: { $gte: 5 } }]);
  });

  it('holds every $and branch to the field allowlist', () => {
    const allowlisted = new QueryParser({ invalidInput: 'drop', allowedFilterFields: ['status'] });
    expect(allowlisted.parse({ $and: [{ status: 'active' }] }).filters.$and).toEqual([
      { status: 'active' },
    ]);
    expect(allowlisted.parse({ $and: [{ secret: 'x' }] }).filters).not.toHaveProperty('$and');
    expect(() =>
      new QueryParser({ allowedFilterFields: ['status'] }).parse({ $and: [{ secret: 'x' }] }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('QueryParser - Aggregation Sanitization', () => {
  const parser = new QueryParser({ invalidInput: 'drop', enableAggregations: true });

  it('should sanitize $match config in aggregation', () => {
    const result = parser.parse({
      'aggregate[match]': {
        $where: 'this.isAdmin = true',
        status: 'active',
      },
    });

    if (result.aggregation) {
      const matchStage = result.aggregation.find((s) => '$match' in s);
      if (matchStage && '$match' in matchStage) {
        expect(matchStage.$match).not.toHaveProperty('$where');
        expect(matchStage.$match).toHaveProperty('status');
      }
    }
  });

  it('should recursively sanitize nested dangerous operators', () => {
    const result = parser.parse({
      'aggregate[match]': {
        $or: [{ $where: 'malicious' }, { status: 'active' }],
      },
    });

    if (result.aggregation) {
      const matchStage = result.aggregation.find((s) => '$match' in s);
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

describe('QueryParser - Lookup Pipeline Security', () => {
  const parser = new QueryParser({ invalidInput: 'drop', enableLookups: true });

  it('should sanitize dangerous stages in lookup pipeline', () => {
    const result = parser.parse({
      lookup: {
        users: {
          localField: 'userId',
          foreignField: '_id',
          pipeline: [{ $match: { active: true } }, { $out: 'stolen_data' }],
        },
      },
    });

    expect(result.lookups).toBeDefined();
    expect(result.lookups!.length).toBeGreaterThan(0);
    const pipeline = result.lookups![0].pipeline;
    expect(pipeline).toBeDefined();
    expect(pipeline!.every((s: any) => !('$out' in s))).toBe(true);
  });

  it('should sanitize dangerous operators in lookup pipeline $match', () => {
    const result = parser.parse({
      lookup: {
        users: {
          localField: 'userId',
          foreignField: '_id',
          pipeline: [{ $match: { $where: 'this.isAdmin', role: 'user' } }],
        },
      },
    });

    expect(result.lookups).toBeDefined();
    const pipeline = result.lookups![0].pipeline;
    expect(pipeline).toBeDefined();
    const match = (pipeline![0] as any).$match;
    expect(match).not.toHaveProperty('$where');
    expect(match).toHaveProperty('role', 'user');
  });
});

describe('QueryParser - Lookup Collection Whitelist', () => {
  it('should enforce collection whitelist', () => {
    const parser = new QueryParser({
      invalidInput: 'drop',
      enableLookups: true,
      allowedLookupCollections: ['users', 'departments'],
    });

    const result = parser.parse({
      lookup: {
        admin_secrets: {
          localField: 'secretId',
          foreignField: '_id',
        },
      },
    });

    expect(result.lookups).toBeDefined();
    expect(result.lookups).toHaveLength(0);
  });
});

describe('QueryParser - Edge Cases', () => {
  const parser = new QueryParser({ invalidInput: 'drop' });

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
      'age[lte]': '',
    });

    // Empty strings should be ignored
    expect(result.filters.age).toBeUndefined();
  });

  it('a non-numeric bound is text without a declared type, and a 400 with one', () => {
    // Untyped: a string comparison is legitimate (Mongoose casts a Number path at query time).
    expect(parser.parse({ 'age[gte]': 'not-a-number' }).filters.age).toEqual({ $gte: 'not-a-number' });
    const typed = new QueryParser({ fieldTypes: { age: 'number' } });
    expect(() => typed.parse({ 'age[gte]': 'not-a-number' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('should handle very large numbers safely', () => {
    const result = parser.parse({
      'age[gte]': '999999999999999999999',
      'age[lte]': Number.MAX_SAFE_INTEGER.toString(),
    });

    expect(result.filters.age).toBeDefined();
  });
});
