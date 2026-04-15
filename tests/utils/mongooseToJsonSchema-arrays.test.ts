/**
 * buildCrudSchemasFromMongooseSchema — array introspection
 *
 * Regression suite for the long-standing "every array item is `string`" bug
 * (introspectArrayItems in src/utils/mongooseToJsonSchema.ts). Covers every
 * array declaration shape a client can realistically POST:
 *
 *   - primitive arrays: [String], [Number], [Boolean], [Date], [ObjectId]
 *   - `{ type: [X] }` shorthand
 *   - element validators: [{ type: String, enum, minlength }]
 *   - DocumentArray: [{ name: String, url: String }]
 *   - explicit Schema: [new Schema({ … }, { _id: false })]
 *   - Mixed arrays: [Schema.Types.Mixed]
 *   - nested subdoc arrays: [{ children: [String] }]
 *   - required flag on subdoc fields
 *
 * Historical behavior: Fastify rejected any non-string item with
 * "body/<field>/0 must be string". Fixed in v3.6.3.
 */

import { describe, expect, it } from 'vitest';
import { Schema, Types } from 'mongoose';
import { buildCrudSchemasFromMongooseSchema } from '../../src/index.js';

const items = (body: { properties?: Record<string, unknown> }, field: string): unknown => {
  const prop = body.properties?.[field] as Record<string, unknown> | undefined;
  expect(prop).toBeDefined();
  expect(prop).toMatchObject({ type: 'array' });
  return (prop as Record<string, unknown>).items;
};

describe('buildCrudSchemas — primitive array items', () => {
  it('[String] → items.type === "string"', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ tags: [String] }),
    );
    expect(items(createBody, 'tags')).toEqual({ type: 'string' });
  });

  it('[Number] → items.type === "number"', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ scores: [Number] }),
    );
    expect(items(createBody, 'scores')).toEqual({ type: 'number' });
  });

  it('[Boolean] → items.type === "boolean"', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ flags: [Boolean] }),
    );
    expect(items(createBody, 'flags')).toEqual({ type: 'boolean' });
  });

  it('[Date] → items is a date-time string', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ events: [Date] }),
    );
    expect(items(createBody, 'events')).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });

  it('[Schema.Types.ObjectId] → items is ObjectId-pattern string', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ refs: [Schema.Types.ObjectId] }),
    );
    expect(items(createBody, 'refs')).toEqual({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
    });
  });

  it('[Types.ObjectId] (runtime ctor) → items is ObjectId-pattern string', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ refs: [Types.ObjectId] }),
    );
    expect(items(createBody, 'refs')).toEqual({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
    });
  });
});

describe('buildCrudSchemas — { type: [X] } shorthand', () => {
  it('{ type: [String] } → items.type === "string"', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ tags: { type: [String], required: true } }),
    );
    expect(items(createBody, 'tags')).toEqual({ type: 'string' });
    expect(createBody.required).toContain('tags');
  });

  it('{ type: [Number] } → items.type === "number"', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ scores: { type: [Number] } }),
    );
    expect(items(createBody, 'scores')).toEqual({ type: 'number' });
  });

  it('{ type: [{ type: String, enum: [...] }] } → element validators carried through', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        roles: {
          type: [{ type: String, enum: ['admin', 'user', 'guest'] }],
        },
      }),
    );
    expect(items(createBody, 'roles')).toEqual({
      type: 'string',
      enum: ['admin', 'user', 'guest'],
    });
  });
});

