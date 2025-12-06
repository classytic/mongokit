/**
 * Validation Chain Plugin
 * 
 * Composable validation for repository operations with customizable rules.
 */

import { createError } from '../utils/error.js';
import type {
  Plugin,
  RepositoryInstance,
  RepositoryContext,
  ValidatorDefinition,
  ValidationChainOptions,
  HttpError,
} from '../types.js';

type OperationType = 'create' | 'createMany' | 'update' | 'delete';

/**
 * Validation chain plugin
 * 
 * @example
 * const repo = new Repository(Model, [
 *   validationChainPlugin([
 *     requireField('email'),
 *     uniqueField('email', 'Email already exists'),
 *     blockIf('no-delete-admin', ['delete'], ctx => ctx.data?.role === 'admin', 'Cannot delete admin'),
 *   ])
 * ]);
 */
export function validationChainPlugin(
  validators: ValidatorDefinition[] = [],
  options: ValidationChainOptions = {}
): Plugin {
  const { stopOnFirstError = true } = options;

  // Validate all validators have required properties
  validators.forEach((v, idx) => {
    if (!v.name || typeof v.name !== 'string') {
      throw new Error(`Validator at index ${idx} missing 'name' (string)`);
    }
    if (typeof v.validate !== 'function') {
      throw new Error(`Validator '${v.name}' missing 'validate' function`);
    }
  });

  // Group validators by operation
  const validatorsByOperation: Record<OperationType, ValidatorDefinition[]> = {
    create: [],
    update: [],
    delete: [],
    createMany: [],
  };
  const allOperationsValidators: ValidatorDefinition[] = [];

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

    apply(repo: RepositoryInstance): void {
      const getValidatorsForOperation = (operation: OperationType): ValidatorDefinition[] => {
        const specific = validatorsByOperation[operation] || [];
        return [...allOperationsValidators, ...specific];
      };

      const runValidators = async (operation: OperationType, context: RepositoryContext): Promise<void> => {
        const operationValidators = getValidatorsForOperation(operation);
        const errors: Array<{ validator: string; error: string }> = [];

        for (const validator of operationValidators) {
          try {
            await validator.validate(context, repo);
          } catch (error) {
            if (stopOnFirstError) {
              throw error;
            }
            errors.push({
              validator: validator.name,
              error: (error as Error).message || String(error),
            });
          }
        }

        if (errors.length > 0) {
          const err = createError(
            400,
            `Validation failed: ${errors.map(e => `[${e.validator}] ${e.error}`).join('; ')}`
          ) as HttpError;
          err.validationErrors = errors;
          throw err;
        }
      };

      repo.on('before:create', async (context: RepositoryContext) => runValidators('create', context));
      repo.on('before:createMany', async (context: RepositoryContext) => runValidators('createMany', context));
      repo.on('before:update', async (context: RepositoryContext) => runValidators('update', context));
      repo.on('before:delete', async (context: RepositoryContext) => runValidators('delete', context));
    },
  };
}

/**
 * Block operation if condition is true
 * 
 * @example
 * blockIf('block-library', ['delete'], ctx => ctx.data?.managed, 'Cannot delete managed records')
 */
export function blockIf(
  name: string,
  operations: OperationType[],
  condition: (context: RepositoryContext) => boolean,
  errorMessage: string
): ValidatorDefinition {
  return {
    name,
    operations,
    validate: (context: RepositoryContext) => {
      if (condition(context)) {
        throw createError(403, errorMessage);
      }
    },
  };
}

/**
 * Require a field to be present
 */
export function requireField(
  field: string,
  operations: OperationType[] = ['create']
): ValidatorDefinition {
  return {
    name: `require-${field}`,
    operations,
    validate: (context: RepositoryContext) => {
      if (!context.data || context.data[field] === undefined || context.data[field] === null) {
        throw createError(400, `Field '${field}' is required`);
      }
    },
  };
}

/**
 * Auto-inject a value if not present
 */
export function autoInject(
  field: string,
  getter: (context: RepositoryContext) => unknown,
  operations: OperationType[] = ['create']
): ValidatorDefinition {
  return {
    name: `auto-inject-${field}`,
    operations,
    validate: (context: RepositoryContext) => {
      if (context.data && !(field in context.data)) {
        const value = getter(context);
        if (value !== null && value !== undefined) {
          context.data[field] = value;
        }
      }
    },
  };
}

/**
 * Make a field immutable (cannot be updated)
 */
export function immutableField(field: string): ValidatorDefinition {
  return {
    name: `immutable-${field}`,
    operations: ['update'],
    validate: (context: RepositoryContext) => {
      if (context.data && field in context.data) {
        throw createError(400, `Field '${field}' cannot be modified`);
      }
    },
  };
}

/**
 * Ensure field value is unique
 */
export function uniqueField(field: string, errorMessage?: string): ValidatorDefinition {
  return {
    name: `unique-${field}`,
    operations: ['create', 'update'],
    validate: async (context: RepositoryContext, repo?: RepositoryInstance) => {
      if (!context.data || !context.data[field] || !repo) return;

      const query = { [field]: context.data[field] };
      
      // Use repo's getByQuery method
      const getByQuery = (repo as Record<string, Function>).getByQuery;
      if (typeof getByQuery !== 'function') return;

      const existing = await getByQuery.call(repo, query, {
        select: '_id',
        lean: true,
        throwOnNotFound: false,
      }) as Record<string, unknown> | null;

      if (existing && String(existing._id) !== String(context.id)) {
        throw createError(409, errorMessage || `${field} already exists`);
      }
    },
  };
}

export default validationChainPlugin;
