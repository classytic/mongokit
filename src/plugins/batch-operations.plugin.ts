/**
 * Batch Operations Plugin
 *
 * Contributes `bulkWrite` as a registered method. `updateMany` and
 * `deleteMany` USED to live here too; as of mongokit 3.11.0 they are
 * primitives on `Repository<TDoc>` itself (sqlitekit parity — always
 * available, no silent "method is undefined" footgun when this plugin
 * isn't wired).
 *
 * `bulkWrite` stays plugin-only because the mongoose-shaped
 * `AnyBulkWriteOperation` and ordered/unordered batching have no clean
 * SQL analogue — arc code using `repo.bulkWrite` is necessarily
 * mongokit-specific.
 */

import type { ClientSession } from 'mongoose';
import type { HttpError, Plugin, RepositoryContext, RepositoryInstance } from '../types.js';
import { createError } from '../utils/error.js';

/**
 * Batch operations plugin.
 *
 * @example
 * const repo = new Repository(Model, [
 *   methodRegistryPlugin(),
 *   batchOperationsPlugin(),
 * ]);
 *
 * // updateMany + deleteMany are primitives on Repository — no plugin needed.
 * await repo.updateMany({ status: 'pending' }, { status: 'active' });
 * await repo.deleteMany({ status: 'deleted' });
 *
 * // bulkWrite is what this plugin contributes.
 * await repo.bulkWrite([...ops]);
 */
export function batchOperationsPlugin(): Plugin {
  return {
    name: 'batch-operations',

    apply(repo: RepositoryInstance): void {
      if (!repo.registerMethod) {
        throw new Error('batchOperationsPlugin requires methodRegistryPlugin');
      }

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
    },
  };
}

/**
 * Type interface for repositories using `batchOperationsPlugin`.
 *
 * Only `bulkWrite` lives here now. `updateMany` and `deleteMany` are
 * declared directly on `Repository<TDoc>` as of 3.11.0, so no type
 * intersection is needed to pick them up.
 *
 * @example
 * ```typescript
 * import {
 *   Repository,
 *   methodRegistryPlugin,
 *   batchOperationsPlugin,
 * } from '@classytic/mongokit';
 * import type { BatchOperationsMethods } from '@classytic/mongokit';
 *
 * class ProductRepo extends Repository<IProduct> {}
 *
 * // Intersect with BatchOperationsMethods only if you need bulkWrite.
 * type ProductRepoWithBulk = ProductRepo & BatchOperationsMethods;
 *
 * const repo = new ProductRepo(ProductModel, [
 *   methodRegistryPlugin(),
 *   batchOperationsPlugin(),
 * ]) as ProductRepoWithBulk;
 *
 * // updateMany / deleteMany work without the intersection — primitives on
 * // the class.
 * await repo.updateMany({ status: 'pending' }, { status: 'active' });
 * await repo.deleteMany({ status: 'archived' });
 *
 * // bulkWrite needs the plugin + intersection for TS autocomplete.
 * await repo.bulkWrite([...ops]);
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
