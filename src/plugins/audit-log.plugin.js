export const auditLogPlugin = (logger) => ({
  name: 'auditLog',

  apply(repo) {
    repo.on('after:create', ({ context, result }) => {
      logger?.info?.('Document created', {
        model: context.model || repo.model,
        id: result._id,
        userId: context.user?._id || context.user?.id,
        organizationId: context.organizationId,
      });
    });

    repo.on('after:update', ({ context, result }) => {
      logger?.info?.('Document updated', {
        model: context.model || repo.model,
        id: context.id || result._id,
        userId: context.user?._id || context.user?.id,
        organizationId: context.organizationId,
      });
    });

    repo.on('after:delete', ({ context, result }) => {
      logger?.info?.('Document deleted', {
        model: context.model || repo.model,
        id: context.id,
        userId: context.user?._id || context.user?.id,
        organizationId: context.organizationId,
      });
    });

    repo.on('error:create', ({ context, error }) => {
      logger?.error?.('Create failed', {
        model: context.model || repo.model,
        error: error.message,
        userId: context.user?._id || context.user?.id,
      });
    });

    repo.on('error:update', ({ context, error }) => {
      logger?.error?.('Update failed', {
        model: context.model || repo.model,
        id: context.id,
        error: error.message,
        userId: context.user?._id || context.user?.id,
      });
    });

    repo.on('error:delete', ({ context, error }) => {
      logger?.error?.('Delete failed', {
        model: context.model || repo.model,
        id: context.id,
        error: error.message,
        userId: context.user?._id || context.user?.id,
      });
    });
  },
});

export default auditLogPlugin;
