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

      repo.on('before:findOneAndUpdate', (context: RepositoryContext) => {
        if (!context.data) return;
        const now = new Date();
        // Update doc may be a plain object, an aggregation pipeline (array),
        // or an operator-style object. Only stamp the plain/operator forms;
        // pipelines are user-driven and should set timestamps explicitly.
        if (Array.isArray(context.data)) return;
        const update = context.data as Record<string, unknown>;
        const hasOperators = Object.keys(update).some((k) => k.startsWith('$'));
        if (hasOperators) {
          const set = (update.$set as Record<string, unknown>) || {};
          set.updatedAt = now;
          update.$set = set;
          // Stamp createdAt only on insert via $setOnInsert (upsert semantics).
          const setOnInsert = (update.$setOnInsert as Record<string, unknown>) || {};
          if (!('createdAt' in setOnInsert)) setOnInsert.createdAt = now;
          update.$setOnInsert = setOnInsert;
        } else {
          update.updatedAt = now;
        }
      });
    },
  };
}
