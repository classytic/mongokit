/**
 * Audit Log Plugin
 * Logs repository operations for auditing purposes
 */

import type { Plugin, RepositoryContext, RepositoryInstance, Logger } from '../types.js';

/**
 * Audit log plugin that logs all repository operations
 * 
 * @example
 * const repo = new Repository(Model, [auditLogPlugin(console)]);
 */
export function auditLogPlugin(logger: Logger): Plugin {
  return {
    name: 'auditLog',

    apply(repo: RepositoryInstance): void {
      repo.on('after:create', ({ context, result }: { context: RepositoryContext; result: unknown }) => {
        logger?.info?.('Document created', {
          model: context.model || repo.model,
          id: (result as Record<string, unknown>)?._id,
          userId: context.user?._id || context.user?.id,
          organizationId: context.organizationId,
        });
      });

      repo.on('after:update', ({ context, result }: { context: RepositoryContext; result: unknown }) => {
        logger?.info?.('Document updated', {
          model: context.model || repo.model,
          id: context.id || (result as Record<string, unknown>)?._id,
          userId: context.user?._id || context.user?.id,
          organizationId: context.organizationId,
        });
      });

      repo.on('after:delete', ({ context }: { context: RepositoryContext }) => {
        logger?.info?.('Document deleted', {
          model: context.model || repo.model,
          id: context.id,
          userId: context.user?._id || context.user?.id,
          organizationId: context.organizationId,
        });
      });

      repo.on('error:create', ({ context, error }: { context: RepositoryContext; error: Error }) => {
        logger?.error?.('Create failed', {
          model: context.model || repo.model,
          error: error.message,
          userId: context.user?._id || context.user?.id,
        });
      });

      repo.on('error:update', ({ context, error }: { context: RepositoryContext; error: Error }) => {
        logger?.error?.('Update failed', {
          model: context.model || repo.model,
          id: context.id,
          error: error.message,
          userId: context.user?._id || context.user?.id,
        });
      });

      repo.on('error:delete', ({ context, error }: { context: RepositoryContext; error: Error }) => {
        logger?.error?.('Delete failed', {
          model: context.model || repo.model,
          id: context.id,
          error: error.message,
          userId: context.user?._id || context.user?.id,
        });
      });
    },
  };
}

export default auditLogPlugin;
