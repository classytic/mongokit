/**
 * Update Actions
 * Pure functions for document updates with optimizations
 */

import type { Model, ClientSession, PopulateOptions } from 'mongoose';
import { createError } from '../utils/error.js';
import type { AnyDocument, UpdateOptions, UpdateManyResult, UpdateWithValidationResult, ObjectId } from '../types.js';

function assertUpdatePipelineAllowed(update: unknown, updatePipeline?: boolean): void {
  if (Array.isArray(update) && updatePipeline !== true) {
    throw createError(
      400,
      'Update pipelines (array updates) are disabled by default; pass `{ updatePipeline: true }` to explicitly allow pipeline-style updates.'
    );
  }
}

/**
 * Parse populate specification into consistent format
 */
function parsePopulate(populate: unknown): (string | PopulateOptions)[] {
  if (!populate) return [];
  if (typeof populate === 'string') {
    return populate.split(',').map(p => p.trim());
  }
  if (Array.isArray(populate)) {
    return populate.map(p => typeof p === 'string' ? p.trim() : p as PopulateOptions);
  }
  return [populate as PopulateOptions];
}

/**
 * Update by ID
 */
export async function update<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  data: Record<string, unknown>,
  options: UpdateOptions = {}
): Promise<TDoc> {
  assertUpdatePipelineAllowed(data, options.updatePipeline);
  const document = await Model.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
  })
    .select(options.select || '')
    .populate(parsePopulate(options.populate))
    .lean(options.lean ?? false);

  if (!document) {
    throw createError(404, 'Document not found');
  }

  return document as TDoc;
}

/**
 * Update with query constraints (optimized)
 * Returns null if constraints not met (not an error)
 */
export async function updateWithConstraints<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  data: Record<string, unknown>,
  constraints: Record<string, unknown> = {},
  options: UpdateOptions = {}
): Promise<TDoc | null> {
  assertUpdatePipelineAllowed(data, options.updatePipeline);
  const query = { _id: id, ...constraints };

  const document = await Model.findOneAndUpdate(query, data, {
    new: true,
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
  })
    .select(options.select || '')
    .populate(parsePopulate(options.populate))
    .lean(options.lean ?? false);

  return document as TDoc | null;
}

/**
 * Validation options for smart update
 */
interface ValidationOptions {
  buildConstraints?: (data: Record<string, unknown>) => Record<string, unknown>;
  validateUpdate?: (
    existing: Record<string, unknown>,
    data: Record<string, unknown>
  ) => { valid: boolean; message?: string; violations?: Array<{ field: string; reason: string }> };
}

/**
 * Update with validation (smart optimization)
 * 1-query on success, 2-queries for detailed errors
 */
export async function updateWithValidation<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  data: Record<string, unknown>,
  validationOptions: ValidationOptions = {},
  options: UpdateOptions = {}
): Promise<UpdateWithValidationResult<TDoc>> {
  const { buildConstraints, validateUpdate } = validationOptions;

  assertUpdatePipelineAllowed(data, options.updatePipeline);

  // Try optimized update with constraints
  if (buildConstraints) {
    const constraints = buildConstraints(data);
    const document = await updateWithConstraints(Model, id, data, constraints, options);

    if (document) {
      return { success: true, data: document };
    }
  }

  // Fetch for validation
  const existing = await Model.findById(id).select(options.select || '').lean();

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
    const validation = validateUpdate(existing as Record<string, unknown>, data);
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
export async function updateMany(
  Model: Model<unknown>,
  query: Record<string, unknown>,
  data: Record<string, unknown>,
  options: { session?: ClientSession; updatePipeline?: boolean } = {}
): Promise<UpdateManyResult> {
  assertUpdatePipelineAllowed(data, options.updatePipeline);
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
export async function updateByQuery<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  data: Record<string, unknown>,
  options: UpdateOptions = {}
): Promise<TDoc | null> {
  assertUpdatePipelineAllowed(data, options.updatePipeline);
  const document = await Model.findOneAndUpdate(query, data, {
    new: true,
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
  })
    .select(options.select || '')
    .populate(parsePopulate(options.populate))
    .lean(options.lean ?? false);

  if (!document && options.throwOnNotFound !== false) {
    throw createError(404, 'Document not found');
  }

  return document as TDoc | null;
}

/**
 * Increment field
 */
export async function increment<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  field: string,
  value: number = 1,
  options: UpdateOptions = {}
): Promise<TDoc> {
  return update(Model, id, { $inc: { [field]: value } }, options);
}

/**
 * Push to array
 */
export async function pushToArray<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  field: string,
  value: unknown,
  options: UpdateOptions = {}
): Promise<TDoc> {
  return update(Model, id, { $push: { [field]: value } }, options);
}

/**
 * Pull from array
 */
export async function pullFromArray<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  field: string,
  value: unknown,
  options: UpdateOptions = {}
): Promise<TDoc> {
  return update(Model, id, { $pull: { [field]: value } }, options);
}
