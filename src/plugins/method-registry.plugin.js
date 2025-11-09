/**
 * Method Registry Plugin
 *
 * Enables plugins to dynamically add methods to repository instances.
 * Foundation for extensibility - allows other plugins to extend repositories
 * with custom methods while maintaining type safety and proper binding.
 *
 * **Pattern:** Inspired by Stripe's extension system
 * **Philosophy:** Repositories start minimal, plugins add capabilities
 *
 * @module common/repositories/plugins/method-registry
 *
 * @example Basic Usage
 * ```js
 * import { Repository } from '../Repository.js';
 * import { methodRegistryPlugin } from './method-registry.plugin.js';
 *
 * class UserRepository extends Repository {
 *   constructor() {
 *     super(User, [methodRegistryPlugin()]);
 *
 *     // Now you can register custom methods
 *     this.registerMethod('findActive', async function() {
 *       return this.getAll({ filters: { status: 'active' } });
 *     });
 *   }
 * }
 * ```
 *
 * @example Plugin Using Method Registry
 * ```js
 * // Other plugins can use registerMethod to add functionality
 * export const mongoOperationsPlugin = () => ({
 *   name: 'mongo-operations',
 *   apply(repo) {
 *     repo.registerMethod('increment', async function(id, field, value = 1, options = {}) {
 *       return this.update(id, { $inc: { [field]: value } }, options);
 *     });
 *   }
 * });
 * ```
 */

/**
 * Method Registry Plugin
 *
 * Adds `registerMethod()` to repository instance, allowing dynamic method addition.
 *
 * @returns {Object} Plugin configuration
 */
export const methodRegistryPlugin = () => ({
  name: 'method-registry',

  apply(repo) {
    /**
     * Register a new method on the repository instance
     *
     * **Rules:**
     * - Method name must not conflict with existing methods
     * - Method is automatically bound to repository instance
     * - Method has access to all repository methods via `this`
     * - Async methods are recommended for consistency
     *
     * @param {string} name - Method name
     * @param {Function} fn - Method implementation (will be bound to repo)
     * @throws {Error} If method name already exists
     *
     * @example
     * repo.registerMethod('findByEmail', async function(email) {
     *   return this.getByQuery({ email }, { lean: true });
     * });
     *
     * @example With options
     * repo.registerMethod('incrementViews', async function(id, amount = 1) {
     *   return this.update(id, { $inc: { views: amount } });
     * });
     */
    repo.registerMethod = function (name, fn) {
      // Check for naming conflicts
      if (repo[name]) {
        throw new Error(
          `Cannot register method '${name}': Method already exists on repository. ` +
          `Choose a different name or use a plugin that doesn't conflict.`
        );
      }

      // Validate method name
      if (!name || typeof name !== 'string') {
        throw new Error('Method name must be a non-empty string');
      }

      // Validate function
      if (typeof fn !== 'function') {
        throw new Error(`Method '${name}' must be a function`);
      }

      // Bind function to repository instance
      repo[name] = fn.bind(repo);

      // Emit event for plugin system awareness
      repo.emit('method:registered', { name, fn });
    };

    /**
     * Check if a method is registered
     *
     * @param {string} name - Method name to check
     * @returns {boolean} True if method exists
     *
     * @example
     * if (repo.hasMethod('increment')) {
     *   await repo.increment(id, 'count', 1);
     * }
     */
    repo.hasMethod = function (name) {
      return typeof repo[name] === 'function';
    };

    /**
     * Get list of all dynamically registered methods
     *
     * @returns {Array<string>} Array of method names
     *
     * @example
     * const methods = repo.getRegisteredMethods();
     * console.log('Available methods:', methods);
     */
    repo.getRegisteredMethods = function () {
      const registeredMethods = [];

      repo.on('method:registered', ({ name }) => {
        registeredMethods.push(name);
      });

      return registeredMethods;
    };
  }
});

export default methodRegistryPlugin;
