/**
 * QueryParser — geospatial query support
 *
 * MongoDB geo queries are notoriously easy to get wrong: lng/lat order, GeoJSON
 * vs legacy pairs, $near vs $nearSphere semantics, $maxDistance in meters vs
 * radians. The parser must turn ergonomic URL syntax into the canonical
 * GeoJSON form and validate that the field is actually 2dsphere-indexed when
 * a schema is provided.
 *
 * URL contract (always lng,lat order — same as GeoJSON):
 *
 *   ?location[near]=-73.97,40.78,5000
 *     → { location: { $near: { $geometry: { type: 'Point',
 *                                           coordinates: [-73.97, 40.78] },
 *                              $maxDistance: 5000 } } }
 *
 *   ?location[nearSphere]=-73.97,40.78,5000   // same shape, $nearSphere
 *
 *   ?location[geoWithin]=-74,40.7,-73.9,40.85  // bounding box: minLng,minLat,maxLng,maxLat
 *     → { location: { $geoWithin: { $box: [[-74, 40.7], [-73.9, 40.85]] } } }
 *
 * E2E tests use a real Mongo collection with a 2dsphere index to prove the
 * generated queries actually find the right documents.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryParser } from '../src/index.js';
import Repository from '../src/Repository.js';

interface IPlace extends Document {
  name: string;
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
}

const PlaceSchema = new Schema<IPlace>({
  name: { type: String, required: true },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
    },
  },
});
PlaceSchema.index({ location: '2dsphere' });

let mongoServer: MongoMemoryServer;
let PlaceModel: mongoose.Model<IPlace>;
let repo: Repository<IPlace>;
let parser: QueryParser;

// Real coordinates around Manhattan for predictable geo math.
const TIMES_SQUARE: [number, number] = [-73.9857, 40.7589];
const STATUE_OF_LIBERTY: [number, number] = [-74.0445, 40.6892];
const CENTRAL_PARK: [number, number] = [-73.9654, 40.7829];
const LAX: [number, number] = [-118.4085, 33.9416]; // ~3940 km from NYC

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  PlaceModel = mongoose.model<IPlace>('GeoPlace', PlaceSchema);
  await PlaceModel.createIndexes();
  repo = new Repository(PlaceModel);
  parser = new QueryParser({ schema: PlaceSchema });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await PlaceModel.deleteMany({});
  await PlaceModel.insertMany([
    { name: 'Times Square', location: { type: 'Point', coordinates: TIMES_SQUARE } },
    { name: 'Statue of Liberty', location: { type: 'Point', coordinates: STATUE_OF_LIBERTY } },
    { name: 'Central Park', location: { type: 'Point', coordinates: CENTRAL_PARK } },
    { name: 'LAX Airport', location: { type: 'Point', coordinates: LAX } },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// Parser-level: URL → query shape
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser geo: URL → MongoDB query shape', () => {
  it('builds $near with GeoJSON Point and $maxDistance from lng,lat,radius', () => {
    const parsed = parser.parse({ 'location[near]': '-73.9857,40.7589,5000' });
    expect(parsed.filters.location).toEqual({
      $near: {
        $geometry: { type: 'Point', coordinates: [-73.9857, 40.7589] },
        $maxDistance: 5000,
      },
    });
  });

  it('builds $nearSphere with the same shape as $near', () => {
    const parsed = parser.parse({ 'location[nearSphere]': '-73.9857,40.7589,2000' });
    expect(parsed.filters.location).toEqual({
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [-73.9857, 40.7589] },
        $maxDistance: 2000,
      },
    });
  });

  it('omits $maxDistance when only lng,lat are supplied (unbounded sort)', () => {
    const parsed = parser.parse({ 'location[near]': '-73.9857,40.7589' });
    expect(parsed.filters.location).toEqual({
      $near: {
        $geometry: { type: 'Point', coordinates: [-73.9857, 40.7589] },
      },
    });
  });

  it('builds $geoWithin $box from minLng,minLat,maxLng,maxLat', () => {
    const parsed = parser.parse({ 'location[geoWithin]': '-74.05,40.65,-73.9,40.8' });
    expect(parsed.filters.location).toEqual({
      $geoWithin: {
        $box: [
          [-74.05, 40.65],
          [-73.9, 40.8],
        ],
      },
    });
  });

  it('rejects coordinates outside lng [-180,180] / lat [-90,90] range', () => {
    const parsed = parser.parse({ 'location[near]': '999,40.7589,5000' });
    // Invalid input must NOT silently produce a $near with garbage — drop it.
    expect(parsed.filters.location).toBeUndefined();
  });

  it('rejects non-numeric coordinates without crashing', () => {
    const parsed = parser.parse({ 'location[near]': 'foo,bar,baz' });
    expect(parsed.filters.location).toBeUndefined();
  });

  it('rejects too few coordinates for $near (needs at least lng,lat)', () => {
    const parsed = parser.parse({ 'location[near]': '-73.9857' });
    expect(parsed.filters.location).toBeUndefined();
  });

  it('rejects $geoWithin with the wrong number of coordinates', () => {
    const parsed = parser.parse({ 'location[geoWithin]': '-74,40.7,-73.9' });
    expect(parsed.filters.location).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Schema introspection: detect 2dsphere indexes
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser geo: schema index introspection', () => {
  it('exposes geo-indexed fields from the schema', () => {
    const p = new QueryParser({ schema: PlaceSchema });
    expect(p.schemaIndexes.geoFields).toContain('location');
  });

  it('returns empty geo fields when no schema is provided', () => {
    const p = new QueryParser();
    expect(p.schemaIndexes.geoFields).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// E2E: parsed query actually finds the right documents
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser geo: E2E against a real 2dsphere index', () => {
  // IMPORTANT: $near / $nearSphere are sort operators and MongoDB forbids
  // them in any context that needs counting (countDocuments, $facet, $lookup).
  // For paginated radius queries, use [withinRadius] which compiles to
  // $geoWithin: $centerSphere — same set of docs, count-compatible. Use [near]
  // only with findAll/noPagination when you need distance ordering.

  it('?location[withinRadius] within 4 km finds 2 Manhattan landmarks', async () => {
    const parsed = parser.parse({
      'location[withinRadius]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},4000`,
    });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    // Times Square (self, 0m) + Central Park (~3.3 km) within 4 km.
    // Statue of Liberty is ~7.9 km away → excluded.
    // LAX is ~3940 km → excluded.
    expect(result.total).toBe(2);
    const names = result.docs.map((d) => d.name);
    expect(names).toContain('Times Square');
    expect(names).toContain('Central Park');
  });

  it('?location[near] returns docs sorted by distance (use noPagination)', async () => {
    // $near is a sort operator — must run via findAll/noPagination, not getAll's
    // counted offset path. This is the documented escape hatch for distance-sorted
    // proximity queries.
    const parsed = parser.parse({
      'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]}`,
    });
    const docs = (await repo.getAll({
      filters: parsed.filters,
      noPagination: true,
    })) as IPlace[];
    expect(docs[0].name).toBe('Times Square'); // self → distance 0
  });

  it('?location[near] ALSO works via paginated getAll (auto-detected, no forced sort/count)', async () => {
    // Repository detects the $near operator in filters and:
    //   1. Does NOT inject its default `-createdAt` sort (MongoDB would reject it)
    //   2. Does NOT run countDocuments (MongoDB forbids count with $near)
    // Returns a result shape compatible with the pagination contract — total is
    // either the doc count from the query or omitted, depending on the strategy.
    const parsed = parser.parse({
      'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},10000`,
    });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    // Times Square + Central Park + Statue of Liberty are all within 10 km.
    // LAX is not.
    expect(result.docs.length).toBeGreaterThanOrEqual(3);
    expect(result.docs[0].name).toBe('Times Square'); // nearest first
  });

  it('?location[nearSphere] also works via paginated getAll', async () => {
    const parsed = parser.parse({
      'location[nearSphere]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},5000`,
    });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.docs.length).toBeGreaterThanOrEqual(1);
    expect(result.docs[0].name).toBe('Times Square');
  });

  it('?location[geoWithin] bounding box finds only Manhattan landmarks', async () => {
    // Box covering Manhattan but excluding Statue of Liberty and LAX
    const parsed = parser.parse({
      'location[geoWithin]': '-74.02,40.70,-73.93,40.80',
    });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(2);
    const names = result.docs.map((d) => d.name).sort();
    expect(names).toEqual(['Central Park', 'Times Square']);
  });

  it('combines geo with non-geo filters (e.g. text match)', async () => {
    const parsed = parser.parse({
      'location[withinRadius]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},10000`,
      'name[regex]': '^Central',
    });
    const result = await repo.getAll({ filters: parsed.filters, mode: 'offset' });
    if (result.method !== 'offset') throw new Error('expected offset');
    expect(result.total).toBe(1);
    expect(result.docs[0].name).toBe('Central Park');
  });
});
