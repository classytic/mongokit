/**
 * softRequired semantics — DB-level required: true but HTTP body optional.
 *
 * Covers both the per-path `softRequired: true` Mongoose schema option and
 * the per-build `softRequiredFields: []` override used when the consumer
 * doesn't own the Mongoose model.
 */

import mongoose, { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { buildCrudSchemasFromModel, buildCrudSchemasFromMongooseSchema } from '../src/index.js';

describe('softRequired support', () => {
  it('omits per-path softRequired:true fields from required[] but keeps them in properties', () => {
    const schema = new Schema({
      journalType: { type: String, required: true, softRequired: true },
      label: { type: String, required: true },
    });
    const Model = mongoose.model('TestSoftReq1', schema);
    const { createBody } = buildCrudSchemasFromModel(Model);

    expect(createBody.properties?.journalType).toBeDefined();
    expect(createBody.required).not.toContain('journalType');
    expect(createBody.required).toContain('label');
  });

  it('softRequiredFields option overrides upstream-owned schemas', () => {
    const schema = new Schema({
      journalType: { type: String, required: true },
      date: { type: Date, required: true },
      label: { type: String, required: true },
    });
    const { createBody } = buildCrudSchemasFromMongooseSchema(schema, {
      softRequiredFields: ['journalType', 'date'],
    });

    expect(createBody.required ?? []).not.toContain('journalType');
    expect(createBody.required ?? []).not.toContain('date');
    expect(createBody.required).toContain('label');
    expect(createBody.properties?.journalType).toBeDefined();
    expect(createBody.properties?.date).toBeDefined();
  });

  it('Mongoose still rejects null saves on softRequired fields (DB invariant preserved)', async () => {
    const schema = new Schema({
      journalType: { type: String, required: true, softRequired: true },
    });
    const Model = mongoose.model('TestSoftReq3', schema);
    await expect(new Model({ journalType: null }).validate()).rejects.toThrow(/journalType/);
  });

  it('update body already treats all fields as optional — softRequired is a no-op there but does not break it', () => {
    const schema = new Schema({
      journalType: { type: String, required: true, softRequired: true },
      label: { type: String, required: true },
    });
    const { updateBody } = buildCrudSchemasFromMongooseSchema(schema);
    expect(updateBody.required ?? []).not.toContain('journalType');
    expect(updateBody.required ?? []).not.toContain('label');
    expect(updateBody.properties?.journalType).toBeDefined();
  });

  it('softRequiredFields option wins even when path has softRequired: false', () => {
    const schema = new Schema({
      journalType: { type: String, required: true, softRequired: false } as any,
    });
    const { createBody } = buildCrudSchemasFromMongooseSchema(schema, {
      softRequiredFields: ['journalType'],
    });
    expect(createBody.required ?? []).not.toContain('journalType');
  });
});
