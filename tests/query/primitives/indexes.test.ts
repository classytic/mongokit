/**
 * Unit tests for schema-index introspection. Uses real Mongoose schemas to
 * exercise the actual `.indexes()` shape, but does not touch Mongo.
 */

import { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { extractSchemaIndexes } from '../../../src/query/primitives/indexes.js';

describe('indexes primitive: extractSchemaIndexes', () => {
  it('returns empty shape when no schema is provided', () => {
    expect(extractSchemaIndexes()).toEqual({
      geoFields: [],
      textFields: [],
      other: [],
    });
    expect(extractSchemaIndexes(null)).toEqual({
      geoFields: [],
      textFields: [],
      other: [],
    });
  });

  it('extracts a 2dsphere field', () => {
    const s = new Schema({
      name: String,
      location: {
        type: { type: String, enum: ['Point'] },
        coordinates: [Number],
      },
    });
    s.index({ location: '2dsphere' });
    const out = extractSchemaIndexes(s);
    expect(out.geoFields).toEqual(['location']);
  });

  it('extracts a 2d (legacy) geo field', () => {
    const s = new Schema({ pos: [Number] });
    s.index({ pos: '2d' });
    expect(extractSchemaIndexes(s).geoFields).toEqual(['pos']);
  });

  it('extracts text-indexed fields', () => {
    const s = new Schema({ title: String, body: String });
    s.index({ title: 'text', body: 'text' });
    const out = extractSchemaIndexes(s);
    expect(out.textFields.sort()).toEqual(['body', 'title']);
  });

  it('classifies a compound non-geo non-text index as "other"', () => {
    const s = new Schema({ org: String, status: String });
    s.index({ org: 1, status: 1 });
    const out = extractSchemaIndexes(s);
    expect(out.geoFields).toEqual([]);
    expect(out.textFields).toEqual([]);
    expect(out.other).toHaveLength(1);
    expect(out.other[0].spec).toEqual({ org: 1, status: 1 });
  });

  it('handles mixed schemas (geo + text + compound)', () => {
    const s = new Schema({
      title: String,
      body: String,
      location: { type: { type: String }, coordinates: [Number] },
      org: String,
    });
    s.index({ title: 'text', body: 'text' });
    s.index({ location: '2dsphere' });
    s.index({ org: 1 });
    const out = extractSchemaIndexes(s);
    expect(out.geoFields).toEqual(['location']);
    expect(out.textFields.sort()).toEqual(['body', 'title']);
    expect(out.other).toHaveLength(1);
  });

  it('does not throw when schema.indexes() throws', () => {
    const broken = {
      indexes() {
        throw new Error('boom');
      },
    };
    expect(extractSchemaIndexes(broken)).toEqual({
      geoFields: [],
      textFields: [],
      other: [],
    });
  });
});
