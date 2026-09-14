/**
 * `bulkWrite` must forward the driver options it is given, or refuse them.
 *
 * The signature was `{ session?, ordered?, [key: string]: unknown }` and the
 * call forwarded exactly two keys. So `writeConcern: { w: 'majority' }` on a
 * money import type-checked, was dropped on the floor, and the write went out
 * under the default concern with nothing raised.
 *
 * Dropping the index signature alone would not have been enough: the mongodb
 * driver ITSELF accepts an unknown option silently — verified against the
 * installed driver, not assumed — so mongokit is the only layer that can catch
 * the mistake.
 *
 * But the bag is dual-purpose: it is spread into `_buildContext`, so plugins
 * read their scope off it too. Refusing every unrecognised key therefore broke
 * multi-tenant `bulkWrite` by rejecting `organizationId` — the first version of
 * this fence did exactly that. The line now sits at the caller's expectation:
 * refuse an option the DRIVER understands and we would drop; let anything else
 * through as context.
 *
 * What is NOT tested here, because it is not true: that a large `bulkWrite`
 * overruns MongoDB's command limits. The driver splits at `maxWriteBatchSize`;
 * 5000 operations insert cleanly. The last case pins that, so the claim does
 * not get re-litigated into a chunking feature nobody needs.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { batchOperationsPlugin, methodRegistryPlugin, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  n: number;
  tag?: string;
}

type BulkRepo = Repository<IRow> & {
  bulkWrite(ops: Record<string, unknown>[], options?: Record<string, unknown>): Promise<{
    insertedCount: number;
    modifiedCount: number;
  }>;
};

let Model: mongoose.Model<IRow>;
let repo: BulkRepo;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'BulkOptRow',
    new mongoose.Schema<IRow>({
      n: { type: Number, required: true },
      tag: { type: String },
    }),
  );
  repo = new Repository<IRow>(Model, [
    methodRegistryPlugin(),
    batchOperationsPlugin(),
  ]) as BulkRepo;
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

const insert = (n: number) => ({ insertOne: { document: { n } } });

describe('a driver option it would silently drop is refused', () => {
  it.each([
    ['forceServerObjectId', { forceServerObjectId: true }],
    ['timeoutMS', { timeoutMS: 5000 }],
    ['maxTimeMS', { maxTimeMS: 5000 }],
    ['retryWrites', { retryWrites: false }],
  ])('refuses %s', async (_label, bad) => {
    await expect(repo.bulkWrite([insert(1)], bad)).rejects.toThrow(/does not forward/i);
  });

  it('names both the offending key and the supported set', async () => {
    await expect(repo.bulkWrite([insert(1)], { timeoutMS: 1 })).rejects.toThrow(
      /'timeoutMS'[\s\S]*Supported:[\s\S]*writeConcern/,
    );
  });

  it('refuses BEFORE writing anything', async () => {
    await expect(repo.bulkWrite([insert(1)], { maxTimeMS: 1 })).rejects.toThrow();
    // A refusal that happened after the write would be worse than the bug.
    expect(await Model.countDocuments({})).toBe(0);
  });
});

describe('plugin context rides alongside and is NOT refused', () => {
  it('passes a tenant id through untouched', async () => {
    // The options bag is spread into `_buildContext`, so plugins read their
    // scope off it. The first version of this fence refused every unknown key
    // and rejected `organizationId` — breaking multi-tenant bulkWrite outright.
    const result = await repo.bulkWrite([insert(1)], { organizationId: 'org_1' });
    expect(result.insertedCount).toBe(1);
  });

  it('accepts an arbitrary host context key', async () => {
    const result = await repo.bulkWrite([insert(2)], { actorId: 'u1', requestId: 'r1' });
    expect(result.insertedCount).toBe(1);
  });
});

describe('the options it does support reach the driver', () => {
  it('accepts every documented option together', async () => {
    const result = await repo.bulkWrite([insert(1), insert(2)], {
      ordered: true,
      writeConcern: { w: 1 },
      bypassDocumentValidation: false,
      comment: 'import-42',
      ignoreUndefined: true,
    });

    expect(result.insertedCount).toBe(2);
  });

  it('honours ordered: false — later operations still run after a failure', async () => {
    await Model.collection.createIndex({ n: 1 }, { unique: true });
    await repo.bulkWrite([insert(1)], {});

    await expect(
      repo.bulkWrite([insert(1), insert(2), insert(3)], { ordered: false }),
    ).rejects.toThrow();

    // 2 and 3 landed despite 1 conflicting — that is what unordered means.
    expect(await Model.countDocuments({})).toBe(3);
    await Model.collection.dropIndexes();
  });

  it('defaults to ordered: true, matching the driver', async () => {
    await Model.collection.createIndex({ n: 1 }, { unique: true });
    await repo.bulkWrite([insert(1)], {});

    await expect(repo.bulkWrite([insert(1), insert(2), insert(3)])).rejects.toThrow();

    // Stopped at the conflict: nothing after it ran.
    expect(await Model.countDocuments({})).toBe(1);
    await Model.collection.dropIndexes();
  });
});

describe('batch size is the driver’s problem, not ours', () => {
  it('writes 5000 operations without chunking', async () => {
    // Well past maxWriteBatchSize (1000). The driver splits; there is no
    // wire-limit failure to defend against, so mongokit adds no chunking.
    const ops = Array.from({ length: 5000 }, (_, i) => insert(i));
    const result = await repo.bulkWrite(ops, { ordered: true });

    expect(result.insertedCount).toBe(5000);
    expect(await Model.countDocuments({})).toBe(5000);
  }, 120_000);
});
