/**
 * MongoDB Operations Plugin
 *
 * Adds MongoDB-specific operations to repositories.
 * Requires method-registry.plugin.js to be loaded first.
 *
 * **Operations Added:**
 * - upsert(query, data, options) - Update or insert
 * - increment(id, field, value, options) - Atomic increment
 * - decrement(id, field, value, options) - Atomic decrement
 * - pushToArray(id, field, value, options) - Add to array
 * - pullFromArray(id, field, value, options) - Remove from array
 * - addToSet(id, field, value, options) - Add unique to array
 *
 * **Pattern:** Opt-in MongoDB features
 * **Philosophy:** Keep core pure, add database-specific features via plugins
 *
 * @module common/repositories/plugins/mongo-operations
 * @requires method-registry.plugin
 *
 * @example Basic Usage
 * ```js
 * import { Repository } from '../Repository.js';
 * import { method

RegistryPlugin } from './method-registry.plugin.js';
 * import { mongoOperationsPlugin } from './mongo-operations.plugin.js';
 *
 * class ProductRepository extends Repository {
 *   constructor() {
 *     super(Product, [
 *       methodRegistryPlugin(),
 *       mongoOperationsPlugin(),
 *     ]);
 *   }
 * }
 *
 * // Now you can use MongoDB operations
 * await productRepo.increment(productId, 'views', 1);
 * await productRepo.pushToArray(productId, 'tags', 'featured');
 * ```
 */

import createError from 'http-errors';
import * as createActions from '../actions/create.js';

/**
 * MongoDB Operations Plugin
 *
 * Adds common MongoDB atomic operations to repository.
 * All operations use repository's update method internally (events/plugins run).
 *
 * @returns {Object} Plugin configuration
 */
