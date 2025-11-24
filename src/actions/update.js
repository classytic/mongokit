/**
 * Update Actions
 * Pure functions for document updates with optimizations
 */

import { createError } from '../utils/error.js';

/**
 * Update by ID
 */
export async function update(Model, id, data, options = {}) {
  const document = await Model.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
  })
    .select(options.select)
    .populate(parsePopulate(options.populate))
    .lean(options.lean);

  if (!document) {
    throw createError(404, 'Document not found');
  }

  return document;
}

/**
 * Update with query constraints (optimized)
 * Returns null if constraints not met (not an error)
 */
export async function updateWithConstraints(Model, id, data, constraints = {}, options = {}) {
  const query = { _id: id, ...constraints };

  const document = await Model.findOneAndUpdate(query, data, {
    new: true,
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
  })
    .select(options.select)
    .populate(parsePopulate(options.populate))
    .lean(options.lean);

  return document;
}

/**
 * Update with validation (smart optimization)
 * 1-query on success, 2-queries for detailed errors
 */
export async function updateWithValidation(
  Model,
  id,
  data,
  validationOptions = {},
  options = {}
) {
  const { buildConstraints, validateUpdate } = validationOptions;

  // Try optimized update with constraints
  if (buildConstraints) {
    const constraints = buildConstraints(data);
    const document = await updateWithConstraints(Model, id, data, constraints, options);

    if (document) {
      return { success: true, data: document };
    }
  }

  // Fetch for validation
  const existing = await Model.findById(id)
    .select(options.select)
    .lean();

  if (!existing) {
    return {
      success: false,
      error: {
        code: 404,
        message: 'Document not found',
      },
    };
  }

  // Run custom validation
  if (validateUpdate) {
    const validation = validateUpdate(existing, data);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          code: 403,
          message: validation.message || 'Update not allowed',
          violations: validation.violations,
        },
      };
    }
  }

  // Validation passed - perform update
  const updated = await update(Model, id, data, options);
  return { success: true, data: updated };
}

/**
 * Update many documents
 */
export async function updateMany(Model, query, data, options = {}) {
  const result = await Model.updateMany(query, data, {
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
  });

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  };
}

/**
 * Update by query
 */
export async function updateByQuery(Model, query, data, options = {}) {
  const document = await Model.findOneAndUpdate(query, data, {
    new: true,
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
  })
    .select(options.select)
    .populate(parsePopulate(options.populate))
    .lean(options.lean);

  if (!document && options.throwOnNotFound !== false) {
    throw createError(404, 'Document not found');
  }

  return document;
}

/**
 * Increment field
 */
export async function increment(Model, id, field, value = 1, options = {}) {
  return update(Model, id, { $inc: { [field]: value } }, options);
}

/**
 * Push to array
 */
export async function pushToArray(Model, id, field, value, options = {}) {
  return update(Model, id, { $push: { [field]: value } }, options);
}

/**
 * Pull from array
 */
export async function pullFromArray(Model, id, field, value, options = {}) {
  return update(Model, id, { $pull: { [field]: value } }, options);
}

// Utilities
function parsePopulate(populate) {
  if (!populate) return [];
  if (typeof populate === 'string') {
    return populate.split(',').map(p => p.trim());
  }
  if (Array.isArray(populate)) {
    return populate.map(p => typeof p === 'string' ? p.trim() : p);
  }
  return [populate];
}

