/**
 * AggRequest → MongoDB pipeline execution.
 *
 * {@link runAgg} is the one place an IR pipeline reaches the driver: the repository's `finalize`
 * (join scoping) runs on the compiled stages, then the resolved defaults, then the request's own
 * `executionHints` (per call, so they win). Row shape matches sqlitekit's output.
 */

import type { AggRequest } from '@classytic/repo-core/repository';
import type { ClientSession, Model, PipelineStage } from 'mongoose';
import { applyToAggregate, type ResolvedQueryOptions } from '../../repository/query-defaults.js';
import { applyExecutionHints } from './hints.js';
import { buildAggPipeline } from './pipeline.js';

export interface AggRunOptions {
  session?: unknown;
  /** Resolved time bound / read concerns (defaults folded in by the repository). */
  queryOptions?: ResolvedQueryOptions;
  /** Rewrites the compiled stages before execution (the repository scopes joins here). */
  finalize?: (stages: PipelineStage[]) => PipelineStage[];
}

/** Build the aggregate for `stages` with every execution option applied, unexecuted. */
export function prepareAgg(
  // biome-ignore lint/suspicious/noExplicitAny: Mongoose models are generic — any TDoc at the boundary.
  Model: Model<any>,
  stages: PipelineStage[],
  req: AggRequest,
  options: AggRunOptions = {},
) {
  const aggregation = Model.aggregate(options.finalize ? options.finalize(stages) : stages);
  if (options.session) aggregation.session(options.session as ClientSession);
  applyToAggregate(aggregation, options.queryOptions ?? {});
  applyExecutionHints(aggregation, req.executionHints);
  return aggregation;
}

export async function runAgg<TRow>(
  // biome-ignore lint/suspicious/noExplicitAny: Mongoose models are generic — any TDoc at the boundary.
  Model: Model<any>,
  stages: PipelineStage[],
  req: AggRequest,
  options: AggRunOptions = {},
): Promise<TRow[]> {
  return (await prepareAgg(Model, stages, req, options).exec()) as TRow[];
}

export async function executeAgg<TRow extends Record<string, unknown>>(
  // biome-ignore lint/suspicious/noExplicitAny: Mongoose models are generic — we accept any TDoc at the boundary since the result type is controlled by the caller.
  Model: Model<any>,
  req: AggRequest,
  options: AggRunOptions = {},
): Promise<TRow[]> {
  const { pipeline } = buildAggPipeline(req, Model.schema);
  return runAgg<TRow>(Model, pipeline, req, options);
}
