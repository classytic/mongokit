/**
 * Pipeline sanitization — shared by URL aggregation parsing and $lookup
 * sub-pipelines. Blocks dangerous stages ($out, $merge, …) and dangerous
 * operators ($where, $function, …) inside $match / $addFields / $set, with
 * depth guards against hostile deeply-nested configs.
 */

import type { PipelineStage } from 'mongoose';
import type { ParserRuntime } from './runtime.js';

/**
 * Sanitize $match configuration to prevent dangerous operators.
 * Recursively filters out operators like $where, $function, $accumulator.
 */
export function sanitizeMatchConfig(
  rt: ParserRuntime,
  config: Record<string, unknown>,
  depth: number = 0,
): Record<string, unknown> {
  // Guard against deeply-nested aggregation $match configs (e.g. a hostile
  // $or/$and chain with thousands of levels). Without this cap, this
  // recursion is unbounded — stack depth becomes the only limit.
  if (depth > rt.options.maxFilterDepth) {
    rt.reject(
      `$match sanitize depth ${depth} exceeds maximum ${rt.options.maxFilterDepth}, truncating branch`,
      { depth, maxFilterDepth: rt.options.maxFilterDepth },
    );
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  // Logical array operators whose branches must be filtered for empty `{}`
  // results — an empty branch matches every document and silently widens the
  // surrounding query. See parseOr for the URL-side analogue.
  const logicalArrayOps = new Set(['$or', '$and', '$nor']);

  for (const [key, value] of Object.entries(config)) {
    // Block dangerous operators
    if (rt.dangerousOperators.includes(key)) {
      rt.reject(`Blocked dangerous operator in aggregation: ${key}`, { key });
      continue;
    }

    // Recursively sanitize nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeMatchConfig(rt, value as Record<string, unknown>, depth + 1);
    } else if (Array.isArray(value)) {
      // Sanitize array elements
      const sanitizedArray = value.map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return sanitizeMatchConfig(rt, item as Record<string, unknown>, depth + 1);
        }
        return item;
      });

      if (logicalArrayOps.has(key)) {
        // Drop branches that became empty `{}` after sanitization. Critical:
        // `$or: [{ $where: '...' }, { status: 'active' }]` would otherwise
        // degrade to `$or: [{}, { status: 'active' }]` ≡ match-all. We keep
        // primitive items (not objects) untouched — those are not branches.
        const filtered = sanitizedArray.filter(
          (item) =>
            !(
              item &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              Object.keys(item as Record<string, unknown>).length === 0
            ),
        );
        // If every branch was dropped, omit the operator entirely — emitting
        // an empty `$or: []` is invalid MongoDB and silently degrading to
        // match-all is exactly the bug we're closing.
        if (filtered.length === 0) {
          rt.reject(`All branches of ${key} were blocked by sanitization; dropping the operator`, {
            key,
          });
          continue;
        }
        sanitized[key] = filtered;
      } else {
        sanitized[key] = sanitizedArray;
      }
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitize pipeline stages for use in $lookup.
 * Blocks dangerous stages ($out, $merge, etc.) and recursively sanitizes
 * operator expressions within $match, $addFields, and $set stages.
 */
export function sanitizePipeline(rt: ParserRuntime, stages: unknown[]): PipelineStage[] {
  const blockedStages = [
    '$out',
    '$merge',
    '$unionWith',
    '$collStats',
    '$currentOp',
    '$listSessions',
  ];
  const sanitized: PipelineStage[] = [];

  for (const stage of stages) {
    if (!stage || typeof stage !== 'object') {
      rt.reject(`Malformed pipeline stage in lookup (not an object): ${String(stage)}`);
      continue;
    }

    const entries = Object.entries(stage as Record<string, unknown>);
    if (entries.length !== 1) {
      rt.reject(
        `Malformed pipeline stage in lookup (expected exactly one operator, got ${entries.length})`,
      );
      continue;
    }

    const [op, config] = entries[0];

    if (blockedStages.includes(op)) {
      rt.reject(`Blocked dangerous pipeline stage in lookup: ${op}`, { stage: op });
      continue;
    }

    if (op === '$match' && typeof config === 'object' && config !== null) {
      sanitized.push({
        $match: sanitizeMatchConfig(rt, config as Record<string, unknown>),
      } as unknown as PipelineStage);
    } else if (
      (op === '$addFields' || op === '$set') &&
      typeof config === 'object' &&
      config !== null
    ) {
      sanitized.push({
        [op]: sanitizeExpressions(rt, config as Record<string, unknown>),
      } as unknown as PipelineStage);
    } else {
      sanitized.push(stage as PipelineStage);
    }
  }

  return sanitized;
}

/**
 * Recursively sanitize expression objects, blocking dangerous operators
 * like $where, $function, $accumulator inside $addFields/$set stages.
 *
 * Depth-guarded — same protection `sanitizeMatchConfig` ships, since
 * a hostile `$cond`/`$switch` chain can recurse arbitrarily deep and
 * exhaust JS stack.
 */
function sanitizeExpressions(
  rt: ParserRuntime,
  config: Record<string, unknown>,
  depth: number = 0,
): Record<string, unknown> {
  if (depth > rt.options.maxFilterDepth) {
    rt.reject(
      `pipeline expression sanitize depth ${depth} exceeds maximum ${rt.options.maxFilterDepth}, truncating branch`,
      { depth, maxFilterDepth: rt.options.maxFilterDepth },
    );
    return {};
  }
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (rt.dangerousOperators.includes(key)) {
      rt.reject(`Blocked dangerous operator in pipeline expression: ${key}`, { key });
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeExpressions(rt, value as Record<string, unknown>, depth + 1);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return sanitizeExpressions(rt, item as Record<string, unknown>, depth + 1);
        }
        return item;
      });
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
