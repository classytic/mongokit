/**
 * Count the distinct grouped rows an `AggRequest` would produce — the
 * `total` field of `aggregatePaginate`'s offset envelope.
 *
 * Strategy:
 *
 *   1. `lookups` OR dotted-path groupBy OR `having` → assemble the
 *      full data pipeline (minus pagination stages) and wrap in
 *      `$count`. Lookups must run before the group stage for joined-
 *      alias paths to resolve, and BSON disallows `.` in `_id` field
 *      names so the safe-key transform inside `buildAggPipeline`
 *      handles dotted groupBy correctly.
 *   2. no `groupBy` → scalar aggregation produces one row — check
 *      existence of any matching document via `{ $limit: 1 }`.
 *   3. plain `groupBy` (no lookups, no dotted paths, no having) →
 *      `$group` to collect distinct group keys, then `$count`. The
 *      planner uses the group-key index when available.
 */

import type { AggRequest } from '@classytic/repo-core/repository';
import type { ClientSession, Model, PipelineStage } from 'mongoose';
import { compileFilterToMongo } from '../../filter/compile.js';
import { applyExecutionHints } from './hints.js';
import { normalizeGroupBy } from './normalize.js';
import { buildAggPipeline } from './pipeline.js';

export async function countAggGroups(
  // biome-ignore lint/suspicious/noExplicitAny: Mongoose models are generic — we accept any TDoc.
  Model: Model<any>,
  req: AggRequest,
  options: { session?: unknown } = {},
): Promise<number> {
  const session = options.session as ClientSession | undefined;
  const groupCols = normalizeGroupBy(req.groupBy);

  // Strategy 1: HAVING / lookups / dotted-path groupBy / dateBuckets
  // → build the full pipeline (less sort/skip/limit) and wrap in
  // $count. The shortcut Strategy 3 below can't handle these cases —
  // lookups must run before the group stage to resolve joined-alias
  // paths, dotted-path keys break the BSON `_id` rule unless the
  // safe-key transform inside `buildAggPipeline` is applied, and date
  // buckets need their materialization stage to compute the bucket
  // label per document before grouping.
  const hasDottedGroupBy = groupCols.some((f) => f.includes('.'));
  const hasDateBuckets = !!req.dateBuckets && Object.keys(req.dateBuckets).length > 0;
  const requiresFullPipeline =
    req.having !== undefined ||
    (req.lookups !== undefined && req.lookups.length > 0) ||
    hasDottedGroupBy ||
    hasDateBuckets;
  if (requiresFullPipeline) {
    const { pipeline, prePaginationIndex } = buildAggPipeline(req);
    const preStages = pipeline.slice(0, prePaginationIndex);
    const finalPipeline: PipelineStage[] = [...preStages, { $count: 'n' } as PipelineStage];
    const aggregation = Model.aggregate(finalPipeline);
    if (session) aggregation.session(session);
    applyExecutionHints(aggregation, req.executionHints);
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
    if (session) aggregation.session(session);
    applyExecutionHints(aggregation, req.executionHints);
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
  if (session) aggregation.session(session);
  const [row] = (await aggregation.exec()) as [{ n: number }?];
  return row?.n ?? 0;
}
