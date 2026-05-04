/**
 * Apply portable `AggExecutionHints` to a mongoose `Aggregate`
 * builder. Every supported hint maps to a mongoose / driver knob
 * with stable semantics; unsupported hints are silently ignored
 * (per the IR contract — kits never throw on unknown hint keys).
 *
 * Currently:
 *   - `allowDiskUse`  → `aggregate.allowDiskUse(true)`
 *   - `maxTimeMs`     → `aggregate.option({ maxTimeMS: ms })`
 *   - `indexHint`     → `aggregate.option({ hint })`
 *
 * Centralised here so every entry point that runs an aggregation —
 * `executeAgg`, `countAggGroups`, the keyset path in
 * `Repository.aggregatePaginate` — applies hints identically. A new
 * hint lands in the IR + here, and every pipeline picks it up.
 */

import type { AggExecutionHints } from '@classytic/repo-core/repository';
import type { Aggregate } from 'mongoose';

export function applyExecutionHints(
  // biome-ignore lint/suspicious/noExplicitAny: Aggregate's TDoc generic is irrelevant here — we only call .allowDiskUse / .option.
  aggregation: Aggregate<any>,
  hints: AggExecutionHints | undefined,
): void {
  if (!hints) return;
  if (hints.allowDiskUse) {
    aggregation.allowDiskUse(true);
  }
  if (typeof hints.maxTimeMs === 'number' && hints.maxTimeMs > 0) {
    aggregation.option({ maxTimeMS: hints.maxTimeMs });
  }
  if (hints.indexHint !== undefined) {
    // mongoose's `.option({ hint })` types `hint` as a query-shape
    // object; we accept either a string index name or an object form.
    aggregation.option({ hint: hints.indexHint as Record<string, unknown> });
  }
}
