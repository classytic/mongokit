/**
 * Count the distinct grouped rows an `AggRequest` would produce — the
 * `total` field of `aggregatePaginate`'s offset envelope.
 *
 * Strategy mirrors sqlitekit's three cases:
 *
 *   1. `having` present → assemble the full data pipeline (minus
 *      pagination stages) and wrap in `$count`. The HAVING filter is
 *      already applied by the data pipeline so the count reflects
 *      post-having groups.
 *   2. no `groupBy` → scalar aggregation produces one row — check
 *      existence of any matching document via `{ $limit: 1 }`.
 *   3. `groupBy` without `having` → `$group` to collect distinct
 *      group keys, then `$count`. MongoDB's planner uses the group-key
 *      index when available.
 */

import type { AggRequest } from '@classytic/repo-core/repository';
import type { ClientSession, Model, PipelineStage } from 'mongoose';
import { compileFilterToMongo } from '../../filter/compile.js';
import { normalizeGroupBy } from './normalize.js';
import { buildAggPipeline } from './pipeline.js';

export async function countAggGroups(
  // biome-ignore lint/suspicious/noExplicitAny: Mongoose models are generic — we accept any TDoc.
  Model: Model<any>,
  req: AggRequest,
  options: { session?: ClientSession } = {},
): Promise<number> {
  const groupCols = normalizeGroupBy(req.groupBy);

  // Strategy 1: HAVING → build the full pipeline (less sort/skip/limit)
  // and wrap in $count.
  if (req.having) {
    const { pipeline, prePaginationIndex } = buildAggPipeline(req);
    const preStages = pipeline.slice(0, prePaginationIndex);
    const finalPipeline: PipelineStage[] = [...preStages, { $count: 'n' } as PipelineStage];
    const aggregation = Model.aggregate(finalPipeline);
    if (options.session) aggregation.session(options.session);
    const [row] = (await aggregation.exec()) as [{ n: number }?];
    return row?.n ?? 0;
  }

  const match = req.filter ? compileFilterToMongo(req.filter) : {};

  // Strategy 2: scalar aggregation — existence check.
  if (groupCols.length === 0) {
    const pipeline: PipelineStage[] = [];
    if (Object.keys(match).length > 0) pipeline.push({ $match: match });
    pipeline.push({ $limit: 1 } as PipelineStage);
    pipeline.push({ $count: 'n' } as PipelineStage);
    const aggregation = Model.aggregate(pipeline);
    if (options.session) aggregation.session(options.session);
    const [row] = (await aggregation.exec()) as [{ n: number }?];
    return row?.n ?? 0;
  }

  // Strategy 3: grouped — $group → $count.
  const groupId = groupCols.reduce<Record<string, string>>((acc, field) => {
    acc[field] = `$${field}`;
    return acc;
  }, {});
  const pipeline: PipelineStage[] = [];
  if (Object.keys(match).length > 0) pipeline.push({ $match: match });
  pipeline.push({ $group: { _id: groupId } } as PipelineStage);
  pipeline.push({ $count: 'n' } as PipelineStage);

  const aggregation = Model.aggregate(pipeline);
  if (options.session) aggregation.session(options.session);
  const [row] = (await aggregation.exec()) as [{ n: number }?];
  return row?.n ?? 0;
}