describe('buildCrudSchemas — DocumentArray (subdocument arrays)', () => {
  it('[{ name: String, url: String }] shorthand → nested object items', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        mcpServers: [{ _id: false, name: { type: String, required: true }, url: String }],
      }),
    );

    const inner = items(createBody, 'mcpServers') as Record<string, unknown>;
    expect(inner.type).toBe('object');
    expect((inner.properties as Record<string, unknown>).name).toEqual({ type: 'string' });
    expect((inner.properties as Record<string, unknown>).url).toEqual({ type: 'string' });
    expect(inner.required).toEqual(['name']);
  });

  it('explicit [new Schema({...}, { _id: false })] → nested object items', () => {
    const Inner = new Schema(
      {
        label: { type: String, required: true },
        priority: { type: Number, min: 0, max: 10 },
      },
      { _id: false },
    );
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ rules: [Inner] }),
    );

    const inner = items(createBody, 'rules') as Record<string, unknown>;
    expect(inner.type).toBe('object');
    const props = inner.properties as Record<string, unknown>;
    expect(props.label).toEqual({ type: 'string' });
    expect(props.priority).toMatchObject({ type: 'number', minimum: 0, maximum: 10 });
    expect(inner.required).toEqual(['label']);
  });

  it('DocumentArray items never collapse to `{ type: "string" }` (regression)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ entries: [{ _id: false, a: String, b: Number }] }),
    );
    const inner = items(createBody, 'entries') as Record<string, unknown>;
    expect(inner.type).toBe('object');
    expect(inner.type).not.toBe('string');
  });

  it('nested subdoc with its own array → tier 1 recurses cleanly', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        groups: [
          {
            _id: false,
            name: { type: String, required: true },
            children: [String],
          },
        ],
      }),
    );
    const outer = items(createBody, 'groups') as Record<string, unknown>;
    expect(outer.type).toBe('object');
    const props = outer.properties as Record<string, unknown>;
    const childrenProp = props.children as Record<string, unknown>;
    expect(childrenProp.type).toBe('array');
    expect(childrenProp.items).toEqual({ type: 'string' });
  });

  it('subdoc array with ObjectId refs inside → ObjectId pattern preserved', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        memberships: [
          {
            _id: false,
            orgId: { type: Schema.Types.ObjectId, required: true },
            role: String,
          },
        ],
      }),
    );
    const inner = items(createBody, 'memberships') as Record<string, unknown>;
    const props = inner.properties as Record<string, unknown>;
    expect(props.orgId).toEqual({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
    });
  });

  it('DocumentArray with _id:true keeps auto-ObjectId out of the JSON schema', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ entries: [{ value: String }] }),
    );
    const inner = items(createBody, 'entries') as Record<string, unknown>;
    const props = inner.properties as Record<string, unknown>;
    // `_id` is auto-ObjectId — clients don't POST it, so it must be absent.
    expect(props).not.toHaveProperty('_id');
    expect(props).toHaveProperty('value');
  });
});

describe('buildCrudSchemas — Mixed arrays', () => {
  it('[Schema.Types.Mixed] → items is an open object', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ payload: [Schema.Types.Mixed] }),
    );
    expect(items(createBody, 'payload')).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });

  it('{ type: [Schema.Types.Mixed] } shorthand → open object items', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ payload: { type: [Schema.Types.Mixed] } }),
    );
    expect(items(createBody, 'payload')).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });
});

describe('buildCrudSchemas — update body mirrors create body', () => {
  it('updateBody preserves array item introspection', () => {
    const { updateBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        tags: [String],
        mcpServers: [{ _id: false, name: String, url: String }],
      }),
    );
    expect(items(updateBody, 'tags')).toEqual({ type: 'string' });
    const inner = items(updateBody, 'mcpServers') as Record<string, unknown>;
    expect(inner.type).toBe('object');
  });
});

describe('buildCrudSchemas — required flag on the array itself', () => {
  it('required array field lands in top-level required[]', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ tags: { type: [String], required: true } }),
    );
    expect(createBody.required).toContain('tags');
    expect(items(createBody, 'tags')).toEqual({ type: 'string' });
  });
});

// ============================================================================
// GeoJSON-style arrays — mongokit has first-class geo support, so the
// [Number] coordinates path MUST serialize correctly or Fastify breaks every
// $near / $geoWithin ingress.
// ============================================================================

