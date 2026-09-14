/**
 * A keyset cursor over a NESTED sort field.
 *
 * The filter side has always treated a sort key as a Mongo path
 * (`{ 'metadata.progressPct': { $lt } }`), but the encode side read
 * `doc['metadata.progressPct']`, a property no document has. The cursor then
 * carried `v: null`, and page two was served by the null branch of the keyset
 * filter: only rows whose sort field is null, with no error anywhere.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, readSortValue } from '../../src/pagination/utils/cursor.js';

describe('readSortValue', () => {
  it('reads a top-level field as before', () => {
    expect(readSortValue({ createdAt: 5 }, 'createdAt')).toBe(5);
  });

  it('follows a dotted path into a subdocument', () => {
    expect(readSortValue({ metadata: { progressPct: 42 } }, 'metadata.progressPct')).toBe(42);
  });

  it('is undefined, not a throw, when a segment is missing or not an object', () => {
    expect(readSortValue({}, 'metadata.progressPct')).toBeUndefined();
    expect(readSortValue({ metadata: null }, 'metadata.progressPct')).toBeUndefined();
    expect(readSortValue({ metadata: 'x' }, 'metadata.progressPct')).toBeUndefined();
  });
});

describe('encodeCursor over a nested sort field', () => {
  it('carries the nested value, typed, so page two resumes from it', () => {
    const doc = { _id: new mongoose.Types.ObjectId(), metadata: { progressPct: 42 } };
    const sort = { 'metadata.progressPct': -1 as const, _id: -1 as const };
    const decoded = decodeCursor(encodeCursor(doc, 'metadata.progressPct', sort));
    expect(decoded.value).toBe(42);
    expect(decoded.id).toEqual(doc._id);
  });

  it('carries every nested field of a compound sort', () => {
    const doc = {
      _id: new mongoose.Types.ObjectId(),
      metadata: { progressPct: 42, customerName: 'Rafi' },
    };
    const sort = {
      'metadata.progressPct': -1 as const,
      'metadata.customerName': -1 as const,
      _id: -1 as const,
    };
    const decoded = decodeCursor(encodeCursor(doc, 'metadata.progressPct', sort));
    expect(decoded.values).toEqual({ 'metadata.progressPct': 42, 'metadata.customerName': 'Rafi' });
  });
});
