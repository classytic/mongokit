/**
 * Unit tests for cursor version negotiation.
 *
 * Guards the contract for how stale client cursors are rejected after a
 * breaking cursor-format change. See src/pagination/utils/cursor.ts.
 */

import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  encodeCursor,
  resolveCursorFilter,
  validateCursorVersion,
} from '../../src/pagination/utils/cursor.js';
import type { SortSpec } from '../../src/types.js';

function makeSampleCursor(version: number, sort: SortSpec): string {
  const doc = {
    _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  return encodeCursor(doc, 'createdAt', sort, version);
}

describe('validateCursorVersion', () => {
  it('accepts a cursor equal to the server expected version', () => {
    expect(() => validateCursorVersion(1, 1)).not.toThrow();
    expect(() => validateCursorVersion(2, 2, 2)).not.toThrow();
  });

  it('accepts a cursor older than expected when above minVersion (rolling deploy)', () => {
    expect(() => validateCursorVersion(1, 2, 1)).not.toThrow();
  });

  it('rejects cursors newer than the server expected version', () => {
    expect(() => validateCursorVersion(3, 2)).toThrow(/newer than expected/);
  });

  it('rejects cursors older than the configured minVersion', () => {
    expect(() => validateCursorVersion(1, 2, 2)).toThrow(
      /older than minimum supported 2\. Pagination must restart/,
    );
  });

  it('default minVersion is 1 so legacy v1 cursors still work without explicit config', () => {
    expect(() => validateCursorVersion(1, 2)).not.toThrow();
  });

  it('rejects version 0 under default minVersion=1', () => {
    expect(() => validateCursorVersion(0, 2)).toThrow(/older than minimum supported 1/);
  });
});

describe('resolveCursorFilter — minCursorVersion propagation', () => {
  const sort: SortSpec = { createdAt: -1, _id: -1 };

  it('passes through the minCursorVersion and rejects a stale cursor', () => {
    const staleCursor = makeSampleCursor(1, sort);
    expect(() => resolveCursorFilter(staleCursor, sort, 2, {}, 2)).toThrow(
      /older than minimum supported/,
    );
  });

  it('accepts a cursor at minCursorVersion', () => {
    const cursor = makeSampleCursor(2, sort);
    const filter = resolveCursorFilter(cursor, sort, 2, {}, 2);
    expect(filter).toBeTypeOf('object');
  });

  it('defaults to minCursorVersion=1 when unspecified', () => {
    const cursor = makeSampleCursor(1, sort);
    expect(() => resolveCursorFilter(cursor, sort, 2, {})).not.toThrow();
  });

  it('bare ObjectId fallback cursor skips version check entirely', () => {
    const objectIdHex = '507f1f77bcf86cd799439011';
    const filter = resolveCursorFilter(objectIdHex, sort, 2, { active: true }, 99);
    expect(filter).toMatchObject({ active: true });
    expect(filter._id).toBeDefined();
  });

  it('rejects a newer-than-expected cursor regardless of minVersion', () => {
    const futureCursor = makeSampleCursor(5, sort);
    expect(() => resolveCursorFilter(futureCursor, sort, 2, {}, 1)).toThrow(/newer than expected/);
  });
});
