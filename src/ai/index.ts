/**
 * MongoKit AI Module
 *
 * Vector search, embedding management, and semantic similarity.
 * Requires MongoDB Atlas for $vectorSearch; provides types for any setup.
 */

export { vectorPlugin, buildVectorSearchPipeline } from './vector.plugin.js';
export type { VectorMethods } from './vector.plugin.js';
export type {
  VectorPluginOptions,
  VectorFieldConfig,
  VectorSearchParams,
  ScoredResult,
  SimilarityMetric,
  EmbedFn,
  BatchEmbedFn,
  EmbeddingInput,
} from './types.js';
