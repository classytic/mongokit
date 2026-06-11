/**
 * `lean: true` on read operations — results are plain objects (no
 * mongoose Document hydration: no `.save`, not `instanceof Document`).
 *
 * Capability flag: `MONGOKIT_CAPABILITIES.lean`.
 *
 * Defaults differ by op (long-standing behavior, locked in here):
 *   - getById / getOne / getByQuery: hydrated by default, lean on request.
 *   - findAll / getAll / cursor: lean by default (list reads).
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MONGOKIT_CAPABILITIES, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface ILeanDoc {
  name: string;
  rank: number;
}

function isPlainObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof mongoose.Document) &&
    typeof (value as { save?: unknown }).save !== 'function'
  );
}

describe('lean reads', () => {
  let Model: mongoose.Model<ILeanDoc>;
  let repo: Repository<ILeanDoc>;
  let id: string;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'LeanReadsDoc',
      new mongoose.Schema<ILeanDoc>({
        name: { type: String, required: true },
        rank: { type: Number, required: true },
      }),
    );
    repo = new Repository<ILeanDoc>(Model);
    const doc = await repo.create({ name: 'alpha', rank: 1 });
    id = String((doc as ILeanDoc & { _id: unknown })._id);
    await repo.create({ name: 'beta', rank: 2 });
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  it('declares the capability', () => {
    expect(MONGOKIT_CAPABILITIES.lean).toBe(true);
    expect(repo.capabilities.lean).toBe(true);
  });

  it('getById honors lean: true (and hydrates by default)', async () => {
    const hydrated = await repo.getById(id);
    expect(typeof (hydrated as unknown as { save?: unknown })?.save).toBe('function');

    const lean = await repo.getById(id, { lean: true });
    expect(lean).not.toBeNull();
    expect(isPlainObject(lean)).toBe(true);
    expect(lean?.name).toBe('alpha');
  });

  it('getOne / getByQuery honor lean: true', async () => {
    const one = await repo.getOne({ name: 'alpha' }, { lean: true });
    expect(isPlainObject(one)).toBe(true);

    const byQuery = await repo.getByQuery({ name: 'beta' }, { lean: true });
    expect(isPlainObject(byQuery)).toBe(true);
  });

  it('findAll returns plain objects with lean: true (and by default)', async () => {
    const docs = await repo.findAll({}, { lean: true });
    expect(docs.length).toBeGreaterThanOrEqual(2);
    for (const doc of docs) expect(isPlainObject(doc)).toBe(true);

    const defaulted = await repo.findAll({});
    for (const doc of defaulted) expect(isPlainObject(doc)).toBe(true);
  });

  it('getAll (paginated) returns plain objects with lean: true', async () => {
    const result = (await repo.getAll({ page: 1, limit: 10 }, { lean: true })) as {
      data: ILeanDoc[];
    };
    expect(result.data.length).toBeGreaterThanOrEqual(2);
    for (const doc of result.data) expect(isPlainObject(doc)).toBe(true);
  });

  it('cursor yields plain objects with lean: true', async () => {
    for await (const doc of repo.cursor({}, { lean: true })) {
      expect(isPlainObject(doc)).toBe(true);
    }
  });
});
