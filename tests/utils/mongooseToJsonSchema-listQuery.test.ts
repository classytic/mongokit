/**
 * listQuery schema — pagination/filter query-string shape
 *
 * Historical bug: mongooseToJsonSchema emitted `{ type: 'string' }` for every
 * field of the list-query schema, including `page`/`limit` (numeric) and
 * `lean`/`includeDeleted` (boolean). Consumers merging numeric constraints
 * (e.g. arc's NORMALIZED_PROPS with `minimum: 1`) onto a `type: 'string'` then
 * hit the Ajv strict-mode warning "keyword minimum is not allowed for type
 * string". Fixed in v3.6.3 — this suite pins the correct semantic types and
 * verifies Ajv accepts the payloads Fastify actually forwards (coerced from
 * query strings by default).
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { buildCrudSchemasFromMongooseSchema } from '../../src/index.js';

function pagination() {
  return buildCrudSchemasFromMongooseSchema(new Schema({ name: String })).listQuery;
}

// Ajv configured the way Fastify configures it for query schemas: coerce
// numeric/boolean strings into their declared types, but still validate
// bounds / enum membership.
function coercingValidator(jsonSchema: unknown) {
  const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true });
  addFormats(ajv);
  return ajv.compile(jsonSchema as Record<string, unknown>);
}

describe('listQuery — declared semantic types', () => {
  it('page and limit are integers with minimum 1 and sensible defaults', () => {
    const q = pagination();
    const props = q.properties as Record<string, unknown>;
    expect(props.page).toEqual({ type: 'integer', minimum: 1, default: 1 });
    expect(props.limit).toEqual({ type: 'integer', minimum: 1, default: 20 });
  });

  it('lean and includeDeleted are booleans with default false', () => {
    const q = pagination();
    const props = q.properties as Record<string, unknown>;
    expect(props.lean).toEqual({ type: 'boolean', default: false });
    expect(props.includeDeleted).toEqual({ type: 'boolean', default: false });
  });

  it('sort / populate / search / select / after stay strings', () => {
    const q = pagination();
    const props = q.properties as Record<string, unknown>;
    for (const k of ['sort', 'populate', 'search', 'select', 'after']) {
      expect(props[k]).toEqual({ type: 'string' });
    }
  });

  it('additionalProperties remains open (custom filter keys)', () => {
    const q = pagination();
    expect(q.additionalProperties).toBe(true);
  });

  it('NO field in listQuery carries `minimum` on a string type (Ajv strict-mode guard)', () => {
    // Regression guard for the Ajv warning "keyword minimum is not allowed
    // for type string". If any downstream merges `minimum:N` onto a string
    // typed property, Ajv flags it. All numeric-ish fields should already be
    // `type: 'integer'` / `'number'` so there's nothing for a minimum to
    // clash with.
    const q = pagination();
    for (const [, prop] of Object.entries(q.properties ?? {})) {
      const p = prop as Record<string, unknown>;
      if (p.type === 'string' && 'minimum' in p) {
        throw new Error(
          `listQuery property has string type with minimum — that's the bug: ${JSON.stringify(p)}`,
        );
      }
    }
  });
});

describe('listQuery — Ajv behavioral coercion (Fastify-compatible)', () => {
  it('accepts `?page=2&limit=10` after coercion', () => {
    const validate = coercingValidator(pagination());
    const body: Record<string, unknown> = { page: '2', limit: '10' };
    expect(validate(body)).toBe(true);
    // Coercion mutates in place — handlers receive typed values.
    expect(body.page).toBe(2);
    expect(body.limit).toBe(10);
  });

  it('rejects `?page=0` and `?page=-1`', () => {
    const validate = coercingValidator(pagination());
    expect(validate({ page: '0' })).toBe(false);
    expect(validate({ page: '-1' })).toBe(false);
  });

  it('rejects non-numeric `?page=abc`', () => {
    const validate = coercingValidator(pagination());
    expect(validate({ page: 'abc' })).toBe(false);
  });

  it('accepts boolean-like `?lean=true` and `?lean=false`', () => {
    const validate = coercingValidator(pagination());
    const a: Record<string, unknown> = { lean: 'true' };
    const b: Record<string, unknown> = { lean: 'false' };
    expect(validate(a)).toBe(true);
    expect(validate(b)).toBe(true);
    expect(a.lean).toBe(true);
    expect(b.lean).toBe(false);
  });

  it('rejects non-boolean `?lean=maybe`', () => {
    const validate = coercingValidator(pagination());
    expect(validate({ lean: 'maybe' })).toBe(false);
  });

  it('applies defaults via `useDefaults` when params are omitted', () => {
    const validate = coercingValidator(pagination());
    const body: Record<string, unknown> = {};
    expect(validate(body)).toBe(true);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.lean).toBe(false);
    expect(body.includeDeleted).toBe(false);
  });

  it('allows additional filter fields (additionalProperties:true)', () => {
    const validate = coercingValidator(pagination());
    expect(validate({ status: 'active', ownerId: 'abc' })).toBe(true);
  });

  it('accepts a realistic combined query', () => {
    const validate = coercingValidator(pagination());
    const body: Record<string, unknown> = {
      page: '3',
      limit: '25',
      sort: '-createdAt',
      search: 'acme',
      lean: 'true',
      status: 'active',
    };
    expect(validate(body)).toBe(true);
    expect(body.page).toBe(3);
    expect(body.limit).toBe(25);
    expect(body.lean).toBe(true);
  });
});

describe('listQuery — strict-mode downstream-merge safety', () => {
  it('merging { minimum: 1 } onto `page` does NOT trigger the Ajv warning', () => {
    // Simulates what arc's NORMALIZED_PROPS does: merge additional keywords
    // onto our declared properties. Pre-3.6.3 this fired
    // "keyword minimum is not allowed for type string". Post-fix the merge is
    // a no-op redundancy (the schema already has minimum:1) but the key point
    // is the resulting schema passes Ajv strict-mode compilation without
    // warnings.
    const q = pagination();
    const merged: Record<string, unknown> = {
      ...(q as Record<string, unknown>),
      properties: {
        ...(q.properties ?? {}),
        page: { ...(q.properties?.page as object), minimum: 1 },
        limit: { ...(q.properties?.limit as object), minimum: 1 },
      },
    };
    // Strict mode on — any mismatched keyword for the declared type throws
    // at compile time.
    expect(() => {
      const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: true });
      addFormats(ajv);
      ajv.compile(merged);
    }).not.toThrow();
  });
});
