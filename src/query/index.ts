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
export type { SortSpec } from '../types/core.js';
/**
 * `AggregationBuilder.sort()` accepts a WIDER spec than the repository-level
 * `SortSpec` above: it also takes `'asc' | 'desc'`, which it normalizes to
 * `1 | -1` before emitting `$sort`.
 *
 * Both names are exported because the builder is public and these types are in
 * its parameter position — without them a host can pass `{ name: 'asc' }` as a
 * literal but cannot declare a variable to hold it, since the `SortSpec` above
 * is the narrow `Record<string, 1 | -1>` and rejects `'asc'`. Aliased rather
 * than re-exported flat, so the two never collide under one name.
 */
export type {
  AggregationPlan,
  GroupSpec,
  ProjectionSpec,
  SortOrder as AggregationSortOrder,
  SortSpec as AggregationSortSpec,
  VectorSearchOptions,
} from './AggregationBuilder.js';
export { AggregationBuilder } from './AggregationBuilder.js';
export { LookupBuilder, type LookupOptions } from './LookupBuilder.js';
// Return type of `QueryParser.getQuerySchema()` — exported so a host can hold it.
export type { QuerySchema } from './parser/schema-docs.js';
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
