/**
 * Cascade Delete Plugin
 * Automatically deletes related documents when a parent document is deleted
 *
 * @example
 * ```typescript
 * import mongoose from 'mongoose';
 * import { Repository, cascadePlugin, methodRegistryPlugin } from '@classytic/mongokit';
 *
 * const productRepo = new Repository(Product, [
 *   methodRegistryPlugin(),
 *   cascadePlugin({
 *     relations: [
 *       { model: 'StockEntry', foreignKey: 'product' },
 *       { model: 'StockMovement', foreignKey: 'product' },
 *     ]
 *   })
 * ]);
 *
 * // When a product is deleted, all related StockEntry and StockMovement docs are also deleted
 * await productRepo.delete(productId);
 * ```
 */

import mongoose from 'mongoose';
import type { Plugin, RepositoryInstance, RepositoryContext, CascadeOptions, CascadeRelation } from '../types.js';

/**
 * Cascade delete plugin
 *
 * Deletes related documents after the parent document is deleted.
 * Works with both hard delete and soft delete scenarios.
 *
 * @param options - Cascade configuration
 * @returns Plugin
 */
export function cascadePlugin(options: CascadeOptions): Plugin {
  const { relations, parallel = true, logger } = options;

  if (!relations || relations.length === 0) {
    throw new Error('cascadePlugin requires at least one relation');
  }

  return {
    name: 'cascade',

    apply(repo: RepositoryInstance): void {
      repo.on('after:delete', async (payload: { context: RepositoryContext; result?: unknown }) => {
        const { context } = payload;
        const deletedId = context.id;

        if (!deletedId) {
          logger?.warn?.('Cascade delete skipped: no document ID in context', {
            model: context.model,
          });
          return;
        }

        const isSoftDelete = (context as Record<string, unknown>).softDeleted === true;

        const cascadeDelete = async (relation: CascadeRelation) => {
          const RelatedModel = mongoose.models[relation.model];

          if (!RelatedModel) {
            logger?.warn?.(`Cascade delete skipped: model '${relation.model}' not found`, {
              parentModel: context.model,
              parentId: String(deletedId),
            });
            return;
          }

          const query = { [relation.foreignKey]: deletedId };

          try {
            // Determine if we should soft delete or hard delete
            const shouldSoftDelete = relation.softDelete ?? isSoftDelete;

            if (shouldSoftDelete) {
              // Soft delete - set deletedAt timestamp
              const updateResult = await RelatedModel.updateMany(
                query,
                {
                  deletedAt: new Date(),
                  ...(context.user ? { deletedBy: context.user._id || context.user.id } : {}),
                },
                { session: context.session }
              );

              logger?.info?.(`Cascade soft-deleted ${updateResult.modifiedCount} documents`, {
                parentModel: context.model,
                parentId: String(deletedId),
                relatedModel: relation.model,
                foreignKey: relation.foreignKey,
                count: updateResult.modifiedCount,
              });
            } else {
              // Hard delete
              const deleteResult = await RelatedModel.deleteMany(query, {
                session: context.session,
              });

              logger?.info?.(`Cascade deleted ${deleteResult.deletedCount} documents`, {
                parentModel: context.model,
                parentId: String(deletedId),
                relatedModel: relation.model,
                foreignKey: relation.foreignKey,
                count: deleteResult.deletedCount,
              });
            }
          } catch (error) {
            logger?.error?.(`Cascade delete failed for model '${relation.model}'`, {
              parentModel: context.model,
              parentId: String(deletedId),
              relatedModel: relation.model,
              foreignKey: relation.foreignKey,
              error: (error as Error).message,
            });
            // Re-throw to propagate the error
            throw error;
          }
        };

        // Execute cascade deletes
        if (parallel) {
          await Promise.all(relations.map(cascadeDelete));
        } else {
          for (const relation of relations) {
            await cascadeDelete(relation);
          }
        }
      });

      // Also handle deleteMany if batch-operations plugin is used
      repo.on('after:deleteMany', async (payload: { context: RepositoryContext; result?: { deletedCount?: number } }) => {
        const { context, result } = payload;
        const query = context.query as Record<string, unknown>;

        if (!query || Object.keys(query).length === 0) {
          logger?.warn?.('Cascade deleteMany skipped: empty query', {
            model: context.model,
          });
          return;
        }

        // Find IDs of documents that were deleted
        // Note: This requires the documents to still exist, which they won't after hard delete
        // For deleteMany cascade, we need to query before delete (handled by before:deleteMany)
        logger?.warn?.('Cascade deleteMany: use before:deleteMany hook for complete cascade support', {
          model: context.model,
        });
      });

      // For deleteMany, we need to capture IDs before deletion
      repo.on('before:deleteMany', async (context: RepositoryContext) => {
        const query = context.query as Record<string, unknown>;

        if (!query || Object.keys(query).length === 0) {
          return;
        }

        // Find all IDs that will be deleted
        const docs = await repo.Model.find(query, { _id: 1 }).lean().session(context.session ?? null);
        const ids = docs.map((doc: { _id: unknown }) => doc._id);

        // Store IDs in context for after:deleteMany
        (context as Record<string, unknown>)._cascadeIds = ids;
      });

      // Handle cascade after deleteMany using stored IDs
      const originalAfterDeleteMany = repo._hooks.get('after:deleteMany') || [];
      repo._hooks.set('after:deleteMany', [
        ...originalAfterDeleteMany,
        async (payload: { context: RepositoryContext }) => {
          const { context } = payload;
          const ids = (context as Record<string, unknown>)._cascadeIds as unknown[];

          if (!ids || ids.length === 0) {
            return;
          }

          const isSoftDelete = (context as Record<string, unknown>).softDeleted === true;

          const cascadeDeleteMany = async (relation: CascadeRelation) => {
            const RelatedModel = mongoose.models[relation.model];

            if (!RelatedModel) {
              logger?.warn?.(`Cascade deleteMany skipped: model '${relation.model}' not found`, {
                parentModel: context.model,
              });
              return;
            }

            const query = { [relation.foreignKey]: { $in: ids } };
            const shouldSoftDelete = relation.softDelete ?? isSoftDelete;

            try {
              if (shouldSoftDelete) {
                const updateResult = await RelatedModel.updateMany(
                  query,
                  {
                    deletedAt: new Date(),
                    ...(context.user ? { deletedBy: context.user._id || context.user.id } : {}),
                  },
                  { session: context.session }
                );

                logger?.info?.(`Cascade soft-deleted ${updateResult.modifiedCount} documents (bulk)`, {
                  parentModel: context.model,
                  parentCount: ids.length,
                  relatedModel: relation.model,
                  foreignKey: relation.foreignKey,
                  count: updateResult.modifiedCount,
                });
              } else {
                const deleteResult = await RelatedModel.deleteMany(query, {
                  session: context.session,
                });

                logger?.info?.(`Cascade deleted ${deleteResult.deletedCount} documents (bulk)`, {
                  parentModel: context.model,
                  parentCount: ids.length,
                  relatedModel: relation.model,
                  foreignKey: relation.foreignKey,
                  count: deleteResult.deletedCount,
                });
              }
            } catch (error) {
              logger?.error?.(`Cascade deleteMany failed for model '${relation.model}'`, {
                parentModel: context.model,
                relatedModel: relation.model,
                foreignKey: relation.foreignKey,
                error: (error as Error).message,
              });
              throw error;
            }
          };

          if (parallel) {
            await Promise.all(relations.map(cascadeDeleteMany));
          } else {
            for (const relation of relations) {
              await cascadeDeleteMany(relation);
            }
          }
        },
      ]);
    },
  };
}

export default cascadePlugin;
