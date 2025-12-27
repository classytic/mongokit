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

export { LookupBuilder, type LookupOptions } from './LookupBuilder.js';
export { AggregationBuilder } from './AggregationBuilder.js';
export { QueryParser, type ParsedQuery, type QueryParserOptions, type FilterQuery } from './QueryParser.js';

// Re-export commonly used types
export type { PipelineStage } from 'mongoose';
export type { SortSpec } from '../types.js';
