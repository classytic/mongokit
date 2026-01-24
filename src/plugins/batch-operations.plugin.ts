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

/**
 * Type interface for repositories using batchOperationsPlugin
 *
 * @example
 * ```typescript
 * import { Repository, methodRegistryPlugin, batchOperationsPlugin } from '@classytic/mongokit';
 * import type { BatchOperationsMethods } from '@classytic/mongokit';
 *
 * class ProductRepo extends Repository<IProduct> {}
 *
 * type ProductRepoWithBatch = ProductRepo & BatchOperationsMethods;
 *
 * const repo = new ProductRepo(ProductModel, [
 *   methodRegistryPlugin(),
 *   batchOperationsPlugin(),
 * ]) as ProductRepoWithBatch;
 *
 * // TypeScript autocomplete works!
 * await repo.updateMany({ status: 'pending' }, { status: 'active' });
 * await repo.deleteMany({ status: 'archived' });
 * ```
 */
export interface BatchOperationsMethods {
  /**
   * Update multiple documents matching the query
   * @param query - Query to match documents
   * @param data - Update data
   * @param options - Operation options
   * @returns Update result with matchedCount, modifiedCount, etc.
   */
  updateMany(
    query: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: { session?: ClientSession; updatePipeline?: boolean }
  ): Promise<{ acknowledged: boolean; matchedCount: number; modifiedCount: number; upsertedCount: number; upsertedId: unknown }>;

  /**
   * Delete multiple documents matching the query
   * @param query - Query to match documents
   * @param options - Operation options
   * @returns Delete result with deletedCount
   */
  deleteMany(
    query: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;
}

export default batchOperationsPlugin;
