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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('createMongoUsageStore — first writes on a brand-new collection', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // Writes issued the moment the store exists, before the unique cell index is built,
  // must still land in ONE cell: concurrent upserts without that index insert
  // duplicates instead of failing on E11000, splitting the count.
  it('concurrent first increments land in one cell with the exact total', async () => {
    const name = `usage_fresh_${Date.now()}`;
    const store = createMongoUsageStore({ collectionName: name, modelName: name });
    const bucket = { actor: 'org:1', period: '2026-10', kind: 'ai.requests' };
    await Promise.all(Array.from({ length: 50 }, () => store.increment(bucket, 1)));
    expect(await store.summary('org:1', '2026-10')).toEqual({ 'ai.requests': 50 });
    expect(await mongoose.connection.collection(name).countDocuments()).toBe(1);
  });
});

// Mirrors repo-core's `UsageStore contract` scenario "kinds named like Object.prototype
// members are plain counters" until the installed repo-core carries it.
describe('createMongoUsageStore — kinds named like Object.prototype members', () => {
  beforeAll(async () => {
    await connectDB();
  });

  it('sums constructor / toString / __proto__ as own counters', async () => {
    const name = `usage_proto_${Date.now()}`;
    const store = createMongoUsageStore({ collectionName: name, modelName: name });
    await store.increment({ actor: 'org-p', period: '2026-07', kind: 'constructor' }, 2);
    await store.increment({ actor: 'org-p', period: '2026-07', kind: 'toString' }, 1);
    await store.increment({ actor: 'org-p', period: '2026-07', kind: '__proto__' }, 3);
    await store.increment({ actor: 'org-p', period: '2026-07', kind: 'constructor' }, 5);
    const summary = await store.summary('org-p', '2026-07');
    expect(Object.entries(summary).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
      ['__proto__', 3],
      ['constructor', 7],
      ['toString', 1],
    ]);
    expect(Object.getPrototypeOf(summary)).toBe(Object.prototype);
  });
});
