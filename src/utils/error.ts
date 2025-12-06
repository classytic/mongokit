/**
 * Error Utilities
 * 
 * HTTP-compatible error creation for repository operations
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
