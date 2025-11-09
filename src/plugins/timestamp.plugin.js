export const timestampPlugin = () => ({
  name: 'timestamp',

  apply(repo) {
    repo.on('before:create', (context) => {
      if (!context.data) return;
      const now = new Date();
      if (!context.data.createdAt) context.data.createdAt = now;
      if (!context.data.updatedAt) context.data.updatedAt = now;
    });

    repo.on('before:update', (context) => {
      if (!context.data) return;
      context.data.updatedAt = new Date();
    });
  },
});

export default timestampPlugin;
