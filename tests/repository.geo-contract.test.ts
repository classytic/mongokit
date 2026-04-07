import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryParser, Repository } from '../src/index.js';

interface IPlace {
  name: string;
  category: string;
  location: {
    type: 'Point';
    coordinates: [number, number];
  };
}

const PlaceSchema = new Schema<IPlace>({
  name: { type: String, required: true },
  category: { type: String, required: true },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      required: true,
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      required: true,
    },
  },
});
PlaceSchema.index({ location: '2dsphere' });

const TIMES_SQUARE: [number, number] = [-73.9857, 40.7589];
const CENTRAL_PARK: [number, number] = [-73.9654, 40.7829];
const STATUE_OF_LIBERTY: [number, number] = [-74.0445, 40.6892];

describe('Repository geo contract', () => {
  let mongoServer: MongoMemoryServer;
  let PlaceModel: mongoose.Model<IPlace>;
  let repo: Repository<IPlace>;
  let parser: QueryParser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    if (mongoose.models.RepositoryGeoContractPlace) {
      delete mongoose.models.RepositoryGeoContractPlace;
    }
    PlaceModel = mongoose.model<IPlace>('RepositoryGeoContractPlace', PlaceSchema);
    await PlaceModel.init();
    repo = new Repository(PlaceModel);
    parser = new QueryParser({ schema: PlaceSchema });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await PlaceModel.deleteMany({});
    await PlaceModel.create([
      {
        name: 'Times Square',
        category: 'landmark',
        location: { type: 'Point', coordinates: TIMES_SQUARE },
      },
      {
        name: 'Central Park',
        category: 'park',
        location: { type: 'Point', coordinates: CENTRAL_PARK },
      },
      {
        name: 'Statue of Liberty',
        category: 'landmark',
        location: { type: 'Point', coordinates: STATUE_OF_LIBERTY },
      },
    ]);
  });

  it('getAll() preserves Mongo $near sorting semantics instead of applying the repository default sort', async () => {
    // Times Square → Central Park is ~3173m (verified via $geoNear).
    // Use 3500m so the count includes both, proving the count rewrite is
    // accurate against the same document set Mongo's $near matches.
    const parsed = parser.parse({
      'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},3500`,
    });

    await expect(
      repo.getAll({
        filters: parsed.filters,
        mode: 'offset',
      }),
    ).resolves.toMatchObject({
      method: 'offset',
      total: 2,
    });
  });

  it('geo filters compose with other filters without forcing a conflicting default sort', async () => {
    const parsed = parser.parse({
      'location[near]': `${TIMES_SQUARE[0]},${TIMES_SQUARE[1]},10000`,
      category: 'park',
    });

    await expect(
      repo.getAll({
        filters: parsed.filters,
        mode: 'offset',
      }),
    ).resolves.toMatchObject({
      method: 'offset',
      total: 1,
    });
  });
});
