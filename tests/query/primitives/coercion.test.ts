/**
 * Unit tests for coercion primitives — pure functions, no Mongo, no parser.
 * These pin the contract that `QueryParser` composes upon.
 */

import { Schema, Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  buildFieldTypeMap,
  coerceFieldValue,
  coerceHeuristic,
  coerceToType,
  type FieldType,
  normalizeMongooseType,
} from '../../../src/query/primitives/coercion.js';

// ─── coerceHeuristic ──────────────────────────────────────────────────────

describe('coercion primitive: coerceHeuristic', () => {
  it('passes nullish through', () => {
    expect(coerceHeuristic(null)).toBeNull();
    expect(coerceHeuristic(undefined)).toBeUndefined();
  });

  it('passes already-typed primitives through', () => {
    expect(coerceHeuristic(42)).toBe(42);
    expect(coerceHeuristic(true)).toBe(true);
    expect(coerceHeuristic(false)).toBe(false);
  });

  it('coerces booleans from string form', () => {
    expect(coerceHeuristic('true')).toBe(true);
    expect(coerceHeuristic('false')).toBe(false);
  });

  it('coerces plain decimals to numbers', () => {
    expect(coerceHeuristic('50')).toBe(50);
    expect(coerceHeuristic('-5')).toBe(-5);
    expect(coerceHeuristic('0')).toBe(0);
    expect(coerceHeuristic('3.14')).toBe(3.14);
  });

  it('rejects leading-zero strings (zip / phone / SKU)', () => {
    expect(coerceHeuristic('01234')).toBe('01234');
    expect(coerceHeuristic('00042')).toBe('00042');
  });

  it('rejects scientific notation (avoids parsing 1e308 to Infinity)', () => {
    expect(coerceHeuristic('1e10')).toBe('1e10');
    expect(coerceHeuristic('1e308')).toBe('1e308');
  });

  it('rejects hex/octal-looking strings', () => {
    expect(coerceHeuristic('0x10')).toBe('0x10');
    expect(coerceHeuristic('0o7')).toBe('0o7');
  });

  it('rejects strings longer than 15 chars (preserves long numeric IDs)', () => {
    const longId = '12345678901234567890';
    expect(coerceHeuristic(longId)).toBe(longId);
    expect(typeof coerceHeuristic(longId)).toBe('string');
  });

  it('preserves 24-char ObjectId hex strings as strings', () => {
    const id = new Types.ObjectId().toHexString();
    expect(coerceHeuristic(id)).toBe(id);
    expect(typeof coerceHeuristic(id)).toBe('string');
  });

  it('recurses into arrays element-wise', () => {
    expect(coerceHeuristic(['1', '2', '3'])).toEqual([1, 2, 3]);
    expect(coerceHeuristic(['00001', '2'])).toEqual(['00001', 2]);
  });

  it('passes objects through (operator filter shapes)', () => {
    const obj = { $gte: 5 };
    expect(coerceHeuristic(obj)).toBe(obj);
  });

  it('returns empty string as empty string (does not become 0/NaN)', () => {
    expect(coerceHeuristic('')).toBe('');
  });
});

// ─── coerceToType ─────────────────────────────────────────────────────────

describe('coercion primitive: coerceToType', () => {
  it('number: parses plain decimals', () => {
    expect(coerceToType('50', 'number')).toBe(50);
    expect(coerceToType('3.14', 'number')).toBe(3.14);
    expect(coerceToType(50, 'number')).toBe(50);
  });

  it('number: returns the original value on garbage instead of NaN', () => {
    expect(coerceToType('not-a-number', 'number')).toBe('not-a-number');
  });

  it('boolean: accepts true/false/1/0 (case-insensitive)', () => {
    expect(coerceToType('true', 'boolean')).toBe(true);
    expect(coerceToType('TRUE', 'boolean')).toBe(true);
    expect(coerceToType('false', 'boolean')).toBe(false);
    expect(coerceToType('1', 'boolean')).toBe(true);
    expect(coerceToType('0', 'boolean')).toBe(false);
    expect(coerceToType(true, 'boolean')).toBe(true);
  });

  it('boolean: returns the original value on garbage', () => {
    expect(coerceToType('maybe', 'boolean')).toBe('maybe');
  });

  it('date: parses ISO strings to Date instances', () => {
    const d = coerceToType('2026-04-07', 'date') as Date;
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-04-07T00:00:00.000Z');
  });

  it('date: passes Date instances through', () => {
    const d = new Date('2026-01-01');
    expect(coerceToType(d, 'date')).toBe(d);
  });

  it('date: returns the original value on garbage rather than Invalid Date', () => {
    expect(coerceToType('not-a-date', 'date')).toBe('not-a-date');
  });

  it('objectid: passes valid 24-char hex through as a string', () => {
    const id = new Types.ObjectId().toHexString();
    expect(coerceToType(id, 'objectid')).toBe(id);
  });

  it('objectid: returns the original value on invalid input', () => {
    expect(coerceToType('not-an-id', 'objectid')).toBe('not-an-id');
  });

  it('string: forces String() coercion (12345 → "12345" preserved as string)', () => {
    expect(coerceToType('12345', 'string')).toBe('12345');
    expect(coerceToType(12345, 'string')).toBe('12345');
  });

  it('mixed: falls through to heuristic', () => {
    expect(coerceToType('50', 'mixed')).toBe(50);
    expect(coerceToType('01234', 'mixed')).toBe('01234');
  });

  it('arrays: recurses element-wise with the same type', () => {
    expect(coerceToType(['1', '2', '3'], 'number')).toEqual([1, 2, 3]);
    expect(coerceToType(['true', 'false'], 'boolean')).toEqual([true, false]);
    expect(coerceToType(['12345', '67890'], 'string')).toEqual(['12345', '67890']);
  });
});

