import mongoose from 'mongoose';

/**
 * Encodes document values and sort metadata into a base64 cursor token
 *
 * @param {any} doc - Document to extract cursor values from
 * @param {string} primaryField - Primary sort field name
 * @param {Record<string, 1|-1>} sort - Normalized sort specification
 * @param {number} [version=1] - Cursor version for forward compatibility
 * @returns {string} Base64-encoded cursor token
 */
export function encodeCursor(doc, primaryField, sort, version = 1) {
  const primaryValue = doc[primaryField];
  const idValue = doc._id;

  const payload = {
    v: serializeValue(primaryValue),
    t: getValueType(primaryValue),
    id: serializeValue(idValue),
    idType: getValueType(idValue),
    sort,
    ver: version
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Decodes a cursor token back into document values and sort metadata
 *
 * @param {string} token - Base64-encoded cursor token
 * @returns {{value: any, id: any, sort: Record<string, 1|-1>, version: number}} Decoded cursor data
 * @throws {Error} If token is invalid or malformed
 */
export function decodeCursor(token) {
  try {
    const json = Buffer.from(token, 'base64').toString('utf-8');
    const payload = JSON.parse(json);

    return {
      value: rehydrateValue(payload.v, payload.t),
      id: rehydrateValue(payload.id, payload.idType),
      sort: payload.sort,
      version: payload.ver
    };
  } catch (err) {
    throw new Error('Invalid cursor token');
  }
}

/**
 * Validates that cursor sort matches current query sort
 *
 * @param {Record<string, 1|-1>} cursorSort - Sort specification from cursor
 * @param {Record<string, 1|-1>} currentSort - Sort specification from query
 * @throws {Error} If sorts don't match
 */
export function validateCursorSort(cursorSort, currentSort) {
  const cursorSortStr = JSON.stringify(cursorSort);
  const currentSortStr = JSON.stringify(currentSort);

  if (cursorSortStr !== currentSortStr) {
    throw new Error('Cursor sort does not match current query sort');
  }
}

/**
 * Validates cursor version matches expected version
 *
 * @param {number} cursorVersion - Version from cursor
 * @param {number} expectedVersion - Expected version from config
 * @throws {Error} If versions don't match
 */
export function validateCursorVersion(cursorVersion, expectedVersion) {
  if (cursorVersion !== expectedVersion) {
    throw new Error(`Cursor version ${cursorVersion} does not match expected version ${expectedVersion}`);
  }
}

/**
 * Serializes a value for cursor storage
 * @param {any} value - Value to serialize
 * @returns {string|number|boolean} Serialized value
 */
function serializeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  return value;
}

/**
 * Gets the type identifier for a value
 * @param {any} value - Value to identify
 * @returns {'date'|'objectid'|'boolean'|'number'|'string'|'unknown'} Type identifier
 */
function getValueType(value) {
  if (value instanceof Date) return 'date';
  if (value instanceof mongoose.Types.ObjectId) return 'objectid';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

/**
 * Rehydrates a serialized value back to its original type
 * @param {any} serialized - Serialized value
 * @param {string} type - Type identifier
 * @returns {any} Rehydrated value
 */
function rehydrateValue(serialized, type) {
  switch (type) {
    case 'date': return new Date(serialized);
    case 'objectid': return new mongoose.Types.ObjectId(serialized);
    case 'boolean': return Boolean(serialized);
    case 'number': return Number(serialized);
    default: return serialized;
  }
}
