/**
 * Soft Delete Plugin
 * Implements soft delete pattern - marks documents as deleted instead of removing
 */

import type { Plugin, RepositoryContext, RepositoryInstance, SoftDeleteOptions } from '../types.js';

/**
 * Soft delete plugin
 * 
 * @example
 * const repo = new Repository(Model, [
 *   softDeletePlugin({ deletedField: 'deletedAt' })
 * ]);
 */
export function softDeletePlugin(options: SoftDeleteOptions = {}): Plugin {
  const deletedField = options.deletedField || 'deletedAt';
  const deletedByField = options.deletedByField || 'deletedBy';

  return {
    name: 'softDelete',

    apply(repo: RepositoryInstance): void {
      repo.on('before:delete', async (context: RepositoryContext) => {
        if (options.soft !== false) {
          const updateData: Record<string, unknown> = {
            [deletedField]: new Date(),
          };

          if (context.user) {
            updateData[deletedByField] = context.user._id || context.user.id;
          }

          await repo.Model.findByIdAndUpdate(context.id, updateData, { session: context.session });

          (context as Record<string, unknown>).softDeleted = true;
        }
      });

      repo.on('before:getAll', (context: RepositoryContext) => {
        if (!context.includeDeleted && options.soft !== false) {
          const queryParams = (context as Record<string, unknown>).queryParams as Record<string, unknown> || {};
          queryParams.filters = {
            ...((queryParams.filters as Record<string, unknown>) || {}),
            [deletedField]: { $exists: false },
          };
          (context as Record<string, unknown>).queryParams = queryParams;
        }
      });

      repo.on('before:getById', (context: RepositoryContext) => {
        if (!context.includeDeleted && options.soft !== false) {
          context.query = {
            ...(context.query || {}),
            [deletedField]: { $exists: false },
          };
        }
      });
    },
  };
}

export default softDeletePlugin;
