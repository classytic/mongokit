/**
 * Custom SchemaType support
 *
 * Convention (matching `mongoose-schema-jsonschema`): if a Mongoose SchemaType
 * instance exposes a `jsonSchema()` method, mongokit's converter defers to
 * it. Users adopt this pattern either by:
 *
 *   - subclassing `mongoose.SchemaType` and adding `prototype.jsonSchema`, or
 *   - installing `mongoose-schema-jsonschema` which monkey-patches every
 *     built-in SchemaType's prototype, or
 *   - assigning a per-path method at runtime: `schema.path('x').jsonSchema = ...`
 *
 * All three forms land as "schemaType.jsonSchema is a function" at the
 * instance level, which is what our extension point keys on.
 *
 * The test suite uses the third form (per-instance assignment) — it tests the
 * exact extension point without having to fight Mongoose's custom-type
 * registration requirements.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { buildCrudSchemasFromMongooseSchema } from '../../src/index.js';

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('custom SchemaType — per-instance jsonSchema() override is honored', () => {
  it('override on a primitive path replaces the built-in introspection', () => {
    const schema = new Schema({ version: { type: String, required: true } });

    // Attach a custom converter to THIS path only.
    (schema.path('version') as unknown as { jsonSchema: () => unknown }).jsonSchema =
      () => ({
        type: 'string',
        pattern: '^\\d+\\.\\d+\\.\\d+$',
        description: 'Semver x.y.z',
      });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);
    expect(createBody.properties?.version).toEqual({
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+$',
      description: 'Semver x.y.z',
    });
    expect(createBody.required).toContain('version');
  });

  it('coexists with built-in primitives on the same schema (no global hijack)', () => {
    const schema = new Schema({
      name: { type: String, required: true },
      version: String,
      ip: String,
      tags: [String],
    });

    (schema.path('version') as unknown as { jsonSchema: () => unknown }).jsonSchema =
      () => ({ type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' });
    (schema.path('ip') as unknown as { jsonSchema: () => unknown }).jsonSchema = () =>
      ({ type: 'string', format: 'ipv4' });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);
    expect(createBody.properties?.name).toEqual({ type: 'string' });
    expect(createBody.properties?.tags).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
    expect(createBody.properties?.version).toEqual({
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+$',
    });
    expect(createBody.properties?.ip).toEqual({ type: 'string', format: 'ipv4' });
  });

  it('custom-override on a SchemaType INSIDE a DocumentArray item is honored', () => {
    const schema = new Schema({
      releases: [
        { _id: false, tag: String, version: { type: String, required: true } },
      ],
    });

    // Walk into the inner subschema to attach the override to the nested path.
    const releasesPath = schema.path('releases') as unknown as {
      schema?: Schema;
    };
    const inner = releasesPath.schema;
    if (!inner) throw new Error('expected DocumentArray inner schema');
    (inner.path('version') as unknown as { jsonSchema: () => unknown }).jsonSchema =
      () => ({ type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);
    const releases = createBody.properties?.releases as Record<string, unknown>;
    const item = releases.items as Record<string, unknown>;
    const itemProps = item.properties as Record<string, unknown>;
    expect(itemProps.version).toEqual({
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+$',
    });
    expect(item.required).toEqual(['version']);
  });
});

describe('custom SchemaType — graceful fallbacks', () => {
  it('buggy jsonSchema() that throws is isolated — built-in introspection fires', () => {
    const schema = new Schema({ anything: { type: String, required: true } });
    (schema.path('anything') as unknown as { jsonSchema: () => unknown }).jsonSchema =
      () => {
        throw new Error('intentionally thrown from custom jsonSchema');
      };

    // Must not throw — the converter swallows the custom-method error and
    // produces the built-in string shape.
    const build = () => buildCrudSchemasFromMongooseSchema(schema);
    expect(build).not.toThrow();
    const { createBody } = build();
    expect(createBody.properties?.anything).toEqual({ type: 'string' });
  });

  it('custom returning a non-object is ignored; built-in introspection fires', () => {
    const schema = new Schema({ x: { type: String } });
    (schema.path('x') as unknown as { jsonSchema: () => unknown }).jsonSchema =
      () => null; // non-object — should be ignored

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);
    expect(createBody.properties?.x).toEqual({ type: 'string' });
  });
});

describe('custom SchemaType — Ajv validates a realistic payload', () => {
  it('versioned product payload accepts only valid semver', () => {
    const schema = new Schema({
      name: { type: String, required: true },
      version: { type: String, required: true },
    });
    (schema.path('version') as unknown as { jsonSchema: () => unknown }).jsonSchema =
      () => ({ type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' });

    const { createBody } = buildCrudSchemasFromMongooseSchema(schema);
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const isValid = ajv.compile(createBody as Record<string, unknown>);

    expect(isValid({ name: 'ui-kit', version: '1.2.3' })).toBe(true);
    expect(isValid({ name: 'ui-kit', version: '1.2' })).toBe(false);
    expect(isValid({ name: 'ui-kit', version: 'latest' })).toBe(false);
    expect(isValid({ name: 'ui-kit' })).toBe(false);
  });
});
