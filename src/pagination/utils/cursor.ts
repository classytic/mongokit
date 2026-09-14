/**
 * Cursor Utilities
 *
 * Encoding and decoding of cursor tokens for keyset pagination.
 * Cursors are base64-encoded JSON containing position data and metadata.
 */

import mongoose from 'mongoose';
import type { ObjectId, SortSpec } from '../../types/core.js';
import type { CursorPayload, DecodedCursor, ValueType } from '../../types/pagination.js';
import {
  attachSignature,
  type CursorSecret,
  resolveCursorSecrets,
  signingRequired,
  verifySignature,
} from './cursor-signing.js';
import { buildKeysetFilter } from './filter.js';

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
  version: number = 1,
  /** When set, the token carries an HMAC. See `./cursor-signing`. */
  secret?: CursorSecret,
): string {
  const primaryValue = readSortValue(doc, primaryField);
  const idValue = doc._id;

  // Build compound sort values for multi-field keyset
  const sortFields = Object.keys(sort).filter((k) => k !== '_id');
  const vals: Record<string, string | number | boolean | null> = {};
  const types: Record<string, ValueType> = {};
  for (const field of sortFields) {
    const value = readSortValue(doc, field);
    vals[field] = serializeValue(value);
    types[field] = getValueType(value);
  }

  const payload: CursorPayload = {
    v: serializeValue(primaryValue),
    t: getValueType(primaryValue),
    id: serializeValue(idValue) as string,
    idType: getValueType(idValue),
    sort,
    ver: version,
    ...(sortFields.length > 1 && { vals, types }),
  };

  /**
   * `base64url`, not `base64`: a cursor rides in `?after=`, and standard base64
   * puts `+` in it — which a query-string parser reads as a SPACE, so the token
   * fails to decode unless every client remembers to percent-encode it. The
   * URL-safe alphabet (`-` `_`, no padding) survives the round trip as-is, and
   * matches what `@classytic/repo-core`'s codec emits.
   *
   * Decoding accepts BOTH alphabets (Node's decoder does), so a token issued
   * before this change keeps working.
   */
  return attachSignature(
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    resolveCursorSecrets(secret),
  );
}

/**
 * Decodes a cursor token back into document values and sort metadata
 *
 * @param token - Base64-encoded cursor token
 * @returns Decoded cursor data
 * @throws Error if token is invalid or malformed
 */
