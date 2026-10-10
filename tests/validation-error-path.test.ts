/**
 * A mongoose ValidationError keeps each failing field's PATH on `validationErrors`, so the
 * wire contract (`toErrorContract` → `details[].path`) can point a form at the field.
 */
import { toErrorContract } from '@classytic/repo-core/errors';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../src/index.js';
import { clearDB, connectDB, createTestModel, disconnectDB } from './setup.js';

const schema = new mongoose.Schema({
  name: { type: String, required: true },
  bin: { type: String, validate: { validator: (v: string) => /^\d{13}$/.test(v), message: 'BIN must be 13 digits' } },
});

describe('Repository — mongoose ValidationError translation', () => {
  let repo: Repository<{ _id: mongoose.Types.ObjectId; name: string; bin?: string }>;

  beforeAll(async () => {
    await connectDB();
    repo = new Repository(await createTestModel('ValidationErrorPath', schema));
    await clearDB();
  });
  afterAll(async () => {
    await disconnectDB();
  });

  it('names the failing field on validationErrors and on the wire details', async () => {
    const err = (await repo.create({ name: 'Supplier', bin: '000123456789' }).catch((e: unknown) => e)) as {
      status?: number;
      validationErrors?: Array<{ path?: string; validator: string; error: string }>;
    };
    expect(err.status).toBe(400);
    expect(err.validationErrors).toEqual([{ path: 'bin', validator: 'user defined', error: 'BIN must be 13 digits' }]);
    expect(toErrorContract(err).details).toEqual([{ path: 'bin', code: 'user defined', message: 'BIN must be 13 digits' }]);
  });

  it('reports every failing field, each with its own path', async () => {
    const err = (await repo.create({ bin: '1' } as never).catch((e: unknown) => e)) as {
      validationErrors?: Array<{ path?: string }>;
    };
    expect((err.validationErrors ?? []).map((v) => v.path).sort()).toEqual(['bin', 'name']);
  });
});
