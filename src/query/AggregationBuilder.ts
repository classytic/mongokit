/**
 * AggregationBuilder - Fluent MongoDB Aggregation Pipeline Builder
 *
 * Modern, type-safe builder for complex MongoDB aggregations.
 * Supports MongoDB 6+ features with optimized query patterns.
 *
 * Features:
 * - Fluent, chainable API
 * - $lookup with custom field joins
 * - Faceted search
 * - Window functions ($setWindowFields)
 * - Atlas Search ($search)
 * - Atlas Vector Search ($vectorSearch)
 * - Union queries ($unionWith)
 * - Full aggregation operator support
 *
 * @example
 * ```typescript
 * const pipeline = new AggregationBuilder()
 *   .match({ status: 'active' })
 *   .lookup('departments', 'deptSlug', 'slug', 'department', true)
 *   .sort({ createdAt: -1 })
 *   .limit(50)
 *   .project({ password: 0 })
 *   .build();
 *
 * const results = await Model.aggregate(pipeline);
 * ```
 */

import type { Expression, Model, PipelineStage } from 'mongoose';
import { LookupBuilder, type LookupOptions } from './LookupBuilder.js';

/** Vector search similarity metrics */
export type VectorSimilarity = 'cosine' | 'euclidean' | 'dotProduct';

/** Options for $vectorSearch stage (Atlas only) */
export interface VectorSearchOptions {
  /** Atlas Search index name */
  index: string;
  /** Field path containing the vector embedding */
  path: string;
  /** Query vector to search against */
  queryVector: number[];
  /** Number of candidates to consider (higher = more accurate, slower) */
  numCandidates?: number;
  /** Max results to return */
  limit: number;
  /** Pre-filter documents before vector search */
  filter?: Record<string, unknown>;
  /** Use exact search instead of ANN (slower but precise) */
  exact?: boolean;
}

/** Result from build() including execution options */
export interface AggregationPlan {
  pipeline: PipelineStage[];
  allowDiskUse: boolean;
}

export type SortOrder = 1 | -1 | 'asc' | 'desc';
export type SortSpec = Record<string, SortOrder>;
export type ProjectionSpec = Record<string, 0 | 1 | Expression>;
export type GroupSpec = {
  _id: string | Record<string, unknown> | null;
  [key: string]: unknown;
};

/**
 * Normalize SortSpec to MongoDB's strict format (1 | -1)
 * Converts 'asc' -> 1, 'desc' -> -1
 */
function normalizeSortSpec(sortSpec: SortSpec): Record<string, 1 | -1> {
  const normalized: Record<string, 1 | -1> = {};
  for (const [field, order] of Object.entries(sortSpec)) {
    if (order === 'asc') {
      normalized[field] = 1;
    } else if (order === 'desc') {
      normalized[field] = -1;
    } else {
      normalized[field] = order as 1 | -1;
    }
  }
  return normalized;
}

/**
 * Fluent builder for MongoDB aggregation pipelines
 * Optimized for complex queries at scale
 */
export class AggregationBuilder {
  private pipeline: PipelineStage[] = [];
  private _diskUse = false;

  /**
   * Get the current pipeline
   */
  get(): PipelineStage[] {
    return [...this.pipeline];
  }

  /**
   * Build and return the final pipeline
   */
  build(): PipelineStage[] {
    return this.get();
  }

  /**
   * Build pipeline with execution options (allowDiskUse, etc.)
   */
  plan(): AggregationPlan {
    return { pipeline: this.get(), allowDiskUse: this._diskUse };
  }

  /**
   * Build and execute the pipeline against a model
   *
   * @example
   * ```typescript
   * const results = await new AggregationBuilder()
   *   .match({ status: 'active' })
   *   .allowDiskUse()
   *   .exec(MyModel);
   * ```
   */
  async exec<T = unknown>(
    model: Model<any>,
    session?: import('mongoose').ClientSession,
  ): Promise<T[]> {
    const agg = model.aggregate<T>(this.build());
    if (this._diskUse) agg.allowDiskUse(true);
    if (session) agg.session(session);
    return agg.exec();
  }

  /**
   * Reset the pipeline
   */
  reset(): this {
    this.pipeline = [];
    this._diskUse = false;
    return this;
  }

