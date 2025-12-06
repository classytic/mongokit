/**
 * Cursor Utilities
 * 
 * Encoding and decoding of cursor tokens for keyset pagination.
 * Cursors are base64-encoded JSON containing position data and metadata.
 */

import mongoose from 'mongoose';
import type { SortSpec, DecodedCursor, ObjectId, CursorPayload, ValueType } from '../../types.js';

/**
 * Encodes document values and sort metadata into a base64 cursor token
 *
 * @param doc - Document to extract cursor values from
 * @param primaryField - Primary sort field name
 * @param sort - Normalized sort specification
 * @param version - Cursor version for forward compatibility
 * @returns Base64-encoded cursor token
 */
export function encodeCursor(
  doc: Record<string, unknown>,
  primaryField: string,
  sort: SortSpec,
  version: number = 1
): string {
  const primaryValue = doc[primaryField];
  const idValue = doc._id;

  const payload: CursorPayload = {
    v: serializeValue(primaryValue),
    t: getValueType(primaryValue),
    id: serializeValue(idValue) as string,
    idType: getValueType(idValue),
    sort,
    ver: version,
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Decodes a cursor token back into document values and sort metadata
 *
 * @param token - Base64-encoded cursor token
 * @returns Decoded cursor data
 * @throws Error if token is invalid or malformed
 */
export function decodeCursor(token: string): DecodedCursor {
  try {
    const json = Buffer.from(token, 'base64').toString('utf-8');
    const payload = JSON.parse(json) as CursorPayload;

    return {
      value: rehydrateValue(payload.v, payload.t),
      id: rehydrateValue(payload.id, payload.idType) as ObjectId | string,
      sort: payload.sort,
      version: payload.ver,
    };
  } catch {
    throw new Error('Invalid cursor token');
  }
}

/**
 * Validates that cursor sort matches current query sort
 *
 * @param cursorSort - Sort specification from cursor
 * @param currentSort - Sort specification from query
 * @throws Error if sorts don't match
 */
export function validateCursorSort(cursorSort: SortSpec, currentSort: SortSpec): void {
  const cursorSortStr = JSON.stringify(cursorSort);
  const currentSortStr = JSON.stringify(currentSort);

  if (cursorSortStr !== currentSortStr) {
    throw new Error('Cursor sort does not match current query sort');
  }
}

/**
 * Validates cursor version matches expected version
 *
 * @param cursorVersion - Version from cursor
 * @param expectedVersion - Expected version from config
 * @throws Error if versions don't match
 */
export function validateCursorVersion(cursorVersion: number, expectedVersion: number): void {
  if (cursorVersion !== expectedVersion) {
    throw new Error(`Cursor version ${cursorVersion} does not match expected version ${expectedVersion}`);
  }
}

/**
 * Serializes a value for cursor storage
 */
function serializeValue(value: unknown): string | number | boolean {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  return value as string | number | boolean;
}

/**
 * Gets the type identifier for a value
 */
function getValueType(value: unknown): ValueType {
  if (value instanceof Date) return 'date';
  if (value instanceof mongoose.Types.ObjectId) return 'objectid';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

/**
 * Rehydrates a serialized value back to its original type
 */
function rehydrateValue(serialized: unknown, type: ValueType): unknown {
  switch (type) {
    case 'date':
      return new Date(serialized as string);
    case 'objectid':
      return new mongoose.Types.ObjectId(serialized as string);
    case 'boolean':
      return Boolean(serialized);
    case 'number':
      return Number(serialized);
    default:
      return serialized;
  }
}
