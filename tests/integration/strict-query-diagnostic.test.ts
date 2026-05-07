/**
 * `RepositoryOptions.warnOnStrictQueryStrip` — runtime diagnostic for
 * the strictQuery silent-strip trap.
 *
 * With `strictQuery: true` (mongoose 6 default), filter keys not on the
 * schema are silently stripped before the query runs — `findOne({ code:
 * 'X' })` on a schema without `code` becomes `findOne({})`. Returns the
 * first doc, not null. Bug looks like "wrong row returned." No error,
 * no warning.
 *
 * The opt-in diagnostic catches it at runtime: log once per
 * `(modelName, fieldName)` pair. This file pins the behavior.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/index.js';
import { configureLogger } from '../../src/utils/logger.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrg {
  _id?: mongoose.Types.ObjectId;
  name: string;
  // `code` deliberately NOT declared — that's the trap.
}

describe('warnOnStrictQueryStrip — silent-strip diagnostic', () => {
  let Model: mongoose.Model<IOrg>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'StrictQueryDiagnosticOrg',
      new Schema<IOrg>({ name: String }, { strictQuery: true }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  let warnSpy: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    await Model.deleteMany({});
    warnSpy = vi.fn();
    configureLogger({ warn: warnSpy });
  });
  afterEach(() => {
    configureLogger({ warn: console.warn.bind(console) });
  });

  it('warns when a query filters on an undeclared field', async () => {
    const repo = new Repository<IOrg>(Model, [], {}, { warnOnStrictQueryStrip: true });
    await repo.create({ name: 'Acme' });

    // Filter on `code` which doesn't exist on the schema.
    await repo.getOne({ code: 'X' } as never);

    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.find((c) => String(c[0]).includes('code'));
    expect(message).toBeDefined();
    expect(String(message?.[0])).toMatch(/StrictQueryDiagnosticOrg.*code.*strictQuery/i);
  });

  it('dedupes — warns once per (model, field) pair, even on N calls', async () => {
    const repo = new Repository<IOrg>(Model, [], {}, { warnOnStrictQueryStrip: true });

    for (let i = 0; i < 5; i++) {
      await repo.getOne({ code: 'X' } as never);
    }
    const calls = warnSpy.mock.calls.filter((c) => String(c[0]).includes('code'));
    expect(calls).toHaveLength(1);
  });

  it('does NOT warn for declared paths', async () => {
    const repo = new Repository<IOrg>(Model, [], {}, { warnOnStrictQueryStrip: true });
    await repo.getOne({ name: 'Acme' });
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('strictQuery'))).toHaveLength(0);
  });

  it('does NOT warn for `_id` queries', async () => {
    const repo = new Repository<IOrg>(Model, [], {}, { warnOnStrictQueryStrip: true });
    const fakeId = new mongoose.Types.ObjectId();
    await repo.getById(String(fakeId));
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('strictQuery'))).toHaveLength(0);
  });

  it('does NOT warn for top-level Mongo operators ($and / $or)', async () => {
    const repo = new Repository<IOrg>(Model, [], {}, { warnOnStrictQueryStrip: true });
    await repo.getOne({
      $or: [{ name: 'Acme' }, { name: 'Beta' }],
    });
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('strictQuery'))).toHaveLength(0);
  });

  it('does NOT warn when the option is off (default behavior)', async () => {
    // No constructor option → diagnostic disabled.
    const repo = new Repository<IOrg>(Model);
    await repo.getOne({ code: 'X' } as never);
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('strictQuery'))).toHaveLength(0);
  });

  it('does NOT warn for a strictQuery: false schema', async () => {
    if (mongoose.models.StrictQueryFalseOrg) delete mongoose.models.StrictQueryFalseOrg;
    const PermissiveModel = mongoose.model<IOrg>(
      'StrictQueryFalseOrg',
      new Schema<IOrg>({ name: String }, { strictQuery: false }),
    );
    await PermissiveModel.init();
    const repo = new Repository<IOrg>(PermissiveModel, [], {}, { warnOnStrictQueryStrip: true });
    await repo.getOne({ code: 'X' } as never);
    // strictQuery: false → no strip → no warn.
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('strictQuery'))).toHaveLength(0);
    await PermissiveModel.deleteMany({});
  });

  it('checks getAll filters bag too, not just query record', async () => {
    const repo = new Repository<IOrg>(Model, [], {}, { warnOnStrictQueryStrip: true });
    await repo.getAll({ filters: { undeclaredField: 'x' }, page: 1, limit: 10 });
    const calls = warnSpy.mock.calls.filter((c) => String(c[0]).includes('undeclaredField'));
    expect(calls).toHaveLength(1);
  });
});
