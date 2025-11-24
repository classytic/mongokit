/**
 * Aggregate Actions
 * MongoDB aggregation pipeline operations
 */

/**
 * @typedef {import('mongoose').Model} Model
 * @typedef {import('mongoose').ClientSession} ClientSession
 */

/**
 * Execute aggregation pipeline
 *
 * @param {Model} Model - Mongoose model
 * @param {any[]} pipeline - Aggregation pipeline stages
 * @param {Object} [options={}] - Aggregation options
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<any[]>} Aggregation results
 */
export async function aggregate(Model, pipeline, options = {}) {
  const aggregation = Model.aggregate(pipeline);

  if (options.session) {
    aggregation.session(options.session);
  }

  return aggregation.exec();
}

/**
 * Aggregate with pagination using native MongoDB $facet
 * WARNING: $facet results must be <16MB. For larger results (limit >1000),
 * consider using Repository.aggregatePaginate() or splitting into separate queries.
 *
 * @param {Model} Model - Mongoose model
 * @param {any[]} pipeline - Aggregation pipeline stages (before pagination)
 * @param {Object} [options={}] - Pagination options
 * @param {number} [options.page=1] - Page number (1-indexed)
 * @param {number} [options.limit=10] - Documents per page
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<{docs: any[], total: number, page: number, limit: number, pages: number, hasNext: boolean, hasPrev: boolean}>} Paginated results
 *
 * @example
 * const result = await aggregatePaginate(UserModel, [
 *   { $match: { status: 'active' } },
 *   { $group: { _id: '$category', count: { $sum: 1 } } }
 * ], { page: 1, limit: 20 });
 */
export async function aggregatePaginate(Model, pipeline, options = {}) {
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

  const facetPipeline = [
    ...pipeline,
    {
      $facet: {
        docs: [
          { $skip: skip },
          { $limit: limit }
        ],
        total: [
          { $count: 'count' }
        ]
      }
    }
  ];

  const aggregation = Model.aggregate(facetPipeline);
  if (options.session) {
    aggregation.session(options.session);
  }

  const [result] = await aggregation.exec();
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
    hasPrev: page > 1
  };
}

/**
 * Group documents by field value
 *
 * @param {Model} Model - Mongoose model
 * @param {string} field - Field name to group by
 * @param {Object} [options={}] - Options
 * @param {number} [options.limit] - Maximum groups to return
 * @param {ClientSession} [options.session] - MongoDB session
 * @returns {Promise<Array<{_id: any, count: number}>>} Grouped results
 */
export async function groupBy(Model, field, options = {}) {
  const pipeline = [
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ];

  if (options.limit) {
    pipeline.push(/** @type {any} */({ $limit: options.limit }));
  }

  return aggregate(Model, pipeline, options);
}

/**
 * Count by field values
 */
export async function countBy(Model, field, query = {}, options = {}) {
  const pipeline = [];

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
export async function lookup(Model, {
  from,
  localField,
  foreignField,
  as,
  pipeline = [],
  query = {},
  options = {}
}) {
  const aggPipeline = [];

  if (Object.keys(query).length > 0) {
    aggPipeline.push({ $match: query });
  }

  aggPipeline.push({
    $lookup: {
      from,
      localField,
      foreignField,
      as,
      ...(pipeline.length > 0 ? { pipeline } : {}),
    },
  });

  return aggregate(Model, aggPipeline, options);
}

/**
 * Unwind array field
 */
export async function unwind(Model, field, options = {}) {
  const pipeline = [
    {
      $unwind: {
        path: `$${field}`,
        preserveNullAndEmptyArrays: options.preserveEmpty !== false,
      },
    },
  ];

  return aggregate(Model, pipeline, options);
}

/**
 * Facet search (multiple aggregations in one query)
 */
export async function facet(Model, facets, options = {}) {
  const pipeline = [{ $facet: facets }];

  return aggregate(Model, pipeline, options);
}

/**
 * Get distinct values
 */
export async function distinct(Model, field, query = {}, options = {}) {
  return Model.distinct(field, query).session(options.session);
}

/**
 * Calculate sum
 */
export async function sum(Model, field, query = {}, options = {}) {
  const pipeline = [];

  if (Object.keys(query).length > 0) {
    pipeline.push({ $match: query });
  }

  pipeline.push({
    $group: {
      _id: null,
      total: { $sum: `$${field}` },
    },
  });

  const result = await aggregate(Model, pipeline, options);
  return result[0]?.total || 0;
}

/**
 * Calculate average
 */
export async function average(Model, field, query = {}, options = {}) {
  const pipeline = [];

  if (Object.keys(query).length > 0) {
    pipeline.push({ $match: query });
  }

  pipeline.push({
    $group: {
      _id: null,
      average: { $avg: `$${field}` },
    },
  });

  const result = await aggregate(Model, pipeline, options);
  return result[0]?.average || 0;
}

/**
 * Min/Max
 */
export async function minMax(Model, field, query = {}, options = {}) {
  const pipeline = [];

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

  const result = await aggregate(Model, pipeline, options);
  return result[0] || { min: null, max: null };
}

