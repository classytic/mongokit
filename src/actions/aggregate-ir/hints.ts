/**
 * Apply portable `AggExecutionHints` to a mongoose `Aggregate` builder — the one place every
 * aggregation entry point (`executeAgg`, `countAggGroups`, `aggregatePaginate`'s keyset path)
 * applies them. Unsupported hints are ignored, per the IR contract.
 *
 *   - `allowDiskUse`  → `aggregate.allowDiskUse(true)`
 *   - `maxTimeMs`     → `aggregate.option({ maxTimeMS: ms })`
 *   - `indexHint`     → a string or key object is a FORCED hint (`aggregate.option({ hint })`);
 *                       `{ leadingKeys }` is an EXPECTED index — see {@link assertExpectedIndex}.
 */

import type { AggExecutionHints } from '@classytic/repo-core/repository';
import type { Aggregate, Model } from 'mongoose';

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
  if (hints.indexHint === undefined) return;
  if (isExpectedIndex(hints.indexHint)) {
    assertExpectedIndex(aggregation.model(), hints.indexHint.leadingKeys);
    return;
  }
  aggregation.option({ hint: hints.indexHint as Record<string, unknown> });
}

/** `{ leadingKeys }`: "an index leading with these fields serves this" — checked, never forced. */
export interface ExpectedIndexHint {
  readonly leadingKeys: readonly string[];
}

function isExpectedIndex(hint: unknown): hint is ExpectedIndexHint {
  return (
    typeof hint === 'object' &&
    hint !== null &&
    Array.isArray((hint as { leadingKeys?: unknown }).leadingKeys) &&
    (hint as { leadingKeys: unknown[] }).leadingKeys.length > 0
  );
}

// biome-ignore lint/suspicious/noExplicitAny: keyed by any model.
const checked = new WeakMap<Model<any>, Set<string>>();

/**
 * Throw unless the model DECLARES an index whose key starts with `leadingKeys`, directly or after
 * one leading scope field (a tenant / branch column the query pins by equality). Forcing such a
 * description as a `hint` was wrong twice over: Mongo requires an index with EXACTLY that key, so a
 * longer one failed `BadValue`; and a hint overrides the planner. The planner picks; this only
 * guarantees the declared expectation holds. Checked once per model and key set.
 */
// biome-ignore lint/suspicious/noExplicitAny: any model.
export function assertExpectedIndex(model: Model<any>, leadingKeys: readonly string[]): void {
  const id = leadingKeys.join(',');
  const done = checked.get(model);
  if (done?.has(id)) return;
  const keys = model.schema.indexes().map(([fields]) => Object.keys(fields as Record<string, unknown>));
  const startsWith = (key: string[], at: number) => leadingKeys.every((k, i) => key[at + i] === k);
  if (!keys.some((key) => startsWith(key, 0) || startsWith(key, 1))) {
    throw new Error(
      `[mongokit] ${model.modelName}: an aggregation expects an index leading with (${id}), but none is ` +
        `declared — declared: ${keys.map((k) => `(${k.join(',')})`).join(' ') || 'none'}. Declare one, or drop the hint.`,
    );
  }
  checked.set(model, (done ?? new Set()).add(id));
}
