/**
 * Subdocument Plugin
 * Adds subdocument array operations
 */

import type { ClientSession } from 'mongoose';
import { createError } from '../utils/error.js';
import type { Plugin, RepositoryInstance, ObjectId } from '../types.js';

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
      repo.registerMethod('addSubdocument', async function (
        this: RepositoryInstance,
        parentId: string | ObjectId,
        arrayPath: string,
        subData: Record<string, unknown>,
        options: Record<string, unknown> = {}
      ) {
        const update = (this as Record<string, Function>).update;
        return update.call(this, parentId, { $push: { [arrayPath]: subData } }, options);
      });

      /**
       * Get subdocument from array
       */
      repo.registerMethod('getSubdocument', async function (
        this: RepositoryInstance,
        parentId: string | ObjectId,
        arrayPath: string,
        subId: string | ObjectId,
        options: { lean?: boolean; session?: unknown } = {}
      ) {
        const _executeQuery = (this as Record<string, Function>)._executeQuery;
        return _executeQuery.call(this, async (Model: typeof this.Model) => {
          const parent = await Model.findById(parentId).session(options.session as never).exec();
          if (!parent) throw createError(404, 'Parent not found');

          const parentObj = parent as Record<string, unknown>;
          const arrayField = parentObj[arrayPath] as { id: (id: string | ObjectId) => Record<string, unknown> | null } | undefined;
          
          if (!arrayField || typeof arrayField.id !== 'function') {
            throw createError(404, 'Array field not found');
          }

          const sub = arrayField.id(subId);
          if (!sub) throw createError(404, 'Subdocument not found');

          return options.lean && typeof (sub as Record<string, unknown>).toObject === 'function'
            ? (sub as { toObject: () => Record<string, unknown> }).toObject()
            : sub;
        });
      });

      /**
       * Update subdocument in array
       */
      repo.registerMethod('updateSubdocument', async function (
        this: RepositoryInstance,
        parentId: string | ObjectId,
        arrayPath: string,
        subId: string | ObjectId,
        updateData: Record<string, unknown>,
        options: { session?: unknown } = {}
      ) {
        const _executeQuery = (this as Record<string, Function>)._executeQuery;
        return _executeQuery.call(this, async (Model: typeof this.Model) => {
          const query = { _id: parentId, [`${arrayPath}._id`]: subId };
          const update = { $set: { [`${arrayPath}.$`]: { ...updateData, _id: subId } } };

          const result = await Model.findOneAndUpdate(query, update, {
            new: true,
            runValidators: true,
            session: options.session as ClientSession | undefined,
          }).exec();

          if (!result) throw createError(404, 'Parent or subdocument not found');
          return result;
        });
      });

      /**
       * Delete subdocument from array
       */
      repo.registerMethod('deleteSubdocument', async function (
        this: RepositoryInstance,
        parentId: string | ObjectId,
        arrayPath: string,
        subId: string | ObjectId,
        options: Record<string, unknown> = {}
      ) {
        const update = (this as Record<string, Function>).update;
        return update.call(this, parentId, { $pull: { [arrayPath]: { _id: subId } } }, options);
      });
    },
  };
}

export default subdocumentPlugin;
