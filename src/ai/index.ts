/**
 * MongoKit AI Module
 *
 * Vector search, embedding management, and semantic similarity.
 * Requires MongoDB Atlas for $vectorSearch; provides types for any setup.
 */

export type {
  BatchEmbedFn,
  EmbeddingInput,
  EmbedFn,
  ScoredResult,
  SimilarityMetric,
  VectorFieldConfig,
  VectorPluginOptions,
  VectorSearchParams,
} from './types.js';
export type { VectorMethods } from './vector.plugin.js';
export { buildVectorSearchPipeline, vectorPlugin } from './vector.plugin.js';