  /**
   * Add a raw pipeline stage
   */
  addStage(stage: PipelineStage): this {
    this.pipeline.push(stage);
    return this;
  }

  /**
   * Add multiple raw pipeline stages
   */
  addStages(stages: PipelineStage[]): this {
    this.pipeline.push(...stages);
    return this;
  }

  // ============================================================
  // CORE AGGREGATION STAGES
  // ============================================================

  /**
   * $match - Filter documents
   * IMPORTANT: Place $match as early as possible for performance
   */
  match(query: Record<string, unknown>): this {
    this.pipeline.push({ $match: query });
    return this;
  }

  /**
   * $project - Include/exclude fields or compute new fields
   */
  project(projection: ProjectionSpec): this {
    this.pipeline.push({ $project: projection });
    return this;
  }

  /**
   * $group - Group documents and compute aggregations
   *
   * @example
   * ```typescript
   * .group({
   *   _id: '$department',
   *   count: { $sum: 1 },
   *   avgSalary: { $avg: '$salary' }
   * })
   * ```
   */
  group(groupSpec: GroupSpec): this {
    this.pipeline.push({ $group: groupSpec });
    return this;
  }

  /**
   * $sort - Sort documents
   */
  sort(sortSpec: SortSpec | string): this {
    if (typeof sortSpec === 'string') {
      // Convert string like '-createdAt' to { createdAt: -1 }
      const order = sortSpec.startsWith('-') ? -1 : 1;
      const field = sortSpec.startsWith('-') ? sortSpec.substring(1) : sortSpec;
      this.pipeline.push({ $sort: { [field]: order } });
    } else {
      this.pipeline.push({ $sort: normalizeSortSpec(sortSpec) });
    }
    return this;
  }

  /**
   * $limit - Limit number of documents
   */
  limit(count: number): this {
    this.pipeline.push({ $limit: count });
    return this;
  }

  /**
   * $skip - Skip documents
   */
  skip(count: number): this {
    this.pipeline.push({ $skip: count });
    return this;
  }

  /**
   * $unwind - Deconstruct array field
   */
  unwind(path: string, preserveNullAndEmptyArrays: boolean = false): this {
    this.pipeline.push({
      $unwind: {
        path: path.startsWith('$') ? path : `$${path}`,
        preserveNullAndEmptyArrays,
      },
    });
    return this;
  }

  /**
   * $addFields - Add new fields or replace existing fields
   */
  addFields(fields: Record<string, unknown>): this {
    this.pipeline.push({ $addFields: fields });
    return this;
  }

  /**
   * $set - Alias for $addFields
   */
  set(fields: Record<string, unknown>): this {
    return this.addFields(fields);
  }

  /**
   * $unset - Remove fields
   */
  unset(fields: string | string[]): this {
    this.pipeline.push({ $unset: fields });
    return this;
  }

  /**
   * $replaceRoot - Replace the root document
   */
  replaceRoot(newRoot: string | Record<string, unknown>): this {
    this.pipeline.push({
      $replaceRoot: {
        newRoot: typeof newRoot === 'string' ? `$${newRoot}` : newRoot,
      },
    });
    return this;
  }

  // ============================================================
  // LOOKUP (JOINS)
  // ============================================================

  /**
   * $lookup - Join with another collection (simple form)
   *
   * @param from - Collection to join with
   * @param localField - Field from source collection
   * @param foreignField - Field from target collection
   * @param as - Output field name
   * @param single - Unwrap array to single object
   *
   * @example
   * ```typescript
   * // Join employees with departments by slug
   * .lookup('departments', 'deptSlug', 'slug', 'department', true)
   * ```
   */
  lookup(
    from: string,
    localField: string,
    foreignField: string,
    as?: string,
    single?: boolean,
  ): this {
    const stages = new LookupBuilder(from)
      .localField(localField)
      .foreignField(foreignField)
      .as(as || from)
      .single(single || false)
      .build();

    this.pipeline.push(...stages);
    return this;
  }

