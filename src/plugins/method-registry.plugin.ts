/**
 * Method Registry Plugin
 *
 * Enables plugins to dynamically add methods to repository instances.
 * Foundation for extensibility - allows other plugins to extend repositories
 * with custom methods while maintaining type safety and proper binding.
 *
 * @example
 * ```typescript
 * const repo = new Repository(User, [methodRegistryPlugin()]);
 *
 * // Now you can register custom methods
 * repo.registerMethod('findActive', async function() {
 *   return this.getAll({ filters: { status: 'active' } });
 * });
 * ```
 */

import type { Plugin, RepositoryInstance } from '../types.js';

/**
 * Extended repository interface with method registry
 */
export interface MethodRegistryRepository extends RepositoryInstance {
  registerMethod(name: string, fn: Function): void;
  hasMethod(name: string): boolean;
  getRegisteredMethods(): string[];
}

/**
 * Method registry plugin that enables dynamic method registration
 */
export function methodRegistryPlugin(): Plugin {
  return {
    name: 'method-registry',

    apply(repo: RepositoryInstance): void {
      const registeredMethods: string[] = [];

      /**
       * Register a new method on the repository instance
       */
      repo.registerMethod = function (name: string, fn: Function): void {
        // Check for naming conflicts
        if ((repo as Record<string, unknown>)[name]) {
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
        (repo as Record<string, unknown>)[name] = fn.bind(repo);
        registeredMethods.push(name);

        // Emit event for plugin system awareness
        repo.emit('method:registered', { name, fn });
      };

      /**
       * Check if a method is registered
       */
      repo.hasMethod = function (name: string): boolean {
        return typeof (repo as Record<string, unknown>)[name] === 'function';
      };

      /**
       * Get list of all dynamically registered methods
       */
      (repo as MethodRegistryRepository).getRegisteredMethods = function (): string[] {
        return [...registeredMethods];
      };
    },
  };
}

export default methodRegistryPlugin;