export function decodeCursor(token: string, secret?: CursorSecret): DecodedCursor {
  // Integrity BEFORE parsing: a payload that failed to verify must never reach
  // the rehydrator, however well-formed it looks.
  const verified = verifySignature(token, resolveCursorSecrets(secret));

  let json: string;
  try {
    json = Buffer.from(verified, 'base64').toString('utf-8');
  } catch {
    throw new Error('Invalid cursor token: not valid base64');
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(json) as CursorPayload;
  } catch {
    throw new Error('Invalid cursor token: not valid JSON');
  }

  // Validate required payload structure
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('v' in payload) ||
    !('t' in payload) ||
    !('id' in payload) ||
    !('idType' in payload) ||
    !payload.sort ||
    typeof payload.sort !== 'object' ||
    typeof payload.ver !== 'number'
  ) {
    throw new Error('Invalid cursor token: malformed payload structure');
  }

  const VALID_TYPES: ValueType[] = [
    'date',
    'objectid',
    'boolean',
    'number',
    'string',
    'null',
    'unknown',
  ];
  if (!VALID_TYPES.includes(payload.t) || !VALID_TYPES.includes(payload.idType)) {
    throw new Error('Invalid cursor token: unrecognized value type');
  }

  try {
    // Rehydrate compound sort values if present
    let values: Record<string, unknown> | undefined;
    if (payload.vals && payload.types) {
      values = {};
      for (const [field, serialized] of Object.entries(payload.vals)) {
        values[field] = rehydrateValue(serialized, payload.types[field]);
      }
    }

    return {
      value: rehydrateValue(payload.v, payload.t),
      id: rehydrateValue(payload.id, payload.idType) as ObjectId | string,
      sort: payload.sort,
      version: payload.ver,
      ...(values && { values }),
    };
  } catch {
    throw new Error('Invalid cursor token: failed to rehydrate values');
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
 * Validates cursor version against the server's expected range.
 *
 * - Cursors newer than `expectedVersion` are rejected (client ahead of server).
 * - Cursors older than `minVersion` are rejected (client cached a cursor from
 *   a pre-breaking-change deploy). Default `minVersion = 1` keeps the legacy
 *   "accept anything <= expected" behavior; bump it when you ship a breaking
 *   cursor format change so old clients restart pagination cleanly instead of
 *   silently paginating from the wrong position.
 */
export function validateCursorVersion(
  cursorVersion: number,
  expectedVersion: number,
  minVersion: number = 1,
): void {
  if (cursorVersion > expectedVersion) {
    throw new Error(
      `Cursor version ${cursorVersion} is newer than expected version ${expectedVersion}. Please upgrade.`,
    );
  }
  if (cursorVersion < minVersion) {
    throw new Error(
      `Cursor version ${cursorVersion} is older than minimum supported ${minVersion}. Pagination must restart.`,
    );
  }
}

/**
 * Read a sort field off the last document of a page, following a dotted path.
 *
 * A sort key is a Mongo PATH (`metadata.progressPct`), and the query side has always
 * treated it as one: `buildKeysetFilter` emits `{ 'metadata.progressPct': { $lt } }`,
 * which Mongo resolves into the subdocument. The encode side read `doc[field]`, a
 * property named with a literal dot, which no document has. So a keyset sort on any
 * nested field encoded `v: null`, and page two came back through the null branch of
 * the filter: only rows whose sort field IS null, silently, with no error. Exported
 * for the unit test; not part of the public surface.
 */
export function readSortValue(doc: Record<string, unknown>, field: string): unknown {
  if (!field.includes('.')) return doc[field];
  let current: unknown = doc;
  for (const segment of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Serializes a value for cursor storage
 */
function serializeValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  return value as string | number | boolean;
}

/**
 * Gets the type identifier for a value
 */
function getValueType(value: unknown): ValueType {
  if (value === null || value === undefined) return 'null' as ValueType;
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
  if (type === ('null' as ValueType) || serialized === null) return null;
  switch (type) {
    case 'date':
      return new Date(serialized as string);
    case 'objectid':
      return new mongoose.Types.ObjectId(serialized as string);
    case 'boolean':
      return serialized === true || serialized === 'true';
    case 'number':
      return Number(serialized);
    default:
      return serialized;
  }
}

/**
 * Resolves cursor token into MongoDB query filters.
 * Shared by PaginationEngine.stream() and Repository.lookupPopulate() keyset path.
 *
 * Handles:
 * - Plain 24-char hex ObjectId strings (fallback cursor)
 * - Base64-encoded cursor tokens (standard cursor)
 * - Cursor version and sort validation
 */
export function resolveCursorFilter(
  after: string,
  sort: SortSpec,
  cursorVersion: number,
  baseFilters: Record<string, unknown> = {},
  minCursorVersion: number = 1,
  /**
   * Direction to build the predicate in, when it differs from the sort the
   * cursor was MINTED under. A backward walk (`before`) runs the query inverted
   * but must still validate the token against the caller's own sort — passing
   * the inverted sort as `sort` would reject every cursor as a sort mismatch.
   * Defaults to `sort`, so a forward walk is unchanged.
   */
  buildSort: SortSpec = sort,
  /** When set, every cursor must carry a valid HMAC. See `./cursor-signing`. */
  secret?: CursorSecret,
): Record<string, unknown> {
  const secrets = resolveCursorSecrets(secret);

  if (/^[a-f0-9]{24}$/i.test(after)) {
    /**
     * The bare-ObjectId fallback is an UNSIGNED position by construction, so a
     * deployment that signs must refuse it — otherwise the signature
     * requirement ships with a documented bypass: send a raw id instead of a
     * token and skip verification entirely.
     */
    if (signingRequired(secrets)) {
      throw new Error(
        'Invalid cursor token: this deployment signs cursors, so a bare ObjectId is not accepted as one',
      );
    }
    const objectId = new mongoose.Types.ObjectId(after);
    const idDirection = buildSort._id || -1;
    const idOperator = idDirection === 1 ? '$gt' : '$lt';
    return { ...baseFilters, _id: { [idOperator]: objectId } };
  }

  const cursor = decodeCursor(after, secret);
  validateCursorVersion(cursor.version, cursorVersion, minCursorVersion);
  // Validated against the minting sort, built in the walking direction.
  validateCursorSort(cursor.sort, sort);
  return buildKeysetFilter(baseFilters, buildSort, cursor.value, cursor.id, cursor.values);
}
