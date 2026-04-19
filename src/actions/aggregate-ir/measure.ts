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
  switch (measure.op) {
    case 'count':
      if (!measure.field || measure.field === '*') {
        return { groupExpr: { $sum: 1 } };
      }
      // Non-null count — emits 0/1 per document then sums.
      return {
        groupExpr: {
          $sum: {
            $cond: [{ $ne: [`$${measure.field}`, null] }, 1, 0],
          },
        },
      };

    case 'countDistinct':
      // Accumulate the set, then project $size in a follow-up stage.
      return {
        groupExpr: { $addToSet: `$${measure.field}` },
        projectExpr: { $size: { $ifNull: ['$$CURRENT', []] } },
      };

    case 'sum':
      return { groupExpr: { $sum: `$${measure.field}` } };
    case 'avg':
      return { groupExpr: { $avg: `$${measure.field}` } };
    case 'min':
      return { groupExpr: { $min: `$${measure.field}` } };
    case 'max':
      return { groupExpr: { $max: `$${measure.field}` } };
  }
}
