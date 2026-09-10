/**
 * A structurally invalid id must not wedge the cache plugin's single flight.
 *
 * `getById` short-circuits an id that cannot exist (wrong ObjectId shape) to
 * `null` without a query. That fast path used to return PAST the after-hook,
 * so repo-core's single-flight claim — taken in `before:getById` — was never
 * released, and the next identical read waited on it forever. No error, no
 * log: the caller simply never resolved.
 */
import { cachePlugin, createMemoryCache, Repository } from '../src/index.js';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearDB, connectDB, createTestModel, disconnectDB } from './setup.js';

const schema = new mongoose.Schema({ name: String });

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> =>
  Promise.race([p, new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms))]);

describe('getById — invalid id under the cache plugin', () => {
  let repo: Repository<{ _id: mongoose.Types.ObjectId; name: string }>;

  beforeAll(async () => {
    await connectDB();
    const Model = await createTestModel<{ _id: mongoose.Types.ObjectId; name: string }>('CacheInvalidId', schema);
    repo = new Repository(Model, [cachePlugin({ adapter: createMemoryCache(), enabled: ['getById'] })]);
    await clearDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  it('two sequential reads of the SAME invalid id both resolve to null — the second must not hang', async () => {
    expect(await withTimeout(repo.getById('not-an-object-id'), 2000)).toBeNull();
    expect(await withTimeout(repo.getById('not-an-object-id'), 2000)).toBeNull();
  });

  it('concurrent reads of the same invalid id all resolve', async () => {
    const results = await withTimeout(
      Promise.all([repo.getById('still-invalid'), repo.getById('still-invalid'), repo.getById('still-invalid')]),
      2000,
    );
    expect(results).toEqual([null, null, null]);
  });

  it('a valid but missing id behaves the same way — null, twice, no hang', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    expect(await withTimeout(repo.getById(id), 2000)).toBeNull();
    expect(await withTimeout(repo.getById(id), 2000)).toBeNull();
  });
});
