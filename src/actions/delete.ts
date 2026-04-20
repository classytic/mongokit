/**
 * Delete Actions
 * Pure functions for document deletion
 */

import type { ClientSession, Model } from 'mongoose';
import type { AnyDocument, DeleteResult, ObjectId } from '../types.js';
import { createError } from '../utils/error.js';

/**
 * Delete by ID
 */
export async function deleteById<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: { session?: unknown; query?: Record<string, unknown> } = {},
): Promise<DeleteResult> {
  const query = { _id: id, ...options.query };
  const document = await Model.findOneAndDelete(query).session((options.session ?? null) as ClientSession | null);

  // MinimalRepo contract: miss → `{ success: false }`, not throw. A
  // second delete on the same id is a no-op, not an error.
  if (!document) {
    return { success: false, message: 'Document not found', id: String(id) };
  }

  return { success: true, message: 'Deleted successfully', id: String(id) };
}

/**
 * Delete many documents
 */
export async function deleteMany<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  options: { session?: unknown } = {},
): Promise<DeleteResult> {
  const result = await Model.deleteMany(query).session((options.session ?? null) as ClientSession | null);

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
  options: { session?: unknown; throwOnNotFound?: boolean } = {},
): Promise<DeleteResult> {
  const document = await Model.findOneAndDelete(query).session((options.session ?? null) as ClientSession | null);

  if (!document) {
    if (options.throwOnNotFound === true) {
      throw createError(404, 'Document not found');
    }
    return { success: false, message: 'Document not found' };
  }

  return {
    success: true,
    message: 'Deleted successfully',
    id: String(document._id),
  };
}

/**
 * Soft delete (set deleted flag)
 */
export async function softDelete<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: { session?: unknown; userId?: string } = {},
): Promise<DeleteResult> {
  const document = await Model.findByIdAndUpdate(
    id,
    {
      deleted: true,
      deletedAt: new Date(),
      deletedBy: options.userId,
    },
    { returnDocument: 'after', session: options.session as ClientSession | undefined },
  );

  if (!document) {
    throw createError(404, 'Document not found');
  }

  return {
    success: true,
    message: 'Soft deleted successfully',
    id: String(id),
    soft: true,
  };
}

/**
 * Restore soft deleted document
 */
export async function restore<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: { session?: unknown } = {},
): Promise<DeleteResult> {
  const document = await Model.findByIdAndUpdate(
    id,
    {
      deleted: false,
      deletedAt: null,
      deletedBy: null,
    },
    { returnDocument: 'after', session: options.session as ClientSession | undefined },
  );

  if (!document) {
    throw createError(404, 'Document not found');
  }

  return { success: true, message: 'Restored successfully', id: String(id) };
}
