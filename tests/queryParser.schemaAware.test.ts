/**
 * QueryParser — schema-aware value coercion
 *
 * The principled fix for the direct-equality vs operator-syntax asymmetry.
 * Instead of guessing types from string shape (which is brittle: "01234" might
 * be a zip code OR a numeric ID, "1.5" might be a version string OR a price),
 * the parser can be given an authoritative type source:
 *
 *   1. A Mongoose schema (zero-config for Mongoose users — pass `Model.schema`).
 *   2. A plain `fieldTypes` map (DB-agnostic — works with raw MongoDB, Prisma, etc.).
 *   3. Both — `fieldTypes` overrides paths in the schema for runtime-only fields.
 *
 * When schema/fieldTypes is configured, the parser coerces values exactly to
 * the declared type and never guesses. Unknown fields fall through to the
 * existing heuristic so ad-hoc filters still work.
 *
 * This file is the RED phase: tests are written before the implementation,
 * fail clearly, and pin the contract.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { QueryParser } from '../src/index.js';

// ── Fixture schemas ────────────────────────────────────────────────────────
// Built once at module load. Mongoose's `.paths` reflection is what the
// parser will introspect, so we exercise the real type names.

interface IInventoryDoc {
  name: string;
  stock: number;
  price: number;
  active: boolean;
  releasedAt: Date;
  ownerId: mongoose.Types.ObjectId;
  tags: string[];
  ratings: number[];
  address: {
    zip: string; // intentionally string — leading zeros must survive
    floor: number;
  };
}

const InventorySchema = new Schema<IInventoryDoc>({
  name: { type: String, required: true },
  stock: { type: Number, required: true },
  price: { type: Number, required: true },
  active: { type: Boolean, default: true },
  releasedAt: { type: Date, required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  tags: [{ type: String }],
  ratings: [{ type: Number }],
  address: {
    zip: { type: String, required: true },
    floor: { type: Number },
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Mongoose schema → primitive coercion
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser schema-aware coercion: Mongoose schema', () => {
  it('coerces direct-equality numeric values when field is declared Number', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({ stock: '50' });
    expect(result.filters.stock).toBe(50);
    expect(typeof result.filters.stock).toBe('number');
  });

  it('preserves numeric-looking strings when field is declared String', () => {
    // Without schema, the heuristic would coerce "12345" to a number.
    // With schema, the parser knows "name" is a string and leaves it alone.
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({ name: '12345' });
    expect(result.filters.name).toBe('12345');
    expect(typeof result.filters.name).toBe('string');
  });

  it('coerces boolean fields from "true"/"false"', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    expect(parser.parse({ active: 'true' }).filters.active).toBe(true);
    expect(parser.parse({ active: 'false' }).filters.active).toBe(false);
  });

  it('coerces boolean fields from "1"/"0" when schema declares Boolean', () => {
    // New behavior: with explicit Boolean type, "1"/"0" become true/false.
    // Without schema, "1" → 1 (number) via heuristic — both behaviors are
    // correct given their information sources.
    const parser = new QueryParser({ schema: InventorySchema });
    expect(parser.parse({ active: '1' }).filters.active).toBe(true);
    expect(parser.parse({ active: '0' }).filters.active).toBe(false);
  });

  it('coerces ISO date strings to Date instances when field is Date', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({ releasedAt: '2026-04-07' });
    expect(result.filters.releasedAt).toBeInstanceOf(Date);
    expect((result.filters.releasedAt as Date).toISOString()).toBe('2026-04-07T00:00:00.000Z');
  });

  it('passes through valid ObjectId hex strings when field is ObjectId', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const id = '507f1f77bcf86cd799439011';
    const result = parser.parse({ ownerId: id });
    expect(result.filters.ownerId).toBe(id);
  });

  it('leaves invalid date strings as-is rather than producing Invalid Date', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({ releasedAt: 'definitely-not-a-date' });
    // Better to leave the string than emit `new Date('Invalid Date')` which
    // would silently match nothing in MongoDB.
    expect(result.filters.releasedAt).toBe('definitely-not-a-date');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Nested paths
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser schema-aware coercion: nested paths', () => {
  it('preserves leading zeros on nested string fields (zip code)', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({ 'address.zip': '01234' });
    expect(result.filters['address.zip']).toBe('01234');
  });

  it('coerces nested numeric fields', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({ 'address.floor': '7' });
    expect(result.filters['address.floor']).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Array fields and operator syntax
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser schema-aware coercion: arrays and operators', () => {
  it('coerces array elements when field is declared as array of numbers', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({ 'ratings[in]': '1,2,3' });
    expect(result.filters.ratings).toEqual({ $in: [1, 2, 3] });
  });

  it('does NOT coerce array elements when field is array of strings', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({ 'tags[in]': 'sale,new,01234' });
    // "01234" must stay a string here — it's a tag, not a number
    expect(result.filters.tags).toEqual({ $in: ['sale', 'new', '01234'] });
  });

  it('coerces operator values consistent with direct equality', () => {
    // Both `stock=50` and `stock[gte]=50` must produce numbers when stock is Number
    const parser = new QueryParser({ schema: InventorySchema });
    const direct = parser.parse({ stock: '50' });
    const operator = parser.parse({ 'stock[gte]': '50' });
    expect(direct.filters.stock).toBe(50);
    expect(operator.filters.stock).toEqual({ $gte: 50 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. fieldTypes map (DB-agnostic, no Mongoose required)
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser schema-aware coercion: fieldTypes map', () => {
  it('coerces using a plain fieldTypes map without any schema', () => {
    const parser = new QueryParser({
      fieldTypes: {
        stock: 'number',
        active: 'boolean',
        releasedAt: 'date',
        name: 'string',
      },
    });
    const result = parser.parse({
      stock: '50',
      active: 'true',
      releasedAt: '2026-04-07',
      name: '12345',
    });
    expect(result.filters.stock).toBe(50);
    expect(result.filters.active).toBe(true);
    expect(result.filters.releasedAt).toBeInstanceOf(Date);
    expect(result.filters.name).toBe('12345');
  });

  it('fieldTypes map overrides the Mongoose schema for the same path', () => {
    // Useful when a runtime/computed field has a different effective type than
    // the persisted Mongoose path, or when an upstream model is wrong.
    const parser = new QueryParser({
      schema: InventorySchema,
      fieldTypes: { stock: 'string' }, // override: treat stock as string
    });
    const result = parser.parse({ stock: '50' });
    expect(result.filters.stock).toBe('50');
    expect(typeof result.filters.stock).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Fallback behavior — unknown fields and no schema
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser schema-aware coercion: fallback behavior', () => {
  it('falls back to heuristic for fields not declared in the schema', () => {
    // Schema declares stock/name/etc., but caller filters on an unknown field.
    // We must not be hostile — the heuristic still runs for the unknown field.
    const parser = new QueryParser({
      schema: InventorySchema,
      // allowedFilterFields not set, so unknown fields are permitted
    });
    const result = parser.parse({ unknownNumeric: '42', unknownString: 'hello' });
    expect(result.filters.unknownNumeric).toBe(42); // heuristic
    expect(result.filters.unknownString).toBe('hello');
  });

  it('with no schema and no fieldTypes, the existing heuristic still applies', () => {
    const parser = new QueryParser();
    expect(parser.parse({ stock: '50' }).filters.stock).toBe(50);
    expect(parser.parse({ stock: '01234' }).filters.stock).toBe('01234'); // leading-zero guard
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Composition with $or (proves the schema-aware path applies inside branches)
// ─────────────────────────────────────────────────────────────────────────

describe('QueryParser schema-aware coercion: composition with $or', () => {
  it('coerces values inside $or branches according to the schema', () => {
    const parser = new QueryParser({ schema: InventorySchema });
    const result = parser.parse({
      or: [{ stock: '50' }, { stock: '100' }],
    });
    expect(result.filters.$or).toEqual([{ stock: 50 }, { stock: 100 }]);
  });
});
