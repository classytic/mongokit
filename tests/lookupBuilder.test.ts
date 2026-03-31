/**
 * LookupBuilder Tests
 *
 * Unit tests for the LookupBuilder fluent API and pipeline sanitization
 */

import { describe, it, expect } from 'vitest';
import { LookupBuilder } from '../src/query/LookupBuilder.js';

describe('LookupBuilder', () => {
  describe('Simple Lookup', () => {
    it('should build a simple equality lookup', () => {
      const stages = new LookupBuilder('departments')
        .localField('departmentId')
        .foreignField('_id')
        .as('department')
        .build();

      expect(stages).toHaveLength(1);
      expect(stages[0]).toEqual({
        $lookup: {
          from: 'departments',
          localField: 'departmentId',
          foreignField: '_id',
          as: 'department',
        },
      });
    });

    it('should add $unwind when single() is set', () => {
      const stages = new LookupBuilder('departments')
        .localField('departmentId')
        .foreignField('_id')
        .as('department')
        .single()
        .build();

      expect(stages).toHaveLength(2);
      expect(stages[1]).toEqual({
        $unwind: {
          path: '$department',
          preserveNullAndEmptyArrays: true,
        },
      });
    });

    it('should default "as" to "from" collection name', () => {
      const stages = new LookupBuilder('departments')
        .localField('departmentId')
        .foreignField('_id')
        .build();

      const lookup = stages[0] as any;
      expect(lookup.$lookup.as).toBe('departments');
    });

    it('should throw when "from" is not provided', () => {
      expect(() =>
        new LookupBuilder('')
          .localField('x')
          .foreignField('y')
          .build()
      ).toThrow('LookupBuilder: "from" collection is required');
    });

    it('should throw when localField/foreignField missing for simple form', () => {
      expect(() =>
        new LookupBuilder('departments')
          .build()
      ).toThrow('localField and foreignField are required');
    });
  });

  describe('Pipeline Form', () => {
    it('should build a pipeline-form lookup with custom pipeline and auto-join', () => {
      const stages = new LookupBuilder('products')
        .localField('productId')
        .foreignField('_id')
        .pipeline([
          { $match: { status: 'active' } },
          { $project: { name: 1, price: 1 } },
        ])
        .as('product')
        .build();

      expect(stages).toHaveLength(1);
      const lookup = stages[0] as any;
      expect(lookup.$lookup.pipeline).toBeDefined();
      // 3 stages: auto-generated $match.$expr join + 2 user stages
      expect(lookup.$lookup.pipeline).toHaveLength(3);
      expect(lookup.$lookup.let).toBeDefined();
      expect(lookup.$lookup.pipeline[0].$match.$expr).toBeDefined();
    });

    it('should build with let variables', () => {
      const stages = new LookupBuilder('products')
        .localField('productId')
        .foreignField('_id')
        .let({ localId: '$productId' })
        .pipeline([
          { $match: { $expr: { $eq: ['$_id', '$$localId'] } } },
        ])
        .as('product')
        .build();

      const lookup = stages[0] as any;
      expect(lookup.$lookup.let).toBeDefined();
    });

    it('should auto-generate pipeline when only let is provided', () => {
      const stages = new LookupBuilder('products')
        .localField('productId')
        .foreignField('_id')
        .let({ extraVar: '$someField' })
        .as('product')
        .build();

      const lookup = stages[0] as any;
      expect(lookup.$lookup.pipeline).toBeDefined();
      expect(lookup.$lookup.pipeline[0].$match).toBeDefined();
    });
  });

  describe('Static Helpers', () => {
    it('should create a simple lookup via static method', () => {
      const stages = LookupBuilder.simple('departments', 'deptId', '_id', {
        as: 'dept',
        single: true,
      });

      expect(stages).toHaveLength(2); // $lookup + $unwind
    });

    it('should create multiple lookups', () => {
      const stages = LookupBuilder.multiple([
        { from: 'departments', localField: 'deptId', foreignField: '_id', single: true },
        { from: 'managers', localField: 'managerId', foreignField: '_id', single: true },
      ]);

      // 2 lookups × 2 stages each ($lookup + $unwind)
      expect(stages).toHaveLength(4);
    });
  });
});

