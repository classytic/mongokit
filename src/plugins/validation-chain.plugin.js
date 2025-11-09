import createError from 'http-errors';

export const validationChainPlugin = (validators = [], options = {}) => {
  const { stopOnFirstError = true } = options;

  validators.forEach((v, idx) => {
    if (!v.name || typeof v.name !== 'string') {
      throw new Error(`Validator at index ${idx} missing 'name' (string)`);
    }
    if (typeof v.validate !== 'function') {
      throw new Error(`Validator '${v.name}' missing 'validate' function`);
    }
  });

  const validatorsByOperation = { create: [], update: [], delete: [], createMany: [] };
  const allOperationsValidators = [];

  validators.forEach(v => {
    if (!v.operations || v.operations.length === 0) {
      allOperationsValidators.push(v);
    } else {
      v.operations.forEach(op => {
        if (validatorsByOperation[op]) {
          validatorsByOperation[op].push(v);
        }
      });
    }
  });

  return {
    name: 'validation-chain',

    apply(repo) {
      const getValidatorsForOperation = (operation) => {
        const specific = validatorsByOperation[operation] || [];
        return [...allOperationsValidators, ...specific];
      };

      const runValidators = async (operation, context) => {
        const validators = getValidatorsForOperation(operation);
        const errors = [];

        for (const validator of validators) {
          try {
            await validator.validate(context, repo);
          } catch (error) {
            if (stopOnFirstError) {
              throw error;
            }
            errors.push({
              validator: validator.name,
              error: error.message || String(error)
            });
          }
        }

        if (errors.length > 0) {
          const error = createError(
            400,
            `Validation failed: ${errors.map(e => `[${e.validator}] ${e.error}`).join('; ')}`
          );
          error.validationErrors = errors;
          throw error;
        }
      };

      repo.on('before:create', async (context) => await runValidators('create', context));
      repo.on('before:createMany', async (context) => await runValidators('createMany', context));
      repo.on('before:update', async (context) => await runValidators('update', context));
      repo.on('before:delete', async (context) => await runValidators('delete', context));
    }
  };
};

/**
 * Block operation if condition is true
 * @param {string} name - Validator name
 * @param {string[]} operations - Operations to block on
 * @param {Function} condition - Condition function (context) => boolean
 * @param {string} errorMessage - Error message to throw
 * @example blockIf('block-library', ['delete'], ctx => ctx.data.managed, 'Cannot delete managed records')
 */
export const blockIf = (name, operations, condition, errorMessage) => ({
  name,
  operations,
  validate: (context) => {
    if (condition(context)) {
      throw createError(403, errorMessage);
    }
  }
});

export const requireField = (field, operations = ['create']) => ({
  name: `require-${field}`,
  operations,
  validate: (context) => {
    if (!context.data || context.data[field] === undefined || context.data[field] === null) {
      throw createError(400, `Field '${field}' is required`);
    }
  }
});

export const autoInject = (field, getter, operations = ['create']) => ({
  name: `auto-inject-${field}`,
  operations,
  validate: (context) => {
    if (context.data && !(field in context.data)) {
      const value = getter(context);
      if (value !== null && value !== undefined) {
        context.data[field] = value;
      }
    }
  }
});

export const immutableField = (field) => ({
  name: `immutable-${field}`,
  operations: ['update'],
  validate: (context) => {
    if (context.data && field in context.data) {
      throw createError(400, `Field '${field}' cannot be modified`);
    }
  }
});

export const uniqueField = (field, errorMessage) => ({
  name: `unique-${field}`,
  operations: ['create', 'update'],
  validate: async (context, repo) => {
    if (!context.data || !context.data[field]) return;

    const query = { [field]: context.data[field] };
    const existing = await repo.getByQuery(query, {
      select: '_id',
      lean: true,
      throwOnNotFound: false
    });

    if (existing && existing._id.toString() !== context.id?.toString()) {
      throw createError(409, errorMessage || `${field} already exists`);
    }
  }
});

export default validationChainPlugin;
