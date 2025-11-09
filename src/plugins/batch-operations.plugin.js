/**
 * Batch Operations Plugin
 * Adds bulk update/delete operations with proper event emission
 */

export const batchOperationsPlugin = () => ({
  name: 'batch-operations',

  apply(repo) {
    if (!repo.registerMethod) {
      throw new Error('batchOperationsPlugin requires methodRegistryPlugin');
    }

    /**
     * Update multiple documents
     * @param {Object} query - MongoDB query to match documents
     * @param {Object} data - Update data
     * @param {Object} options - Additional options (session, context)
     * @returns {Promise<Object>} MongoDB update result
     */
    repo.registerMethod('updateMany', async function (query, data, options = {}) {
      const context = await this._buildContext('updateMany', { query, data, options });

      try {
        this.emit('before:updateMany', context);

        const result = await this.Model.updateMany(query, data, {
          runValidators: true,
          session: options.session,
        }).exec();

        this.emit('after:updateMany', { context, result });
        return result;
      } catch (error) {
        this.emit('error:updateMany', { context, error });
        throw this._handleError(error);
      }
    });

    /**
     * Delete multiple documents
     * @param {Object} query - MongoDB query to match documents
     * @param {Object} options - Additional options (session, context)
     * @returns {Promise<Object>} MongoDB delete result
     */
    repo.registerMethod('deleteMany', async function (query, options = {}) {
      const context = await this._buildContext('deleteMany', { query, options });

      try {
        this.emit('before:deleteMany', context);

        const result = await this.Model.deleteMany(query, {
          session: options.session,
        }).exec();

        this.emit('after:deleteMany', { context, result });
        return result;
      } catch (error) {
        this.emit('error:deleteMany', { context, error });
        throw this._handleError(error);
      }
    });
  }
});

export default batchOperationsPlugin;
