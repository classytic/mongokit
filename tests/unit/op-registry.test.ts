/**
 * Operation registry — invariants the bundled plugins rely on.
 *
 * The registry is the single source of truth that classifies every
 * RepositoryOperation. These tests guard against accidental drift between
 * the registry and the operation set.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_OPERATIONS,
  MUTATING_OPERATIONS,
  OP_REGISTRY,
  operationsByPolicyKey,
  READ_OPERATIONS,
} from '../../src/operations.js';
import type { RepositoryOperation } from '../../src/types.js';

// The exhaustive list of every RepositoryOperation. Kept here as a literal
// array so this test file fails loudly when a new op is added to the union
// without a corresponding registry entry.
const KNOWN_OPERATIONS: readonly RepositoryOperation[] = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'findOneAndUpdate',
  'delete',
  'deleteMany',
  'restore',
  'getById',
  'getByQuery',
  'getOne',
  'getAll',
  'findAll',
  'getOrCreate',
  'count',
  'exists',
  'distinct',
  'aggregate',
  'aggregatePaginate',
  'lookupPopulate',
  'bulkWrite',
];

describe('operations registry', () => {
  it('classifies every known RepositoryOperation', () => {
    for (const op of KNOWN_OPERATIONS) {
      expect(OP_REGISTRY[op], `OP_REGISTRY missing entry for "${op}"`).toBeDefined();
    }
  });

  it('exposes every registry op via ALL_OPERATIONS', () => {
    expect(new Set(ALL_OPERATIONS)).toEqual(new Set(KNOWN_OPERATIONS));
  });

  it('partitions ops cleanly into mutating + read groups', () => {
    const mutating = new Set(MUTATING_OPERATIONS);
    const read = new Set(READ_OPERATIONS);
    expect(mutating.size + read.size).toBe(ALL_OPERATIONS.length);
    for (const op of mutating) {
      expect(read.has(op), `${op} is in both groups`).toBe(false);
    }
  });

  it('routes findOneAndUpdate through context.query (CAS primitive)', () => {
    expect(OP_REGISTRY.findOneAndUpdate.policyKey).toBe('query');
    expect(OP_REGISTRY.findOneAndUpdate.mutates).toBe(true);
    expect(OP_REGISTRY.findOneAndUpdate.hasIdContext).toBe(false);
  });

  it('routes findAll through context.query (filter is first positional arg)', () => {
    expect(OP_REGISTRY.findAll.policyKey).toBe('query');
    expect(OP_REGISTRY.findAll.mutates).toBe(false);
  });

  it('routes getAll through context.filters (paginated bag)', () => {
    expect(OP_REGISTRY.getAll.policyKey).toBe('filters');
  });

  it('classifies create-style ops as data/dataArray', () => {
    expect(OP_REGISTRY.create.policyKey).toBe('data');
    expect(OP_REGISTRY.createMany.policyKey).toBe('dataArray');
  });

  it('classifies bulkWrite as the special "operations" key', () => {
    expect(OP_REGISTRY.bulkWrite.policyKey).toBe('operations');
  });

  it('operationsByPolicyKey returns ops grouped correctly', () => {
    expect(operationsByPolicyKey('filters')).toEqual(
      expect.arrayContaining(['getAll', 'aggregatePaginate', 'lookupPopulate']),
    );
    expect(operationsByPolicyKey('data')).toEqual(['create']);
    expect(operationsByPolicyKey('dataArray')).toEqual(['createMany']);
    expect(operationsByPolicyKey('operations')).toEqual(['bulkWrite']);
  });

  it('marks ops with id context only when context.id is populated by the time hooks fire', () => {
    // These ops accept an `id` parameter on the public API and stash it on
    // context.id before before:* hooks fire. Audit-trail relies on this
    // for snapshot-by-id.
    const expectIdContext = ['update', 'delete', 'restore', 'getById'];
    for (const op of expectIdContext) {
      expect(
        OP_REGISTRY[op as RepositoryOperation].hasIdContext,
        `${op} should have hasIdContext`,
      ).toBe(true);
    }

    // findOneAndUpdate is filter-based — no id at hook time.
    expect(OP_REGISTRY.findOneAndUpdate.hasIdContext).toBe(false);
    // findAll/getOne/etc. are filter-based reads — no id either.
    expect(OP_REGISTRY.findAll.hasIdContext).toBe(false);
    expect(OP_REGISTRY.getOne.hasIdContext).toBe(false);
  });
});
