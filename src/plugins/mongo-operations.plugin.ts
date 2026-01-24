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
 * Adds MongoDB-specific atomic operations to repositories:
 * - upsert: Create or update document
 * - increment/decrement: Atomic numeric operations
 * - pushToArray/pullFromArray/addToSet: Array operations
 * - setField/unsetField/renameField: Field operations
 * - multiplyField: Multiply numeric field
 * - setMin/setMax: Conditional min/max updates
 *
 * @example Basic usage (no TypeScript autocomplete)
 * ```typescript
 * const repo = new Repository(ProductModel, [
 *   methodRegistryPlugin(),
 *   mongoOperationsPlugin(),
 * ]);
 *
 * // Works at runtime but TypeScript doesn't know about these methods
 * await (repo as any).increment(productId, 'views', 1);
 * await (repo as any).pushToArray(productId, 'tags', 'featured');
 * ```
 *
 * @example With TypeScript type safety (recommended)
 * ```typescript
 * import { Repository, mongoOperationsPlugin, methodRegistryPlugin } from '@classytic/mongokit';
 * import type { MongoOperationsMethods } from '@classytic/mongokit';
 *
 * class ProductRepo extends Repository<IProduct> {
 *   // Add your custom methods here
 * }
 *
 * // Create with type assertion to get autocomplete for plugin methods
 * type ProductRepoWithPlugins = ProductRepo & MongoOperationsMethods<IProduct>;
 *
 * const repo = new ProductRepo(ProductModel, [
 *   methodRegistryPlugin(),
 *   mongoOperationsPlugin(),
 * ]) as ProductRepoWithPlugins;
 *
 * // Now TypeScript provides autocomplete and type checking!
 * await repo.increment(productId, 'views', 1);
 * await repo.upsert({ sku: 'ABC' }, { name: 'Product', price: 99 });
 * await repo.pushToArray(productId, 'tags', 'featured');
 * ```
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

/**
 * Type interface for repositories using mongoOperationsPlugin
 *
 * Use this interface to get TypeScript autocomplete and type safety
 * for the methods added by mongoOperationsPlugin.
 *
 * @example
 * ```typescript
 * import { Repository, mongoOperationsPlugin, methodRegistryPlugin } from '@classytic/mongokit';
 * import type { MongoOperationsMethods } from '@classytic/mongokit';
 *
 * // Without type safety (base is flexible)
 * class ProductRepo extends Repository<IProduct> {
 *   // Can add anything - fully flexible
 * }
 *
 * // With type safety for plugin methods
 * class ProductRepo extends Repository<IProduct> implements MongoOperationsMethods<IProduct> {
 *   // TypeScript knows about upsert, increment, decrement, etc.
 * }
 *
 * const repo = new ProductRepo(ProductModel, [
 *   methodRegistryPlugin(),
 *   mongoOperationsPlugin(),
 * ]);
 *
 * // Now TypeScript provides autocomplete and type checking
 * await repo.increment(productId, 'views', 1);
 * await repo.upsert({ sku: 'ABC' }, { name: 'Product' });
 * ```
 */
export interface MongoOperationsMethods<TDoc> {
  /**
   * Update existing document or insert new one
   * @param query - Query to find document
   * @param data - Data to update or insert
   * @param options - Operation options (session, etc.)
   * @returns Created or updated document
   */
  upsert(
    query: Record<string, unknown>,
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Atomically increment numeric field
   * @param id - Document ID
   * @param field - Field name to increment
   * @param value - Value to increment by (default: 1)
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  increment(
    id: string | ObjectId,
    field: string,
    value?: number,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Atomically decrement numeric field
   * @param id - Document ID
   * @param field - Field name to decrement
   * @param value - Value to decrement by (default: 1)
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  decrement(
    id: string | ObjectId,
    field: string,
    value?: number,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Push value to array field
   * @param id - Document ID
   * @param field - Array field name
   * @param value - Value to push
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  pushToArray(
    id: string | ObjectId,
    field: string,
    value: unknown,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Remove value from array field
   * @param id - Document ID
   * @param field - Array field name
   * @param value - Value to remove
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  pullFromArray(
    id: string | ObjectId,
    field: string,
    value: unknown,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Add value to array only if not already present (unique)
   * @param id - Document ID
   * @param field - Array field name
   * @param value - Value to add
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  addToSet(
    id: string | ObjectId,
    field: string,
    value: unknown,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Set field value (alias for update with $set)
   * @param id - Document ID
   * @param field - Field name
   * @param value - Value to set
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  setField(
    id: string | ObjectId,
    field: string,
    value: unknown,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Unset (remove) field from document
   * @param id - Document ID
   * @param fields - Field name or array of field names to remove
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  unsetField(
    id: string | ObjectId,
    fields: string | string[],
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Rename field in document
   * @param id - Document ID
   * @param oldName - Current field name
   * @param newName - New field name
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  renameField(
    id: string | ObjectId,
    oldName: string,
    newName: string,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Multiply numeric field by value
   * @param id - Document ID
   * @param field - Field name
   * @param multiplier - Multiplier value
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  multiplyField(
    id: string | ObjectId,
    field: string,
    multiplier: number,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Set field to minimum value (only if current value is greater)
   * @param id - Document ID
   * @param field - Field name
   * @param value - Minimum value
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  setMin(
    id: string | ObjectId,
    field: string,
    value: unknown,
    options?: Record<string, unknown>
  ): Promise<TDoc>;

  /**
   * Set field to maximum value (only if current value is less)
   * @param id - Document ID
   * @param field - Field name
   * @param value - Maximum value
   * @param options - Operation options (session, etc.)
   * @returns Updated document
   */
  setMax(
    id: string | ObjectId,
    field: string,
    value: unknown,
    options?: Record<string, unknown>
  ): Promise<TDoc>;
}

export default mongoOperationsPlugin;
