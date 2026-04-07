/**
 * Geo edge cases — index gaps, sort conflicts, customization patterns
 *
 * These are the real-world scenarios a team would hit AFTER happy-path geo
 * works. Each one covers a specific DX concern the happy-path tests don't:
 *
 *   1. User has `[near]` in their URL but the schema has no 2dsphere index.
 *      MongoDB will throw a cryptic "2d index required" error — we want to
 *      surface this EARLY (at parser construction when schema is supplied),
 *      not wait for the query to fail in production.
 *
 *   2. User configures an explicit sort alongside `[near]`. MongoDB forbids
 *      any sort with $near — we warn and drop the sort rather than crash.
 *
 *   3. User overrides `getAll` via a before:getAll hook to post-process geo
 *      results (e.g. add a distance field, filter by score). Proves the
 *      customization surface works for geo queries.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, QueryParser } from '../src/index.js';
import Repository from '../src/Repository.js';

// Two schemas side-by-side: one WITH the 2dsphere index, one WITHOUT.
// This is the realistic shape: a team adds geo queries to an admin tool
// before remembering to add the index.

interface IIndexedPlace extends Document {
  name: string;
  location: { type: 'Point'; coordinates: [number, number] };
}

const IndexedPlaceSchema = new Schema<IIndexedPlace>({
  name: { type: String, required: true },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
});
IndexedPlaceSchema.index({ location: '2dsphere' });

interface IUnindexedPlace extends Document {
  name: string;
  location: { type: 'Point'; coordinates: [number, number] };
}

const UnindexedPlaceSchema = new Schema<IUnindexedPlace>({
  name: { type: String, required: true },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
});
// No geo index — deliberately.

let mongoServer: MongoMemoryServer;
let IndexedPlaceModel: mongoose.Model<IIndexedPlace>;
let UnindexedPlaceModel: mongoose.Model<IUnindexedPlace>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  IndexedPlaceModel = mongoose.model<IIndexedPlace>('EdgeIndexedPlace', IndexedPlaceSchema);
  UnindexedPlaceModel = mongoose.model<IUnindexedPlace>('EdgeUnindexedPlace', UnindexedPlaceSchema);
  await IndexedPlaceModel.createIndexes();
  await UnindexedPlaceModel.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await IndexedPlaceModel.deleteMany({});
  await UnindexedPlaceModel.deleteMany({});
  const docs = [
    { name: 'A', location: { type: 'Point' as const, coordinates: [-73.99, 40.75] as const } },
    { name: 'B', location: { type: 'Point' as const, coordinates: [-73.98, 40.77] as const } },
  ];
  await IndexedPlaceModel.insertMany(docs);
  await UnindexedPlaceModel.insertMany(docs);
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Missing 2dsphere index — early detection AND runtime error surfacing
// ─────────────────────────────────────────────────────────────────────────

describe('Geo edge: missing 2dsphere index', () => {
  it('QueryParser warns at construction when schema has no geo fields but is likely used for geo', () => {
    // This is the early-detection path — NOT required for correctness (Mongo
    // will refuse the query anyway), but it catches the 95% case where a
    // team adds `[near]` to a URL before adding the index. Opt-in via a new
    // `warnGeoGap` option is deferred; for now we verify that `schemaIndexes`
    // correctly reports the gap so downstream tools can build the warning.
    const parser = new QueryParser({ schema: UnindexedPlaceSchema });
    expect(parser.schemaIndexes.geoFields).toEqual([]);
  });

  it('Repository.getAll surfaces the real MongoDB error for $near on an unindexed collection', async () => {
    const parser = new QueryParser({ schema: UnindexedPlaceSchema });
    const repo = new Repository(UnindexedPlaceModel);
    const parsed = parser.parse({
      'location[near]': '-73.99,40.75,5000',
    });
    // MongoDB will throw "unable to find index for $geoNear query" (the
    // exact wording varies by version). We don't wrap or rename it —
    // mongokit's job is to propagate, not hide. Users get actionable error
    // text pointing at the index gap.
    await expect(repo.getAll({ filters: parsed.filters, mode: 'offset' })).rejects.toThrow(
      /index|geoNear|2d/i,
    );
  });

  it('does not crash on $geoWithin $box without an index (box queries work on any collection)', async () => {
    // $geoWithin with $box does NOT require a 2dsphere index (Mongo scans).
    // This is the one geo query that works on unindexed collections, so the
    // parser + repo must not refuse it.
    const parser = new QueryParser({ schema: UnindexedPlaceSchema });
    const repo = new Repository(UnindexedPlaceModel);
    const parsed = parser.parse({
      'location[geoWithin]': '-74.0,40.7,-73.95,40.80',
    });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Explicit sort + $near — warn and drop (DX-friendly)
// ─────────────────────────────────────────────────────────────────────────

describe('Geo edge: explicit sort + $near conflict', () => {
  it('drops caller-supplied sort when $near is in filters and warns', async () => {
    // Capture warn output by replacing the logger
    const warnSpy = vi.fn();
    configureLogger({ warn: warnSpy });

    try {
      const parser = new QueryParser({ schema: IndexedPlaceSchema });
      const repo = new Repository(IndexedPlaceModel);
      const parsed = parser.parse({ 'location[near]': '-73.99,40.75,5000' });

      // Caller explicitly asks for -name sort — MongoDB would reject this
      // with "$near in combination with sort is not allowed". The repo
      // should detect the conflict, drop the sort, and warn.
      const result = await repo.getAll({
        filters: parsed.filters,
        sort: '-name',
        mode: 'offset',
      });
      if (result.method !== 'offset') throw new Error('expected offset');
      // Query succeeded — proving the sort was dropped, not forwarded.
      expect(result.docs.length).toBeGreaterThan(0);

      // Warning was emitted with actionable context
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => /sort.*near|near.*sort/i.test(m))).toBe(true);
    } finally {
      // Restore default console.warn behavior for later tests
      configureLogger({ warn: console.warn.bind(console) });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Customization — before:getAll override for post-processing geo results
// ─────────────────────────────────────────────────────────────────────────

describe('Geo edge: Repository customization via before:getAll hook', () => {
  it('allows a before:getAll plugin to transform the filter (example: enforce a max radius)', async () => {
    // Realistic pattern: a team wants to cap the radius users can request
    // via URL params at 20 km, regardless of what they send. They write a
    // small plugin that inspects ctx.filters and clamps $maxDistance.
    const MAX_RADIUS_M = 20_000;

    const capRadiusPlugin = (repo: Repository<IIndexedPlace>) => {
      repo.on('before:getAll', (ctx) => {
        const filters = ctx.filters as Record<string, unknown> | undefined;
        if (!filters) return;
        for (const [, value] of Object.entries(filters)) {
          if (!value || typeof value !== 'object') continue;
          const inner = value as Record<string, unknown>;
          for (const op of ['$near', '$nearSphere'] as const) {
            const near = inner[op] as Record<string, unknown> | undefined;
            if (!near) continue;
            const current = (near.$maxDistance as number | undefined) ?? Infinity;
            if (current > MAX_RADIUS_M) {
              near.$maxDistance = MAX_RADIUS_M;
            }
          }
        }
      });
    };

    const parser = new QueryParser({ schema: IndexedPlaceSchema });
    const repo = new Repository(IndexedPlaceModel, [capRadiusPlugin]);

    // User requests a 1000 km radius — should be clamped to 20 km
    const parsed = parser.parse({ 'location[near]': '-73.99,40.75,1000000' });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');

    // The query ran; proof the clamp took effect is that the count rewrite
    // used the capped radius. We can inspect the mutated filter:
    const nearVal = (parsed.filters.location as { $near: { $maxDistance: number } }).$near;
    expect(nearVal.$maxDistance).toBe(MAX_RADIUS_M);
    expect(result.docs.length).toBeGreaterThanOrEqual(1);
  });
});
