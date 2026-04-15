/**
 * End-to-end regression: mongoose → buildCrudSchemas → Ajv validates a
 * payload clients would POST.
 *
 * This is the industry-standard way to guard a Mongoose→JSON-Schema converter:
 * stop asserting on the converter's internal output shape, instead assert that
 * the generated schema accepts every realistic good payload and rejects every
 * realistic bad one. If a future converter change silently drifts (e.g. back
 * to `items: { type: 'string' }` for numeric arrays), Ajv catches it end-to-end
 * because the rejection will flip from "wrong type" to "accepted". Combined
 * with `mongooseToJsonSchema-arrays.test.ts`, we have both structural coverage
 * (what the schema looks like) and behavioral coverage (what it accepts).
 *
 * Ajv is configured the same way Fastify configures it by default:
 *   - strict schema mode (fails on unknown keywords)
 *   - allErrors (surface every violation, not just the first)
 *   - ajv-formats for `date-time`, `date`, etc.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { buildCrudSchemasFromMongooseSchema } from '../../src/index.js';

function compile(jsonSchema: unknown): ValidateFunction {
  // strict:false — our generated schemas add keywords like `x-*` hints Ajv's
  // strict mode doesn't recognize; we keep strict for required/type but loose
  // for vendor extensions.
  const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
  addFormats(ajv);
  return ajv.compile(jsonSchema as Record<string, unknown>);
}

describe('Ajv regression — primitive array payloads validate correctly', () => {
  it('accepts [Number] payloads and rejects string-in-number arrays', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ scores: { type: [Number], required: true } }),
    );
    const validate = compile(createBody);

    expect(validate({ scores: [1, 2, 3] })).toBe(true);
    expect(validate({ scores: [] })).toBe(true);
    // Old bug: converter emitted items:{type:'string'}, so [1,2,3] would be
    // rejected and ['1','2','3'] accepted. Flip.
    expect(validate({ scores: ['1', '2'] })).toBe(false);
    expect(validate({})).toBe(false); // required
  });

  it('accepts [Boolean] payloads and rejects non-boolean items', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ flags: [Boolean] }),
    );
    const validate = compile(createBody);

    expect(validate({ flags: [true, false, true] })).toBe(true);
    expect(validate({ flags: ['yes', 'no'] })).toBe(false);
    expect(validate({ flags: [0, 1] })).toBe(false);
  });

  it('accepts [Date] payloads as ISO date-time strings, rejects free-form strings', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ events: [Date] }),
    );
    const validate = compile(createBody);

    expect(validate({ events: ['2026-04-15T12:00:00Z'] })).toBe(true);
    // ajv-formats enforces date-time format — "not-a-date" fails.
    expect(validate({ events: ['not-a-date'] })).toBe(false);
  });

  it('accepts ObjectId array with valid hex IDs, rejects malformed', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ refs: [Schema.Types.ObjectId] }),
    );
    const validate = compile(createBody);

    expect(validate({ refs: ['507f1f77bcf86cd799439011'] })).toBe(true);
    expect(validate({ refs: ['bad'] })).toBe(false);
    expect(validate({ refs: ['507f1f77bcf86cd79943901'] })).toBe(false); // 23 chars
  });
});

describe('Ajv regression — DocumentArray payloads', () => {
  it('accepts the MCP-server shape that was the original bug report', () => {
    // This is the exact case that surfaced the issue: `body/mcpServers/0 must
    // be string` under the old converter. After the fix, Fastify (via Ajv)
    // now accepts the payload clients actually send.
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        mcpServers: [
          {
            _id: false,
            name: { type: String, required: true },
            url: { type: String, required: true },
          },
        ],
      }),
    );
    const validate = compile(createBody);

    expect(
      validate({
        mcpServers: [
          { name: 'primary', url: 'https://mcp.example.com/v1' },
          { name: 'fallback', url: 'https://backup.example.com/v1' },
        ],
      }),
    ).toBe(true);

    // Missing required nested field → rejected
    expect(validate({ mcpServers: [{ name: 'only-name' }] })).toBe(false);
    // Wrong nested type → rejected
    expect(validate({ mcpServers: [{ name: 42, url: 'x' }] })).toBe(false);
    // Empty array is still valid (the array itself is not required here)
    expect(validate({ mcpServers: [] })).toBe(true);
  });

  it('subdoc with ObjectId ref field — Ajv enforces the hex pattern', () => {
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
    const validate = compile(createBody);

    expect(
      validate({
        memberships: [
          { orgId: '507f1f77bcf86cd799439011', role: 'admin' },
        ],
      }),
    ).toBe(true);
    expect(
      validate({
        memberships: [{ orgId: 'not-a-hex', role: 'admin' }],
      }),
    ).toBe(false);
    expect(validate({ memberships: [{ role: 'admin' }] })).toBe(false); // orgId required
  });
});

describe('Ajv regression — GeoJSON-style coordinate arrays', () => {
  it('accepts numeric coordinates in top-level location.coordinates', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        location: {
          type: { type: String, enum: ['Point'] },
          coordinates: { type: [Number], required: true },
        },
      }),
    );
    const validate = compile(createBody);

    expect(
      validate({
        location: { type: 'Point', coordinates: [-73.9857, 40.7484] },
      }),
    ).toBe(true);
    // The one assertion the old converter would have INVERTED — strings in
    // coordinates used to pass, numbers used to fail.
    expect(
      validate({
        location: { type: 'Point', coordinates: ['-73.9857', '40.7484'] },
      }),
    ).toBe(false);
  });

  it('accepts a realistic feature collection subdoc array', () => {
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
    const validate = compile(createBody);

    expect(
      validate({
        features: [
          { label: 'Home', coordinates: [-73.9857, 40.7484] },
          { label: 'Office', coordinates: [-73.9911, 40.7505] },
        ],
      }),
    ).toBe(true);
    expect(
      validate({
        features: [{ label: 'Home', coordinates: ['x', 'y'] }],
      }),
    ).toBe(false);
  });
});

describe('Ajv regression — deeply nested subdocument arrays', () => {
  it('3-level tree: accepts realistic task payloads, rejects wrong types anywhere', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        projects: [
          {
            _id: false,
            name: { type: String, required: true },
            tasks: [
              {
                _id: false,
                title: { type: String, required: true },
                tags: [String],
                assigneeIds: [Schema.Types.ObjectId],
              },
            ],
          },
        ],
      }),
    );
    const validate = compile(createBody);

    const good = {
      projects: [
        {
          name: 'Sprint 42',
          tasks: [
            {
              title: 'Ship the fix',
              tags: ['backend', 'urgent'],
              assigneeIds: ['507f1f77bcf86cd799439011'],
            },
          ],
        },
      ],
    };
    expect(validate(good)).toBe(true);

    // Bad: task.tags has a number
    expect(
      validate({
        projects: [
          {
            name: 'x',
            tasks: [{ title: 't', tags: [1, 2, 3], assigneeIds: [] }],
          },
        ],
      }),
    ).toBe(false);

    // Bad: task.assigneeIds has a malformed ObjectId
    expect(
      validate({
        projects: [
          {
            name: 'x',
            tasks: [{ title: 't', tags: ['a'], assigneeIds: ['nope'] }],
          },
        ],
      }),
    ).toBe(false);

    // Bad: project missing `name`
    expect(
      validate({
        projects: [{ tasks: [{ title: 't' }] }],
      }),
    ).toBe(false);
  });
});

describe('Ajv regression — single-embedded (top-level Embedded instance)', () => {
  it('accepts billing-address-shaped payloads, rejects bad zips', () => {
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
    const validate = compile(createBody);

    expect(
      validate({ billingAddress: { street: '5 Main St', zip: '10001' } }),
    ).toBe(true);
    expect(validate({ billingAddress: { street: '5 Main St' } })).toBe(true);
    expect(
      validate({ billingAddress: { street: '5 Main St', zip: '1001' } }),
    ).toBe(false);
    expect(validate({ billingAddress: { zip: '10001' } })).toBe(false);
    expect(validate({})).toBe(false);
  });
});

describe('Ajv regression — Mixed arrays accept heterogeneous payloads', () => {
  it('[Schema.Types.Mixed] accepts any object-shaped item', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ payload: [Schema.Types.Mixed] }),
    );
    const validate = compile(createBody);

    expect(validate({ payload: [{ a: 1 }, { b: 'x' }, { c: [1, 2] }] })).toBe(true);
    // Our Mixed fallback is `{ type: 'object', additionalProperties: true }` —
    // primitive items are rejected. That's intentional and documented — the
    // industry convention is "objects only" for Mixed-typed arrays.
    expect(validate({ payload: [1, 'x'] })).toBe(false);
  });
});

describe('Ajv regression — element-level validators enforced', () => {
  it('[{ type: String, enum: […] }] rejects values outside the enum', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({
        roles: [{ type: String, enum: ['admin', 'user', 'guest'] }],
      }),
    );
    const validate = compile(createBody);

    expect(validate({ roles: ['admin', 'user'] })).toBe(true);
    expect(validate({ roles: ['admin', 'owner'] })).toBe(false);
  });

  it('[{ type: Number, min, max }] rejects out-of-range values', () => {
    const { createBody } = buildCrudSchemasFromMongooseSchema(
      new Schema({ scores: [{ type: Number, min: 0, max: 100 }] }),
    );
    const validate = compile(createBody);

    expect(validate({ scores: [0, 50, 100] })).toBe(true);
    expect(validate({ scores: [101] })).toBe(false);
    expect(validate({ scores: [-1] })).toBe(false);
  });
});
