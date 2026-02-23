/**
 * AI/Vector Search Type Definitions
 *
 * Types for vector embedding storage, search, and similarity operations.
 * Requires MongoDB Atlas for `$vectorSearch` aggregation.
 */

import type { ClientSession, PipelineStage } from 'mongoose';

/** Supported similarity metrics for vector search */
export type SimilarityMetric = 'cosine' | 'euclidean' | 'dotProduct';

// ============================================================================
// Embedding Input — unified, multimodal-ready
// ============================================================================

/** A single piece of content to embed — text, image, or any media */
export interface EmbeddingInput {
  /** Text content to embed */
  text?: string;
  /** Image URL or base64 data (for multimodal models like CLIP, Jina v3) */
  image?: string;
  /** Audio URL or base64 data */
  audio?: string;
  /** Arbitrary media — for custom model inputs (video frames, PDFs, etc.) */
  media?: Record<string, unknown>;
}

/**
 * Unified embedding function — receives structured input, returns vector.
 * Works for text-only, multimodal, or any custom model.
 *
 * @example
 * ```typescript
 * // Text-only (OpenAI)
 * const embed: EmbedFn = async ({ text }) =>
 *   openai.embeddings.create({ input: text!, model: 'text-embedding-3-small' })
 *     .then(r => r.data[0].embedding);
 *
 * // Multimodal (Jina CLIP v3)
 * const embed: EmbedFn = async ({ text, image }) =>
 *   jina.embed({ input: [{ text, image }] }).then(r => r.data[0].embedding);
 *
 * // Local model
 * const embed: EmbedFn = async ({ text }) =>
 *   fetch('http://localhost:11434/api/embeddings', {
 *     method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text', prompt: text })
 *   }).then(r => r.json()).then(j => j.embedding);
 * ```
 */
export type EmbedFn = (input: EmbeddingInput) => Promise<number[]>;

/**
 * Batch embedding function — same contract, multiple inputs at once.
 * Falls back to sequential EmbedFn calls if not provided.
 */
export type BatchEmbedFn = (inputs: EmbeddingInput[]) => Promise<number[][]>;

// ============================================================================
// Field Configuration
// ============================================================================

/** Vector field configuration for a model */
export interface VectorFieldConfig {
  /** Field path where the vector is stored (e.g., 'embedding') */
  path: string;
  /** Atlas Search index name for this field */
  index: string;
  /** Number of dimensions in the embedding */
  dimensions: number;
  /** Similarity metric used by the index (informational — the index defines this) */
  similarity?: SimilarityMetric;
  /** Text source fields to embed from (e.g., ['title', 'description']) */
  sourceFields?: string[];
  /** Image/media source fields (e.g., ['imageUrl', 'thumbnailUrl']) */
  mediaFields?: string[];
}

// ============================================================================
// Search Parameters & Results
// ============================================================================

/** Options for vector search operations */
export interface VectorSearchParams {
  /** Query — vector, text string, or structured multimodal input */
  query: number[] | string | EmbeddingInput;
  /** Maximum number of results */
  limit?: number;
  /** Candidates to consider (higher = more accurate, slower). Default: limit * 10 */
  numCandidates?: number;
  /** Pre-filter documents before vector search */
  filter?: Record<string, unknown>;
  /** Use exact KNN instead of approximate (slower but precise) */
  exact?: boolean;
  /** Which vector field config to use (default: first configured) */
  field?: string;
  /** MongoDB session for transactions */
  session?: ClientSession;
  /** Fields to include/exclude in results */
  project?: Record<string, 0 | 1>;
  /** Include similarity score in results */
  includeScore?: boolean;
  /** Minimum score threshold (0-1 for cosine) */
  minScore?: number;
  /** Additional pipeline stages to append after search */
  postPipeline?: PipelineStage[];
}

/** Vector search result with score */
export interface ScoredResult<T = Record<string, unknown>> {
  /** The matched document */
  doc: T;
  /** Similarity score from vector search */
  score: number;
}

// ============================================================================
// Plugin Options
// ============================================================================

/** Options for the vector search plugin */
export interface VectorPluginOptions {
  /** Vector field configurations */
  fields: VectorFieldConfig[];
  /** Unified embedding function (text, image, multimodal) */
  embedFn?: EmbedFn;
  /** Batch embedding function for bulk operations */
  batchEmbedFn?: BatchEmbedFn;
  /** Auto-generate embeddings on create/update (requires embedFn) */
  autoEmbed?: boolean;
  /**
   * Called when auto-embed fails (e.g., embedding service down).
   * If provided, the write operation continues without an embedding.
   * If not provided, the error propagates and blocks the write.
   */
  onEmbedError?: (error: Error, doc: unknown) => void;
}
