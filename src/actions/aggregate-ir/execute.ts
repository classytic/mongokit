/**
 * AggRequest → MongoDB pipeline execution.
 *
 * Assembles the pipeline via `buildAggPipeline`, runs it against a
 * Mongoose model, and returns the projected rows. Row shape matches
 * sqlitekit's output — one key per `groupBy` column plus one key per
 * measure alias.
 *
 * The session threading here is the thin envelope every action uses
 * — callers get a `ClientSession` slot so `withTransaction` can wire
 * the aggregate into a cross-op transaction.
 */

import type { AggRequest } from '@classytic/repo-core/repository';
import type { ClientSession, Model } from 'mongoose';
import { buildAggPipeline } from './pipeline.js';

export async function executeAgg<TRow extends Record<string, unknown>>(
  // biome-ignore lint/suspicious/noExplicitAny: Mongoose models are generic — we accept any TDoc at the boundary since the result type is controlled by the caller.
  Model: Model<any>,
  req: AggRequest,
  options: { session?: unknown } = {},
): Promise<TRow[]> {
  const session = options.session as ClientSession | undefined;
  const { pipeline } = buildAggPipeline(req);
  const aggregation = Model.aggregate(pipeline);
  if (session) aggregation.session(session);
  return (await aggregation.exec()) as TRow[];
}
