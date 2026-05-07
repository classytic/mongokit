/**
 * Run the cross-kit lock conformance suite against the Mongo-backed
 * adapter. Proves parity with the memory reference + the SQLite kit:
 * identical scenarios, identical assertions, different backend.
 *
 * If a future change to the Mongo adapter drifts behavior away from
 * the contract, this test fails before the kit's local-only test
 * does. The local lock-adapter.test.ts stays as the place for
 * Mongo-specific scenarios that don't apply to other backends.
 */

import { runLockAdapterConformance } from '@classytic/repo-core/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe } from 'vitest';
import { createMongoLockAdapter } from '../../src/lock/index.js';
import { connectDB, disconnectDB } from '../setup.js';

describe('createMongoLockAdapter — conformance', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  runLockAdapterConformance({
    createAdapter: () =>
      createMongoLockAdapter({
        collectionName: 'lock_conformance',
        modelName: 'MongoLockConformance',
      }),
    async beforeEach() {
      // Drop residual locks between scenarios so "first acquire"
      // tests start from a clean slate.
      const conn = mongoose.connection.db;
      if (conn) {
        await conn.collection('lock_conformance').deleteMany({});
      }
    },
  });
});
