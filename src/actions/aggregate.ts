/**
 * Aggregate Actions
 * MongoDB aggregation pipeline operations
 */

import type { Model, ClientSession, PipelineStage } from 'mongoose';
import type { AnyDocument, LookupOptions, GroupResult, MinMaxResult } from '../types.js';

/**
 * Execute aggregation pipeline
 */
export async function aggregate<TResult = unknown>(
  Model: Model<any>,
  pipeline: PipelineStage[],
  options: { session?: ClientSession } = {}
): Promise<TResult[]> {
  const aggregation = Model.aggregate(pipeline);

  if (options.session) {
    aggregation.session(options.session);
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
  options: { page?: number; limit?: number; session?: ClientSession } = {}
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
    console.warn(
      `[mongokit] Large aggregation limit (${limit}). $facet results must be <16MB. ` +
      `Consider using Repository.aggregatePaginate() for safer handling of large datasets.`
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
    aggregation.session(options.session);
  }

  const [result] = await aggregation.exec() as [{ docs: TDoc[]; total: { count: number }[] }];
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
  options: { limit?: number; session?: ClientSession } = {}
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
  options: { session?: ClientSession } = {}
): Promise<GroupResult[]> {
  const pipeline: PipelineStage[] = [];

  if (Object.keys(query).length > 0) {
    pipeline.push({ $match: query });
  }

  pipeline.push(
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  );

  return aggregate(Model, pipeline, options);
}

/**
 * Lookup (join) with another collection
 */
export async function lookup<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  lookupOptions: LookupOptions
): Promise<TDoc[]> {
  const { from, localField, foreignField, as, pipeline = [], query = {}, options = {} } = lookupOptions;

  const aggPipeline: PipelineStage[] = [];

  if (Object.keys(query).length > 0) {
    aggPipeline.push({ $match: query });
  }

  aggPipeline.push({
    $lookup: {
      from,
      localField,
      foreignField,
      as,
      ...(pipeline.length > 0 ? { pipeline: pipeline as any } : {}),
    },
  } as any);

  return aggregate(Model, aggPipeline, options);
}

/**
 * Unwind array field
 */
export async function unwind<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  field: string,
  options: { preserveEmpty?: boolean; session?: ClientSession } = {}
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
  options: { session?: ClientSession } = {}
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
  options: { session?: ClientSession } = {}
): Promise<T[]> {
  return Model.distinct(field, query).session(options.session ?? null) as Promise<T[]>;
}

/**
 * Calculate sum
 */
export async function sum(
  Model: Model<any>,
  field: string,
  query: Record<string, unknown> = {},
  options: { session?: ClientSession } = {}
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
  options: { session?: ClientSession } = {}
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
  options: { session?: ClientSession } = {}
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