  /**
   * $lookup - Join with another collection (advanced form with pipeline)
   *
   * @example
   * ```typescript
   * .lookupWithPipeline({
   *   from: 'products',
   *   localField: 'productIds',
   *   foreignField: 'sku',
   *   as: 'products',
   *   pipeline: [
   *     { $match: { status: 'active' } },
   *     { $project: { name: 1, price: 1 } }
   *   ]
   * })
   * ```
   */
  lookupWithPipeline(options: LookupOptions): this {
    const builder = new LookupBuilder(options.from)
      .localField(options.localField)
      .foreignField(options.foreignField);

    if (options.as) builder.as(options.as);
    if (options.single) builder.single(options.single);
    if (options.pipeline) builder.pipeline(options.pipeline);
    if (options.let) builder.let(options.let);

    this.pipeline.push(...builder.build());
    return this;
  }

  /**
   * Multiple lookups at once
   *
   * @example
   * ```typescript
   * .multiLookup([
   *   { from: 'departments', localField: 'deptSlug', foreignField: 'slug', single: true },
   *   { from: 'managers', localField: 'managerId', foreignField: '_id', single: true }
   * ])
   * ```
   */
  multiLookup(lookups: LookupOptions[]): this {
    const stages = LookupBuilder.multiple(lookups);
    this.pipeline.push(...stages);
    return this;
  }

  // ============================================================
  // ADVANCED OPERATORS (MongoDB 6+)
  // ============================================================

  /**
   * $facet - Process multiple aggregation pipelines in a single stage
   * Useful for computing multiple aggregations in parallel
   *
   * @example
   * ```typescript
   * .facet({
   *   totalCount: [{ $count: 'count' }],
   *   avgPrice: [{ $group: { _id: null, avg: { $avg: '$price' } } }],
   *   topProducts: [{ $sort: { sales: -1 } }, { $limit: 10 }]
   * })
   * ```
   */
  facet(facets: Record<string, PipelineStage[]>): this {
    this.pipeline.push({ $facet: facets } as any);
    return this;
  }

  /**
   * $bucket - Categorize documents into buckets
   *
   * @example
   * ```typescript
   * .bucket({
   *   groupBy: '$price',
   *   boundaries: [0, 50, 100, 200],
   *   default: 'Other',
   *   output: {
   *     count: { $sum: 1 },
   *     products: { $push: '$name' }
   *   }
   * })
   * ```
   */
  bucket(options: {
    groupBy: string | Expression;
    boundaries: unknown[];
    default?: string;
    output?: Record<string, unknown>;
  }): this {
    this.pipeline.push({ $bucket: options } as any);
    return this;
  }

  /**
   * $bucketAuto - Automatically determine bucket boundaries
   */
  bucketAuto(options: {
    groupBy: string | Expression;
    buckets: number;
    output?: Record<string, unknown>;
    granularity?: string;
  }): this {
    this.pipeline.push({ $bucketAuto: options } as any);
    return this;
  }

  /**
   * $setWindowFields - Perform window functions (MongoDB 5.0+)
   * Useful for rankings, running totals, moving averages
   *
   * @example
   * ```typescript
   * .setWindowFields({
   *   partitionBy: '$department',
   *   sortBy: { salary: -1 },
   *   output: {
   *     rank: { $rank: {} },
   *     runningTotal: { $sum: '$salary', window: { documents: ['unbounded', 'current'] } }
   *   }
   * })
   * ```
   */
  setWindowFields(options: {
    partitionBy?: string | Expression;
    sortBy?: SortSpec;
    output: Record<string, unknown>;
  }): this {
    const normalizedOptions = {
      ...options,
      sortBy: options.sortBy ? normalizeSortSpec(options.sortBy) : undefined,
    };
    this.pipeline.push({ $setWindowFields: normalizedOptions } as any);
    return this;
  }

  /**
   * $unionWith - Combine results from multiple collections (MongoDB 4.4+)
   *
   * @example
   * ```typescript
   * .unionWith({
   *   coll: 'archivedOrders',
   *   pipeline: [{ $match: { year: 2024 } }]
   * })
   * ```
   */
  unionWith(options: { coll: string; pipeline?: PipelineStage[] }): this {
    this.pipeline.push({ $unionWith: options } as any);
    return this;
  }