// ─── normalizeMongooseType + buildFieldTypeMap ────────────────────────────

describe('coercion primitive: normalizeMongooseType', () => {
  it('maps each Mongoose type name to the normalized FieldType', () => {
    const cases: Array<[string, FieldType]> = [
      ['String', 'string'],
      ['Number', 'number'],
      ['Boolean', 'boolean'],
      ['Date', 'date'],
      ['ObjectID', 'objectid'],
      ['ObjectId', 'objectid'],
      ['Mixed', 'mixed'],
    ];
    for (const [instance, expected] of cases) {
      expect(normalizeMongooseType({ instance })).toBe(expected);
    }
  });

  it('reads array element type from caster.instance', () => {
    expect(normalizeMongooseType({ instance: 'Array', caster: { instance: 'Number' } })).toBe(
      'number',
    );
    expect(normalizeMongooseType({ instance: 'Array', caster: { instance: 'String' } })).toBe(
      'string',
    );
  });

  it('returns null for unknown / embedded types', () => {
    expect(normalizeMongooseType({ instance: 'Embedded' })).toBeNull();
    expect(normalizeMongooseType({})).toBeNull();
  });
});

describe('coercion primitive: buildFieldTypeMap', () => {
  it('builds a map from a real Mongoose schema (both [Type] and [{ type: Type }] array forms)', () => {
    const s = new Schema({
      name: { type: String },
      stock: { type: Number },
      active: { type: Boolean },
      releasedAt: { type: Date },
      ownerId: { type: Schema.Types.ObjectId },
      // Both array declaration forms — Mongoose 8 stores element type on
      // embeddedSchemaType.instance for both, but older Mongoose used
      // caster.instance for the [Type] form. The primitive must handle both.
      tags: [{ type: String }],
      ratings: [{ type: Number }],
      shorthandTags: [String],
      shorthandRatings: [Number],
    });
    const map = buildFieldTypeMap(s);
    expect(map.get('name')).toBe('string');
    expect(map.get('stock')).toBe('number');
    expect(map.get('active')).toBe('boolean');
    expect(map.get('releasedAt')).toBe('date');
    expect(map.get('ownerId')).toBe('objectid');
    expect(map.get('tags')).toBe('string');
    expect(map.get('ratings')).toBe('number');
    expect(map.get('shorthandTags')).toBe('string');
    expect(map.get('shorthandRatings')).toBe('number');
  });

  it('overrides win over schema entries', () => {
    const s = new Schema({ stock: { type: Number } });
    const map = buildFieldTypeMap(s, { stock: 'string' });
    expect(map.get('stock')).toBe('string');
  });

  it('overrides can declare fields not in the schema', () => {
    const s = new Schema({ stock: { type: Number } });
    const map = buildFieldTypeMap(s, { computedField: 'date' });
    expect(map.get('computedField')).toBe('date');
    expect(map.get('stock')).toBe('number');
  });

  it('returns an empty map when no schema or overrides are provided', () => {
    expect(buildFieldTypeMap()).toEqual(new Map());
    expect(buildFieldTypeMap(null)).toEqual(new Map());
  });
});

// ─── coerceFieldValue (the orchestrator entry point) ──────────────────────

describe('coercion primitive: coerceFieldValue', () => {
  const types = new Map<string, FieldType>([
    ['stock', 'number'],
    ['name', 'string'],
    ['active', 'boolean'],
  ]);

  it('uses type-directed coercion for declared fields', () => {
    expect(coerceFieldValue('stock', '50', types)).toBe(50);
    expect(coerceFieldValue('name', '12345', types)).toBe('12345');
    expect(coerceFieldValue('active', '1', types)).toBe(true);
  });

  it('falls back to heuristic for undeclared fields', () => {
    expect(coerceFieldValue('unknownNumeric', '42', types)).toBe(42);
    expect(coerceFieldValue('unknownLeadingZero', '01234', types)).toBe('01234');
  });

  it('still falls back to heuristic when types is empty', () => {
    expect(coerceFieldValue('stock', '50', new Map())).toBe(50);
  });
});
