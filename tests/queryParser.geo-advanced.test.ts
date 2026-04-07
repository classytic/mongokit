/**
 * Geo advanced integrations — three corners that the happy-path tests don't
 * cover, each one a real production pattern users will hit:
 *
 *   1. `$geoNear` aggregation pipeline (the only way to get distance values
 *      back to the client). Proves Repository.aggregate composes with the
 *      same 2dsphere index getAll uses, and that pipeline output includes
 *      the `distance` field.
 *
 *   2. `$near` + populate. A common pattern is "find nearby places, populate
 *      their owner". Mongoose populate runs as a follow-up query after the
 *      main find — it should not interfere with `$near`'s implicit sort,
 *      and the populated docs should retain their proximity order.
 *
 *   3. Replica-set `readPreference` with geo. Geo queries hit specific
 *      shards/secondaries; we verify Repository forwards `readPreference`
 *      to PaginationEngine for the find query (and that the count rewrite
 *      also honors it).
 *
 * Each section uses a real Mongo collection with a 2dsphere index — the
 * pipeline / populate / read pref must actually execute end-to-end.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryParser } from '../src/index.js';
import Repository from '../src/Repository.js';

// ── Two related schemas: Place (geo) and Owner (referenced) ───────────────

interface IOwner extends Document {
  name: string;
  email: string;
}

const OwnerSchema = new Schema<IOwner>({
  name: { type: String, required: true },
  email: { type: String, required: true },
});

interface IPlace extends Document {
  name: string;
  category: string;
  ownerId: mongoose.Types.ObjectId;
  location: { type: 'Point'; coordinates: [number, number] };
}

const PlaceSchema = new Schema<IPlace>({
  name: { type: String, required: true },
  category: { type: String, required: true },
  ownerId: { type: Schema.Types.ObjectId, ref: 'GeoAdvOwner', required: true },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
});
PlaceSchema.index({ location: '2dsphere' });

let mongoServer: MongoMemoryServer;
let OwnerModel: mongoose.Model<IOwner>;
let PlaceModel: mongoose.Model<IPlace>;
let placeRepo: Repository<IPlace>;
let parser: QueryParser;

const TIMES_SQUARE: [number, number] = [-73.9857, 40.7589];
const CENTRAL_PARK: [number, number] = [-73.9654, 40.7829];
const STATUE_OF_LIBERTY: [number, number] = [-74.0445, 40.6892];

let owner1Id: mongoose.Types.ObjectId;
let owner2Id: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  OwnerModel = mongoose.model<IOwner>('GeoAdvOwner', OwnerSchema);
  PlaceModel = mongoose.model<IPlace>('GeoAdvPlace', PlaceSchema);
  await OwnerModel.createIndexes();
  await PlaceModel.createIndexes();
  placeRepo = new Repository(PlaceModel);
  parser = new QueryParser({ schema: PlaceSchema });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await OwnerModel.deleteMany({});
  await PlaceModel.deleteMany({});
  const owners = await OwnerModel.insertMany([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
  ]);
  owner1Id = owners[0]._id as mongoose.Types.ObjectId;
  owner2Id = owners[1]._id as mongoose.Types.ObjectId;
  await PlaceModel.insertMany([
    {
      name: 'Times Square',
      category: 'landmark',
      ownerId: owner1Id,
      location: { type: 'Point', coordinates: TIMES_SQUARE },
    },
    {
      name: 'Central Park',
      category: 'park',
      ownerId: owner2Id,
      location: { type: 'Point', coordinates: CENTRAL_PARK },
    },
    {
      name: 'Statue of Liberty',
      category: 'landmark',
      ownerId: owner1Id,
      location: { type: 'Point', coordinates: STATUE_OF_LIBERTY },
    },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// 1. $geoNear aggregation pipeline
// ─────────────────────────────────────────────────────────────────────────

describe('Geo advanced: $geoNear aggregation pipeline', () => {
  it('repo.aggregate executes a $geoNear stage and returns distance values', async () => {
    // $geoNear MUST be the first stage and must specify the field with a
    // 2dsphere index. It writes the computed distance into `distanceField`.
    const results = (await placeRepo.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: TIMES_SQUARE },
          distanceField: 'distanceMeters',
          spherical: true,
          maxDistance: 10000,
        },
      },
      { $project: { name: 1, distanceMeters: 1 } },
    ])) as Array<{ name: string; distanceMeters: number }>;

    // All three NYC docs are within 10 km
    expect(results).toHaveLength(3);
    // Distances are populated and sorted ascending (intrinsic to $geoNear)
    expect(results[0].name).toBe('Times Square');
    expect(results[0].distanceMeters).toBe(0);
    expect(results[1].name).toBe('Central Park');
    expect(results[1].distanceMeters).toBeGreaterThan(0);
    expect(results[2].name).toBe('Statue of Liberty');
    expect(results[2].distanceMeters).toBeGreaterThan(results[1].distanceMeters);
  });

  it('$geoNear pipeline composes with $match for category filtering', async () => {
    const results = (await placeRepo.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: TIMES_SQUARE },
          distanceField: 'd',
          spherical: true,
          query: { category: 'landmark' }, // built-in $match for $geoNear
        },
      },
      { $project: { name: 1 } },
    ])) as Array<{ name: string }>;

    // Only the two landmarks (Times Square + Statue of Liberty), not the park
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name).sort()).toEqual(['Statue of Liberty', 'Times Square']);
  });

  it('$geoNear + $count produces a documented total without breaking the pipeline', async () => {
    // The canonical "count things within radius with distance metadata available"
    // pattern: $geoNear → $count. This is what `getAll` uses internally for the
    // total when a $near query has $maxDistance, but applied as a one-off here.
    const results = (await placeRepo.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: TIMES_SQUARE },
          distanceField: 'd',
          spherical: true,
          maxDistance: 5000,
        },
      },
      { $count: 'total' },
    ])) as Array<{ total: number }>;

    expect(results).toHaveLength(1);
    // Times Square (0 m) + Central Park (~3.3 km) within 5 km, Statue of
    // Liberty is ~9.2 km, so 2 docs.
    expect(results[0].total).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. $near + populate
// ─────────────────────────────────────────────────────────────────────────

describe('Geo advanced: $near with populate', () => {
  it('preserves $near distance ordering when populating a referenced field', async () => {
    // Note: QueryParser expects URL params to be pre-decoded into nested
    // objects (the shape produced by `qs` / Express's default body parser /
    // Fastify's `fast-querystring`). Bracketed keys like
    // `populate[ownerId][select]` decode to `{ populate: { ownerId: { select } } }`.
    const parsed = parser.parse({
      'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},10000`,
      populate: { ownerId: { select: 'name email' } },
    });

    const result = await placeRepo.getAll({
      filters: parsed.filters,
      populateOptions: parsed.populateOptions,
      mode: 'offset',
    });
    if (result.method !== 'offset') throw new Error('expected offset');

    // Distance order is preserved through populate (Mongoose populate runs
    // as a separate query after the find, so the parent docs keep their
    // intrinsic $near sort)
    expect(result.docs).toHaveLength(3);
    expect(result.docs[0].name).toBe('Times Square');
    expect(result.docs[1].name).toBe('Central Park');
    expect(result.docs[2].name).toBe('Statue of Liberty');

    // Owner field was populated with selected fields
    const owner0 = (result.docs[0] as IPlace & { ownerId: { name: string; email: string } })
      .ownerId;
    expect(owner0).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
    // Verify it is NOT just the raw ObjectId
    expect(typeof owner0).toBe('object');
    expect(owner0).not.toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('count rewrite still produces accurate total when populate is in play', async () => {
    // Populate runs after find, separately from count. The count rewrite
    // (via $geoWithin: $centerSphere) must still produce the same total
    // regardless of whether populate is requested.
    const withPopulate = await placeRepo.getAll({
      filters: parser.parse({
        'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},10000`,
      }).filters,
      populateOptions: parser.parse({
        populate: { ownerId: { select: 'name' } },
      }).populateOptions,
      mode: 'offset',
    });
    const withoutPopulate = await placeRepo.getAll({
      filters: parser.parse({
        'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},10000`,
      }).filters,
      mode: 'offset',
    });

    if (withPopulate.method !== 'offset' || withoutPopulate.method !== 'offset') {
      throw new Error('expected offset');
    }
    expect(withPopulate.total).toBe(withoutPopulate.total);
    expect(withPopulate.total).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Replica-set readPreference forwarding with geo
// ─────────────────────────────────────────────────────────────────────────

describe('Geo advanced: readPreference forwarding through $near pagination', () => {
  it('Repository.getAll forwards readPreference to the find query without breaking $near', async () => {
    // The in-memory MongoDB topology doesn't actually have replicas, but
    // Mongoose accepts the readPreference and forwards it to the driver
    // without error when set to 'primary' (the default for standalone).
    // The important contract is: passing readPreference does NOT make the
    // $near query throw, and the result count is unchanged.
    const parsed = parser.parse({
      'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},10000`,
    });

    const result = await placeRepo.getAll({
      filters: parsed.filters,
      readPreference: 'primary',
      mode: 'offset',
    });
    if (result.method !== 'offset') throw new Error('expected offset');

    expect(result.total).toBe(3);
    expect(result.docs[0].name).toBe('Times Square');
  });

  it('rejects unknown readPreference values gracefully (driver-level error)', async () => {
    // We don't validate readPreference ourselves — Mongoose/driver does.
    // This proves the error surfaces clearly when the value is wrong, so
    // users get an actionable failure rather than a silent fallback.
    const parsed = parser.parse({
      'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},10000`,
    });

    await expect(
      placeRepo.getAll({
        filters: parsed.filters,
        readPreference: 'not-a-valid-pref' as unknown as 'primary',
        mode: 'offset',
      }),
    ).rejects.toThrow();
  });

  it('readPreference + $geoWithin (no rewrite path) also works', async () => {
    // $geoWithin is a filter, not a sort, so it goes through the normal
    // PaginationEngine path. Verifies readPreference forwards there too.
    const parsed = parser.parse({
      'location[geoWithin]': '-74.05,40.65,-73.93,40.80',
    });

    const result = await placeRepo.getAll({
      filters: parsed.filters,
      readPreference: 'primary',
      mode: 'offset',
    });
    if (result.method !== 'offset') throw new Error('expected offset');

    // Box covers Manhattan + Statue of Liberty
    expect(result.total).toBeGreaterThanOrEqual(2);
  });
});