describe('LookupBuilder - Pipeline Sanitization', () => {
  it('should block $out stage', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $match: { status: 'active' } },
      { $out: 'hacked_collection' } as any,
    ]);

    expect(stages).toHaveLength(1);
    expect(stages[0]).toEqual({ $match: { status: 'active' } });
  });

  it('should block $merge stage', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $match: { status: 'active' } },
      { $merge: { into: 'other' } } as any,
    ]);

    expect(stages).toHaveLength(1);
  });

  it('should block $unionWith stage', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $unionWith: 'secret_collection' } as any,
    ]);

    expect(stages).toHaveLength(0);
  });

  it('should block $collStats stage', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $collStats: { latencyStats: {} } } as any,
    ]);

    expect(stages).toHaveLength(0);
  });

  it('should block $currentOp stage', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $currentOp: {} } as any,
    ]);

    expect(stages).toHaveLength(0);
  });

  it('should block $listSessions stage', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $listSessions: {} } as any,
    ]);

    expect(stages).toHaveLength(0);
  });

  it('should block $where inside $match', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $match: { $where: 'this.isAdmin', status: 'active' } } as any,
    ]);

    expect(stages).toHaveLength(1);
    const match = (stages[0] as any).$match;
    expect(match).not.toHaveProperty('$where');
    expect(match).toHaveProperty('status', 'active');
  });

  it('should block $function inside $addFields', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $addFields: { result: { $function: { body: 'evil()' } }, name: '$firstName' } } as any,
    ]);

    expect(stages).toHaveLength(1);
    const addFields = (stages[0] as any).$addFields;
    expect(addFields.result).not.toHaveProperty('$function');
    expect(addFields).toHaveProperty('name', '$firstName');
  });

  it('should block $accumulator inside $set', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $set: { total: { $accumulator: { init: 'evil' } } } } as any,
    ]);

    expect(stages).toHaveLength(1);
    const set = (stages[0] as any).$set;
    expect(set.total).not.toHaveProperty('$accumulator');
  });

  it('should recursively sanitize nested dangerous operators', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $match: { $or: [{ $where: 'evil' }, { status: 'active' }] } } as any,
    ]);

    expect(stages).toHaveLength(1);
    const match = (stages[0] as any).$match;
    if (match.$or && Array.isArray(match.$or)) {
      expect(match.$or.every((item: any) => !item.$where)).toBe(true);
    }
  });

  it('should pass through safe stages like $project, $sort, $limit', () => {
    const stages = LookupBuilder.sanitizePipeline([
      { $project: { name: 1, price: 1 } },
      { $sort: { price: -1 } },
      { $limit: 10 },
    ]);

    expect(stages).toHaveLength(3);
  });

  it('should skip invalid stage entries (non-objects, empty, multi-key)', () => {
    const stages = LookupBuilder.sanitizePipeline([
      null as any,
      undefined as any,
      'not-a-stage' as any,
      { $match: { x: 1 }, $sort: { x: 1 } } as any, // multi-key — invalid
      { $match: { x: 1 } },
    ]);

    expect(stages).toHaveLength(1);
  });

  it('should sanitize user pipelines in LookupBuilder.build()', () => {
    const stages = new LookupBuilder('products')
      .localField('productId')
      .foreignField('_id')
      .pipeline([
        { $match: { status: 'active' } },
        { $out: 'hacked' } as any,
      ])
      .as('product')
      .build();

    const lookup = stages[0] as any;
    // Auto-join prepended + 1 user stage ($out stripped by sanitizer)
    expect(lookup.$lookup.pipeline).toHaveLength(2);
    expect(lookup.$lookup.pipeline[0].$match.$expr).toBeDefined(); // auto-join
    expect(lookup.$lookup.pipeline[1]).toEqual({ $match: { status: 'active' } });
  });

  it('should skip sanitization when sanitize=false', () => {
    const stages = new LookupBuilder('products')
      .localField('productId')
      .foreignField('_id')
      .pipeline([
        { $match: { status: 'active' } },
        { $out: 'collection' } as any,
      ])
      .as('product')
      .sanitize(false)
      .build();

    const lookup = stages[0] as any;
    // Auto-join prepended + 2 user stages (nothing blocked)
    expect(lookup.$lookup.pipeline).toHaveLength(3);
  });
});
