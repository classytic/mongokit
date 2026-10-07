/** The mongo command-stream store against the `CommandStreamStore` contract, on a replica set. */
import { runCommandStreamStoreConformance } from '@classytic/repo-core/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe } from 'vitest';
import { createChangeLogModels, createChangeLogStore, createCommandStreamModels, createCommandStreamStore } from '../../src/sync/index.js';
import { connectDB, disconnectDB } from '../setup.js';

describe('mongo command-stream store', () => {
  let n = 0;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  runCommandStreamStoreConformance({
    async createStore() {
      n += 1;
      const feed = createChangeLogModels(mongoose.connection, { collection: `cs_feed_${n}`, modelName: `CsFeed${n}` });
      const models = createCommandStreamModels(mongoose.connection, { prefix: `cs_${n}`, modelName: `Cs${n}` });
      // Collections exist before the first transaction: creating one inside it can abort it.
      await Promise.all([feed.entries.createCollection(), feed.counter.createCollection(), models.streams.createCollection(), models.verdicts.syncIndexes(), models.aliases.syncIndexes()]);
      return createCommandStreamStore(mongoose.connection, models, createChangeLogStore(feed));
    },
  });
});
