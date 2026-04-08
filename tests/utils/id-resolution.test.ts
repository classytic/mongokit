/**
 * ID resolution primitive — unit tests
 *
 * Pure functions that detect the _id type from a Mongoose schema and validate
 * an id value against it. No MongoDB, no Model, no Repository — just schema
 * reflection and value checking.
 */

import mongoose, { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  getSchemaIdType,
  isValidIdForType,
  type IdType,
} from '../../src/utils/id-resolution.js';

// ── getSchemaIdType ────────────────────────────────────────────────────────

describe('id-resolution: getSchemaIdType', () => {
  it('returns "objectid" for default Mongoose schemas (auto _id)', () => {
    const s = new Schema({ name: String });
    expect(getSchemaIdType(s)).toBe('objectid');
  });

  it('returns "string" when _id is declared as String', () => {
    const s = new Schema({ _id: { type: String }, name: String });
    expect(getSchemaIdType(s)).toBe('string');
  });

  it('returns "number" when _id is declared as Number', () => {
    const s = new Schema({ _id: { type: Number }, name: String });
    expect(getSchemaIdType(s)).toBe('number');
  });

  it('returns "uuid" when _id is declared as UUID', () => {
    const s = new Schema({ _id: { type: Schema.Types.UUID }, name: String });
    expect(getSchemaIdType(s)).toBe('uuid');
  });

  it('returns "objectid" for null / undefined / missing schema (safe default)', () => {
    expect(getSchemaIdType(null)).toBe('objectid');
    expect(getSchemaIdType(undefined)).toBe('objectid');
    expect(getSchemaIdType({} as any)).toBe('objectid');
  });

  it('returns "objectid" for a mock model without schema.paths (safe default)', () => {
    // This is the MockModel pattern used in type-dx tests
    expect(getSchemaIdType({ paths: {} } as any)).toBe('objectid');
    expect(getSchemaIdType({ paths: { _id: {} } } as any)).toBe('objectid');
  });
});

// ── isValidIdForType ──────────────────────────────────────────────────────

describe('id-resolution: isValidIdForType', () => {
  // ObjectId type
  it('accepts a valid 24-hex string for objectid type', () => {
    expect(isValidIdForType('507f1f77bcf86cd799439011', 'objectid')).toBe(true);
  });

  it('accepts an ObjectId instance for objectid type', () => {
    expect(isValidIdForType(new mongoose.Types.ObjectId(), 'objectid')).toBe(true);
  });

  it('rejects a UUID string for objectid type', () => {
    expect(isValidIdForType('550e8400-e29b-41d4-a716-446655440000', 'objectid')).toBe(false);
  });

  it('rejects a random string for objectid type', () => {
    expect(isValidIdForType('not-an-id', 'objectid')).toBe(false);
  });

  it('rejects empty string for objectid type', () => {
    expect(isValidIdForType('', 'objectid')).toBe(false);
  });

  // String type — any non-empty string is valid
  it('accepts UUIDs for string type', () => {
    expect(isValidIdForType('550e8400-e29b-41d4-a716-446655440000', 'string')).toBe(true);
  });

  it('accepts hex ObjectId strings for string type (they are valid strings)', () => {
    expect(isValidIdForType('507f1f77bcf86cd799439011', 'string')).toBe(true);
  });

  it('accepts arbitrary strings for string type', () => {
    expect(isValidIdForType('my-custom-slug', 'string')).toBe(true);
  });

  it('rejects empty string for string type', () => {
    expect(isValidIdForType('', 'string')).toBe(false);
  });

  it('rejects nullish for string type', () => {
    expect(isValidIdForType(null, 'string')).toBe(false);
    expect(isValidIdForType(undefined, 'string')).toBe(false);
  });

  // Number type
  it('accepts numeric values for number type', () => {
    expect(isValidIdForType(42, 'number')).toBe(true);
    expect(isValidIdForType(0, 'number')).toBe(true);
    expect(isValidIdForType(-1, 'number')).toBe(true);
  });

  it('accepts numeric strings for number type (coerced)', () => {
    expect(isValidIdForType('42', 'number')).toBe(true);
  });

  it('rejects NaN / non-numeric strings for number type', () => {
    expect(isValidIdForType('not-a-number', 'number')).toBe(false);
    expect(isValidIdForType(Number.NaN, 'number')).toBe(false);
  });

  // UUID type
  it('accepts standard UUID v4 format for uuid type', () => {
    expect(isValidIdForType('550e8400-e29b-41d4-a716-446655440000', 'uuid')).toBe(true);
  });

  it('rejects non-UUID strings for uuid type', () => {
    expect(isValidIdForType('not-a-uuid', 'uuid')).toBe(false);
    expect(isValidIdForType('507f1f77bcf86cd799439011', 'uuid')).toBe(false);
  });

  // Unknown type — accept anything non-empty (let DB decide)
  it('accepts any truthy value for unknown type', () => {
    expect(isValidIdForType('anything', 'unknown')).toBe(true);
    expect(isValidIdForType(42, 'unknown')).toBe(true);
  });

  it('rejects nullish / empty for unknown type', () => {
    expect(isValidIdForType(null, 'unknown')).toBe(false);
    expect(isValidIdForType('', 'unknown')).toBe(false);
  });
});
