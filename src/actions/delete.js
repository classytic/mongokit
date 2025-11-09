/**
 * Delete Actions
 * Pure functions for document deletion
 */

import createError from 'http-errors';

/**
 * Delete by ID
 */
export async function deleteById(Model, id, options = {}) {
  const document = await Model.findByIdAndDelete(id).session(options.session);

  if (!document) {
    throw createError(404, 'Document not found');
  }

  return { success: true, message: 'Deleted successfully' };
}

/**
 * Delete many documents
 */
export async function deleteMany(Model, query, options = {}) {
  const result = await Model.deleteMany(query).session(options.session);

  return {
    success: true,
    count: result.deletedCount,
    message: 'Deleted successfully',
  };
}

/**
 * Delete by query
 */
export async function deleteByQuery(Model, query, options = {}) {
  const document = await Model.findOneAndDelete(query).session(options.session);

  if (!document && options.throwOnNotFound !== false) {
    throw createError(404, 'Document not found');
  }

  return { success: true, message: 'Deleted successfully' };
}

/**
 * Soft delete (set deleted flag)
 */
export async function softDelete(Model, id, options = {}) {
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
export async function restore(Model, id, options = {}) {
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

