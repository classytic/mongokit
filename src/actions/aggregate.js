/**
 * Aggregate Actions
 * MongoDB aggregation pipeline operations
 */

/**
 * Execute aggregation pipeline
 */
export async function aggregate(Model, pipeline, options = {}) {
  const aggregation = Model.aggregate(pipeline);

  if (options.session) {
    aggregation.session(options.session);
  }

  return aggregation.exec();
}

/**
 * Aggregate with pagination
 */
export async function aggregatePaginate(Model, pipeline, options = {}) {
  const { page = 1, limit = 10 } = options;

  return Model.aggregatePaginate(Model.aggregate(pipeline), {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
  });
}

/**
 * Group by field
 */
export async function groupBy(Model, field, options = {}) {
  const pipeline = [
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

