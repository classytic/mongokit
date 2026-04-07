/**
 * Query Utilities - Modern MongoDB Query Building
 *
 * Standalone utilities for building complex MongoDB queries:
 * - LookupBuilder: $lookup aggregation for custom field joins
 * - AggregationBuilder: Fluent API for aggregation pipelines
 * - QueryParser: URL parameters to MongoDB queries
 *
 * All utilities can be used independently without Repository class.
 */

// Re-export commonly used types
export type { PipelineStage } from 'mongoose';
export type { SortSpec } from '../types.js';
export { AggregationBuilder } from './AggregationBuilder.js';
export { LookupBuilder, type LookupOptions } from './LookupBuilder.js';
// Primitives are NOT re-exported from this barrel — import them directly
// from `./primitives/{geo,coercion,indexes}` to keep tree-shaking optimal.
export {
  type FieldType,
  type FilterQuery,
  type ParsedQuery,
  type PopulateOption,
  QueryParser,
  type QueryParserOptions,
  type SchemaLike,
  type SearchMode,
} from './QueryParser.js';
