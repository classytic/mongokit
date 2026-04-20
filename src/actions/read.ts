/**
 * Read Actions
 * Pure functions for document retrieval
 */

import type { ClientSession, Model, PopulateOptions } from 'mongoose';
import type {
  AnyDocument,
  ObjectId,
  OperationOptions,
  PopulateSpec,
  ReadPreferenceType,
  SelectSpec,
  SortSpec,
} from '../types.js';
import { createError } from '../utils/error.js';

/**
 * Parse populate specification into consistent format
 */
function parsePopulate(populate: PopulateSpec | undefined): (string | PopulateOptions)[] {
  if (!populate) return [];
  if (typeof populate === 'string') {
    return populate.split(',').map((p) => p.trim());
  }
  if (Array.isArray(populate)) {
    return populate.map((p) => (typeof p === 'string' ? p.trim() : p));
  }
  return [populate];
}

/**
 * Get document by ID
 *
 * @param Model - Mongoose model
 * @param id - Document ID
 * @param options - Query options
 * @returns Document or null
 * @throws Error if document not found and throwOnNotFound is true
 */
export async function getById<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: OperationOptions = {},
): Promise<TDoc | null> {
  // If additional query filters are provided (e.g., soft delete filter), use findOne
  const query = options.query ? Model.findOne({ _id: id, ...options.query }) : Model.findById(id);

  if (options.select) query.select(options.select);
  if (options.populate) query.populate(parsePopulate(options.populate));
  if (options.lean) query.lean();
  if (options.session) query.session(options.session as ClientSession);
  if (options.readPreference) query.read(options.readPreference);

  const document = await query.exec();
  // MinimalRepo contract: miss is not an error. Callers who prefer
  // throw-on-miss (legacy pattern) pass `throwOnNotFound: true` explicitly.
  if (!document && options.throwOnNotFound === true) {
    throw createError(404, 'Document not found');
  }

  return document;
}

/**
 * Get document by query
 *
 * @param Model - Mongoose model
 * @param query - MongoDB query
 * @param options - Query options
 * @returns Document or null
 * @throws Error if document not found and throwOnNotFound is true
 */
export async function getByQuery<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  options: OperationOptions = {},
): Promise<TDoc | null> {
  const mongoQuery = Model.findOne(query);

  if (options.select) mongoQuery.select(options.select);
  if (options.populate) mongoQuery.populate(parsePopulate(options.populate));
  if (options.lean) mongoQuery.lean();
  if (options.session) mongoQuery.session(options.session as ClientSession);
  if (options.readPreference) mongoQuery.read(options.readPreference);

  const document = await mongoQuery.exec();
  if (!document && options.throwOnNotFound === true) {
    throw createError(404, 'Document not found');
  }

  return document;
}

/**
 * Get document by query without throwing (returns null if not found)
 */
export async function tryGetByQuery<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  options: Omit<OperationOptions, 'throwOnNotFound'> = {},
): Promise<TDoc | null> {
  return getByQuery(Model, query, { ...options, throwOnNotFound: false });
}

/**
 * Get all documents (basic query without pagination)
 * For pagination, use Repository.paginate() or Repository.stream()
 */
export async function getAll<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown> = {},
  options: {
    select?: SelectSpec;
    populate?: PopulateSpec;
    sort?: SortSpec;
    limit?: number;
    skip?: number;
    lean?: boolean;
    session?: unknown;
    readPreference?: ReadPreferenceType;
  } = {},
) {
  let mongoQuery = Model.find(query);

  if (options.select) mongoQuery = mongoQuery.select(options.select);
  if (options.populate) mongoQuery = mongoQuery.populate(parsePopulate(options.populate));
  if (options.sort) mongoQuery = mongoQuery.sort(options.sort);
  if (options.limit) mongoQuery = mongoQuery.limit(options.limit);
  if (options.skip) mongoQuery = mongoQuery.skip(options.skip);

  // Mongoose 9: .lean() changes return type from Document to POJO —
  // the `as typeof mongoQuery` cast is needed because the generic
  // chain type cannot express the lean transform at compile time.
  if (options.lean !== false) mongoQuery = mongoQuery.lean() as typeof mongoQuery;
  if (options.session) mongoQuery = mongoQuery.session(options.session as ClientSession);
  if (options.readPreference) mongoQuery = mongoQuery.read(options.readPreference);

  return mongoQuery.exec() as Promise<TDoc[]>;
}

/**
 * Get or create document (upsert)
 */
export async function getOrCreate<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  createData: Record<string, unknown>,
  options: { session?: unknown; updatePipeline?: boolean } = {},
): Promise<TDoc | null> {
  return Model.findOneAndUpdate(
    query,
    { $setOnInsert: createData },
    {
      upsert: true,
      returnDocument: 'after',
      runValidators: true,
      session: options.session as ClientSession | undefined,
      ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
    },
  );
}

/**
 * Count documents matching query
 */
export async function count<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown> = {},
  options: {
    session?: unknown;
    readPreference?: ReadPreferenceType;
  } = {},
): Promise<number> {
  const q = Model.countDocuments(query).session((options.session ?? null) as ClientSession | null);
  if (options.readPreference) q.read(options.readPreference);
  return q;
}

/**
 * Check if document exists
 */
export async function exists<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  options: {
    session?: unknown;
    readPreference?: ReadPreferenceType;
  } = {},
): Promise<{ _id: unknown } | null> {
  const q = Model.exists(query).session((options.session ?? null) as ClientSession | null);
  if (options.readPreference) q.read(options.readPreference);
  return q;
}
