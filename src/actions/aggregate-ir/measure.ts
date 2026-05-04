/**
 * AggMeasure → MongoDB `$group` operator expression.
 *
 * Maps each portable measure op to the MongoDB accumulator it uses
 * inside a `$group` stage. Outputs fragment go into
 * `{ $group: { _id, [alias]: <fragment>, ... } }`.
 *
 *   count           → `{ $sum: 1 }`
 *   count(field)    → `{ $sum: { $cond: [{ $ne: [$field, null] }, 1, 0] } }`
 *                     (matches SQL's `COUNT(col)` — non-null rows only)
 *   countDistinct   → `{ $addToSet: '$field' }` captured as a set; the
 *                     pipeline assembler later replaces with a
 *                     `{ $size: '$field_set' }` projection because mongo's
 *                     `$group` doesn't ship a native `countDistinct`.
 *   sum / avg / min / max → the native `$sum` / `$avg` / `$min` / `$max`.
 */

import type { AggMeasure } from '@classytic/repo-core/repository';
import { compileFilterToMongoExpr } from '../../filter/compile-expr.js';

/**
 * Compiled accumulator descriptor. Most measures produce a single
 * `groupExpr` that lands directly in `$group`. `countDistinct` needs a
 * two-step — collect values in `$group`, then `$size` them in
 * `$project` — so we return an optional `projectExpr` the pipeline
 * assembler inlines after the group stage.
 */
export interface CompiledMeasure {
  /** Expression inserted into `$group: { [alias]: groupExpr }`. */
  groupExpr: Record<string, unknown>;
  /**
   * Optional post-group projection that finalizes the value — set only
   * for `countDistinct`. When present, the assembler emits an
   * `$addFields` / `$project` stage that replaces the raw accumulated
   * value with `projectExpr`.
   */
  projectExpr?: Record<string, unknown>;
}

export function compileMeasure(measure: AggMeasure): CompiledMeasure {
  // Filtered measure (`where` set) wraps the per-doc operand in
  // `$cond: [<predicate>, <operand>, <fallback>]` so the accumulator
  // sees the operand only when the predicate matches. This is the
  // mongo equivalent of SQL's `FILTER (WHERE …)` clause.
  //
  // Per-op `<fallback>` choices (load-bearing for correctness):
  //   - `$sum` / count-via-cond → `0`     (additive identity)
  //   - `$avg`                  → `null`  (mongo's $avg ignores nulls,
  //                                         so non-matching rows don't
  //                                         drag the average down)
  //   - `$min` / `$max`         → `null`  (mongo's $min/$max ignore
  //                                         nulls — we don't poison the
  //                                         extreme with a sentinel)
  //   - `$addToSet`             → `'$$REMOVE'` (mongo skips the sentinel
  //                                              so non-matching rows
  //                                              don't accidentally land
  //                                              in the distinct set)
  const whereExpr =
    measure.where !== undefined ? compileFilterToMongoExpr(measure.where) : undefined;

  switch (measure.op) {
    case 'count': {
      const fieldName = measure.field;
      const noField = !fieldName || fieldName === '*';

      // Build the per-doc 0/1 contribution once, with optional null
      // check (when a field is provided) AND optional `where` predicate.
      const baseCondition = noField ? true : { $ne: [`$${fieldName}`, null] };
      const condition =
        whereExpr === undefined
          ? baseCondition
          : baseCondition === true
            ? whereExpr
            : { $and: [baseCondition, whereExpr] };
      // Optimization: when the condition is the literal `true` (no field,
      // no where), collapse to `{ $sum: 1 }` — same disk-write cost,
      // smaller pipeline shape.
      if (condition === true) return { groupExpr: { $sum: 1 } };
      return {
        groupExpr: { $sum: { $cond: [condition, 1, 0] } },
      };
    }

    case 'countDistinct': {
      // Accumulate the set, then project $size in a follow-up stage.
      // With `where`: emit `$$REMOVE` so non-matching rows don't enter
      // the distinct set (no extra cardinality from the sentinel).
      const operand =
        whereExpr === undefined
          ? `$${measure.field}`
          : { $cond: [whereExpr, `$${measure.field}`, '$$REMOVE'] };
      return {
        groupExpr: { $addToSet: operand },
        projectExpr: { $size: { $ifNull: ['$$CURRENT', []] } },
      };
    }

    case 'sum':
      return {
        groupExpr: {
          $sum:
            whereExpr === undefined
              ? `$${measure.field}`
              : { $cond: [whereExpr, `$${measure.field}`, 0] },
        },
      };
    case 'avg':
      return {
        groupExpr: {
          $avg:
            whereExpr === undefined
              ? `$${measure.field}`
              : { $cond: [whereExpr, `$${measure.field}`, null] },
        },
      };
    case 'min':
      return {
        groupExpr: {
          $min:
            whereExpr === undefined
              ? `$${measure.field}`
              : { $cond: [whereExpr, `$${measure.field}`, null] },
        },
      };
    case 'max':
      return {
        groupExpr: {
          $max:
            whereExpr === undefined
              ? `$${measure.field}`
              : { $cond: [whereExpr, `$${measure.field}`, null] },
        },
      };

    case 'stddev':
      // Sample standard deviation (`/ (n - 1)`). Matches SQL's
      // `STDDEV_SAMP()` and `numpy.std(ddof=1)`. Mongo's
      // `$stdDevSamp` uses Welford's online algorithm — numerically
      // stable across large + near-equal value sets.
      return {
        groupExpr: {
          $stdDevSamp:
            whereExpr === undefined
              ? `$${measure.field}`
              : { $cond: [whereExpr, `$${measure.field}`, null] },
        },
      };
    case 'stddevPop':
      // Population standard deviation (`/ n`). Matches SQL's
      // `STDDEV_POP()`. Same Welford basis as `$stdDevSamp` — only
      // the divisor differs.
      return {
        groupExpr: {
          $stdDevPop:
            whereExpr === undefined
              ? `$${measure.field}`
              : { $cond: [whereExpr, `$${measure.field}`, null] },
        },
      };

    case 'percentile': {
      // Mongo 7+ exposes `$percentile`. The accumulator returns an
      // ARRAY (one element per `p` requested) — we always pass a
      // single-element `p: [...]` and unwrap with `$arrayElemAt`
      // in the post-group $project stage so the row shape matches
      // SQL's scalar-percentile output.
      //
      // Filtered percentile: like avg, the operand becomes
      // `$cond: [where, $field, null]`. `$percentile` ignores nulls,
      // so non-matching rows don't bias the distribution.
      if (typeof measure.p !== 'number' || measure.p < 0 || measure.p > 1) {
        throw new Error(
          `mongokit/aggregate: 'percentile' requires p in [0, 1] — got ${String(measure.p)}`,
        );
      }
      const operand =
        whereExpr === undefined
          ? `$${measure.field}`
          : { $cond: [whereExpr, `$${measure.field}`, null] };
      return {
        groupExpr: {
          $percentile: {
            input: operand,
            p: [measure.p],
            method: 'approximate',
          },
        },
        // Set in pipeline.ts via `distinctSetAliases`-shaped path —
        // the assembler runs `$addFields` to unwrap the array. See
        // `pipeline.ts` for the wiring (treat percentile aliases the
        // same way countDistinct ones get post-processed).
        projectExpr: { $arrayElemAt: ['$$CURRENT', 0] },
      };
    }
  }
}
