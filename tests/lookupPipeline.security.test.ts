/**
 * Lookup Pipeline Security Tests
 *
 * Tests that dangerous pipeline stages and operators are blocked
 * when parsed from user input via QueryParser.
 */

import { describe, it, expect } from 'vitest';
import { QueryParser, LookupBuilder } from '../src/index.js';

describe('QueryParser - Lookup Pipeline Sanitization', () => {
  const parser = new QueryParser({ enableLookups: true });

  it('should block $out in lookup pipeline', () => {
    const result = parser.parse({
      lookup: {
        orders: {
          localField: 'userId',
          foreignField: '_id',
          pipeline: [
            { $match: { status: 'active' } },
            { $out: 'hacked_collection' },
          ],
        },
      },
    });

    expect(result.lookups).toBeDefined();
    expect(result.lookups!.length).toBeGreaterThan(0);
    const pipeline = result.lookups![0].pipeline!;
    expect(pipeline).toHaveLength(1);
    expect(pipeline.some((s: any) => '$out' in s)).toBe(false);
  });

  it('should block $merge in lookup pipeline', () => {
    const result = parser.parse({
      lookup: {
        orders: {
          localField: 'userId',
          foreignField: '_id',
          pipeline: [
            { $merge: { into: 'other_collection' } },
          ],
        },
      },
    });

    expect(result.lookups).toBeDefined();
    const pipeline = result.lookups![0].pipeline!;
    expect(pipeline).toHaveLength(0);
  });

  it('should block $where inside lookup pipeline $match', () => {
    const result = parser.parse({
      lookup: {
        orders: {
          localField: 'userId',
          foreignField: '_id',
          pipeline: [
            { $match: { $where: 'this.isAdmin = true', status: 'active' } },
          ],
        },
      },
    });

    expect(result.lookups).toBeDefined();
    const pipeline = result.lookups![0].pipeline!;
    expect(pipeline).toHaveLength(1);
    const match = (pipeline[0] as any).$match;
    expect(match).not.toHaveProperty('$where');
    expect(match).toHaveProperty('status', 'active');
  });

  it('should block $function inside lookup pipeline $addFields', () => {
    const result = parser.parse({
      lookup: {
        orders: {
          localField: 'userId',
          foreignField: '_id',
          pipeline: [
            { $addFields: { evil: { $function: { body: 'return 1' } }, safe: '$name' } },
          ],
        },
      },
    });

    expect(result.lookups).toBeDefined();
    const pipeline = result.lookups![0].pipeline!;
    expect(pipeline).toHaveLength(1);
    const addFields = (pipeline[0] as any).$addFields;
    expect(addFields.evil).not.toHaveProperty('$function');
    expect(addFields).toHaveProperty('safe', '$name');
  });

  it('should allow safe pipeline stages', () => {
    const result = parser.parse({
      lookup: {
        orders: {
          localField: 'userId',
          foreignField: '_id',
          pipeline: [
            { $match: { status: 'active' } },
            { $project: { name: 1, total: 1 } },
            { $sort: { total: -1 } },
            { $limit: 5 },
          ],
        },
      },
    });

    expect(result.lookups).toBeDefined();
    expect(result.lookups![0].pipeline).toHaveLength(4);
  });
});

describe('QueryParser - Collection Whitelist', () => {
  it('should allow lookups to whitelisted collections', () => {
    const parser = new QueryParser({
      enableLookups: true,
      allowedLookupCollections: ['departments', 'users'],
    });

    const result = parser.parse({
      lookup: {
        department: {
          localField: 'deptId',
          foreignField: '_id',
        },
      },
    });

    // 'department' pluralizes to 'departments' which is in the whitelist
    expect(result.lookups).toBeDefined();
    expect(result.lookups).toHaveLength(1);
  });

  it('should block lookups to non-whitelisted collections', () => {
    const parser = new QueryParser({
      enableLookups: true,
      allowedLookupCollections: ['departments'],
    });

    const result = parser.parse({
      lookup: {
        secret: {
          localField: 'secretId',
          foreignField: '_id',
        },
      },
    });

    // 'secret' pluralizes to 'secrets' which is NOT in the whitelist
    expect(result.lookups).toBeDefined();
    expect(result.lookups).toHaveLength(0);
  });

  it('should block lookups with explicit from to non-whitelisted collections', () => {
    const parser = new QueryParser({
      enableLookups: true,
      allowedLookupCollections: ['departments'],
    });

    const result = parser.parse({
      lookup: {
        dept: {
          from: 'secret_collection',
          localField: 'deptId',
          foreignField: '_id',
        },
      },
    });

    expect(result.lookups).toBeDefined();
    expect(result.lookups).toHaveLength(0);
  });

  it('should allow all collections when whitelist is not set', () => {
    const parser = new QueryParser({ enableLookups: true });

    const result = parser.parse({
      lookup: {
        anything: {
          localField: 'someId',
          foreignField: '_id',
        },
      },
    });

    expect(result.lookups).toBeDefined();
    expect(result.lookups).toHaveLength(1);
  });
});

describe('LookupBuilder - sanitizePipeline edge cases', () => {
  it('should handle empty pipeline', () => {
    const result = LookupBuilder.sanitizePipeline([]);
    expect(result).toHaveLength(0);
  });

  it('should block multiple dangerous stages in sequence', () => {
    const result = LookupBuilder.sanitizePipeline([
      { $out: 'col1' } as any,
      { $merge: { into: 'col2' } } as any,
      { $unionWith: 'col3' } as any,
      { $match: { status: 'ok' } },
    ]);

    expect(result).toHaveLength(1);
    expect((result[0] as any).$match.status).toBe('ok');
  });

  it('should handle deeply nested dangerous operators in $match', () => {
    const result = LookupBuilder.sanitizePipeline([
      {
        $match: {
          $and: [
            { status: 'active' },
            { $or: [{ type: 'a' }, { $where: 'evil()' }] },
          ],
        },
      } as any,
    ]);

    expect(result).toHaveLength(1);
    const match = (result[0] as any).$match;
    const orClause = match.$and[1].$or;
    expect(orClause.every((item: any) => !item.$where)).toBe(true);
  });
});