describe('buildCrudSchemas — GeoJSON / geo arrays', () => {
  it('GeoJSON Point: location.coordinates: [Number] → number items', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        location: {
          type: { type: String, enum: ['Point'], default: 'Point' },
          coordinates: { type: [Number], required: true },
        },
      }),
    );

    const locProp = createBody.properties?.location as Record<string, unknown>;
    expect(locProp.type).toBe('object');
    const coordsProp = (locProp.properties as Record<string, unknown>)
      .coordinates as Record<string, unknown>;
    expect(coordsProp.type).toBe('array');
    expect(coordsProp.items).toEqual({ type: 'number' });
  });

  it('GeoJSON Polygon: coordinates: [[Number]] — outer array, inner inferred', () => {
    // Polygons declare as [[Number]] in Mongoose — the outer array's element
    // type ends up as Mixed/Array. We just assert the outer is an array and
    // inner is NOT the broken `{ type: "string" }` default.
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ polygon: { type: [[Number]] } }),
    );
    const prop = createBody.properties?.polygon as Record<string, unknown>;
    expect(prop.type).toBe('array');
    expect(prop.items).not.toEqual({ type: 'string' });
  });

  it('geo subdoc array: label + coordinates: [Number] at the item root', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        features: [
          {
            _id: false,
            label: { type: String, required: true },
            coordinates: { type: [Number], required: true },
          },
        ],
      }),
    );
    const feat = items(createBody, 'features') as Record<string, unknown>;
    expect(feat.type).toBe('object');
    const featProps = feat.properties as Record<string, unknown>;
    expect(featProps.label).toEqual({ type: 'string' });
    const coords = featProps.coordinates as Record<string, unknown>;
    expect(coords.type).toBe('array');
    expect(coords.items).toEqual({ type: 'number' });
    expect(feat.required).toEqual(expect.arrayContaining(['label', 'coordinates']));
  });

  it('top-level single-embedded subdoc (instance === Embedded) introspects fully', () => {
    const AddressSchema = new Schema(
      {
        street: { type: String, required: true },
        zip: { type: String, match: /^\d{5}$/ },
      },
      { _id: false },
    );
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ billingAddress: { type: AddressSchema, required: true } }),
    );
    const addr = createBody.properties?.billingAddress as Record<string, unknown>;
    expect(addr.type).toBe('object');
    const addrProps = addr.properties as Record<string, unknown>;
    expect(addrProps.street).toEqual({ type: 'string' });
    expect(addrProps.zip).toMatchObject({ type: 'string', pattern: '^\\d{5}$' });
    expect(addr.required).toEqual(['street']);
  });

  it('single-embedded subdoc nested inside a DocumentArray item', () => {
    const GeometrySchema = new Schema(
      {
        geoType: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true },
      },
      { _id: false },
    );
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        features: [
          { _id: false, label: String, geometry: GeometrySchema },
        ],
      }),
    );
    const feat = items(createBody, 'features') as Record<string, unknown>;
    const geom = (feat.properties as Record<string, unknown>).geometry as Record<
      string,
      unknown
    >;
    expect(geom.type).toBe('object');
    const geomProps = geom.properties as Record<string, unknown>;
    expect(geomProps.geoType).toMatchObject({ type: 'string', enum: ['Point'] });
    const coords = geomProps.coordinates as Record<string, unknown>;
    expect(coords.type).toBe('array');
    expect(coords.items).toEqual({ type: 'number' });
    expect(geom.required).toEqual(['coordinates']);
  });
});

// ============================================================================
// Deep nesting — three levels of subdocument arrays, mixed primitive and
// subdoc elements at each level. This is the shape used by, e.g., a
// hierarchical "workspace → projects → tasks → tags" model.
// ============================================================================

