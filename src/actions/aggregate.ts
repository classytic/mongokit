/**
 * Aggregate Actions
 * MongoDB aggregation pipeline operations
 */

import type { ClientSession, Model, PipelineStage } from 'mongoose';
import { LookupBuilder } from '../query/LookupBuilder.js';
import type { AnyDocument, GroupResult, LookupOptions, MinMaxResult } from '../types.js';
import { warn } from '../utils/logger.js';

/**
 * Execute aggregation pipeline
 */
export async function aggregate<TResult = unknown>(
  Model: Model<any>,
  pipeline: PipelineStage[],
  options: { session?: unknown } = {},
): Promise<TResult[]> {
  const aggregation = Model.aggregate(pipeline);

  if (options.session) {
    aggregation.session(options.session as ClientSession);
  }

  return aggregation.exec() as Promise<TResult[]>;
}

/**
 * Aggregate with pagination using native MongoDB $facet
 * WARNING: $facet results must be <16MB. For larger results (limit >1000),
 * consider using Repository.aggregatePaginate() or splitting into separate queries.
 */
export async function aggregatePaginate<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  pipeline: PipelineStage[],
  options: { page?: number; limit?: number; session?: unknown } = {},
): Promise<{
  docs: TDoc[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}> {
  const page = parseInt(String(options.page || 1), 10);
  const limit = parseInt(String(options.limit || 10), 10);
  const skip = (page - 1) * limit;

  // 16MB MongoDB document size limit safety check
  const SAFE_LIMIT = 1000;
  if (limit > SAFE_LIMIT) {
    warn(
      `[mongokit] Large aggregation limit (${limit}). $facet results must be <16MB. ` +
        `Consider using Repository.aggregatePaginate() for safer handling of large datasets.`,
    );
  }

  const facetPipeline: PipelineStage[] = [
    ...pipeline,
    {
      $facet: {
        docs: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: 'count' }],
      },
    },
  ];

  const aggregation = Model.aggregate(facetPipeline);
  if (options.session) {
    aggregation.session(options.session as ClientSession);
  }

  const [result] = (await aggregation.exec()) as [{ docs: TDoc[]; total: { count: number }[] }];
  const docs = result.docs || [];
  const total = result.total[0]?.count || 0;
  const pages = Math.ceil(total / limit);

  return {
    docs,
    total,
    page,
    limit,
    pages,
    hasNext: page < pages,
    hasPrev: page > 1,
  };
}

/**
 * Group documents by field value
 */
export async function groupBy(
  Model: Model<any>,
  field: string,
  options: { limit?: number; session?: unknown } = {},
): Promise<GroupResult[]> {
  const pipeline: PipelineStage[] = [
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ];

  if (options.limit) {
    pipeline.push({ $limit: options.limit });
  }

  return aggregate(Model, pipeline, options);
}

/**
 * Count by field values
 */
export async function countBy(
  Model: Model<any>,
  field: string,
  query: Record<string, unknown> = {},
  options: { session?: unknown } = {},
): Promise<GroupResult[]> {
  const pipeline: PipelineStage[] = [];

  if (Object.keys(query).length > 0) {
    pipeline.push({ $match: query });
  }

  pipeline.push({ $group: { _id: `$${field}`, count: { $sum: 1 } } }, { $sort: { count: -1 } });

  return aggregate(Model, pipeline, options);
}

/**
 * Lookup (join) with another collection
 *
 * MongoDB $lookup has two mutually exclusive forms:
 * 1. Simple form: { from, localField, foreignField, as }
 * 2. Pipeline form: { from, let, pipeline, as }
 *
 * This function automatically selects the appropriate form based on parameters.
 */
