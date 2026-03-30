/**
 * Soft Delete Plugin
 * Implements soft delete pattern - marks documents as deleted instead of removing
 */

import type { ClientSession, PopulateOptions } from 'mongoose';
import { HOOK_PRIORITY } from '../Repository.js';
import type {
  ObjectId,
  OffsetPaginationResult,
  Plugin,
  PopulateSpec,
  RepositoryContext,
  RepositoryInstance,
  SelectSpec,
  SoftDeleteFilterMode,
  SoftDeleteOptions,
  SortSpec,
} from '../types.js';
import { warn } from '../utils/logger.js';

/**
 * Build filter condition based on filter mode
 */
function buildDeletedFilter(
  deletedField: string,
  filterMode: SoftDeleteFilterMode,
  includeDeleted: boolean,
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
  filterMode: SoftDeleteFilterMode,
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
      // Warn about unique indexes that conflict with soft-delete
      // Unique indexes on soft-deleted models need partialFilterExpression
      // to allow re-creation of docs with the same unique value
      try {
        const schemaPaths = repo.Model.schema.paths;
        for (const [pathName, schemaType] of Object.entries(schemaPaths)) {
          if (pathName === '_id' || pathName === deletedField) continue;
          const pathOptions = (schemaType as { options?: { unique?: boolean } }).options;
          if (pathOptions?.unique) {
            warn(
              `[softDeletePlugin] Field '${pathName}' on model '${repo.Model.modelName}' has a unique index. ` +
                `With soft-delete enabled, deleted documents will block new documents with the same '${pathName}'. ` +
                `Fix: change to a compound partial index — ` +
                `{ ${pathName}: 1 }, { unique: true, partialFilterExpression: { ${deletedField}: null } }`,
            );
          }
        }
      } catch (err) {
        // Schema introspection is best-effort — don't block plugin init
        warn(
          `[softDeletePlugin] Schema introspection failed for ${repo.Model.modelName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Create TTL index if configured
      if (ttlDays !== undefined && ttlDays > 0) {
        const ttlSeconds = ttlDays * 24 * 60 * 60;
        repo.Model.collection
          .createIndex(
            { [deletedField]: 1 },
            {
              expireAfterSeconds: ttlSeconds,
              partialFilterExpression: { [deletedField]: { $type: 'date' } },
            },
          )
          .catch((err: Error & { code?: number }) => {
            // Error code 85/86: index already exists with same/different options — safe to ignore
            if (err.code !== 85 && err.code !== 86 && !err.message.includes('already exists')) {
              warn(`[softDeletePlugin] Failed to create TTL index: ${err.message}`);
            }
          });
      }

      // Hook: before:delete - Perform soft delete instead of hard delete
      // Uses findOneAndUpdate with context.query to respect tenant scoping
      // injected by multiTenantPlugin (prevents cross-tenant soft-delete)
      repo.on(
        'before:delete',
        async (context: RepositoryContext) => {
          if (options.soft !== false) {
            const updateData: Record<string, unknown> = {
              [deletedField]: new Date(),
            };

            if (context.user) {
              updateData[deletedByField] = context.user._id || context.user.id;
            }

            // Build query that includes both _id and any policy filters (e.g. tenant scoping)
            const deleteQuery = { _id: context.id, ...(context.query || {}) };
            const result = await repo.Model.findOneAndUpdate(deleteQuery, updateData, {
              session: context.session,
            });

            if (!result) {
              const error = new Error(`Document with id '${context.id}' not found`) as Error & {
                status: number;
              };
              error.status = 404;
              throw error;
            }

            context.softDeleted = true;
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:getAll - Filter out deleted documents
      repo.on(
        'before:getAll',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );

            if (Object.keys(deleteFilter).length > 0) {
              // Set filters directly on context - Repository.getAll reads from context.filters
              const existingFilters = context.filters || {};
              context.filters = {
                ...existingFilters,
                ...deleteFilter,
              };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:getById - Filter out deleted documents
      repo.on(
        'before:getById',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );

            if (Object.keys(deleteFilter).length > 0) {
              context.query = {
                ...(context.query || {}),
                ...deleteFilter,
              };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:getByQuery - Filter out deleted documents
      repo.on(
        'before:getByQuery',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );

            if (Object.keys(deleteFilter).length > 0) {
              context.query = {
                ...(context.query || {}),
                ...deleteFilter,
              };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:count - Filter out deleted documents
      repo.on(
        'before:count',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );
            if (Object.keys(deleteFilter).length > 0) {
              context.query = { ...(context.query || {}), ...deleteFilter };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:exists - Filter out deleted documents
      repo.on(
        'before:exists',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );
            if (Object.keys(deleteFilter).length > 0) {
              context.query = { ...(context.query || {}), ...deleteFilter };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:getOrCreate - Filter out deleted documents
      repo.on(
        'before:getOrCreate',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );
            if (Object.keys(deleteFilter).length > 0) {
              context.query = { ...(context.query || {}), ...deleteFilter };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:distinct - Filter out deleted documents
      repo.on(
        'before:distinct',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );
            if (Object.keys(deleteFilter).length > 0) {
              context.query = { ...(context.query || {}), ...deleteFilter };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:updateMany - Exclude soft-deleted documents from batch updates
      repo.on(
        'before:updateMany',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );
            if (Object.keys(deleteFilter).length > 0) {
              context.query = { ...(context.query || {}), ...deleteFilter };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:deleteMany - Convert hard-delete to soft-delete via updateMany
      repo.on(
        'before:deleteMany',
        async (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(deletedField, filterMode, false);
            const finalQuery = { ...(context.query || {}), ...deleteFilter };

            await repo.Model.updateMany(
              finalQuery,
              {
                $set: { [deletedField]: new Date() },
              },
              { session: context.session },
            );

            context.softDeleted = true;
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:aggregate - Inject soft-delete filter via context.query
      repo.on(
        'before:aggregate',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );
            if (Object.keys(deleteFilter).length > 0) {
              context.query = { ...(context.query || {}), ...deleteFilter };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Hook: before:aggregatePaginate - Filter out deleted documents
      repo.on(
        'before:aggregatePaginate',
        (context: RepositoryContext) => {
          if (options.soft !== false) {
            const deleteFilter = buildDeletedFilter(
              deletedField,
              filterMode,
              !!context.includeDeleted,
            );
            if (Object.keys(deleteFilter).length > 0) {
              context.filters = { ...(context.filters || {}), ...deleteFilter };
            }
          }
        },
        { priority: HOOK_PRIORITY.POLICY },
      );

      // Add restore method
      if (addRestoreMethod) {
        const restoreMethod = async function (
          this: RepositoryInstance,
          id: string | ObjectId,
          restoreOptions: { session?: ClientSession; [key: string]: unknown } = {},
        ): Promise<unknown> {
          // Route through _buildContext so policy hooks (multi-tenant) can inject tenant filters
          const _buildContext = (this as Record<string, Function>)._buildContext;
          const context = (await _buildContext.call(this, 'restore', {
            id,
            ...restoreOptions,
          })) as RepositoryContext;

          const updateData: Record<string, unknown> = {
            [deletedField]: null,
            [deletedByField]: null,
          };

          // Use findOneAndUpdate with combined query { _id, ...context.query }
          // so tenant scoping from multi-tenant plugin is enforced
          const restoreQuery = { _id: id, ...(context.query || {}) };
          const result = await this.Model.findOneAndUpdate(
            restoreQuery,
            { $set: updateData },
            {
              returnDocument: 'after',
              session: restoreOptions.session,
            },
          );

          if (!result) {
            const error = new Error(`Document with id '${id}' not found`) as Error & {
              status: number;
            };
            error.status = 404;
            throw error;
          }

          await this.emitAsync('after:restore', { id, result, context });

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
            [key: string]: unknown;
          } = {},
          getDeletedOptions: {
            select?: SelectSpec;
            populate?: PopulateSpec;
            lean?: boolean;
            session?: ClientSession;
            [key: string]: unknown;
          } = {},
        ): Promise<OffsetPaginationResult<unknown>> {
          // Route through _buildContext so policy hooks (multi-tenant) inject tenant filters.
          // We spread both params and options so organizationId (etc.) is at top-level for multi-tenant.
          const _buildContext = (this as Record<string, Function>)._buildContext;
          const context = (await _buildContext.call(this, 'getDeleted', {
            ...params,
            ...getDeletedOptions,
          })) as RepositoryContext;

          const deletedFilter = buildGetDeletedFilter(deletedField, filterMode);
          // Merge: user filters + deleted filter + tenant filters from context
          const combinedFilters = {
            ...(params.filters || {}),
            ...deletedFilter,
            // context.filters is set by multi-tenant plugin for filter-based ops
            ...(context.filters || {}),
            // context.query is set by multi-tenant plugin for query-based ops
            ...(context.query || {}),
          };

          const page = params.page || 1;
          const limit = params.limit || 20;
          const skip = (page - 1) * limit;

          // Parse sort
          let sortSpec: SortSpec = { [deletedField]: -1 }; // Default: most recently deleted first
          if (params.sort) {
            if (typeof params.sort === 'string') {
              const sortOrder = params.sort.startsWith('-') ? -1 : 1;
              const sortField = params.sort.startsWith('-')
                ? params.sort.substring(1)
                : params.sort;
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
              query = query.populate(populateSpec.split(',').map((p) => p.trim()));
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

/**
 * TypeScript interface for soft delete plugin methods
 *
 * @example
 * ```typescript
 * import type { SoftDeleteMethods } from '@classytic/mongokit';
 *
 * type UserRepoWithSoftDelete = UserRepo & SoftDeleteMethods<IUser>;
 *
 * const userRepo = new UserRepo(UserModel, [
 *   methodRegistryPlugin(),
 *   softDeletePlugin({ deletedField: 'deletedAt' }),
 * ]) as UserRepoWithSoftDelete;
 *
 * // TypeScript autocomplete for soft delete methods
 * await userRepo.restore(userId);
 * const deleted = await userRepo.getDeleted({ page: 1, limit: 20 });
 * ```
 */
export interface SoftDeleteMethods<TDoc> {
  /**
   * Restore a soft-deleted document
   * @param id - Document ID to restore
   * @param options - Optional restore options
   * @returns Restored document
   */
  restore(id: string | ObjectId, options?: { session?: ClientSession }): Promise<TDoc>;

  /**
   * Get paginated list of soft-deleted documents
   * @param params - Query parameters (filters, sort, pagination)
   * @param options - Query options (select, populate, lean, session)
   * @returns Paginated result of deleted documents
   */
  getDeleted(
    params?: {
      filters?: Record<string, unknown>;
      sort?: SortSpec | string;
      page?: number;
      limit?: number;
    },
    options?: {
      select?: SelectSpec;
      populate?: PopulateSpec;
      lean?: boolean;
      session?: ClientSession;
    },
  ): Promise<OffsetPaginationResult<TDoc>>;
}

export default softDeletePlugin;
