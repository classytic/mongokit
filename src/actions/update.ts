/**
 * Update Actions
 * Pure functions for document updates with optimizations
 */

import type { ClientSession, Model, PopulateOptions } from 'mongoose';
import type {
  AnyDocument,
  FindOneAndUpdateOptions,
  ObjectId,
  UpdateManyResult,
  UpdateOptions,
  UpdateWithValidationResult,
} from '../types.js';
import { createError } from '../utils/error.js';

function assertUpdatePipelineAllowed(update: unknown, updatePipeline?: boolean): void {
  if (Array.isArray(update) && updatePipeline !== true) {
    throw createError(
      400,
      'Update pipelines (array updates) are disabled by default; pass `{ updatePipeline: true }` to explicitly allow pipeline-style updates.',
    );
  }
}

/**
 * Parse populate specification into consistent format
 */
function parsePopulate(populate: unknown): (string | PopulateOptions)[] {
  if (!populate) return [];
  if (typeof populate === 'string') {
    return populate.split(',').map((p) => p.trim());
  }
  if (Array.isArray(populate)) {
    return populate.map((p) => (typeof p === 'string' ? p.trim() : (p as PopulateOptions)));
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
  options: UpdateOptions = {},
): Promise<TDoc> {
  assertUpdatePipelineAllowed(data, options.updatePipeline);
  const query = { _id: id, ...options.query };
  const document = await Model.findOneAndUpdate(query, data, {
    returnDocument: 'after',
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
    ...(options.arrayFilters ? { arrayFilters: options.arrayFilters } : {}),
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
  options: UpdateOptions = {},
): Promise<TDoc | null> {
  assertUpdatePipelineAllowed(data, options.updatePipeline);
  const query = { _id: id, ...constraints };

  const document = await Model.findOneAndUpdate(query, data, {
    returnDocument: 'after',
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
    ...(options.arrayFilters ? { arrayFilters: options.arrayFilters } : {}),
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
    data: Record<string, unknown>,
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
  options: UpdateOptions = {},
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

  // Fetch for validation — use findOne with options.query to respect tenant/policy filters
  const findQuery = { _id: id, ...options.query };
  const existing = await Model.findOne(findQuery)
    .select(options.select || '')
    .session(options.session ?? null)
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
  options: {
    session?: ClientSession;
    updatePipeline?: boolean;
    arrayFilters?: Record<string, unknown>[];
  } = {},
): Promise<UpdateManyResult> {
  assertUpdatePipelineAllowed(data, options.updatePipeline);
  const result = await Model.updateMany(query, data, {
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
    ...(options.arrayFilters ? { arrayFilters: options.arrayFilters } : {}),
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
  options: UpdateOptions = {},
): Promise<TDoc | null> {
  assertUpdatePipelineAllowed(data, options.updatePipeline);
  const document = await Model.findOneAndUpdate(query, data, {
    returnDocument: 'after',
    runValidators: true,
    session: options.session,
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
    ...(options.arrayFilters ? { arrayFilters: options.arrayFilters } : {}),
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
 * Atomic findOneAndUpdate primitive.
 *
 * Returns the matched document (post-update by default) or null when no doc
 * matches and `upsert` is false. Used by outbox relays, distributed locks,
 * and workflow semaphores that need compare-and-set in a single round-trip.
 */
export async function findOneAndUpdate<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  filter: Record<string, unknown>,
  update: Record<string, unknown> | Record<string, unknown>[],
  options: FindOneAndUpdateOptions = {},
): Promise<TDoc | null> {
  assertUpdatePipelineAllowed(update, options.updatePipeline);
  const returnDocument = options.returnDocument ?? 'after';
  const document = await Model.findOneAndUpdate(filter, update, {
    returnDocument,
    upsert: options.upsert ?? false,
    runValidators: options.runValidators ?? true,
    session: options.session,
    ...(options.sort ? { sort: options.sort } : {}),
    ...(options.arrayFilters ? { arrayFilters: options.arrayFilters } : {}),
    ...(options.collation ? { collation: options.collation } : {}),
    ...(options.maxTimeMS ? { maxTimeMS: options.maxTimeMS } : {}),
    ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
  })
    .select(options.select || '')
    .populate(parsePopulate(options.populate))
    .lean(options.lean ?? true);

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
  options: UpdateOptions = {},
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
  options: UpdateOptions = {},
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
  options: UpdateOptions = {},
): Promise<TDoc> {
  return update(Model, id, { $pull: { [field]: value } }, options);
}
