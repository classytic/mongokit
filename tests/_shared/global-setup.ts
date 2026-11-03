/**
 * Vitest global setup — runs ONCE per `vitest run` invocation, across all
 * forks. Spins up a single-node **replica set** via `MongoMemoryReplSet`
 * (not a plain standalone) so the entire test suite — including the
 * transaction safety tests and the outbox atomicity assertions — can
 * exercise real `session.withTransaction` semantics.
 *
 * Why a replica set instead of a standalone mongod:
 *   - Standalone mongod returns error 263 on `startTransaction`, forcing
 *     every transaction test into its `allowFallback` branch. That means
 *     we never actually observe a real commit or a real rollback in CI.
 *   - The outbox pattern's entire guarantee ("outbox row commits atomically
 *     with the business write, or not at all") is undetectable without
 *     a real transaction. Skipping that coverage defeats the point of
 *     shipping the recipe.
 *   - Single-node replica sets boot in ~2-3s on modern hardware — small
 *     price for covering the one behavior that distinguishes transactional
 *     writes from unreliable ones.
 *
 * To run against an external MongoDB (real replica set, CI smoke, sharded
 * cluster), set `MONGODB_URI` before invoking vitest:
 *     MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0 vitest run
 * When `MONGODB_URI` is already present, globalSetup skips its own server
 * entirely — the caller owns the lifecycle.
 */

import { createMongoMemory, type MongoMemoryHandle } from '../../src/testkit/index.js';

// Through the testkit, not `MongoMemoryReplSet.create()`: stop cleans up the
// data dir, a run killed before teardown is cleaned up on exit, and abandoned
// `mongo-mem-*` dirs from earlier killed runs are swept (see src/testkit/mongo-tmp.ts).
let replset: MongoMemoryHandle | undefined;

export async function setup(): Promise<void> {
  // Honor caller-provided URI (real mongo, CI replica set, etc.)
  if (process.env.MONGODB_URI) {
    // eslint-disable-next-line no-console
    console.log('[mongokit-tests] Using external MONGODB_URI, skipping memory server');
    return;
  }

  // Single-node replica set — the smallest topology that supports
  // multi-document transactions. We don't need election/majority
  // semantics for tests; we just need the replication oplog so
  // `session.startTransaction()` doesn't error out with code 263.
  replset = await createMongoMemory({ replset: true, dbName: 'mongokit-test' });

  process.env.MONGODB_URI = replset.uri;
  process.env.MONGOKIT_TEST_SHARED_SERVER = '1';
  process.env.MONGOKIT_TEST_REPLICA_SET = '1';
}

export async function teardown(): Promise<void> {
  if (replset) {
    await replset.stop();
    replset = undefined;
  }
  // Leave MONGODB_URI alone in case teardown is followed by another suite.
}
