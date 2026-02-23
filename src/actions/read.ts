/**
 * Read Actions
 * Pure functions for document retrieval
 */

import type { Model, ClientSession, PopulateOptions } from "mongoose";
import { createError } from "../utils/error.js";
import type {
  AnyDocument,
  SelectSpec,
  PopulateSpec,
  SortSpec,
  OperationOptions,
  ObjectId,
  ReadPreferenceType,
} from "../types.js";

/**
 * Parse populate specification into consistent format
 */
function parsePopulate(
  populate: PopulateSpec | undefined,
): (string | PopulateOptions)[] {
  if (!populate) return [];
  if (typeof populate === "string") {
    return populate.split(",").map((p) => p.trim());
  }
  if (Array.isArray(populate)) {
    return populate.map((p) => (typeof p === "string" ? p.trim() : p));
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
  const query = options.query
    ? Model.findOne({ _id: id, ...options.query })
    : Model.findById(id);

  if (options.select) query.select(options.select);
  if (options.populate) query.populate(parsePopulate(options.populate));
  if (options.lean) query.lean();
  if (options.session) query.session(options.session);
  if (options.readPreference) query.read(options.readPreference);

  const document = await query.exec();
  if (!document && options.throwOnNotFound !== false) {
    throw createError(404, "Document not found");
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
  if (options.session) mongoQuery.session(options.session);
  if (options.readPreference) mongoQuery.read(options.readPreference);

  const document = await mongoQuery.exec();
  if (!document && options.throwOnNotFound !== false) {
    throw createError(404, "Document not found");
  }

  return document;
}

/**
 * Get document by query without throwing (returns null if not found)
 */
export async function tryGetByQuery<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  options: Omit<OperationOptions, "throwOnNotFound"> = {},
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
    session?: ClientSession;
    readPreference?: ReadPreferenceType;
  } = {},
) {
  let mongoQuery = Model.find(query);

  if (options.select) mongoQuery = mongoQuery.select(options.select);
  if (options.populate)
    mongoQuery = mongoQuery.populate(parsePopulate(options.populate));
  if (options.sort) mongoQuery = mongoQuery.sort(options.sort);
  if (options.limit) mongoQuery = mongoQuery.limit(options.limit);
  if (options.skip) mongoQuery = mongoQuery.skip(options.skip);

  mongoQuery = mongoQuery.lean(options.lean !== false) as any;
  if (options.session) mongoQuery = mongoQuery.session(options.session) as any;
  if (options.readPreference)
    mongoQuery = (mongoQuery as any).read(options.readPreference);

  return mongoQuery.exec() as Promise<TDoc[]>;
}

/**
 * Get or create document (upsert)
 */
export async function getOrCreate<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  createData: Record<string, unknown>,
  options: { session?: ClientSession; updatePipeline?: boolean } = {},
): Promise<TDoc | null> {
  return Model.findOneAndUpdate(
    query,
    { $setOnInsert: createData },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      session: options.session,
      ...(options.updatePipeline !== undefined
        ? { updatePipeline: options.updatePipeline }
        : {}),
    },
  );
}

/**
 * Count documents matching query
 */
export async function count(
  Model: Model<any>,
  query: Record<string, unknown> = {},
  options: {
    session?: ClientSession;
    readPreference?: ReadPreferenceType;
  } = {},
): Promise<number> {
  const q = Model.countDocuments(query).session(options.session ?? null);
  if (options.readPreference) q.read(options.readPreference);
  return q;
}

/**
 * Check if document exists
 */
export async function exists(
  Model: Model<any>,
  query: Record<string, unknown>,
  options: {
    session?: ClientSession;
    readPreference?: ReadPreferenceType;
  } = {},
): Promise<{ _id: unknown } | null> {
  const q = Model.exists(query).session(options.session ?? null);
  if (options.readPreference) q.read(options.readPreference);
  return q;
}
