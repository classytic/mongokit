/**
 * Error Utilities
 *
 * HTTP-compatible error creation for repository operations.
 * Handles Mongoose validation, cast, and MongoDB driver errors
 * with proper status codes and actionable messages.
 */

import type { HttpError } from '../types.js';

/**
 * Creates an error with HTTP status code
 *
 * @param status - HTTP status code
 * @param message - Error message
 * @returns Error with status property
 *
 * @example
 * throw createError(404, 'Document not found');
 * throw createError(400, 'Invalid input');
 * throw createError(403, 'Access denied');
 */
export function createError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

/** MongoDB driver error shape (E11000, write errors, etc.) */
interface MongoServerError extends Error {
  code?: number;
  keyPattern?: Record<string, number>;
  keyValue?: Record<string, unknown>;
}

/** Options for parseDuplicateKeyError */
export interface ParseDuplicateKeyOptions {
  /**
   * Include the offending values inline in the error message and under
   * `error.duplicate.values`. Default is `false` because those values can be
   * PII (emails, tokens, phone numbers) and end up in logs/crash reports.
   * Enable in dev or for trusted internal tools only.
   */
  exposeValues?: boolean;
}

/**
 * Detect and convert a MongoDB E11000 duplicate-key error into
 * a 409 HttpError with an actionable message.
 *
 * PII-safe by default: the error message lists only the conflicting field
 * names, never the values. Structured field names are attached under
 * `error.duplicate.fields` for downstream handlers. Pass
 * `{ exposeValues: true }` to opt into including the values (dev or trusted
 * server-to-server contexts only).
 *
 * Returns `null` when the error is not a duplicate-key error.
 */
export function parseDuplicateKeyError(
  error: unknown,
  options: ParseDuplicateKeyOptions = {},
): HttpError | null {
  if (!error || typeof error !== 'object') return null;
  const mongoErr = error as MongoServerError;
  if (mongoErr.code !== 11000) return null;

  const fields = mongoErr.keyPattern ? Object.keys(mongoErr.keyPattern) : [];
  const exposed = options.exposeValues === true;

  const valuesString =
    exposed && mongoErr.keyValue
      ? Object.entries(mongoErr.keyValue)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(', ')
      : '';

  const detail = fields.length
    ? `Duplicate value for ${fields.join(', ')}${valuesString ? ` (${valuesString})` : ''}`
    : 'Duplicate key error';

  const httpError = createError(409, detail);
  httpError.duplicate = {
    fields,
    ...(exposed && mongoErr.keyValue ? { values: { ...mongoErr.keyValue } } : {}),
  };
  return httpError;
}
