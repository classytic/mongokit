/**
 * The mongo change feed against the `ChangeLogStore` contract, on a replica set (transactions).
 * Each scenario gets its own feed, so every case starts from an empty store.
 */
import { runChangeLogStoreConformance } from '@classytic/repo-core/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe } from 'vitest';
import { createChangeLogModels, createChangeLogStore } from '../../src/sync/index.js';
import { connectDB, disconnectDB } from '../setup.js';

describe('mongo change-log store', () => {
  let feeds = 0;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  runChangeLogStoreConformance({
    async createStore() {
      feeds += 1;
      const models = createChangeLogModels(mongoose.connection, { collection: `sync_conformance_${feeds}`, modelName: `SyncConformance${feeds}` });
      await models.entries.syncIndexes();
      return createChangeLogStore(models);
    },
    // As production code runs it: the driver retries a transaction that loses a write conflict.
    async transaction(work) {
      const session = await mongoose.startSession();
      try {
        let result: Awaited<ReturnType<typeof work>> | undefined;
        await session.withTransaction(async () => {
          result = await work(session);
        });
        return result as Awaited<ReturnType<typeof work>>;
      } finally {
        await session.endSession();
      }
    },
  });
});
