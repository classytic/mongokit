/**
 * Run the cross-kit usage-store conformance suite against the
 * Mongo-backed adapter. Proves parity with the memory reference (and
 * future SQL kits): identical scenarios, identical assertions,
 * different backend — including $inc atomicity under concurrency and
 * dotted-kind round-tripping (the reason the adapter is row-per-cell,
 * not a kinds-map).
 */

import { runUsageStoreContract } from '@classytic/repo-core/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe } from 'vitest';
import { createMongoUsageStore } from '../../src/usage/index.js';
import { connectDB, disconnectDB } from '../setup.js';

describe('createMongoUsageStore — conformance', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  runUsageStoreContract({
    createStore: () =>
      createMongoUsageStore({
        collectionName: 'usage_conformance',
        modelName: 'MongoUsageConformance',
      }),
    async beforeEach() {
      await mongoose.connection.collection('usage_conformance').deleteMany({});
    },
  });
});
