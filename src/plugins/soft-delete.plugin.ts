/**
 * Soft Delete Plugin
 * Implements soft delete pattern - marks documents as deleted instead of removing
 */

import type { ClientSession, PopulateOptions } from 'mongoose';
import type {
  Plugin,
  RepositoryContext,
  RepositoryInstance,
  SoftDeleteOptions,
  SoftDeleteFilterMode,
  OffsetPaginationResult,
  SortSpec,
  SelectSpec,
  PopulateSpec,
  ObjectId,
} from '../types.js';

/**
 * Build filter condition based on filter mode
 */
function buildDeletedFilter(
  deletedField: string,
  filterMode: SoftDeleteFilterMode,
  includeDeleted: boolean
): Record<string, unknown> {
  if (includeDeleted) {
    return {};
  }

  if (filterMode === 'exists') {
    // Legacy behavior: filter where field doesn't exist
    return { [deletedField]: { $exists: false } };
  }

  // Default 'null' mode: filter where field is null (works with default: null in schema)
  return { [deletedField]: null };
}

/**
 * Build filter condition for finding deleted documents
 */
function buildGetDeletedFilter(
  deletedField: string,
  filterMode: SoftDeleteFilterMode
): Record<string, unknown> {
  if (filterMode === 'exists') {
    // Legacy behavior: deleted docs have the field set
    return { [deletedField]: { $exists: true, $ne: null } };
  }

  // Default 'null' mode: deleted docs have non-null value
  return { [deletedField]: { $ne: null } };
}

/**
 * Soft delete plugin
 *
 * @example Basic usage
 * ```typescript
 * const repo = new Repository(Model, [
 *   softDeletePlugin({ deletedField: 'deletedAt' })
 * ]);
 *
 * // Delete (soft)
 * await repo.delete(id);
 *
 * // Restore
 * await repo.restore(id);
 *
 * // Get deleted documents
 * await repo.getDeleted({ page: 1, limit: 20 });
 * ```
 *
 * @example With null filter mode (for schemas with default: null)
 * ```typescript
 * // Schema: { deletedAt: { type: Date, default: null } }
 * const repo = new Repository(Model, [
 *   softDeletePlugin({
 *     deletedField: 'deletedAt',
 *     filterMode: 'null', // default - works with default: null
 *   })
 * ]);
 * ```
 *
 * @example With TTL for auto-cleanup
 * ```typescript
 * const repo = new Repository(Model, [
 *   softDeletePlugin({
 *     deletedField: 'deletedAt',
 *     ttlDays: 30, // Auto-delete after 30 days
 *   })
 * ]);
 * ```
 */
