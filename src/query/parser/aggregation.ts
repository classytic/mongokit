/**
 * URL aggregation parsing (advanced, opt-in via `enableAggregations`) —
 * `?aggregate[group][_id]=$status` → sanitized pipeline stages.
 */

import type { PipelineStage } from 'mongoose';
import { sanitizeMatchConfig } from './pipeline-sanitizer.js';
import type { ParserRuntime } from './runtime.js';
import type { SortSpec } from './types.js';

/**
 * Parse aggregation pipeline from URL (advanced feature).
 *
 * @example
 * ```typescript
 * // URL: ?aggregate[group][_id]=$status&aggregate[group][count]=$sum:1
 * parseAggregation(rt, { group: { _id: '$status', count: '$sum:1' } });
 * ```
 */
export function parseAggregation(
  rt: ParserRuntime,
  aggregate: unknown,
): PipelineStage[] | undefined {
  if (!aggregate || typeof aggregate !== 'object') return undefined;

  const pipeline: PipelineStage[] = [];
  const aggObj = aggregate as Record<string, unknown>;

  for (const [stage, config] of Object.entries(aggObj)) {
    try {
      if (stage === 'group' && typeof config === 'object') {
        pipeline.push({ $group: config } as unknown as PipelineStage);
      } else if (stage === 'match' && typeof config === 'object') {
        // Sanitize $match config to prevent dangerous operators like $where
        const sanitizedMatch = sanitizeMatchConfig(rt, config as Record<string, unknown>);
        if (Object.keys(sanitizedMatch).length > 0) {
          pipeline.push({ $match: sanitizedMatch });
        }
      } else if (stage === 'sort' && typeof config === 'object') {
        pipeline.push({ $sort: config as SortSpec });
      } else if (stage === 'project' && typeof config === 'object') {
        pipeline.push({ $project: config as Record<string, unknown> });
      } else {
        // Unknown stage (or non-object config) — silently ignoring it in
        // 'throw' mode would misreport the query as fully applied.
        rt.reject(`Unsupported aggregation stage: ${stage}`, { stage });
      }
    } catch (error) {
      // Propagate policy 400s from sanitizeMatchConfig / reject intact.
      if ((error as { code?: unknown }).code === 'INVALID_QUERY_INPUT') throw error;
      rt.reject(
        `Invalid aggregation stage ${stage}: ${error instanceof Error ? error.message : String(error)}`,
        { stage },
      );
    }
  }

  return pipeline.length > 0 ? pipeline : undefined;
}