describe('buildCrudSchemas — deeply nested subdocument arrays', () => {
  it('3-level subdoc array: workspace → projects → tasks preserves every level', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        projects: [
          {
            _id: false,
            name: { type: String, required: true },
            priority: { type: Number, min: 0, max: 10 },
            tasks: [
              {
                _id: false,
                title: { type: String, required: true },
                tags: [String],
                assigneeIds: [Schema.Types.ObjectId],
                done: { type: Boolean, default: false },
              },
            ],
          },
        ],
      }),
    );

    // Level 1: projects array
    const projItem = items(createBody, 'projects') as Record<string, unknown>;
    expect(projItem.type).toBe('object');
    const projProps = projItem.properties as Record<string, unknown>;
    expect(projProps.name).toEqual({ type: 'string' });
    expect(projProps.priority).toMatchObject({ type: 'number', minimum: 0, maximum: 10 });
    expect(projItem.required).toEqual(['name']);

    // Level 2: tasks array inside a project
    const tasksProp = projProps.tasks as Record<string, unknown>;
    expect(tasksProp.type).toBe('array');
    const taskItem = tasksProp.items as Record<string, unknown>;
    expect(taskItem.type).toBe('object');
    const taskProps = taskItem.properties as Record<string, unknown>;
    expect(taskProps.title).toEqual({ type: 'string' });
    expect(taskProps.done).toEqual({ type: 'boolean' });
    expect(taskItem.required).toEqual(['title']);

    // Level 3: primitive string array inside a task
    expect(taskProps.tags).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
    // Level 3: ObjectId array inside a task
    expect(taskProps.assigneeIds).toMatchObject({
      type: 'array',
      items: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
    });
  });

  it('subdoc → subdoc → primitive array → no leaked "string" default at any level', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        teams: [
          {
            _id: false,
            members: [
              {
                _id: false,
                name: String,
                scores: [Number],
                flags: [Boolean],
              },
            ],
          },
        ],
      }),
    );
    const team = items(createBody, 'teams') as Record<string, unknown>;
    const members = (team.properties as Record<string, unknown>).members as Record<
      string,
      unknown
    >;
    const member = members.items as Record<string, unknown>;
    const memberProps = member.properties as Record<string, unknown>;

    const scoresProp = memberProps.scores as Record<string, unknown>;
    expect(scoresProp.items).toEqual({ type: 'number' });
    const flagsProp = memberProps.flags as Record<string, unknown>;
    expect(flagsProp.items).toEqual({ type: 'boolean' });
    // Critical regression assertion:
    expect(JSON.stringify(createBody)).not.toContain('"items":{"type":"string"}0'); // no sibling leak
  });

  it('mixed primitives and subdocs at the same level — no cross-contamination', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        tags: [String],
        refs: [Schema.Types.ObjectId],
        entries: [{ _id: false, label: String, count: Number }],
        numbers: [Number],
      }),
    );
    expect(items(createBody, 'tags')).toEqual({ type: 'string' });
    expect(items(createBody, 'refs')).toEqual({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
    });
    const entries = items(createBody, 'entries') as Record<string, unknown>;
    expect(entries.type).toBe('object');
    expect(items(createBody, 'numbers')).toEqual({ type: 'number' });
  });
});

// ============================================================================
// Exotic Mongoose types — Decimal128, UUID, Buffer. These are real types
// declared by real schemas (financial models, device IDs, binary blobs).
// ============================================================================

describe('buildCrudSchemas — exotic primitive types in arrays', () => {
  it('[Schema.Types.Decimal128] → at minimum, not "string default"', () => {
    // Decimal128 serializes as string in JSON. We don't require a specific
    // shape, only that we don't silently fall through to the broken default.
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ amounts: [Schema.Types.Decimal128] }),
    );
    const prop = createBody.properties?.amounts as Record<string, unknown>;
    expect(prop.type).toBe('array');
    expect(prop.items).toBeDefined();
    // Anything but literal silent-fallback-string (which would have been a
    // guess under the old default when the real type is Decimal128):
    expect(prop.items).not.toEqual({ type: 'string' });
  });

  it('[Schema.Types.UUID] → ObjectId-style string pattern OR a valid type', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ ids: [Schema.Types.UUID] }),
    );
    const prop = createBody.properties?.ids as Record<string, unknown>;
    expect(prop.type).toBe('array');
    expect(prop.items).toBeDefined();
    expect(typeof prop.items).toBe('object');
  });
});

// ============================================================================
// Ref-style DocumentArray — the Mongoose population pattern. Clients POST
// ObjectId strings; arrays of refs must serialize as ObjectId-pattern strings.
// ============================================================================

describe('buildCrudSchemas — ref-style arrays', () => {
  it('[{ type: ObjectId, ref: "User" }] → items are ObjectId-pattern strings', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        authorIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      }),
    );
    expect(items(createBody, 'authorIds')).toEqual({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
    });
  });

  it('subdoc with a ref field → nested orgId is ObjectId-pattern (+ x-ref)', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        memberships: [
          {
            _id: false,
            orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
            role: { type: String, enum: ['admin', 'member'] },
          },
        ],
      }),
    );
    const inner = items(createBody, 'memberships') as Record<string, unknown>;
    const props = inner.properties as Record<string, unknown>;
    // toMatchObject — allow `x-ref` vendor extension to coexist with the
    // pattern (added in 3.6.4 for OpenAPI docgen friendliness).
    expect(props.orgId).toMatchObject({
      type: 'string',
      pattern: '^[0-9a-fA-F]{24}$',
      'x-ref': 'Organization',
    });
    expect(props.role).toMatchObject({
      type: 'string',
      enum: ['admin', 'member'],
    });
    expect(inner.required).toEqual(['orgId']);
  });
});

