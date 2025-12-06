/**
 * MongoDB Operations Plugin
 *
 * Adds MongoDB-specific operations to repositories.
 * Requires method-registry.plugin.js to be loaded first.
 */

import { createError } from '../utils/error.js';
import * as createActions from '../actions/create.js';
import type { Plugin, RepositoryInstance, ObjectId } from '../types.js';

/**
 * MongoDB operations plugin
 * 
 * @example
 * const repo = new Repository(Model, [
 *   methodRegistryPlugin(),
 *   mongoOperationsPlugin(),
 * ]);
 * 
 * await repo.increment(productId, 'views', 1);
 * await repo.pushToArray(productId, 'tags', 'featured');
 */
export function mongoOperationsPlugin(): Plugin {
  return {
    name: 'mongo-operations',

    apply(repo: RepositoryInstance): void {
      // Check if method-registry is available
      if (!repo.registerMethod) {
        throw new Error(
          'mongoOperationsPlugin requires methodRegistryPlugin. ' +
          'Add methodRegistryPlugin() before mongoOperationsPlugin() in plugins array.'
        );
      }

      /**
       * Update existing document or insert new one
       */
      repo.registerMethod('upsert', async function (
        this: RepositoryInstance,
        query: Record<string, unknown>,
        data: Record<string, unknown>,
        options: Record<string, unknown> = {}
      ) {
        return createActions.upsert(this.Model, query, data, options);
      });

      // Helper: Validate and perform numeric operation
      const validateAndUpdateNumeric = async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: number,
        operator: string,
        operationName: string,
        options: Record<string, unknown>
      ) {
        if (typeof value !== 'number') {
          throw createError(400, `${operationName} value must be a number`);
        }
        return (this as Record<string, Function>).update(id, { [operator]: { [field]: value } }, options);
      };

      /**
       * Atomically increment numeric field
       */
      repo.registerMethod('increment', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: number = 1,
        options: Record<string, unknown> = {}
      ) {
        return validateAndUpdateNumeric.call(this, id, field, value, '$inc', 'Increment', options);
      });

      /**
       * Atomically decrement numeric field
       */
      repo.registerMethod('decrement', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: number = 1,
        options: Record<string, unknown> = {}
      ) {
        return validateAndUpdateNumeric.call(this, id, field, -value, '$inc', 'Decrement', options);
      });

      // Helper: Generic MongoDB operator update
      const applyOperator = function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: unknown,
        operator: string,
        options: Record<string, unknown>
      ) {
        return (this as Record<string, Function>).update(id, { [operator]: { [field]: value } }, options);
      };

      /**
       * Push value to array field
       */
      repo.registerMethod('pushToArray', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: unknown,
        options: Record<string, unknown> = {}
      ) {
        return applyOperator.call(this, id, field, value, '$push', options);
      });

      /**
       * Remove value from array field
       */
      repo.registerMethod('pullFromArray', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: unknown,
        options: Record<string, unknown> = {}
      ) {
        return applyOperator.call(this, id, field, value, '$pull', options);
      });

      /**
       * Add value to array only if not already present (unique)
       */
      repo.registerMethod('addToSet', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: unknown,
        options: Record<string, unknown> = {}
      ) {
        return applyOperator.call(this, id, field, value, '$addToSet', options);
      });

      /**
       * Set field value (alias for update with $set)
       */
      repo.registerMethod('setField', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: unknown,
        options: Record<string, unknown> = {}
      ) {
        return applyOperator.call(this, id, field, value, '$set', options);
      });

      /**
       * Unset (remove) field from document
       */
      repo.registerMethod('unsetField', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        fields: string | string[],
        options: Record<string, unknown> = {}
      ) {
        const fieldArray = Array.isArray(fields) ? fields : [fields];
        const unsetObj = fieldArray.reduce((acc, field) => {
          acc[field] = '';
          return acc;
        }, {} as Record<string, string>);

        return (this as Record<string, Function>).update(id, { $unset: unsetObj }, options);
      });

      /**
       * Rename field in document
       */
      repo.registerMethod('renameField', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        oldName: string,
        newName: string,
        options: Record<string, unknown> = {}
      ) {
        return (this as Record<string, Function>).update(id, { $rename: { [oldName]: newName } }, options);
      });

      /**
       * Multiply numeric field by value
       */
      repo.registerMethod('multiplyField', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        multiplier: number,
        options: Record<string, unknown> = {}
      ) {
        return validateAndUpdateNumeric.call(this, id, field, multiplier, '$mul', 'Multiplier', options);
      });

      /**
       * Set field to minimum value (only if current value is greater)
       */
      repo.registerMethod('setMin', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: unknown,
        options: Record<string, unknown> = {}
      ) {
        return applyOperator.call(this, id, field, value, '$min', options);
      });

      /**
       * Set field to maximum value (only if current value is less)
       */
      repo.registerMethod('setMax', async function (
        this: RepositoryInstance,
        id: string | ObjectId,
        field: string,
        value: unknown,
        options: Record<string, unknown> = {}
      ) {
        return applyOperator.call(this, id, field, value, '$max', options);
      });
    },
  };
}

export default mongoOperationsPlugin;
