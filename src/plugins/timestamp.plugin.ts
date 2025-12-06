/**
 * Timestamp Plugin
 * Auto-injects createdAt/updatedAt timestamps on create/update
 */

import type { Plugin, RepositoryContext, RepositoryInstance } from '../types.js';

/**
 * Timestamp plugin that auto-injects timestamps
 * 
 * @example
 * const repo = new Repository(Model, [timestampPlugin()]);
 */
export function timestampPlugin(): Plugin {
  return {
    name: 'timestamp',

    apply(repo: RepositoryInstance): void {
      repo.on('before:create', (context: RepositoryContext) => {
        if (!context.data) return;
        const now = new Date();
        if (!context.data.createdAt) context.data.createdAt = now;
        if (!context.data.updatedAt) context.data.updatedAt = now;
      });

      repo.on('before:update', (context: RepositoryContext) => {
        if (!context.data) return;
        context.data.updatedAt = new Date();
      });
    },
  };
}

export default timestampPlugin;
