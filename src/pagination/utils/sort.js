/**
 * Normalizes sort object to ensure stable key order
 * Primary fields first, _id last (not alphabetical)
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @returns {Record<string, 1|-1>} Normalized sort with stable key order
 */
export function normalizeSort(sort) {
  /** @type {Record<string, 1|-1>} */
  const normalized = {};

  Object.keys(sort).forEach(key => {
    if (key !== '_id') normalized[key] = sort[key];
  });

  if (sort._id !== undefined) {
    normalized._id = sort._id;
  }

  return normalized;
}

/**
 * Validates and normalizes sort for keyset pagination
 * Auto-adds _id tie-breaker if needed
 * Ensures _id direction matches primary field
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @returns {Record<string, 1|-1>} Validated and normalized sort
 * @throws {Error} If sort is invalid for keyset pagination
 */
export function validateKeysetSort(sort) {
  const keys = Object.keys(sort);

  if (keys.length === 1 && keys[0] !== '_id') {
    const field = keys[0];
    const direction = sort[field];
    return normalizeSort({ [field]: direction, _id: direction });
  }

  if (keys.length === 1 && keys[0] === '_id') {
    return normalizeSort(sort);
  }

  if (keys.length === 2) {
    if (!keys.includes('_id')) {
      throw new Error('Keyset pagination requires _id as tie-breaker');
    }

    const primaryField = keys.find(k => k !== '_id');
    const primaryDirection = sort[primaryField];
    const idDirection = sort._id;

    if (primaryDirection !== idDirection) {
      throw new Error('_id direction must match primary field direction');
    }

    return normalizeSort(sort);
  }

  throw new Error('Keyset pagination only supports single field + _id');
}

/**
 * Inverts sort directions (1 becomes -1, -1 becomes 1)
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @returns {Record<string, 1|-1>} Inverted sort
 */
export function invertSort(sort) {
  /** @type {Record<string, 1|-1>} */
  const inverted = {};

  Object.keys(sort).forEach(key => {
    inverted[key] = sort[key] === 1 ? -1 : 1;
  });

  return inverted;
}

/**
 * Extracts primary sort field (first non-_id field)
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @returns {string} Primary field name
 */
export function getPrimaryField(sort) {
  const keys = Object.keys(sort);
  return keys.find(k => k !== '_id') || '_id';
}

/**
 * Gets sort direction for a specific field
 *
 * @param {Record<string, 1|-1>} sort - Sort specification
 * @param {string} field - Field name
 * @returns {1|-1|undefined} Sort direction
 */
export function getDirection(sort, field) {
  return sort[field];
}