export async function lookup<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  lookupOptions: LookupOptions,
): Promise<TDoc[]> {
  const {
    from,
    localField,
    foreignField,
    as,
    pipeline = [],
    let: letVars,
    query = {},
    options = {},
  } = lookupOptions;

  const aggPipeline: PipelineStage[] = [];

  // Add initial match filter if provided
  if (Object.keys(query).length > 0) {
    aggPipeline.push({ $match: query });
  }

  // Delegate to LookupBuilder for consistent behavior across all lookup APIs
  // (auto-correlation, sanitization, select shorthand)
  const builder = new LookupBuilder(from)
    .localField(localField)
    .foreignField(foreignField)
    .as(as || from);

  if (lookupOptions.single) builder.single(lookupOptions.single);
  if (pipeline.length > 0) builder.pipeline(pipeline);
  if (letVars) builder.let(letVars);
  if (lookupOptions.sanitize === false) builder.sanitize(false);

  aggPipeline.push(...builder.build());

  return aggregate(Model, aggPipeline, options);
}

/**
 * Unwind array field
 */
export async function unwind<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  field: string,
  options: { preserveEmpty?: boolean; session?: unknown } = {},
): Promise<TDoc[]> {
  const pipeline: PipelineStage[] = [
    {
      $unwind: {
        path: `$${field}`,
        preserveNullAndEmptyArrays: options.preserveEmpty !== false,
      },
    },
  ];

  return aggregate(Model, pipeline, { session: options.session });
}

/**
 * Facet search (multiple aggregations in one query)
 */
export async function facet<TResult = Record<string, unknown[]>>(
  Model: Model<any>,
  facets: Record<string, PipelineStage[]>,
  options: { session?: unknown } = {},
): Promise<TResult[]> {
  const pipeline: PipelineStage[] = [{ $facet: facets as any } as any];

  return aggregate(Model, pipeline, options);
}

/**
 * Get distinct values
 */
export async function distinct<T = unknown>(
  Model: Model<any>,
  field: string,
  query: Record<string, unknown> = {},
  options: {
    session?: unknown;
    readPreference?: string;
  } = {},
): Promise<T[]> {
  const q = Model.distinct(field, query).session((options.session ?? null) as ClientSession | null);
  if (options.readPreference) {
    // Mongoose Query.read() accepts string; Aggregate.read() accepts ReadPreferenceLike.
    // distinct() returns a Query, so string is the correct type here.
    q.read(options.readPreference);
  }
  return q as Promise<T[]>;
}

/**
 * Calculate sum
 */
export async function sum(
  Model: Model<any>,
  field: string,
  query: Record<string, unknown> = {},
  options: { session?: unknown } = {},
): Promise<number> {
  const pipeline: PipelineStage[] = [];

  if (Object.keys(query).length > 0) {
    pipeline.push({ $match: query });
  }

  pipeline.push({
    $group: {
      _id: null,
      total: { $sum: `$${field}` },
    },
  });

  const result = await aggregate<{ total: number }>(Model, pipeline, options);
  return result[0]?.total || 0;
}

/**
 * Calculate average
 */
export async function average(
  Model: Model<any>,
  field: string,
  query: Record<string, unknown> = {},
  options: { session?: unknown } = {},
): Promise<number> {
  const pipeline: PipelineStage[] = [];

  if (Object.keys(query).length > 0) {
    pipeline.push({ $match: query });
  }

  pipeline.push({
    $group: {
      _id: null,
      average: { $avg: `$${field}` },
    },
  });

  const result = await aggregate<{ average: number }>(Model, pipeline, options);
  return result[0]?.average || 0;
}

/**
 * Min/Max
 */
export async function minMax(
  Model: Model<any>,
  field: string,
  query: Record<string, unknown> = {},
  options: { session?: unknown } = {},
): Promise<MinMaxResult> {
  const pipeline: PipelineStage[] = [];

  if (Object.keys(query).length > 0) {
    pipeline.push({ $match: query });
  }

  pipeline.push({
    $group: {
      _id: null,
      min: { $min: `$${field}` },
      max: { $max: `$${field}` },
    },
  });

  const result = await aggregate<MinMaxResult>(Model, pipeline, options);
  return result[0] || { min: null, max: null };
}
