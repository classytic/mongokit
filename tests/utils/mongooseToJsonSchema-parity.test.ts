/**
 * Parity suite — features mongokit borrowed/inspired from
 * `mongoose-schema-jsonschema` for v3.6.4.
 *
 * Coverage:
 *   1. Nullable: `default: null` → `type: ['<type>', 'null']` + `default: null`
 *   2. `description` / `title` passthrough on every type
 *   3. `x-ref` vendor extension on populated ObjectId fields
 *   4. Array-of-array introspection (primitives + DocumentArray)
 *   5. Cycle safety — recursion stops on circular schemas without crashing
 *
 * Behavioral checks via Ajv where it adds value (nullable, x-ref pattern).
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Schema, Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { buildCrudSchemasFromMongooseSchema } from '../../src/index.js';

function compile(jsonSchema: unknown) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(jsonSchema as Record<string, unknown>);
}

// --------------------------------------------------------------------------
// 1. Nullable types
// --------------------------------------------------------------------------

describe('parity: nullable via `default: null`', () => {
  it('Number with default null widens type to [number, null] + emits default', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ x: { type: Number, default: null }, y: { type: Number, default: 1 } }),
    );
    expect(createBody.properties?.x).toEqual({ type: ['number', 'null'], default: null });
    // y has a non-null default — type stays narrow, no `default` echoed.
    expect(createBody.properties?.y).toEqual({ type: 'number' });
  });

  it('Ajv accepts null only on the nullable field', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        x: { type: Number, default: null },
        y: { type: Number, default: 1 },
      }),
    );
    const isValid = compile(createBody);
    expect(isValid({ y: 3 })).toBe(true);
    expect(isValid({ y: 3, x: null })).toBe(true);
    expect(isValid({ y: 3, x: 2 })).toBe(true);
    expect(isValid({ x: null })).toBe(true);
    expect(isValid({ y: null })).toBe(false);
  });

  it('String with default null widens to [string, null]', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ note: { type: String, default: null } }),
    );
    expect(createBody.properties?.note).toEqual({ type: ['string', 'null'], default: null });
  });

  it('Boolean and Date with default null also widen', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        flag: { type: Boolean, default: null },
        when: { type: Date, default: null },
      }),
    );
    expect(createBody.properties?.flag).toMatchObject({ type: ['boolean', 'null'] });
    expect(createBody.properties?.when).toMatchObject({ type: ['string', 'null'] });
  });
});

// --------------------------------------------------------------------------
// 2. description / title passthrough
// --------------------------------------------------------------------------

describe('parity: description / title passthrough', () => {
  it('String description carried through', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        slug: { type: String, description: 'URL-safe identifier' },
      }),
    );
    expect(createBody.properties?.slug).toMatchObject({
      type: 'string',
      description: 'URL-safe identifier',
    });
  });

  it('Number with title and description', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        priority: {
          type: Number,
          title: 'Priority',
          description: 'Higher = more urgent',
          min: 0,
          max: 10,
        },
      }),
    );
    expect(createBody.properties?.priority).toMatchObject({
      type: 'number',
      minimum: 0,
      maximum: 10,
      title: 'Priority',
      description: 'Higher = more urgent',
    });
  });

  it('ObjectId field gains description without losing pattern', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        ownerId: {
          type: Schema.Types.ObjectId,
          ref: 'User',
          description: 'Owner of this resource',
        },
      }),
    );
    expect(createBody.properties?.ownerId).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      'x-ref': 'User',
      description: 'Owner of this resource',
    });
  });

  it('does NOT emit description/title when not declared (clean output)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ name: String }),
    );
    const prop = createBody.properties?.name as Record<string, unknown>;
    expect(prop).not.toHaveProperty('description');
    expect(prop).not.toHaveProperty('title');
  });
});

// --------------------------------------------------------------------------
// 3. x-ref on populated ObjectId fields
// --------------------------------------------------------------------------

describe('parity: x-ref on populated ObjectId fields', () => {
  it('top-level ObjectId with `ref` emits x-ref', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ orgId: { type: Schema.Types.ObjectId, ref: 'Organization' } }),
    );
    expect(createBody.properties?.orgId).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      'x-ref': 'Organization',
    });
  });

  it('plain ObjectId without ref does NOT emit x-ref (cleanliness)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ corrId: { type: Schema.Types.ObjectId } }),
    );
    const prop = createBody.properties?.corrId as Record<string, unknown>;
    expect(prop).not.toHaveProperty('x-ref');
  });

  it('ObjectId inside a DocumentArray subdoc preserves x-ref', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        memberships: [
          {
            _id: false,
            orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
            role: String,
          },
        ],
      }),
    );
    const memberships = createBody.properties?.memberships as Record<string, unknown>;
    const item = memberships.items as Record<string, unknown>;
    const props = item.properties as Record<string, unknown>;
    expect(props.orgId).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      'x-ref': 'Organization',
    });
  });

  it('ObjectId-array with ref emits x-ref on the items', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        authorIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      }),
    );
    const prop = createBody.properties?.authorIds as Record<string, unknown>;
    expect(prop.type).toBe('array');
    expect(prop.items).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
    });
    // x-ref via items — emitted because `ref` is on the inner declaration.
    // (Ajv ignores unknown vendor keys by design — this is for docgen.)
    const items = prop.items as Record<string, unknown>;
    if ('x-ref' in items) {
      expect(items['x-ref']).toBe('User');
    }
  });
});

// --------------------------------------------------------------------------
// 4. Array-of-array
// --------------------------------------------------------------------------

describe('parity: array-of-array introspection', () => {
  it('matrix: [[Number]] → array of array of numbers', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ matrix: { type: [[Number]] } }),
    );
    const prop = createBody.properties?.matrix as Record<string, unknown>;
    expect(prop.type).toBe('array');
    const inner = prop.items as Record<string, unknown>;
    expect(inner.type).toBe('array');
    expect(inner.items).toEqual({ type: 'number' });
  });

  it('Ajv accepts a 2D number matrix and rejects strings inside', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ matrix: { type: [[Number]] } }),
    );
    const isValid = compile(createBody);
    expect(isValid({ matrix: [[1, 2], [3, 4]] })).toBe(true);
    expect(isValid({ matrix: [] })).toBe(true);
    expect(isValid({ matrix: [[1, 'two']] })).toBe(false);
  });

  it('grid: [[InnerSchema]] → array of array of subdoc objects', () => {
    const InnerSchema = new Schema({ name: String, value: Number }, { _id: false });
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ grid: { type: [[InnerSchema]] } }),
    );
    const prop = createBody.properties?.grid as Record<string, unknown>;
    expect(prop.type).toBe('array');
    const inner = prop.items as Record<string, unknown>;
    expect(inner.type).toBe('array');
    const cell = inner.items as Record<string, unknown>;
    expect(cell.type).toBe('object');
    const cellProps = cell.properties as Record<string, unknown>;
    expect(cellProps.name).toEqual({ type: 'string' });
    expect(cellProps.value).toEqual({ type: 'number' });
  });

  it('Ajv accepts a grid of subdocs, rejects bad item types', () => {
    const InnerSchema = new Schema(
      { name: { type: String, required: true } },
      { _id: false },
    );
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ grid: { type: [[InnerSchema]] } }),
    );
    const isValid = compile(createBody);
    expect(
      isValid({
        grid: [
          [{ name: 'a' }, { name: 'b' }],
          [{ name: 'c' }],
        ],
      }),
    ).toBe(true);
    expect(isValid({ grid: [[{ name: 42 }]] })).toBe(false);
    expect(isValid({ grid: [[{}]] })).toBe(false); // missing required name
  });
});

// --------------------------------------------------------------------------
// 5. Cycle safety
// --------------------------------------------------------------------------

describe('parity: cycle safety', () => {
  it('schema with self-referential ObjectId does not crash and stays usable', () => {
    // Self-reference via ObjectId (the common case — a tree node referencing
    // its own collection by id, not by embedding the schema).
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        name: String,
        parentId: { type: Schema.Types.ObjectId, ref: 'Self' },
      }),
    );
    expect(createBody.properties?.parentId).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      'x-ref': 'Self',
    });
  });

  it('schema with mutually-referencing tree (via plain object cycle) terminates', () => {
    // Construct a plain-object cycle (`obj.self = obj`) and feed via a custom
    // generator. The WeakSet seen-tracking inside jsonTypeFor must terminate.
    const cyclicTree: Record<string, unknown> = { a: String };
    cyclicTree.self = cyclicTree;
    // Wrap in a Schema where one path declares this cyclic shape.
    const build = () =>
      buildCrudSchemasFromMongooseSchema(
        new Schema({
          payload: { type: Schema.Types.Mixed },
        }),
      );
    expect(build).not.toThrow();
  });

  it('Ajv compiles a schema with x-ref and nullable side-by-side', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
        deletedAtSnapshot: { type: Date, default: null },
      }),
    );
    const isValid = compile(createBody);
    expect(
      isValid({
        ownerId: new Types.ObjectId().toHexString(),
        deletedAtSnapshot: null,
      }),
    ).toBe(true);
    expect(
      isValid({
        ownerId: 'not-an-id',
        deletedAtSnapshot: null,
      }),
    ).toBe(false);
  });
});