export function softDeletePlugin(options: SoftDeleteOptions = {}): Plugin {
  const deletedField = options.deletedField || 'deletedAt';
  const deletedByField = options.deletedByField || 'deletedBy';
  const filterMode: SoftDeleteFilterMode = options.filterMode || 'null';
  const addRestoreMethod = options.addRestoreMethod !== false;
  const addGetDeletedMethod = options.addGetDeletedMethod !== false;
  const ttlDays = options.ttlDays;

  return {
    name: 'softDelete',

    apply(repo: RepositoryInstance): void {
      // Create TTL index if configured
      if (ttlDays !== undefined && ttlDays > 0) {
        const ttlSeconds = ttlDays * 24 * 60 * 60;
        repo.Model.collection
          .createIndex(
            { [deletedField]: 1 },
            {
              expireAfterSeconds: ttlSeconds,
              partialFilterExpression: { [deletedField]: { $type: 'date' } },
            }
          )
          .catch((err: Error) => {
            // Index might already exist, which is fine
            if (!err.message.includes('already exists')) {
              console.warn(`[softDeletePlugin] Failed to create TTL index: ${err.message}`);
            }
          });
      }

      // Hook: before:delete - Perform soft delete instead of hard delete
      repo.on('before:delete', async (context: RepositoryContext) => {
        if (options.soft !== false) {
          const updateData: Record<string, unknown> = {
            [deletedField]: new Date(),
          };

          if (context.user) {
            updateData[deletedByField] = context.user._id || context.user.id;
          }

          await repo.Model.findByIdAndUpdate(context.id, updateData, { session: context.session });

          (context as Record<string, unknown>).softDeleted = true;
        }
      });

      // Hook: before:getAll - Filter out deleted documents
      repo.on('before:getAll', (context: RepositoryContext) => {
        if (options.soft !== false) {
          const deleteFilter = buildDeletedFilter(deletedField, filterMode, !!context.includeDeleted);

          if (Object.keys(deleteFilter).length > 0) {
            // Set filters directly on context - Repository.getAll reads from context.filters
            const existingFilters = (context as Record<string, unknown>).filters as Record<string, unknown> || {};
            (context as Record<string, unknown>).filters = {
              ...existingFilters,
              ...deleteFilter,
            };
          }
        }
      });

      // Hook: before:getById - Filter out deleted documents
      repo.on('before:getById', (context: RepositoryContext) => {
        if (options.soft !== false) {
          const deleteFilter = buildDeletedFilter(deletedField, filterMode, !!context.includeDeleted);

          if (Object.keys(deleteFilter).length > 0) {
            context.query = {
              ...(context.query || {}),
              ...deleteFilter,
            };
          }
        }
      });

      // Hook: before:getByQuery - Filter out deleted documents
      repo.on('before:getByQuery', (context: RepositoryContext) => {
        if (options.soft !== false) {
          const deleteFilter = buildDeletedFilter(deletedField, filterMode, !!context.includeDeleted);

          if (Object.keys(deleteFilter).length > 0) {
            context.query = {
              ...(context.query || {}),
              ...deleteFilter,
            };
          }
        }
      });

      // Add restore method
      if (addRestoreMethod) {
        const restoreMethod = async function (
          this: RepositoryInstance,
          id: string | ObjectId,
          restoreOptions: { session?: ClientSession } = {}
        ): Promise<unknown> {
          const updateData: Record<string, unknown> = {
            [deletedField]: null,
            [deletedByField]: null,
          };

          const result = await this.Model.findByIdAndUpdate(id, { $set: updateData }, {
            new: true,
            session: restoreOptions.session,
          });

          if (!result) {
            const error = new Error(`Document with id '${id}' not found`) as Error & { status: number };
            error.status = 404;
            throw error;
          }

          await this.emitAsync('after:restore', { id, result });

          return result;
        };

        // Register method if methodRegistryPlugin is available, otherwise attach directly
        if (typeof repo.registerMethod === 'function') {
          repo.registerMethod('restore', restoreMethod);
        } else {
          repo.restore = restoreMethod.bind(repo);
        }
      }

      // Add getDeleted method
      if (addGetDeletedMethod) {
        const getDeletedMethod = async function (
          this: RepositoryInstance,
          params: {
            filters?: Record<string, unknown>;
            sort?: SortSpec | string;
            page?: number;
            limit?: number;
          } = {},
          getDeletedOptions: {
            select?: SelectSpec;
            populate?: PopulateSpec;
            lean?: boolean;
            session?: ClientSession;
          } = {}
        ): Promise<OffsetPaginationResult<unknown>> {
          const deletedFilter = buildGetDeletedFilter(deletedField, filterMode);
          const combinedFilters = {
            ...(params.filters || {}),
            ...deletedFilter,
          };

          const page = params.page || 1;
          const limit = params.limit || 20;
          const skip = (page - 1) * limit;

          // Parse sort
          let sortSpec: SortSpec = { [deletedField]: -1 }; // Default: most recently deleted first
          if (params.sort) {
            if (typeof params.sort === 'string') {
              const sortOrder = params.sort.startsWith('-') ? -1 : 1;
              const sortField = params.sort.startsWith('-') ? params.sort.substring(1) : params.sort;
              sortSpec = { [sortField]: sortOrder };
            } else {
              sortSpec = params.sort;
            }
          }

          // Build query
          let query = this.Model.find(combinedFilters)
            .sort(sortSpec as Record<string, 1 | -1>)
            .skip(skip)
            .limit(limit);

          if (getDeletedOptions.session) {
            query = query.session(getDeletedOptions.session);
          }

          if (getDeletedOptions.select) {
            const selectValue = Array.isArray(getDeletedOptions.select)
              ? getDeletedOptions.select.join(' ')
              : getDeletedOptions.select;
            query = query.select(selectValue as string);
          }

          if (getDeletedOptions.populate) {
            const populateSpec = getDeletedOptions.populate;
            if (typeof populateSpec === 'string') {
              query = query.populate(populateSpec.split(',').map(p => p.trim()));
            } else if (Array.isArray(populateSpec)) {
              query = query.populate(populateSpec as (string | PopulateOptions)[]);
            } else {
              query = query.populate(populateSpec);
            }
          }

          if (getDeletedOptions.lean !== false) {
            query = query.lean();
          }

          const [docs, total] = await Promise.all([
            query.exec(),
            this.Model.countDocuments(combinedFilters),
          ]);

          const pages = Math.ceil(total / limit);

          return {
            method: 'offset',
            docs,
            page,
            limit,
            total,
            pages,
            hasNext: page < pages,
            hasPrev: page > 1,
          };
        };

        // Register method if methodRegistryPlugin is available, otherwise attach directly
        if (typeof repo.registerMethod === 'function') {
          repo.registerMethod('getDeleted', getDeletedMethod);
        } else {
          repo.getDeleted = getDeletedMethod.bind(repo);
        }
      }
    },
  };
}

export default softDeletePlugin;
