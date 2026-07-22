/**
 * Delete Actions
 * Pure functions for document deletion
 */

import type { ClientSession, Model } from 'mongoose';
import type { AnyDocument, ObjectId } from '../types/core.js';
import type { DeleteResult } from '../types/operations.js';
import { createError } from '../utils/error.js';

/**
 * Delete by ID. Returns `null` on miss (matches `update()` convention) —
 * a second delete on the same id is a no-op, not an error.
 */
export async function deleteById<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: { session?: unknown; query?: Record<string, unknown> } = {},
): Promise<DeleteResult | null> {
  const query = { _id: id, ...options.query };
  const document = await Model.findOneAndDelete(query).session(
    (options.session ?? null) as ClientSession | null,
  );

  if (!document) return null;

  return { message: 'Deleted successfully', id: String(id) };
}

/**
 * Delete many documents. Always returns a {@link DeleteResult} (never
 * null) — a deleteMany with zero matches is a successful op with
 * `count: 0`, not a miss.
 */
export async function deleteMany<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  options: { session?: unknown } = {},
): Promise<DeleteResult> {
  const result = await Model.deleteMany(query).session(
    (options.session ?? null) as ClientSession | null,
  );

  return {
    count: result.deletedCount,
    message: 'Deleted successfully',
  };
}

/**
 * Delete by query. Returns `null` on miss unless `throwOnNotFound: true`.
 */
export async function deleteByQuery(
  Model: Model<any>,
  query: Record<string, unknown>,
  options: { session?: unknown; throwOnNotFound?: boolean } = {},
): Promise<DeleteResult | null> {
  const document = await Model.findOneAndDelete(query).session(
    (options.session ?? null) as ClientSession | null,
  );

  if (!document) {
    if (options.throwOnNotFound === true) {
      throw createError(404, 'Document not found');
    }
    return null;
  }

  return {
    message: 'Deleted successfully',
    id: String(document._id),
  };
}

/**
 * Soft delete (set deleted flag). Returns `null` on miss for parity with
 * `deleteById`; callers that prefer a throw can wrap or use `throwOnNotFound`
 * pattern at the call site.
 */
export async function softDelete<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: { session?: unknown; userId?: string } = {},
): Promise<DeleteResult | null> {
  const document = await Model.findByIdAndUpdate(
    id,
    {
      deleted: true,
      deletedAt: new Date(),
      deletedBy: options.userId,
    },
    { returnDocument: 'after', session: options.session as ClientSession | undefined },
  );

  if (!document) return null;

  return {
    message: 'Soft deleted successfully',
    id: String(id),
    soft: true,
  };
}

/**
 * Restore soft-deleted document. Returns `null` on miss.
 */
export async function restore<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  id: string | ObjectId,
  options: { session?: unknown } = {},
): Promise<DeleteResult | null> {
  const document = await Model.findByIdAndUpdate(
    id,
    {
      deleted: false,
      deletedAt: null,
      deletedBy: null,
    },
    { returnDocument: 'after', session: options.session as ClientSession | undefined },
  );

  if (!document) return null;

  return { message: 'Restored successfully', id: String(id) };
}
