/**
 * Creates an error with HTTP status code
 *
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @returns {Error & {status: number}} Error with status property
 */
export function createError(status, message) {
  const error = /** @type {Error & {status: number}} */ (new Error(message));
  error.status = status;
  return error;
}
