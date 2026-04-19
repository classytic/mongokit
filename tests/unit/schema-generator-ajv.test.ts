/**
 * Schema-generator integration test: mongokit → AJV.
 *
 * Pure unit (no mongo): builds real `CrudSchemas` from a Mongoose schema,
 * hands them to AJV, asserts that realistic HTTP payloads validate / reject
 * as the contract promises.
 *
 * Parity note: sqlitekit ships a matching test at
 * `sqlitekit/tests/unit/schema/ajv-validation.test.ts`. The two files use
 * equivalent Mongoose / Drizzle schemas + identical `SchemaBuilderOptions`
 * so any drift in the generated CRUD shape surfaces as a test-diff on one
 * side or the other.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { buildCrudSchemasFromMongooseSchema } from '../../src/utils/mongooseToJsonSchema.js';

// Shared Mongoose fixture — every test below operates on the same shape,
// which is the whole point of the parity story: one declared model + a
// bag of policy flags → a deterministic `CrudSchemas` bundle.
function buildUsersSchema(): Schema {
  return new Schema(
    {
      email: { type: String, required: true, maxlength: 120 },
      name: { type: String, required: true },
      role: {
        type: String,
        required: true,
        enum: ['admin', 'user', 'guest'],
        default: 'user',
      },
      age: { type: Number },
      active: { type: Boolean, required: true, default: true },
      tenantId: { type: String, required: true },
      status: { type: String, default: 'pending' },
    },
    { _id: false },
  );
}

function compile(schema: unknown): ReturnType<Ajv['compile']> {
  const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
  addFormats(ajv);
  return ajv.compile(schema as object);
}

describe('mongokit schema generator — AJV validation', () => {
  describe('createBody', () => {
    it('accepts a fully-populated valid payload', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema());
      const validate = compile(schemas.createBody);
      const ok = validate({
        email: 'a@b.co',
        name: 'Ada',
        role: 'admin',
        age: 30,
        active: true,
        tenantId: 't1',
      });
      expect(ok).toBe(true);
    });

    it('rejects missing required fields', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema());
      const validate = compile(schemas.createBody);
      const ok = validate({ email: 'a@b.co', name: 'Ada' });
      expect(ok).toBe(false);
      const missing = (validate.errors ?? []).map((e) => e.params['missingProperty']);
      expect(missing).toEqual(expect.arrayContaining(['tenantId']));
    });

    it('rejects enum values outside the declared set', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema());
      const validate = compile(schemas.createBody);
      const ok = validate({
        email: 'a@b.co',
        name: 'Ada',
        role: 'superuser',
        active: true,
        tenantId: 't1',
      });
      expect(ok).toBe(false);
      expect(validate.errors?.[0]?.keyword).toBe('enum');
    });

    it('rejects strings exceeding maxlength', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema());
      const validate = compile(schemas.createBody);
      const ok = validate({
        email: 'x'.repeat(121),
        name: 'Ada',
        active: true,
        tenantId: 't1',
      });
      expect(ok).toBe(false);
      expect(validate.errors?.[0]?.keyword).toBe('maxLength');
    });

    it('strictAdditionalProperties rejects unknown fields', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        strictAdditionalProperties: true,
      });
      const validate = compile(schemas.createBody);
      const ok = validate({
        email: 'a@b.co',
        name: 'Ada',
        active: true,
        tenantId: 't1',
        attackField: 'exploit',
      });
      expect(ok).toBe(false);
      expect(validate.errors?.[0]?.keyword).toBe('additionalProperties');
    });
  });

  describe('updateBody', () => {
    it('accepts partial updates', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema());
      const validate = compile(schemas.updateBody);
      expect(validate({ name: 'Ada Lovelace' })).toBe(true);
      expect(validate({})).toBe(true);
    });

    it('requireAtLeastOne rejects empty PATCH', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        update: { requireAtLeastOne: true },
      });
      const validate = compile(schemas.updateBody);
      expect(validate({})).toBe(false);
      expect(validate.errors?.[0]?.keyword).toBe('minProperties');
      expect(validate({ name: 'Ada' })).toBe(true);
    });

    it('immutable rule removes the field from update body', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        fieldRules: { tenantId: { immutable: true } },
        strictAdditionalProperties: true,
      });
      expect(schemas.updateBody.properties).not.toHaveProperty('tenantId');
      expect(schemas.createBody.properties).toHaveProperty('tenantId');

      const validate = compile(schemas.updateBody);
      // With strict additionalProperties, tenantId in PATCH is rejected.
      expect(validate({ tenantId: 'other' })).toBe(false);
    });
  });

  describe('contract invariants (shared across every kit)', () => {
    it('systemManaged → field absent from BOTH create and update', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        fieldRules: { status: { systemManaged: true } },
      });
      expect(schemas.createBody.properties).not.toHaveProperty('status');
      expect(schemas.updateBody.properties).not.toHaveProperty('status');
    });

    it('optional rule → field in properties but not required[]', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        fieldRules: { name: { optional: true } },
      });
      expect(schemas.createBody.properties).toHaveProperty('name');
      expect(schemas.createBody.required).not.toContain('name');
    });

    it('create.omitFields wins over schema inference', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        create: { omitFields: ['email'] },
      });
      expect(schemas.createBody.properties).not.toHaveProperty('email');
    });

    it('update.omitFields scopes to update only', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        update: { omitFields: ['email'] },
      });
      expect(schemas.createBody.properties).toHaveProperty('email');
      expect(schemas.updateBody.properties).not.toHaveProperty('email');
    });

    it('params always has { id: required }', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema());
      expect(schemas.params.properties).toHaveProperty('id');
      expect(schemas.params.required).toEqual(['id']);
    });

    it('listQuery always ships page / limit / sort knobs', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema());
      expect(schemas.listQuery.properties).toMatchObject({
        page: { type: 'integer' },
        limit: { type: 'integer' },
        sort: { type: 'string' },
      });
    });

    it('create.schemaOverrides replaces the generated property shape', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        create: {
          schemaOverrides: { email: { type: 'string', format: 'email' } },
        },
      });
      expect(schemas.createBody.properties?.email).toEqual({
        type: 'string',
        format: 'email',
      });
      const validate = compile(schemas.createBody);
      expect(
        validate({
          email: 'not-an-email',
          name: 'Ada',
          active: true,
          tenantId: 't1',
        }),
      ).toBe(false);
    });

    it('every generated schema compiles with AJV (no invalid JSON Schema keywords)', () => {
      const schemas = buildCrudSchemasFromMongooseSchema(buildUsersSchema(), {
        strictAdditionalProperties: true,
        fieldRules: {
          tenantId: { immutable: true },
          status: { systemManaged: true },
          name: { optional: true },
        },
        update: { requireAtLeastOne: true },
      });
      expect(() => compile(schemas.createBody)).not.toThrow();
      expect(() => compile(schemas.updateBody)).not.toThrow();
      expect(() => compile(schemas.params)).not.toThrow();
      expect(() => compile(schemas.listQuery)).not.toThrow();
    });
  });
});