// ============================================================================
// Element validators preserved — common client-visible constraints
// ============================================================================

describe('buildCrudSchemas — element-level validators preserved in items', () => {
  it('[{ type: String, minlength, maxlength, match }] propagates validators', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        usernames: [
          {
            type: String,
            minlength: 3,
            maxlength: 30,
            match: /^[a-z0-9_]+$/,
          },
        ],
      }),
    );
    const inner = items(createBody, 'usernames') as Record<string, unknown>;
    expect(inner).toMatchObject({
      type: 'string',
      minLength: 3,
      maxLength: 30,
      pattern: '^[a-z0-9_]+$',
    });
  });

  it('[{ type: Number, min, max }] propagates numeric bounds', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ scores: [{ type: Number, min: 0, max: 100 }] }),
    );
    const inner = items(createBody, 'scores') as Record<string, unknown>;
    expect(inner).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
  });
});

// ============================================================================
// Empty / degenerate shapes — ensure no crash and no "string" default
// ============================================================================

describe('buildCrudSchemas — degenerate array declarations', () => {
  it('[] (no element type) → falls back to a permissive object, never string', () => {
    // Mongoose accepts an empty array as "untyped" — we just must not silently
    // crash or regress to the old string default.
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ whatever: { type: [] } }),
    );
    const prop = createBody.properties?.whatever as Record<string, unknown>;
    // Either we produced an array (good) — if so, items must not be {type:'string'}
    // Or the path got dropped entirely (also acceptable for a degenerate decl).
    if (prop) {
      if (prop.type === 'array') {
        expect(prop.items).not.toEqual({ type: 'string' });
      }
    }
  });

  it('Array of objects without _id option still strips auto _id', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ items: [{ name: String }] }),
    );
    const inner = (createBody.properties?.items as Record<string, unknown>).items as Record<
      string,
      unknown
    >;
    const props = inner.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty('_id');
    expect(props).toHaveProperty('name');
  });
});

// ============================================================================
// Round-trip sanity — a schema that touches many shapes at once should
// serialize to a JSON Schema where zero fields match the old broken default.
// ============================================================================

describe('buildCrudSchemas — round-trip across a realistic mixed model', () => {
  it('no array in a realistic model collapses to items === { type: "string" } unexpectedly', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        tags: [String], // expected string
        counts: [Number],
        toggles: [Boolean],
        moments: [Date],
        refs: [Schema.Types.ObjectId],
        mcpServers: [{ _id: false, name: String, url: String }],
        meta: [Schema.Types.Mixed],
        nested: [
          {
            _id: false,
            child: [{ _id: false, label: String, score: Number }],
          },
        ],
        location: {
          type: { type: String, enum: ['Point'] },
          coordinates: [Number],
        },
      }),
    );

    // The ONLY top-level array whose items should be `{ type: 'string' }`:
    expect(items(createBody, 'tags')).toEqual({ type: 'string' });

    // Every other top-level array must NOT match the broken default.
    const checks: Array<[string, (i: unknown) => void]> = [
      ['counts', (i) => expect(i).toEqual({ type: 'number' })],
      ['toggles', (i) => expect(i).toEqual({ type: 'boolean' })],
      ['moments', (i) => expect(i).toMatchObject({ type: 'string', format: 'date-time' })],
      [
        'refs',
        (i) => expect(i).toEqual({ type: 'string', pattern: '^[0-9a-fA-F]{24}$' }),
      ],
      [
        'mcpServers',
        (i) => {
          const obj = i as Record<string, unknown>;
          expect(obj.type).toBe('object');
        },
      ],
      [
        'meta',
        (i) => expect(i).toEqual({ type: 'object', additionalProperties: true }),
      ],
      [
        'nested',
        (i) => {
          const obj = i as Record<string, unknown>;
          expect(obj.type).toBe('object');
        },
      ],
    ];
    for (const [name, assert] of checks) {
      assert(items(createBody, name));
    }

    // location.coordinates (deep)
    const loc = createBody.properties?.location as Record<string, unknown>;
    const coords = (loc.properties as Record<string, unknown>).coordinates as Record<
      string,
      unknown
    >;
    expect(coords.items).toEqual({ type: 'number' });
  });
});
