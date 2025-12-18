/**
 * Batch Operations Plugin
 * Adds bulk update/delete operations with proper event emission
 */

import type { ClientSession } from 'mongoose';
import { createError } from '../utils/error.js';
import type { Plugin, RepositoryInstance, RepositoryContext, HttpError } from '../types.js';

/**
 * Batch operations plugin
 * 
 * @example
 * const repo = new Repository(Model, [
 *   methodRegistryPlugin(),
 *   batchOperationsPlugin(),
 * ]);
 * 
 * await repo.updateMany({ status: 'pending' }, { status: 'active' });
 * await repo.deleteMany({ status: 'deleted' });
 */
export function batchOperationsPlugin(): Plugin {
  return {
    name: 'batch-operations',

    apply(repo: RepositoryInstance): void {
      if (!repo.registerMethod) {
        throw new Error('batchOperationsPlugin requires methodRegistryPlugin');
      }

      /**
       * Update multiple documents
       */
      repo.registerMethod('updateMany', async function (
        this: RepositoryInstance,
        query: Record<string, unknown>,
        data: Record<string, unknown>,
        options: { session?: ClientSession; updatePipeline?: boolean } = {}
      ) {
        const _buildContext = (this as Record<string, Function>)._buildContext;
        const context = await _buildContext.call(this, 'updateMany', { query, data, options }) as RepositoryContext;

        try {
          this.emit('before:updateMany', context);

          if (Array.isArray(data) && options.updatePipeline !== true) {
            throw createError(
              400,
              'Update pipelines (array updates) are disabled by default; pass `{ updatePipeline: true }` to explicitly allow pipeline-style updates.'
            );
          }

          const result = await this.Model.updateMany(query, data, {
            runValidators: true,
            session: options.session,
            ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
          }).exec();

          this.emit('after:updateMany', { context, result });
          return result;
        } catch (error) {
          this.emit('error:updateMany', { context, error });
          const _handleError = (this as Record<string, Function>)._handleError;
          throw _handleError.call(this, error as Error) as HttpError;
        }
      });

      /**
       * Delete multiple documents
       */
      repo.registerMethod('deleteMany', async function (
        this: RepositoryInstance,
        query: Record<string, unknown>,
        options: Record<string, unknown> = {}
      ) {
        const _buildContext = (this as Record<string, Function>)._buildContext;
        const context = await _buildContext.call(this, 'deleteMany', { query, options }) as RepositoryContext;

        try {
          this.emit('before:deleteMany', context);

          const result = await this.Model.deleteMany(query, {
            session: options.session as ClientSession | undefined,
          }).exec();

          this.emit('after:deleteMany', { context, result });
          return result;
        } catch (error) {
          this.emit('error:deleteMany', { context, error });
          const _handleError = (this as Record<string, Function>)._handleError;
          throw _handleError.call(this, error as Error) as HttpError;
        }
      });
    },
  };
}

export default batchOperationsPlugin;
