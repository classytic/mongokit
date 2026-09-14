/**
 * A rejected `createMany` must say what it wrote.
 *
 * Neither ordering prevents a partial write — `ordered: true` keeps everything
 * before the first failure, `ordered: false` keeps everything valid. Measured
 * on a six-document batch with a conflict in the middle: ordered wrote 3,
 * unordered wrote 5. Only a transaction gives all-or-nothing.
 *
 * So the danger was never the default; it was that the rejection carried no
 * usable account of what had happened. A caller that treats it as "nothing
 * was written" and retries the batch double-writes everything that succeeded.
 *
 * `err.partial` closes that: what landed, what did not, and WHERE in the input
 * each failure was. The index is the load-bearing field — the driver reports
 * failures positionally, and a rejected document never comes back with an
 * `_id` to match on.
 *
 * The existing contract is unchanged: the call still rejects, with the driver's
 * own error. This only decorates it.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isCreateManyPartialError, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id?: mongoose.Types.ObjectId;
  n: number;
  tag?: string;
}

let Model: mongoose.Model<IRow>;
let repo: Repository<IRow>;

beforeAll(async () => {
  await connectDB();
  Model = await createTestModel<IRow>(
    'PartialReportRow',
    new mongoose.Schema<IRow>({
      n: { type: Number, required: true, unique: true },
      tag: { type: String },
    }),
  );
  await Model.createIndexes();
  repo = new Repository<IRow>(Model);
}, 120_000);

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

const batch = () => [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }];

describe('the rejection reports what landed', () => {
  it('names the inserted documents and the failures by input index', async () => {
    await Model.create({ n: 3 }); // conflicts with index 2 of the batch

    let caught: unknown;
    try {
      await repo.createMany(batch());
    } catch (err) {
      caught = err;
    }

    expect(isCreateManyPartialError(caught)).toBe(true);
    if (!isCreateManyPartialError<IRow>(caught)) return;

    const { inserted, failed } = caught.partial;
    expect(inserted).toHaveLength(4);
    expect(failed).toHaveLength(1);
    // The position in the array the CALLER passed, not a server offset.
    expect(failed[0].index).toBe(2);
    expect(failed[0].doc).toEqual({ n: 3 });
    expect(failed[0].code).toBe(11000);
    expect(failed[0].message).toMatch(/duplicate key/i);
  });

  it('reports several failures, each at its own index', async () => {
    await Model.insertMany([{ n: 2 }, { n: 4 }]);

    let caught: unknown;
    try {
      await repo.createMany(batch());
    } catch (err) {
      caught = err;
    }

    if (!isCreateManyPartialError<IRow>(caught)) throw new Error('expected a partial report');
    expect(caught.partial.failed.map((f) => f.index)).toEqual([1, 3]);
    expect(caught.partial.inserted).toHaveLength(3);
  });

  it('still rejects — the contract is unchanged, only better described', async () => {
    await Model.create({ n: 1 });
    // A caller that only cares that it failed sees exactly what it saw before.
    await expect(repo.createMany(batch())).rejects.toThrow(/duplicate key/i);
  });

  it('is absent on success', async () => {
    const docs = await repo.createMany(batch());
    expect(docs).toHaveLength(5);
  });
});

describe('the report is enough to retry only what failed', () => {
  it('a retry of `failed` completes the batch without double-writing', async () => {
    // The scenario the report exists for. Retrying the whole batch would
    // conflict on every document that had already succeeded; retrying the
    // failures alone converges.
    await Model.create({ n: 3, tag: 'pre-existing' });

    let caught: unknown;
    try {
      await repo.createMany(batch());
    } catch (err) {
      caught = err;
    }
    if (!isCreateManyPartialError<IRow>(caught)) throw new Error('expected a partial report');

    // Resolve the conflict the way an operator would, then retry ONLY the
    // rejected inputs.
    await Model.deleteOne({ n: 3 });
    const retry = caught.partial.failed.map((f) => f.doc);
    const recovered = await repo.createMany(retry);

    expect(recovered).toHaveLength(1);
    expect(await Model.countDocuments({})).toBe(5);
    // Every original input landed exactly once.
    const all = await Model.find({}).sort({ n: 1 }).lean();
    expect(all.map((d) => d.n)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('ordered: true reports too — it is not the safe path either', () => {
  it('a rejected ordered batch also wrote part of the input, and says so', async () => {
    await Model.create({ n: 3 });

    let caught: unknown;
    try {
      await repo.createMany(batch(), { ordered: true });
    } catch (err) {
      caught = err;
    }

    if (!isCreateManyPartialError<IRow>(caught)) throw new Error('expected a partial report');
    // Stopped at index 2, keeping the two before it — a deterministic prefix,
    // but a partial write all the same.
    expect(caught.partial.failed[0].index).toBe(2);
    expect(await Model.countDocuments({})).toBe(3);
  });
});
