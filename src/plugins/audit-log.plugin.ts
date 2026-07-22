/**
 * Audit Log Plugin
 * Logs repository operations for auditing purposes
 */

import type { Logger } from '../types/plugin-options.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';

/**
 * Audit log plugin that logs all repository operations
 *
 * @example
 * const repo = new Repository(Model, [auditLogPlugin(console)]);
 *
 * Hot-path opt-out — skip per call by passing `skipPlugins: ['auditLog']`
 * in the operation options. The plugin honors the flag for every
 * listener it registers; security/correctness plugins (multi-tenant,
 * cache invalidation, soft-delete) deliberately do NOT honor it.
 */
const PLUGIN_NAME = 'auditLog';

/** True when the caller passed `skipPlugins: ['auditLog', ...]`. */
function isSkipped(context: RepositoryContext): boolean {
  const list = context.skipPlugins as readonly string[] | undefined;
  return Array.isArray(list) && list.includes(PLUGIN_NAME);
}

export function auditLogPlugin(logger: Logger): Plugin {
  return {
    name: PLUGIN_NAME,

    apply(repo: RepositoryInstance): void {
      repo.on(
        'after:create',
        ({ context, result }: { context: RepositoryContext; result: unknown }) => {
          if (isSkipped(context)) return;
          const idKey = ((repo as Record<string, unknown>).idField as string) || '_id';
          logger?.info?.('Document created', {
            model: context.model || repo.model,
            id: (result as Record<string, unknown>)?.[idKey],
            userId: context.user?._id || context.user?.id,
            organizationId: context.organizationId,
          });
        },
      );

      repo.on(
        'after:update',
        ({ context, result }: { context: RepositoryContext; result: unknown }) => {
          if (isSkipped(context)) return;
          logger?.info?.('Document updated', {
            model: context.model || repo.model,
            id:
              context.id ||
              (result as Record<string, unknown>)?.[
                ((repo as Record<string, unknown>).idField as string) || '_id'
              ],
            userId: context.user?._id || context.user?.id,
            organizationId: context.organizationId,
          });
        },
      );

      repo.on(
        'after:findOneAndUpdate',
        ({ context, result }: { context: RepositoryContext; result: unknown }) => {
          if (isSkipped(context)) return;
          if (!result) return; // null match — nothing to log
          logger?.info?.('Document upserted/updated (findOneAndUpdate)', {
            model: context.model || repo.model,
            id: (result as Record<string, unknown>)?.[
              ((repo as Record<string, unknown>).idField as string) || '_id'
            ],
            userId: context.user?._id || context.user?.id,
            organizationId: context.organizationId,
          });
        },
      );

      repo.on(
        'error:findOneAndUpdate',
        ({ context, error }: { context: RepositoryContext; error: Error }) => {
          if (isSkipped(context)) return;
          logger?.error?.('findOneAndUpdate failed', {
            model: context.model || repo.model,
            error: error.message,
            userId: context.user?._id || context.user?.id,
          });
        },
      );

      repo.on('after:delete', ({ context }: { context: RepositoryContext }) => {
        if (isSkipped(context)) return;
        logger?.info?.('Document deleted', {
          model: context.model || repo.model,
          id: context.id,
          userId: context.user?._id || context.user?.id,
          organizationId: context.organizationId,
        });
      });

      repo.on(
        'error:create',
        ({ context, error }: { context: RepositoryContext; error: Error }) => {
          if (isSkipped(context)) return;
          logger?.error?.('Create failed', {
            model: context.model || repo.model,
            error: error.message,
            userId: context.user?._id || context.user?.id,
          });
        },
      );

      repo.on(
        'error:update',
        ({ context, error }: { context: RepositoryContext; error: Error }) => {
          if (isSkipped(context)) return;
          logger?.error?.('Update failed', {
            model: context.model || repo.model,
            id: context.id,
            error: error.message,
            userId: context.user?._id || context.user?.id,
          });
        },
      );

      repo.on(
        'error:delete',
        ({ context, error }: { context: RepositoryContext; error: Error }) => {
          if (isSkipped(context)) return;
          logger?.error?.('Delete failed', {
            model: context.model || repo.model,
            id: context.id,
            error: error.message,
            userId: context.user?._id || context.user?.id,
          });
        },
      );
    },
  };
}
