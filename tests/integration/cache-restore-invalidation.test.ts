/**
 * Regression: cache plugin didn't listen for `after:restore`. After a
 * soft-deleted doc was restored, cached "not found" / "filtered-out"
 * responses kept serving until the TTL elapsed — symmetric with the
 * `after:delete` invalidation that already existed.
 *
 * Fix: cache plugin now invalidates the restored doc's id-keyed cache
 * + bumps the list-cache version on `after:restore`. This file pins the
 * behavior so the gap can't reopen.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import {
  batchOperationsPlugin,
  cachePlugin,
  methodRegistryPlugin,
} from '../../src/plugins/index.js';
import { softDeletePlugin } from '../../src/plugins/soft-delete.plugin.js';
import { createMemoryCache } from '../../src/utils/memory-cache.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  _id?: mongoose.Types.ObjectId;
  name: string;
  status: 'active' | 'archived';
  deletedAt?: Date | null;
}

describe('cache plugin invalidates on restore (regression)', () => {
  let Model: mongoose.Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'CacheRestoreInvalidation',
      new Schema<IDoc>({
        name: { type: String, required: true },
        status: { type: String, required: true },
        deletedAt: { type: Date, default: null },
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  it('after:restore invalidates the id-keyed cache so getById returns the restored doc', async () => {
    const adapter = createMemoryCache();
    const repo = new Repository<IDoc>(Model, [
      methodRegistryPlugin(),
      softDeletePlugin({ deletedField: 'deletedAt' }),
      batchOperationsPlugin(),
      cachePlugin({ adapter, defaults: { staleTime: 60 } }),
    ]);

    const created = await repo.create({ name: 'A', status: 'active' });
    const id = String(created._id);

    // Prime the id cache.
    expect(await repo.getById(id)).not.toBeNull();

    // Soft-delete — `after:delete` already invalidates id cache (covered).
    await repo.delete(id);
    // After delete, getById is filtered (returns null) and that null is cached.
    expect(await repo.getById(id)).toBeNull();

    // Restore. Without `after:restore` invalidation, the cached null persists.
    await (repo as Repository<IDoc> & { restore: (id: string) => Promise<unknown> }).restore(id);

    // Now getById must see the restored doc — pre-fix this returned null
    // because the cached "filtered out" response from step above stuck.
    const seen = await repo.getById(id);
    expect(seen).not.toBeNull();
    expect(seen?.name).toBe('A');
  });

  it('after:restore bumps list-cache version so getAll picks up the restored doc', async () => {
    const adapter = createMemoryCache();
    const repo = new Repository<IDoc>(Model, [
      methodRegistryPlugin(),
      softDeletePlugin({ deletedField: 'deletedAt' }),
      batchOperationsPlugin(),
      cachePlugin({ adapter, defaults: { staleTime: 60 } }),
    ]);

    await repo.create({ name: 'X', status: 'active' });
    const created = await repo.create({ name: 'Y', status: 'active' });

    // Prime the list cache.
    let list = await repo.getAll({ page: 1, limit: 10 });
    expect(list.method).toBe('offset');
    if (list.method !== 'offset') throw new Error('expected offset');
    expect(list.data).toHaveLength(2);

    // Soft-delete one doc — list cache invalidated by `after:delete`.
    await repo.delete(String(created._id));
    list = await repo.getAll({ page: 1, limit: 10 });
    if (list.method !== 'offset') throw new Error('expected offset');
    expect(list.data).toHaveLength(1);

    // Restore. `after:restore` MUST bump the list-cache version too.
    await (repo as Repository<IDoc> & { restore: (id: string) => Promise<unknown> }).restore(
      String(created._id),
    );

    list = await repo.getAll({ page: 1, limit: 10 });
    if (list.method !== 'offset') throw new Error('expected offset');
    expect(list.data).toHaveLength(2); // pre-fix: still 1, list-cache stale
  });
});
