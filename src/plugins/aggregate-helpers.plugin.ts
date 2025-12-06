/**
 * Aggregate Helpers Plugin
 * Adds common aggregation helper methods
 */

import type { PipelineStage } from 'mongoose';
import type { Plugin, RepositoryInstance } from '../types.js';

/**
 * Aggregate helpers plugin
 * 
 * @example
 * const repo = new Repository(Model, [
 *   methodRegistryPlugin(),
 *   aggregateHelpersPlugin(),
 * ]);
 * 
 * const groups = await repo.groupBy('category');
 * const total = await repo.sum('amount', { status: 'completed' });
 */
export function aggregateHelpersPlugin(): Plugin {
  return {
    name: 'aggregate-helpers',

    apply(repo: RepositoryInstance): void {
      if (!repo.registerMethod) {
        throw new Error('aggregateHelpersPlugin requires methodRegistryPlugin');
      }

      /**
       * Group by field
       */
      repo.registerMethod('groupBy', async function (
        this: RepositoryInstance,
        field: string,
        options: { limit?: number; session?: unknown } = {}
      ) {
        const pipeline: PipelineStage[] = [
          { $group: { _id: `$${field}`, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ];

        if (options.limit) {
          pipeline.push({ $limit: options.limit });
        }

        const aggregate = (this as Record<string, Function>).aggregate;
        return aggregate.call(this, pipeline, options);
      });

      // Helper: Generic aggregation operation
      const aggregateOperation = async function (
        this: RepositoryInstance,
        field: string,
        operator: string,
        resultKey: string,
        query: Record<string, unknown> = {},
        options: Record<string, unknown> = {}
      ): Promise<number> {
        const pipeline: PipelineStage[] = [
          { $match: query },
          { $group: { _id: null, [resultKey]: { [operator]: `$${field}` } } },
        ];

        const aggregate = (this as Record<string, Function>).aggregate;
        const result = await aggregate.call(this, pipeline, options) as Array<Record<string, number>>;
        return result[0]?.[resultKey] || 0;
      };

      /**
       * Sum field values
       */
      repo.registerMethod('sum', async function (
        this: RepositoryInstance,
        field: string,
        query: Record<string, unknown> = {},
        options: Record<string, unknown> = {}
      ) {
        return aggregateOperation.call(this, field, '$sum', 'total', query, options);
      });

      /**
       * Average field values
       */
      repo.registerMethod('average', async function (
        this: RepositoryInstance,
        field: string,
        query: Record<string, unknown> = {},
        options: Record<string, unknown> = {}
      ) {
        return aggregateOperation.call(this, field, '$avg', 'avg', query, options);
      });

      /**
       * Get minimum value
       */
      repo.registerMethod('min', async function (
        this: RepositoryInstance,
        field: string,
        query: Record<string, unknown> = {},
        options: Record<string, unknown> = {}
      ) {
        return aggregateOperation.call(this, field, '$min', 'min', query, options);
      });

      /**
       * Get maximum value
       */
      repo.registerMethod('max', async function (
        this: RepositoryInstance,
        field: string,
        query: Record<string, unknown> = {},
        options: Record<string, unknown> = {}
      ) {
        return aggregateOperation.call(this, field, '$max', 'max', query, options);
      });
    },
  };
}

export default aggregateHelpersPlugin;
