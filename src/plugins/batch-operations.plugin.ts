/**
 * Batch Operations Plugin
 * Adds bulk update/delete operations with proper event emission
 */

import type { ClientSession } from 'mongoose';
import type { HttpError, Plugin, RepositoryContext, RepositoryInstance } from '../types.js';
import { createError } from '../utils/error.js';

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
      repo.registerMethod(
        'updateMany',
        async function (
          this: RepositoryInstance,
          query: Record<string, unknown>,
          data: Record<string, unknown>,
          options: {
            session?: unknown;
            updatePipeline?: boolean;
            [key: string]: unknown;
          } = {},
        ) {
          // Spread options into context so policy plugins (multi-tenant) can read tenant ID at top level
          const context = (await this._buildContext('updateMany', {
            query,
            data,
            ...options,
          })) as RepositoryContext;

          try {
            // Use context.query — policy hooks (multi-tenant) may have injected tenant filters
            const finalQuery = (context.query || query) as Record<string, unknown>;

            if (!finalQuery || Object.keys(finalQuery).length === 0) {
              throw createError(
                400,
                'updateMany requires a non-empty query filter. Pass an explicit filter to prevent accidental mass updates.',
              );
            }

            if (Array.isArray(data) && options.updatePipeline !== true) {
              throw createError(
                400,
                'Update pipelines (array updates) are disabled by default; pass `{ updatePipeline: true }` to explicitly allow pipeline-style updates.',
              );
            }

            // Use context.data if hooks modified the update payload, otherwise original data
            const finalData = context.data || data;

            const result = await this.Model.updateMany(finalQuery, finalData, {
              runValidators: true,
              session: options.session as ClientSession | undefined,
              ...(options.updatePipeline !== undefined
                ? { updatePipeline: options.updatePipeline }
                : {}),
            }).exec();

            await this.emitAsync('after:updateMany', { context, result });
            return result;
          } catch (error) {
            this.emit('error:updateMany', { context, error });
            throw this._handleError(error as Error) as HttpError;
          }
        },
      );

      /**
       * Execute heterogeneous bulk write operations in a single database call.
       *
       * Supports insertOne, updateOne, updateMany, deleteOne, deleteMany, and replaceOne
       * operations mixed together for maximum efficiency.
       *
       * @example
       * await repo.bulkWrite([
       *   { insertOne: { document: { name: 'New Item', price: 10 } } },
       *   { updateOne: { filter: { _id: id1 }, update: { $inc: { views: 1 } } } },
       *   { updateMany: { filter: { status: 'draft' }, update: { $set: { status: 'published' } } } },
       *   { deleteOne: { filter: { _id: id2 } } },
       * ]);
       */
      repo.registerMethod(
        'bulkWrite',
        async function (
          this: RepositoryInstance,
          operations: Record<string, unknown>[],
          options: { session?: unknown; ordered?: boolean; [key: string]: unknown } = {},
        ) {
          // Spread options into context so policy plugins (multi-tenant) can read tenant ID at top level
          const context = (await this._buildContext('bulkWrite', {
            operations,
            ...options,
          })) as RepositoryContext;

          try {
            // Use context.operations — policy hooks (multi-tenant) may have injected tenant filters
            const finalOps =
              (context.operations as Record<string, unknown>[] | undefined) || operations;

            if (!finalOps || finalOps.length === 0) {
              throw createError(400, 'bulkWrite requires at least one operation');
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await this.Model.bulkWrite(
              finalOps as import('mongoose').AnyBulkWriteOperation<any>[],
              {
                ordered: options.ordered ?? true,
                session: options.session as ClientSession | undefined,
              },
            );

            const bulkResult = {
              ok: result.ok,
              insertedCount: result.insertedCount,
              upsertedCount: result.upsertedCount,
              matchedCount: result.matchedCount,
              modifiedCount: result.modifiedCount,
              deletedCount: result.deletedCount,
              insertedIds: result.insertedIds,
              upsertedIds: result.upsertedIds,
            };

            await this.emitAsync('after:bulkWrite' as string, { context, result: bulkResult });
            return bulkResult;
          } catch (error) {
            this.emit('error:bulkWrite' as string, { context, error });
            throw this._handleError(error as Error) as HttpError;
          }
        },
      );

      /**
       * Delete multiple documents matching a query.
       *
       * Behavior mirrors `Repository.delete`: defaults to soft-delete when
       * `softDeletePlugin` is wired, physical delete otherwise. Pass
       * `{ mode: 'hard' }` to bypass soft-delete for GDPR / cleanup paths —
       * multi-tenant scoping and audit hooks still fire.
       *
       * Rejects empty filters even after policy hooks run, to prevent
       * accidental collection wipes.
       */
      repo.registerMethod(
        'deleteMany',
        async function (
          this: RepositoryInstance,
          query: Record<string, unknown>,
          options: Record<string, unknown> = {},
        ) {
          // Reject empty filters up front (before policy hooks can run and
          // accidentally mask a caller who passed {}). This is a defense-in-depth
          // check — the post-policy check below still catches missed cases.
          if (!query || Object.keys(query).length === 0) {
            throw createError(
              400,
              'deleteMany requires a non-empty query filter. Pass an explicit filter to prevent accidental mass deletes.',
            );
          }

          const mode = options.mode as 'hard' | 'soft' | undefined;

          // Spread options into context so policy plugins (multi-tenant) can read tenant ID at top level
          const context = (await this._buildContext('deleteMany', {
            query,
            ...options,
            ...(mode ? { deleteMode: mode } : {}),
          })) as RepositoryContext;

          try {
            // Soft-delete plugin set this on before:deleteMany when the mode
            // allowed it. For mode:'hard' the plugin short-circuited.
            if (context.softDeleted) {
              const result = { acknowledged: true, deletedCount: 0 };
              await this.emitAsync('after:deleteMany', { context, result });
              return result;
            }

            // Use context.query — policy hooks (multi-tenant) may have injected tenant filters
            const finalQuery = (context.query || query) as Record<string, unknown>;

            if (!finalQuery || Object.keys(finalQuery).length === 0) {
              throw createError(
                400,
                'deleteMany requires a non-empty query filter after policy hooks.',
              );
            }

            const result = await this.Model.deleteMany(finalQuery, {
              session: options.session as ClientSession | undefined,
            }).exec();

            await this.emitAsync('after:deleteMany', { context, result });
            return result;
          } catch (error) {
            this.emit('error:deleteMany', { context, error });
            throw this._handleError(error as Error) as HttpError;
          }
        },
      );
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
/**
 * Bulk-write result. Re-exported from repo-core so the plugin's
 * surface uses the canonical contract type — adding fields here
 * would create drift with sqlitekit/pgkit/prismakit consumers.
 */
import type { BulkWriteResult } from '@classytic/repo-core/repository';

export type { BulkWriteResult };

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
    options?: { session?: unknown; updatePipeline?: boolean },
  ): Promise<{
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    upsertedCount: number;
    upsertedId: unknown;
  }>;

  /**
   * Delete multiple documents matching the query.
   *
   * Defaults to soft delete when `softDeletePlugin` is wired, physical delete
   * otherwise. Pass `{ mode: 'hard' }` for GDPR / admin cleanup — multi-tenant
   * scoping and audit hooks still fire.
   *
   * @param query - Query to match documents (must be non-empty)
   * @param options - Operation options (session, mode, tenant keys)
   * @returns Delete result with deletedCount
   */
  deleteMany(
    query: Record<string, unknown>,
    options?: {
      session?: unknown;
      mode?: 'hard' | 'soft';
      [key: string]: unknown;
    },
  ): Promise<{ acknowledged: boolean; deletedCount: number }>;

  /**
   * Execute heterogeneous bulk write operations in a single database call.
   * Supports insertOne, updateOne, updateMany, deleteOne, deleteMany, replaceOne.
   *
   * @param operations - Array of bulk write operations
   * @param options - Options (session, ordered)
   * @returns Bulk write result with counts per operation type
   *
   * @example
   * const result = await repo.bulkWrite([
   *   { insertOne: { document: { name: 'Item', price: 10 } } },
   *   { updateOne: { filter: { _id: id }, update: { $inc: { views: 1 } } } },
   *   { deleteOne: { filter: { _id: oldId } } },
   * ]);
   * console.log(result.insertedCount, result.modifiedCount, result.deletedCount);
   */
  bulkWrite(
    operations: Record<string, unknown>[],
    options?: { session?: unknown; ordered?: boolean },
  ): Promise<BulkWriteResult>;
}
