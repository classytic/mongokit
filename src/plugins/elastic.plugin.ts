/**
 * Elastic/OpenSearch Plugin for MongoKit
 *
 * Executes search in external engine (ES/OpenSearch), retrieves IDs + scores,
 * fetches original documents from MongoDB by IDs, and preserves the ranking order.
 *
 * Keeps OLTP operational queries running fast in MongoDB while delegating
 * heavy text/semantic search to a dedicated search engine.
 */

import type { Plugin, RepositoryInstance } from '../types.js';

export interface ElasticSearchOptions {
  /** Elasticsearch or OpenSearch client instance */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  /** Index name to perform search against */
  index: string;
  /** Field to extract MongoDB ID from the indexed document (default: '_id') */
  idField?: string;
}

export function elasticSearchPlugin(options: ElasticSearchOptions): Plugin {
  return {
    name: 'elastic-search',

    apply(repo: RepositoryInstance): void {
      if (!repo.registerMethod) {
        throw new Error(
          `[mongokit] elasticSearchPlugin requires methodRegistryPlugin to be registered first. ` +
            `Add methodRegistryPlugin() before elasticSearchPlugin() in your repository plugins array.`,
        );
      }

      repo.registerMethod(
        'search',
        async function (
          this: RepositoryInstance,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          searchQuery: any,
          searchOptions: {
            limit?: number;
            from?: number;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mongoOptions?: any; // e.g. select, populate, lean
          } = {},
        ) {
          const { client, index, idField = '_id' } = options;
          const limit = Math.min(Math.max(searchOptions.limit || 20, 1), 1000);
          const from = Math.max(searchOptions.from || 0, 0);

          // 1. Execute search in ES/OpenSearch
          const esResponse = await client.search({
            index,
            body: {
              query: searchQuery,
              size: limit,
              from,
            },
          });

          // Depending on client version, hits are in body or directly on response
          const hits = esResponse.hits?.hits || esResponse.body?.hits?.hits || [];
          if (hits.length === 0) {
            return { docs: [], total: 0, limit, from };
          }

          const totalValue =
            esResponse.hits?.total?.value ??
            esResponse.hits?.total ??
            esResponse.body?.hits?.total?.value ??
            esResponse.body?.hits?.total ??
            0;
          const total = typeof totalValue === 'number' ? totalValue : 0;

          // 2. Extract IDs and preserve ES ranking order
          const docsOrder = new Map<string, number>();
          const scores = new Map<string, number>();
          const ids: string[] = [];

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hits.forEach((hit: any, idx: number) => {
            const docId = hit._source?.[idField] || hit[idField] || hit._id;
            if (docId) {
              const strId = String(docId);
              docsOrder.set(strId, idx);
              if (hit._score !== undefined) scores.set(strId, hit._score);
              ids.push(strId);
            }
          });

          if (ids.length === 0) {
            return { docs: [], total, limit, from };
          }

          // 3. Fetch docs by IDs from Mongo — use idField for custom ID lookups
          const mongoIdField = ((repo as Record<string, unknown>).idField as string) || '_id';
          const mongoQuery = this.Model.find({ [mongoIdField]: { $in: ids } });

          if (searchOptions.mongoOptions?.select) {
            mongoQuery.select(searchOptions.mongoOptions.select);
          }
          if (searchOptions.mongoOptions?.populate) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mongoQuery.populate(searchOptions.mongoOptions.populate as any);
          }
          if (searchOptions.mongoOptions?.lean !== false) {
            mongoQuery.lean();
          }

          const unorderedDocs = await mongoQuery.exec();

          // 4. Preserve ES ranking order and optionally attach score
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const docs = unorderedDocs
            .sort((a: any, b: any) => {
              const aId = String(a[mongoIdField]);
              const bId = String(b[mongoIdField]);
              return (
                (docsOrder.get(aId) ?? Number.MAX_SAFE_INTEGER) -
                (docsOrder.get(bId) ?? Number.MAX_SAFE_INTEGER)
              );
            })
            .map((doc: any) => {
              const strId = String(doc[mongoIdField]);
              if (searchOptions.mongoOptions?.lean !== false) {
                return {
                  ...doc,
                  _score: scores.get(strId),
                };
              }
              // If strictly Mongoose documents, we just return them ordered
              return doc;
            });

          return { docs, total, limit, from };
        },
      );
    },
  };
}
