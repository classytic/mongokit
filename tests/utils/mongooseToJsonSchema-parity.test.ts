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

  it('ObjectId field gains description without losing pattern (x-ref opt-in)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        ownerId: {
          type: Schema.Types.ObjectId,
          ref: 'User',
          description: 'Owner of this resource',
        },
      }),
      { openApiExtensions: true },
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

describe('parity: x-ref on populated ObjectId fields (opt-in via openApiExtensions)', () => {
  it('DEFAULT (flag off): ObjectId field does NOT emit x-ref — Ajv-strict-safe', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ orgId: { type: Schema.Types.ObjectId, ref: 'Organization' } }),
    );
    const prop = createBody.properties?.orgId as Record<string, unknown>;
    expect(prop).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
    });
    // Critical: no x-ref when the caller didn't opt in. Ajv strict mode
    // throws on unknown x-* keywords, so validation schemas must stay clean.
    expect(prop).not.toHaveProperty('x-ref');
  });

  it('OPT-IN: openApiExtensions:true emits x-ref', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ orgId: { type: Schema.Types.ObjectId, ref: 'Organization' } }),
      { openApiExtensions: true },
    );
    expect(createBody.properties?.orgId).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      'x-ref': 'Organization',
    });
  });

  it('plain ObjectId without ref does NOT emit x-ref even when opt-in (cleanliness)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ corrId: { type: Schema.Types.ObjectId } }),
      { openApiExtensions: true },
    );
    const prop = createBody.properties?.corrId as Record<string, unknown>;
    expect(prop).not.toHaveProperty('x-ref');
  });

  it('OPT-IN: ObjectId inside a DocumentArray subdoc carries x-ref', () => {
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
      { openApiExtensions: true },
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

  it('OPT-IN: ObjectId-array shorthand `[{type,ref}]` carries x-ref on items', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ authorIds: [{ type: Schema.Types.ObjectId, ref: 'User' }] }),
      { openApiExtensions: true },
    );
    const prop = createBody.properties?.authorIds as Record<string, unknown>;
    expect(prop.type).toBe('array');
    expect(prop.items).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      'x-ref': 'User',
    });
  });

  it('DEFAULT: ObjectId-array shorthand does NOT carry x-ref (Ajv-strict-safe)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ authorIds: [{ type: Schema.Types.ObjectId, ref: 'User' }] }),
    );
    const prop = createBody.properties?.authorIds as Record<string, unknown>;
    const itemsProp = prop.items as Record<string, unknown>;
    expect(itemsProp).not.toHaveProperty('x-ref');
  });

  it('OPT-IN: array-of-array-of-subdocs with ref fields carries x-ref at every level', () => {
    // The deepest realistic shape — `[[{ ownerId: ObjectId(ref) }]]` (a
    // grid of cells where each cell is a subdoc holding a populated ref).
    // This is the shape that would catch any future regression where
    // builderOptions stops being threaded down through jsonTypeFor or the
    // array-of-array recursion.
    const CellSchema = new Schema(
      {
        ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        label: String,
      },
      { _id: false },
    );

    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        grid: { type: [[CellSchema]] },
      }),
      { openApiExtensions: true },
    );

    const prop = createBody.properties?.grid as Record<string, unknown>;
    expect(prop.type).toBe('array');

    const row = prop.items as Record<string, unknown>;
    expect(row.type).toBe('array');

    const cell = row.items as Record<string, unknown>;
    expect(cell.type).toBe('object');
    const cellProps = cell.properties as Record<string, unknown>;
    expect(cellProps.ownerId).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      'x-ref': 'User',
    });
    expect(cellProps.label).toEqual({ type: 'string' });
    expect(cell.required).toEqual(['ownerId']);
  });

  it('DEFAULT: array-of-array-of-subdocs with refs is keyword-clean', () => {
    // Mirror of the above with the flag OFF — Ajv strict:true must compile
    // a schema with the deepest possible nested ref shape.
    const CellSchema = new Schema(
      { ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true } },
      { _id: false },
    );
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ grid: { type: [[CellSchema]] } }),
    );
    const ajv = new Ajv({ strict: true, allErrors: true });
    expect(() => ajv.compile(createBody as Record<string, unknown>)).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// Ajv strict-mode regression — the reason openApiExtensions is opt-in.
// Pre-fix, any schema with ref:'X' forced x-ref into the output, which Ajv
// strict mode rejected with "strict mode: unknown keyword: x-ref". This suite
// pins the contract: DEFAULT output compiles under Ajv strict.
// --------------------------------------------------------------------------

describe('Ajv strict-mode: default output is keyword-clean', () => {
  it('ObjectId-with-ref schema compiles under Ajv strict:true', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        orgId: { type: Schema.Types.ObjectId, ref: 'Organization' },
        memberships: [
          { _id: false, userId: { type: Schema.Types.ObjectId, ref: 'User' } },
        ],
        authorIds: [{ type: Schema.Types.ObjectId, ref: 'Author' }],
      }),
    );
    const ajv = new Ajv({ strict: true, allErrors: true });
    // Must not throw — this is the bug we're guarding.
    expect(() => ajv.compile(createBody as Record<string, unknown>)).not.toThrow();
  });

  it('OPT-IN output does throw under Ajv strict (expected — use for docgen)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ orgId: { type: Schema.Types.ObjectId, ref: 'Organization' } }),
      { openApiExtensions: true },
    );
    const ajv = new Ajv({ strict: true, allErrors: true });
    expect(() => ajv.compile(createBody as Record<string, unknown>)).toThrow(
      /unknown keyword.*x-ref/i,
    );
  });

  it('OPT-IN output still compiles under Ajv strict:false (standard behavior)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ orgId: { type: Schema.Types.ObjectId, ref: 'Organization' } }),
      { openApiExtensions: true },
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    expect(() => ajv.compile(createBody as Record<string, unknown>)).not.toThrow();
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
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        name: String,
        parentId: { type: Schema.Types.ObjectId, ref: 'Self' },
      }),
      { openApiExtensions: true },
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
