/**
 * Keyset pagination index-compatibility tests.
 *
 * Pure-function tests for hasCompatibleKeysetIndex + an integration smoke
 * test that the warning only fires when no matching schema index exists.
 *
 * Real-world scenarios this covers:
 *
 *   - `@classytic/invoice` lists invoices filtered by tenant + deletedAt with
 *     sort `{ createdAt: -1 }` and a compound index
 *     `{ organizationId: 1, deletedAt: 1, createdAt: -1 }`. Previously the
 *     warning fired on every query. It must stay silent now.
 *
 *   - A schema that forgot the compound index should still receive the warning.
 *
 *   - MongoDB can traverse a btree index in reverse, so `sort: { createdAt: 1 }`
 *     against index `{ ..., createdAt: -1 }` is still efficient — no warning.
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaginationEngine, Repository } from '../src/index.js';
import {
  hasCompatibleKeysetIndex,
  readSchemaIndexes,
  type SchemaIndexTuple,
} from '../src/pagination/utils/index-hint.js';
import { configureLogger } from '../src/utils/logger.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

// ============================================================================
// Pure function — no DB
// ============================================================================

describe('hasCompatibleKeysetIndex', () => {
  const mkIndex = (spec: Record<string, 1 | -1>): SchemaIndexTuple => [spec, {}];

  it('returns true when a compound index exactly matches filters + sort', () => {
    const indexes = [mkIndex({ organizationId: 1, deletedAt: 1, createdAt: -1 })];
    const ok = hasCompatibleKeysetIndex(
      indexes,
      ['organizationId', 'deletedAt'],
      { createdAt: -1 },
    );
    expect(ok).toBe(true);
  });

  it('returns true regardless of equality-prefix ordering', () => {
    // User passed filters in a different order than the index declaration.
    const indexes = [mkIndex({ organizationId: 1, deletedAt: 1, createdAt: -1 })];
    const ok = hasCompatibleKeysetIndex(
      indexes,
      ['deletedAt', 'organizationId'],
      { createdAt: -1 },
    );
    expect(ok).toBe(true);
  });

  it('returns true when sort is inverse-walkable (all directions flipped)', () => {
    // Index is { createdAt: -1 }, query sorts ASC — MongoDB walks index backward.
    const indexes = [mkIndex({ organizationId: 1, createdAt: -1 })];
    const ok = hasCompatibleKeysetIndex(indexes, ['organizationId'], { createdAt: 1 });
    expect(ok).toBe(true);
  });

  it('returns true for multi-field sort when ALL directions flip together', () => {
    const indexes = [mkIndex({ status: 1, createdAt: -1, _id: -1 })];
    // Exact
    expect(
      hasCompatibleKeysetIndex(indexes, ['status'], { createdAt: -1, _id: -1 }),
    ).toBe(true);
    // All flipped
    expect(
      hasCompatibleKeysetIndex(indexes, ['status'], { createdAt: 1, _id: 1 }),
    ).toBe(true);
  });

  it('returns false when multi-field sort directions flip inconsistently', () => {
    const indexes = [mkIndex({ status: 1, createdAt: -1, _id: -1 })];
    // Only one direction flipped — not a valid reverse walk.
    expect(
      hasCompatibleKeysetIndex(indexes, ['status'], { createdAt: 1, _id: -1 }),
    ).toBe(false);
  });

  it('returns false when the filter fields are not the equality prefix', () => {
    // Index is { a:1, b:1, c:-1 } but caller filters { b } and sorts { c: -1 }.
    // That's not a usable prefix — MongoDB would need to scan.
    const indexes = [mkIndex({ a: 1, b: 1, c: -1 })];
    expect(hasCompatibleKeysetIndex(indexes, ['b'], { c: -1 })).toBe(false);
  });

  it('returns false when sort suffix order does not match', () => {
    const indexes = [mkIndex({ organizationId: 1, updatedAt: -1, createdAt: -1 })];
    // Index has updatedAt before createdAt, but caller sorts createdAt first.
    expect(
      hasCompatibleKeysetIndex(
        indexes,
        ['organizationId'],
        { createdAt: -1, updatedAt: -1 },
      ),
    ).toBe(false);
  });

  it('returns false when no index exists at all', () => {
    expect(hasCompatibleKeysetIndex([], ['organizationId'], { createdAt: -1 })).toBe(false);
  });

  it('returns false when indexes exist but none match the query shape', () => {
    const indexes = [
      mkIndex({ email: 1 }),
      mkIndex({ name: 1, createdAt: 1 }),
    ];
    expect(
      hasCompatibleKeysetIndex(indexes, ['organizationId'], { createdAt: -1 }),
    ).toBe(false);
  });

  it('returns true when one of several indexes matches', () => {
    const indexes = [
      mkIndex({ email: 1 }), // unrelated
      mkIndex({ organizationId: 1, createdAt: -1 }), // the match
      mkIndex({ name: 1, createdAt: 1 }), // unrelated
    ];
    expect(
      hasCompatibleKeysetIndex(indexes, ['organizationId'], { createdAt: -1 }),
    ).toBe(true);
  });

  it('accepts indexes with extra trailing fields beyond sort suffix', () => {
    // Index has an extra _id tie-breaker at the end; still usable.
    const indexes = [mkIndex({ organizationId: 1, createdAt: -1, _id: -1 })];
    expect(
      hasCompatibleKeysetIndex(indexes, ['organizationId'], { createdAt: -1 }),
    ).toBe(true);
  });

  it('skips non-btree indexes (text, 2dsphere, hashed)', () => {
    const indexes: SchemaIndexTuple[] = [
      [{ name: 'text', description: 'text' }, {}],
      [{ location: '2dsphere' }, {}],
      [{ shardKey: 'hashed' }, {}],
    ];
    expect(hasCompatibleKeysetIndex(indexes, ['name'], { createdAt: -1 })).toBe(false);
  });

  it('treats filter-less queries as sort-only prefix match', () => {
    const indexes = [mkIndex({ createdAt: -1 })];
    expect(hasCompatibleKeysetIndex(indexes, [], { createdAt: -1 })).toBe(true);
    expect(hasCompatibleKeysetIndex(indexes, [], { updatedAt: -1 })).toBe(false);
  });
});

// ============================================================================
// readSchemaIndexes — defensive helper
// ============================================================================

describe('readSchemaIndexes', () => {
  it('returns empty list when schema is missing or broken', () => {
    expect(readSchemaIndexes({} as any)).toEqual([]);
    expect(readSchemaIndexes({ schema: null } as any)).toEqual([]);
    expect(readSchemaIndexes({ schema: { indexes: 'not a function' } } as any)).toEqual([]);
    expect(
      readSchemaIndexes({
        schema: {
          indexes: () => {
            throw new Error('boom');
          },
        },
      } as any),
    ).toEqual([]);
  });
});

// ============================================================================
// Integration — PaginationEngine.stream() emission behavior
// ============================================================================

interface IIndexTestDoc {
  _id: Types.ObjectId;
  organizationId: string;
  deletedAt: Date | null;
  createdAt: Date;
  name: string;
}

describe('PaginationEngine.stream() index-compat warning integration', () => {
  // The engine skips warning when NODE_ENV === 'test'. We temporarily flip it
  // here so we can verify the real emission path.
  const originalEnv = process.env.NODE_ENV;
  let warnings: string[] = [];

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
    process.env.NODE_ENV = originalEnv;
    configureLogger({ warn: console.warn.bind(console) });
  });

  beforeEach(() => {
    warnings = [];
    process.env.NODE_ENV = 'production';
    configureLogger({ warn: (msg: string) => warnings.push(msg) });
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
    configureLogger({ warn: console.warn.bind(console) });
  });

  it('does NOT warn when a matching schema-declared compound index exists', async () => {
    const schema = new Schema<IIndexTestDoc>(
      {
        organizationId: { type: String, required: true },
        deletedAt: { type: Date, default: null },
        name: { type: String, required: true },
      },
      { timestamps: true },
    );
    // Declare the exact compound index the query will need.
    schema.index({ organizationId: 1, deletedAt: 1, createdAt: -1 });

    const Model = await createTestModel<IIndexTestDoc>('IndexedDocWithIdx', schema);
    const repo = new Repository<IIndexTestDoc>(Model);

    await Model.create({ organizationId: 'org_1', name: 'doc1' });

    // Invoke stream() through the engine directly to avoid extra hooks.
    await repo._pagination.stream({
      filters: { organizationId: 'org_1', deletedAt: null },
      sort: { createdAt: -1 },
      limit: 10,
    });

    const indexWarnings = warnings.filter((w) => w.includes('no matching schema-declared'));
    expect(indexWarnings).toHaveLength(0);
  });

  it('tolerates index missing the `_id` tiebreaker that keyset auto-appends', async () => {
    // Real-world schemas declare compound indexes without `_id`. Keyset pagination
    // auto-appends `_id` to the sort for stable ordering, but the planner still
    // uses the primary compound index efficiently. We must not warn in this case.
    const schema = new Schema<IIndexTestDoc>(
      {
        organizationId: { type: String, required: true },
        deletedAt: { type: Date, default: null },
        name: { type: String, required: true },
      },
      { timestamps: true },
    );
    schema.index({ organizationId: 1, deletedAt: 1, createdAt: -1 }); // no _id

    const Model = await createTestModel<IIndexTestDoc>('IndexedDocNoIdTail', schema);
    const repo = new Repository<IIndexTestDoc>(Model);

    await Model.create({ organizationId: 'org_1', name: 'doc' });

    await repo._pagination.stream({
      filters: { organizationId: 'org_1', deletedAt: null },
      sort: { createdAt: -1 }, // keyset will auto-add _id
      limit: 10,
    });

    const indexWarnings = warnings.filter((w) => w.includes('no matching schema-declared'));
    expect(indexWarnings).toHaveLength(0);
  });

  it('DOES warn when no matching schema-declared compound index exists', async () => {
    const schema = new Schema<IIndexTestDoc>(
      {
        organizationId: { type: String, required: true },
        deletedAt: { type: Date, default: null },
        name: { type: String, required: true },
      },
      { timestamps: true },
    );
    // Intentionally NO compound index.

    const Model = await createTestModel<IIndexTestDoc>('IndexedDocNoIdx', schema);
    const repo = new Repository<IIndexTestDoc>(Model);

    await Model.create({ organizationId: 'org_1', name: 'doc1' });

    await repo._pagination.stream({
      filters: { organizationId: 'org_1', deletedAt: null },
      sort: { createdAt: -1 },
      limit: 10,
    });

    const indexWarnings = warnings.filter((w) => w.includes('no matching schema-declared'));
    expect(indexWarnings.length).toBeGreaterThan(0);
    expect(indexWarnings[0]).toContain('organizationId: 1');
    expect(indexWarnings[0]).toContain('deletedAt: 1');
    expect(indexWarnings[0]).toContain('createdAt: -1');
  });

  it('stays silent in NODE_ENV=test regardless of index presence', async () => {
    process.env.NODE_ENV = 'test'; // override the beforeEach flip
    warnings = [];
    configureLogger({ warn: (msg: string) => warnings.push(msg) });

    const schema = new Schema<IIndexTestDoc>(
      {
        organizationId: { type: String, required: true },
        deletedAt: { type: Date, default: null },
        name: { type: String, required: true },
      },
      { timestamps: true },
    );
    // No index — would warn in prod.

    const Model = await createTestModel<IIndexTestDoc>('IndexedDocTestEnv', schema);
    const repo = new Repository<IIndexTestDoc>(Model);

    await Model.create({ organizationId: 'org_1', name: 'doc1' });

    await repo._pagination.stream({
      filters: { organizationId: 'org_1', deletedAt: null },
      sort: { createdAt: -1 },
      limit: 10,
    });

    const indexWarnings = warnings.filter((w) => w.includes('no matching schema-declared'));
    expect(indexWarnings).toHaveLength(0);
  });

  it('caches schema indexes across stream() invocations', async () => {
    const schema = new Schema<IIndexTestDoc>({
      organizationId: { type: String, required: true },
      deletedAt: { type: Date, default: null },
      name: { type: String, required: true },
    });
    schema.index({ organizationId: 1, deletedAt: 1, createdAt: -1 });

    const Model = await createTestModel<IIndexTestDoc>('IndexedDocCache', schema);
    const engine = new PaginationEngine<IIndexTestDoc>(Model);

    let indexesCalls = 0;
    const originalIndexes = schema.indexes.bind(schema);
    schema.indexes = ((...args: unknown[]) => {
      indexesCalls += 1;
      return originalIndexes(...(args as []));
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    }) as any;

    await Model.create({ organizationId: 'org_1', name: 'doc' });

    await engine.stream({
      filters: { organizationId: 'org_1' },
      sort: { createdAt: -1 },
      limit: 10,
    });
    await engine.stream({
      filters: { organizationId: 'org_1' },
      sort: { createdAt: -1 },
      limit: 10,
    });
    await engine.stream({
      filters: { organizationId: 'org_1' },
      sort: { createdAt: -1 },
      limit: 10,
    });

    // Cache means schema.indexes() should be invoked at most once.
    expect(indexesCalls).toBeLessThanOrEqual(1);

    schema.indexes = originalIndexes as any;
  });
});
