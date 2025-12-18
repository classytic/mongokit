/**
 * Delete Actions
 * Pure functions for document deletion
 */

import type { Model, ClientSession } from 'mongoose';
import { createError } from '../utils/error.js';
import type { DeleteResult, AnyDocument, ObjectId } from '../types.js';

/**
 * Delete by ID
 */
export async function deleteById(
  Model: Model<any>,
  id: string | ObjectId,
  options: { session?: ClientSession } = {}
): Promise<DeleteResult> {
  const document = await Model.findByIdAndDelete(id).session(options.session ?? null);

  if (!document) {
    throw createError(404, 'Document not found');
  }

  return { success: true, message: 'Deleted successfully' };
}

/**
 * Delete many documents
 */
export async function deleteMany(
  Model: Model<any>,
  query: Record<string, unknown>,
  options: { session?: ClientSession } = {}
): Promise<DeleteResult> {
  const result = await Model.deleteMany(query).session(options.session ?? null);

  return {
    success: true,
    count: result.deletedCount,
    message: 'Deleted successfully',
  };
}

/**
 * Delete by query
 */
export async function deleteByQuery(
  Model: Model<any>,
  query: Record<string, unknown>,
  options: { session?: ClientSession; throwOnNotFound?: boolean } = {}
): Promise<DeleteResult> {
  const document = await Model.findOneAndDelete(query).session(options.session ?? null);

  if (!document && options.throwOnNotFound !== false) {
    throw createError(404, 'Document not found');
  }

  return { success: true, message: 'Deleted successfully' };
}

/**
 * Soft delete (set deleted flag)
 */
export async function softDelete<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: { session?: ClientSession; userId?: string } = {}
): Promise<DeleteResult> {
  const document = await Model.findByIdAndUpdate(
    id,
    {
      deleted: true,
      deletedAt: new Date(),
      deletedBy: options.userId,
    },
    { new: true, session: options.session }
  );

  if (!document) {
    throw createError(404, 'Document not found');
  }

  return { success: true, message: 'Soft deleted successfully' };
}

/**
 * Restore soft deleted document
 */
export async function restore<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: { session?: ClientSession } = {}
): Promise<DeleteResult> {
  const document = await Model.findByIdAndUpdate(
    id,
    {
      deleted: false,
      deletedAt: null,
      deletedBy: null,
    },
    { new: true, session: options.session }
  );

  if (!document) {
    throw createError(404, 'Document not found');
  }

  return { success: true, message: 'Restored successfully' };
}