  /**
   * $densify - Fill gaps in data (MongoDB 5.1+)
   * Useful for time series data with missing points
   */
  densify(options: {
    field: string;
    range: {
      step: number;
      unit?:
        | 'millisecond'
        | 'second'
        | 'minute'
        | 'hour'
        | 'day'
        | 'week'
        | 'month'
        | 'quarter'
        | 'year';
      bounds: 'full' | 'partition' | [unknown, unknown];
    };
  }): this {
    this.pipeline.push({ $densify: options } as any);
    return this;
  }

  /**
   * $fill - Fill null or missing field values (MongoDB 5.3+)
   */
  fill(options: {
    sortBy?: SortSpec;
    output: Record<string, { method: 'linear' | 'locf' | 'value'; value?: unknown }>;
  }): this {
    const normalizedOptions = {
      ...options,
      sortBy: options.sortBy ? normalizeSortSpec(options.sortBy) : undefined,
    };
    this.pipeline.push({ $fill: normalizedOptions } as any);
    return this;
  }

  // ============================================================
  // EXECUTION OPTIONS
  // ============================================================

  /**
   * Enable allowDiskUse for large aggregations that exceed 100MB memory limit
   *
   * @example
   * ```typescript
   * const results = await new AggregationBuilder()
   *   .match({ status: 'active' })
   *   .group({ _id: '$category', total: { $sum: '$amount' } })
   *   .allowDiskUse()
   *   .exec(Model);
   * ```
   */
  allowDiskUse(enable: boolean = true): this {
    this._diskUse = enable;
    return this;
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  /**
   * Paginate - Add skip and limit for offset-based pagination
   */
  paginate(page: number, limit: number): this {
    const skip = (page - 1) * limit;
    return this.skip(skip).limit(limit);
  }

  /**
   * Count total documents (useful with $facet for pagination metadata)
   */
  count(outputField: string = 'count'): this {
    this.pipeline.push({ $count: outputField });
    return this;
  }

  /**
   * Sample - Randomly select N documents
   */
  sample(size: number): this {
    this.pipeline.push({ $sample: { size } });
    return this;
  }

  /**
   * Out - Write results to a collection
   */
  out(collection: string): this {
    this.pipeline.push({ $out: collection });
    return this;
  }

  /**
   * Merge - Merge results into a collection
   */
  merge(
    options:
      | string
      | { into: string; on?: string | string[]; whenMatched?: string; whenNotMatched?: string },
  ): this {
    this.pipeline.push({
      $merge: typeof options === 'string' ? { into: options } : options,
    } as any);
    return this;
  }

  /**
   * GeoNear - Perform geospatial queries
   */
  geoNear(options: {
    near: { type: 'Point'; coordinates: [number, number] };
    distanceField: string;
    maxDistance?: number;
    query?: Record<string, unknown>;
    spherical?: boolean;
  }): this {
    this.pipeline.push({ $geoNear: options });
    return this;
  }

  /**
   * GraphLookup - Perform recursive search (graph traversal)
   */
  graphLookup(options: {
    from: string;
    startWith: string | Expression;
    connectFromField: string;
    connectToField: string;
    as: string;
    maxDepth?: number;
    depthField?: string;
    restrictSearchWithMatch?: Record<string, unknown>;
  }): this {
    this.pipeline.push({ $graphLookup: options });
    return this;
  }

  // ============================================================
  // ATLAS SEARCH (MongoDB Atlas only)
  // ============================================================

  /**
   * $search - Atlas Search full-text search (Atlas only)
   *
   * @example
   * ```typescript
   * .search({
   *   index: 'default',
   *   text: {
   *     query: 'laptop computer',
   *     path: ['title', 'description'],
   *     fuzzy: { maxEdits: 2 }
   *   }
   * })
   * ```
   */
  search(options: {
    index?: string;
    text?: {
      query: string;
      path: string | string[];
      fuzzy?: { maxEdits?: number; prefixLength?: number };
      score?: { boost?: { value?: number } };
    };
    compound?: {
      must?: unknown[];
      mustNot?: unknown[];
      should?: unknown[];
      filter?: unknown[];
    };
    autocomplete?: unknown;
    near?: unknown;
    range?: unknown;
  }): this {
    this.pipeline.push({ $search: options } as PipelineStage);
    return this;
  }

  /**
   * $searchMeta - Get Atlas Search metadata (Atlas only)
   */
  searchMeta(options: Record<string, unknown>): this {
    this.pipeline.push({ $searchMeta: options } as PipelineStage);
    return this;
  }

  // ============================================================
  // ATLAS VECTOR SEARCH (MongoDB Atlas 7.0+)
  // ============================================================

  /**
   * $vectorSearch - Semantic similarity search using vector embeddings (Atlas only)
   *
   * Requires an Atlas Vector Search index on the target field.
   * Must be the first stage in the pipeline.
   *
   * @example
   * ```typescript
   * const results = await new AggregationBuilder()
   *   .vectorSearch({
   *     index: 'vector_index',
   *     path: 'embedding',
   *     queryVector: await getEmbedding('running shoes'),
   *     limit: 10,
   *     numCandidates: 100,
   *     filter: { category: 'footwear' }
   *   })
   *   .project({ embedding: 0, score: { $meta: 'vectorSearchScore' } })
   *   .exec(ProductModel);
   * ```
   */
  vectorSearch(options: VectorSearchOptions): this {
    if (this.pipeline.length > 0) {
      throw new Error('[mongokit] $vectorSearch must be the first stage in the pipeline');
    }
    const rawCandidates = options.numCandidates ?? Math.max(options.limit * 10, 100);
    const numCandidates = Math.min(Math.max(rawCandidates, options.limit), 10_000);
    this.pipeline.push({
      $vectorSearch: {
        index: options.index,
        path: options.path,
        queryVector: options.queryVector,
        numCandidates,
        limit: options.limit,
        ...(options.filter && { filter: options.filter }),
        ...(options.exact && { exact: options.exact }),
      },
    } as unknown as PipelineStage);
    return this;
  }

  /**
   * Add vectorSearchScore as a field after $vectorSearch
   * Convenience for `.addFields({ score: { $meta: 'vectorSearchScore' } })`
   */
  withVectorScore(fieldName: string = 'score'): this {
    return this.addFields({ [fieldName]: { $meta: 'vectorSearchScore' } });
  }

  // ============================================================
  // HELPER FACTORY METHODS
  // ============================================================

  /**
   * Create a builder from an existing pipeline
   */
  static from(pipeline: PipelineStage[]): AggregationBuilder {
    const builder = new AggregationBuilder();
    builder.pipeline = [...pipeline];
    return builder;
  }

  /**
   * Create a builder with initial match stage
   */
  static startWith(query: Record<string, unknown>): AggregationBuilder {
    return new AggregationBuilder().match(query);
  }
}

/**
 * Optimized Aggregation Patterns for Scale
 *
 * 1. **Early Filtering** - Always place $match as early as possible:
 *    ```typescript
 *    new AggregationBuilder()
 *      .match({ status: 'active' })  // ✅ Filter first
 *      .lookup(...)                  // Then join
 *      .sort(...)
 *    ```
 *
 * 2. **Index Usage** - Ensure indexes on:
 *    - Fields in $match
 *    - Fields in $sort (especially with $limit)
 *    - Fields in $lookup (both local and foreign)
 *
 * 3. **Projection** - Remove unnecessary fields early:
 *    ```typescript
 *    .project({ password: 0, internalNotes: 0 })  // Remove before joins
 *    .lookup(...)
 *    ```
 *
 * 4. **Faceted Pagination** - Get count and data in one query:
 *    ```typescript
 *    .facet({
 *      metadata: [{ $count: 'total' }],
 *      data: [{ $skip: skip }, { $limit: limit }]
 *    })
 *    ```
 *
 * 5. **allowDiskUse** - For large datasets:
 *    ```typescript
 *    new AggregationBuilder()
 *      .match({ status: 'active' })
 *      .allowDiskUse()
 *      .exec(Model)
 *    ```
 *
 * 6. **Vector Search** - Semantic similarity (Atlas only):
 *    ```typescript
 *    new AggregationBuilder()
 *      .vectorSearch({ index: 'vec_idx', path: 'embedding', queryVector: vec, limit: 10 })
 *      .withVectorScore()
 *      .exec(Model)
 *    ```
 */
