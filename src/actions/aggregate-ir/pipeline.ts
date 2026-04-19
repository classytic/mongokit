/**
 * AggRequest → MongoDB pipeline assembler.
 *
 * Composes the stages that `aggregate(req)` / `aggregatePaginate(req)`
 * ultimately run. The output is a flat `PipelineStage[]` that every
 * mongo driver accepts — no kit-specific wrapping.
 *
 * Stage order:
 *
 *   1. `$match` — pre-aggregate filter (WHERE-equivalent)
 *   2. `$group` — grouping + measure accumulators
 *   3. `$addFields` — finalize `countDistinct` sets into sizes
 *   4. `$project` — flatten `_id` into top-level group-by keys + drop
 *      intermediate set-accumulators; match the portable output shape
 *      sqlitekit produces (`{ role: 'admin', count: 2 }` not
 *      `{ _id: 'admin', count: 2 }`)
 *   5. `$match` — post-aggregate filter (HAVING-equivalent)
 *   6. `$sort`
 *   7. `$skip` / `$limit`
 *
 * The `$project` stage is essential for portability. Without it, a
 * sqlitekit caller and a mongokit caller would see different row
 * shapes for the same `AggRequest` — sqlitekit returns
 * `{ role: 'admin', count: 2 }`, stock mongo returns
 * `{ _id: 'admin', count: 2 }`. The flatten stage closes that gap.
 */

import type { AggRequest } from '@classytic/repo-core/repository';
import type { PipelineStage } from 'mongoose';
import { compileFilterToMongo } from '../../filter/compile.js';
import { compileMeasure } from './measure.js';
import { normalizeGroupBy, validateMeasures } from './normalize.js';

export interface BuiltPipeline {
  pipeline: PipelineStage[];
  /**
   * The stage count in `pipeline` that covers *everything except*
   * `$sort` / `$skip` / `$limit`. Paginators splice count + data
   * branches at this index so they share the group stage.
   */
  prePaginationIndex: number;
}

export function buildAggPipeline(req: AggRequest): BuiltPipeline {
  validateMeasures(req.measures);
  const groupCols = normalizeGroupBy(req.groupBy);
  const stages: PipelineStage[] = [];

  // 1. WHERE / pre-aggregate filter
  if (req.filter) {
    const match = compileFilterToMongo(req.filter);
    if (Object.keys(match).length > 0) {
      stages.push({ $match: match });
    }
  }

  // 2. $group — build _id + accumulators
  const groupId: Record<string, string> | null =
    groupCols.length === 0
      ? null
      : groupCols.reduce<Record<string, string>>((acc, field) => {
          acc[field] = `$${field}`;
          return acc;
        }, {});

  const groupStage: Record<string, unknown> = { _id: groupId };
  const distinctSetAliases: string[] = []; // measures that need post-group $size

  for (const [alias, measure] of Object.entries(req.measures)) {
    const compiled = compileMeasure(measure);
    groupStage[alias] = compiled.groupExpr;
    if (measure.op === 'countDistinct') {
      distinctSetAliases.push(alias);
    }
  }
  stages.push({ $group: groupStage } as PipelineStage);

  // 3. countDistinct — replace set accumulators with their sizes
  if (distinctSetAliases.length > 0) {
    const addFields: Record<string, unknown> = {};
    for (const alias of distinctSetAliases) {
      addFields[alias] = { $size: { $ifNull: [`$${alias}`, []] } };
    }
    stages.push({ $addFields: addFields } as PipelineStage);
  }

  // 4. $project — flatten _id into top-level group-by keys. We always
  // build $group with an object-shaped _id (`_id: { role: '$role' }`)
  // regardless of group-by arity, so projection is uniform: pull each
  // field out of `$_id.<name>`.
  const projection: Record<string, 0 | 1 | string | Record<string, unknown>> = {
    _id: 0,
  };
  for (const field of groupCols) {
    projection[field] = `$_id.${field}`;
  }
  for (const alias of Object.keys(req.measures)) {
    projection[alias] = 1;
  }
  stages.push({ $project: projection } as PipelineStage);

  // 5. HAVING — post-aggregate filter on measure aliases / group keys
  if (req.having) {
    const match = compileFilterToMongo(req.having);
    if (Object.keys(match).length > 0) {
      stages.push({ $match: match });
    }
  }

  const prePaginationIndex = stages.length;

  // 6–7. Sort + pagination.
  if (req.sort) {
    stages.push({ $sort: req.sort } as PipelineStage);
  }
  if (typeof req.offset === 'number' && req.offset > 0) {
    stages.push({ $skip: req.offset } as PipelineStage);
  }
  if (typeof req.limit === 'number') {
    stages.push({ $limit: req.limit } as PipelineStage);
  }

  return { pipeline: stages, prePaginationIndex };
}
