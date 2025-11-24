/**
 * Aggregate Helpers Plugin
 * Adds common aggregation helper methods
 */

export const aggregateHelpersPlugin = () => ({
  name: 'aggregate-helpers',

  apply(repo) {
    if (!repo.registerMethod) {
      throw new Error('aggregateHelpersPlugin requires methodRegistryPlugin');
    }

    /**
     * Group by field
     */
    repo.registerMethod('groupBy', async function (field, options = {}) {
      const pipeline = [
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ];

      if (options.limit) {
        pipeline.push(/** @type {any} */({ $limit: options.limit }));
      }

      return this.aggregate(pipeline, options);
    });

    // Helper: Generic aggregation operation
    const aggregateOperation = async function (field, operator, resultKey, query = {}, options = {}) {
      const pipeline = [
        { $match: query },
        { $group: { _id: null, [resultKey]: { [operator]: `$${field}` } } }
      ];

      const result = await this.aggregate(pipeline, options);
      return result[0]?.[resultKey] || 0;
    };

    /**
     * Sum field values
     */
    repo.registerMethod('sum', async function (field, query = {}, options = {}) {
      return aggregateOperation.call(this, field, '$sum', 'total', query, options);
    });

    /**
     * Average field values
     */
    repo.registerMethod('average', async function (field, query = {}, options = {}) {
      return aggregateOperation.call(this, field, '$avg', 'avg', query, options);
    });

    /**
     * Get minimum value
     */
    repo.registerMethod('min', async function (field, query = {}, options = {}) {
      return aggregateOperation.call(this, field, '$min', 'min', query, options);
    });

    /**
     * Get maximum value
     */
    repo.registerMethod('max', async function (field, query = {}, options = {}) {
      return aggregateOperation.call(this, field, '$max', 'max', query, options);
    });
  }
});

export default aggregateHelpersPlugin;
