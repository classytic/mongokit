export const softDeletePlugin = (options = {}) => ({
  name: 'softDelete',

  apply(repo) {
    const deletedField = options.deletedField || 'deletedAt';
    const deletedByField = options.deletedByField || 'deletedBy';

    repo.on('before:delete', async (context) => {
      if (options.soft !== false) {
        const updateData = {
          [deletedField]: new Date(),
        };

        if (context.user) {
          updateData[deletedByField] = context.user._id || context.user.id;
        }

        await repo.Model.findByIdAndUpdate(context.id, updateData, { session: context.session });

        context.softDeleted = true;
      }
    });

    repo.on('before:getAll', (context) => {
      if (!context.includeDeleted && options.soft !== false) {
        const queryParams = context.queryParams || {};
        queryParams.filters = {
          ...(queryParams.filters || {}),
          [deletedField]: { $exists: false },
        };
        context.queryParams = queryParams;
      }
    });

    repo.on('before:getById', (context) => {
      if (!context.includeDeleted && options.soft !== false) {
        context.query = {
          ...(context.query || {}),
          [deletedField]: { $exists: false },
        };
      }
    });
  },
});

export default softDeletePlugin;
