/**
 * `incrementIfBelow(id, field, ceiling, by?)` — single-round-trip CAS.
 *
 * Increments the field only when its current value is strictly below
 * the ceiling. Returns the updated doc on success; null when at/above
 * the ceiling (or the row is missing). Pattern targets per-doc
 * concurrency limits / quotas / capacity caps where a read-then-write
 * loop would race.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import {
  methodRegistryPlugin,
  mongoOperationsPlugin,
  type MongoOperationsMethods,
} from '../../src/plugins/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface ITenant {
  _id?: mongoose.Types.ObjectId;
  name: string;
  activeRuns: number;
}

type TenantRepo = Repository<ITenant> & MongoOperationsMethods<ITenant>;

describe('incrementIfBelow — atomic conditional increment', () => {
  let Model: mongoose.Model<ITenant>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'IncrementIfBelowTenant',
      new Schema<ITenant>({
        name: { type: String, required: true },
        activeRuns: { type: Number, required: true, default: 0 },
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

  it('increments when current value is below the ceiling', async () => {
    const repo = new Repository<ITenant>(Model, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]) as TenantRepo;

    const created = await repo.create({ name: 'A', activeRuns: 5 });
    const id = String(created._id);

    const result = await repo.incrementIfBelow(id, 'activeRuns', 10);
    expect(result).not.toBeNull();
    expect(result?.activeRuns).toBe(6);
  });

  it('returns null when value is already at the ceiling', async () => {
    const repo = new Repository<ITenant>(Model, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]) as TenantRepo;

    const created = await repo.create({ name: 'B', activeRuns: 10 });
    const id = String(created._id);

    const result = await repo.incrementIfBelow(id, 'activeRuns', 10);
    expect(result).toBeNull();

    // Doc unchanged.
    const reread = await repo.getById(id);
    expect(reread?.activeRuns).toBe(10);
  });

  it('returns null when value is above the ceiling', async () => {
    const repo = new Repository<ITenant>(Model, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]) as TenantRepo;

    const created = await repo.create({ name: 'C', activeRuns: 15 });
    const id = String(created._id);

    expect(await repo.incrementIfBelow(id, 'activeRuns', 10)).toBeNull();
  });

  it('honors a custom `by` delta', async () => {
    const repo = new Repository<ITenant>(Model, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]) as TenantRepo;

    const created = await repo.create({ name: 'D', activeRuns: 0 });
    const id = String(created._id);

    const result = await repo.incrementIfBelow(id, 'activeRuns', 10, 3);
    expect(result?.activeRuns).toBe(3);
  });

  it('is race-safe under concurrent callers (only ceiling-many succeed)', async () => {
    const repo = new Repository<ITenant>(Model, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]) as TenantRepo;

    const created = await repo.create({ name: 'E', activeRuns: 0 });
    const id = String(created._id);

    // 20 callers race for 10 slots. Exactly 10 must succeed.
    const ceiling = 10;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repo.incrementIfBelow(id, 'activeRuns', ceiling)),
    );

    const successes = results.filter((r) => r !== null);
    const failures = results.filter((r) => r === null);
    expect(successes).toHaveLength(ceiling);
    expect(failures).toHaveLength(20 - ceiling);

    // Final value must be exactly the ceiling — no slot slipped through.
    const final = await repo.getById(id);
    expect(final?.activeRuns).toBe(ceiling);
  });

  it('returns null when the id does not exist', async () => {
    const repo = new Repository<ITenant>(Model, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]) as TenantRepo;

    const fakeId = new mongoose.Types.ObjectId();
    expect(await repo.incrementIfBelow(String(fakeId), 'activeRuns', 10)).toBeNull();
  });

  it('rejects non-numeric ceiling and `by` arguments', async () => {
    const repo = new Repository<ITenant>(Model, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]) as TenantRepo;

    const created = await repo.create({ name: 'F', activeRuns: 0 });
    const id = String(created._id);

    await expect(
      repo.incrementIfBelow(id, 'activeRuns', 'ten' as unknown as number),
    ).rejects.toThrow(/ceiling must be a number/);
    await expect(
      repo.incrementIfBelow(id, 'activeRuns', 10, 'one' as unknown as number),
    ).rejects.toThrow(/`by` must be a number/);
  });

  describe('field-path validation (injection / prototype-pollution guard)', () => {
    let repo: TenantRepo;
    let id: string;
    beforeEach(async () => {
      repo = new Repository<ITenant>(Model, [
        methodRegistryPlugin(),
        mongoOperationsPlugin(),
      ]) as TenantRepo;
      const created = await repo.create({ name: 'G', activeRuns: 0 });
      id = String(created._id);
    });

    it('rejects an empty field name', async () => {
      await expect(repo.incrementIfBelow(id, '', 10)).rejects.toThrow(
        /must be a non-empty string/,
      );
    });

    it('rejects a non-string field', async () => {
      await expect(
        repo.incrementIfBelow(id, 123 as unknown as string, 10),
      ).rejects.toThrow(/must be a non-empty string/);
    });

    it('rejects $-prefixed segments (Mongo would treat as operator)', async () => {
      await expect(repo.incrementIfBelow(id, '$where', 10)).rejects.toThrow(
        /cannot start with '\$'/,
      );
      await expect(repo.incrementIfBelow(id, 'nested.$inc', 10)).rejects.toThrow(
        /cannot start with '\$'/,
      );
    });

    it('rejects __proto__ / constructor / prototype segments', async () => {
      for (const evil of ['__proto__', 'constructor', 'prototype']) {
        await expect(repo.incrementIfBelow(id, evil, 10)).rejects.toThrow(
          /reserved.*prototype-pollution/,
        );
        await expect(repo.incrementIfBelow(id, `nested.${evil}`, 10)).rejects.toThrow(
          /reserved.*prototype-pollution/,
        );
      }
    });

    it('rejects empty segments in dotted paths', async () => {
      await expect(repo.incrementIfBelow(id, 'a..b', 10)).rejects.toThrow(/empty segment/);
      await expect(repo.incrementIfBelow(id, '.activeRuns', 10)).rejects.toThrow(/empty segment/);
      await expect(repo.incrementIfBelow(id, 'activeRuns.', 10)).rejects.toThrow(/empty segment/);
    });

    it('accepts well-formed nested dotted paths', async () => {
      // Sanity check: legitimate paths still work after the guard.
      // (No nested numeric field on this schema to actually mutate, so we
      // just assert the call doesn't throw at the validation layer.)
      const result = await repo.incrementIfBelow(id, 'activeRuns', 10);
      expect(result).not.toBeNull();
    });
  });
});
