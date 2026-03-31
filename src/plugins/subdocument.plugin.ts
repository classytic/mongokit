/**
 * Subdocument Plugin
 * Adds subdocument array operations
 */

import type { ClientSession } from 'mongoose';
import type { ObjectId, Plugin, RepositoryInstance } from '../types.js';
import { createError } from '../utils/error.js';

/**
 * Subdocument plugin for managing nested arrays
 *
 * @example
 * const repo = new Repository(Model, [
 *   methodRegistryPlugin(),
 *   subdocumentPlugin(),
 * ]);
 *
 * await repo.addSubdocument(parentId, 'items', { name: 'Item 1' });
 * await repo.updateSubdocument(parentId, 'items', itemId, { name: 'Updated Item' });
 */
export function subdocumentPlugin(): Plugin {
  return {
    name: 'subdocument',

    apply(repo: RepositoryInstance): void {
      if (!repo.registerMethod) {
        throw new Error('subdocumentPlugin requires methodRegistryPlugin');
      }

      /**
       * Add subdocument to array
       */
      repo.registerMethod(
        'addSubdocument',
        async function (
          this: RepositoryInstance,
          parentId: string | ObjectId,
          arrayPath: string,
          subData: Record<string, unknown>,
          options: Record<string, unknown> = {},
        ) {
          return this.update(parentId, { $push: { [arrayPath]: subData } }, options);
        },
      );

      /**
       * Get subdocument from array
       */
      repo.registerMethod(
        'getSubdocument',
        async function (
          this: RepositoryInstance,
          parentId: string | ObjectId,
          arrayPath: string,
          subId: string | ObjectId,
          options: { lean?: boolean; session?: unknown } = {},
        ) {
          return this._executeQuery(async (Model: typeof this.Model) => {
            const parent = await Model.findById(parentId)
              .session(options.session as never)
              .exec();
            if (!parent) throw createError(404, 'Parent not found');

            const parentObj = parent as Record<string, unknown>;
            const arrayField = parentObj[arrayPath] as
              | { id: (id: string | ObjectId) => Record<string, unknown> | null }
              | undefined;

            if (!arrayField || typeof arrayField.id !== 'function') {
              throw createError(404, 'Array field not found');
            }

            const sub = arrayField.id(subId);
            if (!sub) throw createError(404, 'Subdocument not found');

            return options.lean && typeof (sub as Record<string, unknown>).toObject === 'function'
              ? (sub as { toObject: () => Record<string, unknown> }).toObject()
              : sub;
          });
        },
      );

      /**
       * Update subdocument in array
       */
      repo.registerMethod(
        'updateSubdocument',
        async function (
          this: RepositoryInstance,
          parentId: string | ObjectId,
          arrayPath: string,
          subId: string | ObjectId,
          updateData: Record<string, unknown>,
          options: { session?: unknown } = {},
        ) {
          return this._executeQuery(async (Model: typeof this.Model) => {
            const query = { _id: parentId, [`${arrayPath}._id`]: subId };
            const update = { $set: { [`${arrayPath}.$`]: { ...updateData, _id: subId } } };

            const result = await Model.findOneAndUpdate(query, update, {
              returnDocument: 'after',
              runValidators: true,
              session: options.session as ClientSession | undefined,
            }).exec();

            if (!result) throw createError(404, 'Parent or subdocument not found');
            return result;
          });
        },
      );

      /**
       * Delete subdocument from array
       */
      repo.registerMethod(
        'deleteSubdocument',
        async function (
          this: RepositoryInstance,
          parentId: string | ObjectId,
          arrayPath: string,
          subId: string | ObjectId,
          options: Record<string, unknown> = {},
        ) {
          return this.update(parentId, { $pull: { [arrayPath]: { _id: subId } } }, options);
        },
      );
    },
  };
}

/**
 * Type interface for repositories using subdocumentPlugin
 *
 * @example
 * ```typescript
 * import { Repository, methodRegistryPlugin, subdocumentPlugin } from '@classytic/mongokit';
 * import type { SubdocumentMethods } from '@classytic/mongokit';
 *
 * class OrderRepo extends Repository<IOrder> {}
 *
 * type OrderRepoWithSubdocs = OrderRepo & SubdocumentMethods<IOrder>;
 *
 * const repo = new OrderRepo(OrderModel, [
 *   methodRegistryPlugin(),
 *   subdocumentPlugin(),
 * ]) as OrderRepoWithSubdocs;
 *
 * // TypeScript autocomplete works!
 * await repo.addSubdocument(orderId, 'items', { productId: '123', quantity: 2 });
 * await repo.updateSubdocument(orderId, 'items', itemId, { quantity: 5 });
 * await repo.deleteSubdocument(orderId, 'items', itemId);
 * ```
 */
export interface SubdocumentMethods<TDoc> {
  /**
   * Add subdocument to array field
   * @param parentId - Parent document ID
   * @param arrayPath - Path to array field (e.g., 'items', 'addresses')
   * @param subData - Subdocument data
   * @param options - Operation options
   * @returns Updated parent document
   */
  addSubdocument(
    parentId: string | ObjectId,
    arrayPath: string,
    subData: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;

  /**
   * Get subdocument from array field
   * @param parentId - Parent document ID
   * @param arrayPath - Path to array field
   * @param subId - Subdocument ID
   * @param options - Operation options
   * @returns Subdocument
   */
  getSubdocument(
    parentId: string | ObjectId,
    arrayPath: string,
    subId: string | ObjectId,
    options?: { lean?: boolean; session?: unknown },
  ): Promise<Record<string, unknown>>;

  /**
   * Update subdocument in array field
   * @param parentId - Parent document ID
   * @param arrayPath - Path to array field
   * @param subId - Subdocument ID
   * @param updateData - Update data
   * @param options - Operation options
   * @returns Updated parent document
   */
  updateSubdocument(
    parentId: string | ObjectId,
    arrayPath: string,
    subId: string | ObjectId,
    updateData: Record<string, unknown>,
    options?: { session?: unknown },
  ): Promise<TDoc>;

  /**
   * Delete subdocument from array field
   * @param parentId - Parent document ID
   * @param arrayPath - Path to array field
   * @param subId - Subdocument ID
   * @param options - Operation options
   * @returns Updated parent document
   */
  deleteSubdocument(
    parentId: string | ObjectId,
    arrayPath: string,
    subId: string | ObjectId,
    options?: Record<string, unknown>,
  ): Promise<TDoc>;
}

export default subdocumentPlugin;