export const mongoOperationsPlugin = () => ({
  name: 'mongo-operations',

  apply(repo) {
    // Check if method-registry is available
    if (!repo.registerMethod) {
      throw new Error(
        'mongoOperationsPlugin requires methodRegistryPlugin. ' +
        'Add methodRegistryPlugin() before mongoOperationsPlugin() in plugins array.'
      );
    }

    /**
     * Update existing document or insert new one
     *
     * @param {Object} query - Query to find existing document
     * @param {Object} data - Data to insert/update
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Upserted document
     *
     * @example
     * // Create or update user session
     * await repo.upsert(
     *   { userId, deviceId },
     *   { lastActive: new Date(), ipAddress },
     *   { lean: true }
     * );
     */
    repo.registerMethod('upsert', async function (query, data, options = {}) {
      return createActions.upsert(this.Model, query, data, options);
    });

    // Helper: Validate and perform numeric operation
    const validateAndUpdateNumeric = function (id, field, value, operator, operationName, options) {
      if (typeof value !== 'number') {
        throw createError(400, `${operationName} value must be a number`);
      }
      return this.update(id, { [operator]: { [field]: value } }, options);
    };

    /**
     * Atomically increment numeric field
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Field name to increment
     * @param {number} [value=1] - Amount to increment by
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Increment product views
     * await productRepo.increment(productId, 'views', 1);
     *
     * @example
     * // Increment multiple times
     * await productRepo.increment(userId, 'points', 100);
     */
    repo.registerMethod('increment', async function (id, field, value = 1, options = {}) {
      return validateAndUpdateNumeric.call(this, id, field, value, '$inc', 'Increment', options);
    });

    /**
     * Atomically decrement numeric field
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Field name to decrement
     * @param {number} [value=1] - Amount to decrement by
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Decrement product stock
     * await productRepo.decrement(productId, 'stock', 1);
     */
    repo.registerMethod('decrement', async function (id, field, value = 1, options = {}) {
      return validateAndUpdateNumeric.call(this, id, field, -value, '$inc', 'Decrement', options);
    });

    // Helper: Generic MongoDB operator update
    const applyOperator = function (id, field, value, operator, options) {
      return this.update(id, { [operator]: { [field]: value } }, options);
    };

    /**
     * Push value to array field
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Array field name
     * @param {*} value - Value to push
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Add tag to product
     * await productRepo.pushToArray(productId, 'tags', 'new-arrival');
     *
     * @example
     * // Add multiple items
     * await productRepo.pushToArray(userId, 'notifications', {
     *   message: 'Welcome!',
     *   createdAt: new Date()
     * });
     */
    repo.registerMethod('pushToArray', async function (id, field, value, options = {}) {
      return applyOperator.call(this, id, field, value, '$push', options);
    });

    /**
     * Remove value from array field
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Array field name
     * @param {*} value - Value to remove (can be query object)
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Remove tag from product
     * await productRepo.pullFromArray(productId, 'tags', 'old-tag');
     *
     * @example
     * // Remove by query
     * await productRepo.pullFromArray(userId, 'notifications', { read: true });
     */
    repo.registerMethod('pullFromArray', async function (id, field, value, options = {}) {
      return applyOperator.call(this, id, field, value, '$pull', options);
    });

    /**
     * Add value to array only if not already present (unique)
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Array field name
     * @param {*} value - Value to add
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Add unique follower
     * await userRepo.addToSet(userId, 'followers', followerId);
     */
    repo.registerMethod('addToSet', async function (id, field, value, options = {}) {
      return applyOperator.call(this, id, field, value, '$addToSet', options);
    });

    /**
     * Set field value (alias for update with $set)
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Field name
     * @param {*} value - New value
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Set last login
     * await userRepo.setField(userId, 'lastLogin', new Date());
     */
    repo.registerMethod('setField', async function (id, field, value, options = {}) {
      return applyOperator.call(this, id, field, value, '$set', options);
    });

    /**
     * Unset (remove) field from document
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string|string[]} fields - Field name(s) to remove
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Remove temporary field
     * await userRepo.unsetField(userId, 'tempToken');
     *
     * @example
     * // Remove multiple fields
     * await userRepo.unsetField(userId, ['tempToken', 'tempData']);
     */
    repo.registerMethod('unsetField', async function (id, fields, options = {}) {
      const fieldArray = Array.isArray(fields) ? fields : [fields];
      const unsetObj = fieldArray.reduce((acc, field) => {
        acc[field] = '';
        return acc;
      }, {});

      return this.update(id, { $unset: unsetObj }, options);
    });

    /**
     * Rename field in document
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} oldName - Current field name
     * @param {string} newName - New field name
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Rename field
     * await userRepo.renameField(userId, 'username', 'displayName');
     */
    repo.registerMethod('renameField', async function (id, oldName, newName, options = {}) {
      return this.update(id, { $rename: { [oldName]: newName } }, options);
    });

    /**
     * Multiply numeric field by value
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Field name
     * @param {number} multiplier - Multiplier value
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Double points
     * await userRepo.multiplyField(userId, 'points', 2);
     */
    repo.registerMethod('multiplyField', async function (id, field, multiplier, options = {}) {
      return validateAndUpdateNumeric.call(this, id, field, multiplier, '$mul', 'Multiplier', options);
    });

    /**
     * Set field to minimum value (only if current value is greater)
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Field name
     * @param {number} value - Minimum value
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Set minimum price
     * await productRepo.setMin(productId, 'price', 999);
     */
    repo.registerMethod('setMin', async function (id, field, value, options = {}) {
      return applyOperator.call(this, id, field, value, '$min', options);
    });

    /**
     * Set field to maximum value (only if current value is less)
     *
     * @param {string|ObjectId} id - Document ID
     * @param {string} field - Field name
     * @param {number} value - Maximum value
     * @param {Object} [options={}] - Options
     * @returns {Promise<Object>} Updated document
     *
     * @example
     * // Set maximum score
     * await gameRepo.setMax(gameId, 'highScore', newScore);
     */
    repo.registerMethod('setMax', async function (id, field, value, options = {}) {
      return applyOperator.call(this, id, field, value, '$max', options);
    });
  }
});

export default mongoOperationsPlugin;
