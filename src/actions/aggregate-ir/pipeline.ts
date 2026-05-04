/**
 * AggRequest → MongoDB pipeline assembler.
 *
 * Composes the stages that `aggregate(req)` / `aggregatePaginate(req)`
 * ultimately run. The output is a flat `PipelineStage[]` that every
 * mongo driver accepts — no kit-specific wrapping.
 *
 * Stage order:
 *
 *   1. `$match`   — pre-aggregate filter on BASE rows (WHERE-equivalent)
 *   2. `$lookup*` — joins (zero or more), processed in `req.lookups`
 *      array order. Each `LookupSpec` becomes one `$lookup` (plus
 *      `$addFields` coalesce for `single: true`) using the same
 *      `LookupBuilder.multiple` compiler `lookupPopulate` uses.
 *      `groupBy`, `measure.field`, `having`, and `sort` may then
 *      reference dotted paths into the joined alias
 *      (e.g. `'category.parent'`).
 *   3. `$group`   — grouping + measure accumulators
 *   4. `$addFields` — finalize `countDistinct` sets into sizes
 *   5. `$project` — flatten `_id` into top-level group-by keys + drop
 *      intermediate set-accumulators; match the portable output shape
 *      sqlitekit produces (`{ role: 'admin', count: 2 }` not
 *      `{ _id: 'admin', count: 2 }`)
 *   6. `$match`   — post-aggregate filter (HAVING-equivalent)
 *   7. `$sort`
 *   8. `$skip` / `$limit`
 *
 * The `$project` stage is essential for portability. Without it, a
 * sqlitekit caller and a mongokit caller would see different row
 * shapes for the same `AggRequest` — sqlitekit returns
 * `{ role: 'admin', count: 2 }`, stock mongo returns
 * `{ _id: 'admin', count: 2 }`. The flatten stage closes that gap.
 */

import type { Filter } from '@classytic/repo-core/filter';
import { isFilter } from '@classytic/repo-core/filter';
import type { LookupSpec } from '@classytic/repo-core/lookup';
import type { AggRequest } from '@classytic/repo-core/repository';
import type { PipelineStage } from 'mongoose';
import { compileFilterToMongo } from '../../filter/compile.js';
import { LookupBuilder, type LookupOptions } from '../../query/LookupBuilder.js';
import { compileDateBucket } from './dateBucket.js';
import { compileMeasure } from './measure.js';
import { normalizeGroupBy, validateMeasures } from './normalize.js';

export interface BuiltPipeline {
  pipeline: PipelineStage[];
  /**
   * The stage count in `pipeline` that covers *everything except*
   * `$sort` / `$skip` / `$limit`. Paginators splice count + data
   * branches at this index so they share the group stage.
   */
  prePaginationIndex: number;
}

export function buildAggPipeline(req: AggRequest): BuiltPipeline {
  validateMeasures(req.measures);
  const groupCols = normalizeGroupBy(req.groupBy);
  const bucketAliases = req.dateBuckets ? Object.keys(req.dateBuckets) : [];
  validateBucketAliases(bucketAliases, groupCols, req.measures);
  const stages: PipelineStage[] = [];

  // 1+2. Filter split + lookups.
  //
  // `$match` BEFORE `$lookup` doesn't have access to joined fields
  // (the joined documents don't exist yet). When the caller's filter
  // references a joined-alias path (e.g. `'category.tier'`), that
  // predicate has to wait until AFTER all `$lookup` stages run.
  //
  // `splitFilterByAlias` produces:
  //   - `base`   — predicates referencing only base-collection fields.
  //                Emitted as `$match` BEFORE the `$lookup` chain so
  //                Mongo can leverage indexes on the base collection.
  //   - `joined` — predicates referencing one or more joined aliases.
  //                Emitted as `$match` AFTER the `$lookup` chain (and
  //                AFTER the `$addFields` coalesce that flips empty
  //                LEFT-JOIN results from `[]` to `null`), so dotted
  //                paths resolve correctly.
  //
  // No lookups → entire filter is base-side; no split needed.
  const aliasSet = new Set<string>((req.lookups ?? []).map((l) => l.as ?? l.from));
  const { base: baseFilter, joined: joinedFilter } = splitFilterByAlias(req.filter, aliasSet);

  if (baseFilter !== undefined) {
    const match = compileFilterToMongo(baseFilter);
    if (Object.keys(match).length > 0) {
      stages.push({ $match: match });
    }
  }

  // 2. $lookup* — joins, processed in array order. Reuses the same
  // `LookupBuilder.multiple` compiler that `lookupPopulate` ships, so
  // `LookupSpec.where` / `select` / `single` semantics are identical
  // across the two operations. After this block, dotted paths
  // (`'category.parent'`) into the joined alias are addressable in
  // `$group._id`, `$sum/$avg/...` measure expressions, and `$sort`.
  if (req.lookups && req.lookups.length > 0) {
    appendLookupStages(stages, req.lookups);
  }

  // 2b. Post-lookup `$match` — predicates that needed joined fields
  // to evaluate. Runs ONLY when at least one filter clause references
  // a joined alias. Cost: one extra pipeline stage; benefit:
  // dashboards can filter "premium-tier orders" without dropping to
  // kit-native pipelines.
  if (joinedFilter !== undefined) {
    const match = compileFilterToMongo(joinedFilter);
    if (Object.keys(match).length > 0) {
      stages.push({ $match: match });
    }
  }

  // 2c. Date buckets — synthesize a stable, sortable string label per
  // configured bucket alias and stash it under a safe internal field
  // name (`__bucket_<alias>`). The `$group` stage references these
  // materialized values; the post-group `$project` rebuilds them
  // under the user-provided alias on the output row.
  //
  // Materializing into `$addFields` BEFORE `$group` (rather than
  // inlining the expression inside `_id`) keeps the group-stage shape
  // simple and lets sort / having reference the bucket label without
  // recomputing it.
  const bucketInternalKey = (alias: string) => `__bucket_${alias}`;
  if (req.dateBuckets && bucketAliases.length > 0) {
    const addFields: Record<string, unknown> = {};
    for (const alias of bucketAliases) {
      // biome-ignore lint/style/noNonNullAssertion: alias was just keyed off req.dateBuckets above
      addFields[bucketInternalKey(alias)] = compileDateBucket(req.dateBuckets[alias]!);
    }
    stages.push({ $addFields: addFields } as PipelineStage);
  }

  // 3. $group — build _id + accumulators
  //
  // BSON disallows `.` in field names — `_id: { 'department.code': ... }`
  // throws "FieldPath field names may not contain '.'". We use a safe
  // key (`__` separator) for the `_id` slot and the matching `$project`
  // step rebuilds the nested output shape from the safe key.
  //
  // Group keys = real `groupBy` columns + materialized date-bucket
  // aliases. Empty groupBy + empty buckets → scalar aggregation
  // (`_id: null`). Either alone counts as a real group set.
  const groupId: Record<string, string> | null =
    groupCols.length === 0 && bucketAliases.length === 0
      ? null
      : (() => {
          const id: Record<string, string> = {};
          for (const field of groupCols) {
            id[safeIdKey(field)] = `$${field}`;
          }
          for (const alias of bucketAliases) {
            id[alias] = `$${bucketInternalKey(alias)}`;
          }
          return id;
        })();

  const groupStage: Record<string, unknown> = { _id: groupId };
  const distinctSetAliases: string[] = []; // measures that need post-group $size
  const percentileAliases: string[] = []; // measures that need post-group $arrayElemAt

  for (const [alias, measure] of Object.entries(req.measures)) {
    const compiled = compileMeasure(measure);
    groupStage[alias] = compiled.groupExpr;
    if (measure.op === 'countDistinct') {
      distinctSetAliases.push(alias);
    } else if (measure.op === 'percentile') {
      // `$percentile` returns an array (one element per `p`). We
      // always request a single-element array so a post-group
      // `$addFields` can unwrap it to a scalar — matches the SQL
      // `PERCENTILE_CONT(p)` output shape.
      percentileAliases.push(alias);
    }
  }
  stages.push({ $group: groupStage } as PipelineStage);

  // 3. countDistinct — replace set accumulators with their sizes
  if (distinctSetAliases.length > 0) {
    const addFields: Record<string, unknown> = {};
    for (const alias of distinctSetAliases) {
      addFields[alias] = { $size: { $ifNull: [`$${alias}`, []] } };
    }
    stages.push({ $addFields: addFields } as PipelineStage);
  }

  // 3b. percentile — unwrap the single-element `[value]` array to a scalar.
  // Defensive `$ifNull` shields against the empty-input case where Mongo
  // returns `null` instead of an array (would otherwise break `$arrayElemAt`).
  if (percentileAliases.length > 0) {
    const addFields: Record<string, unknown> = {};
    for (const alias of percentileAliases) {
      addFields[alias] = { $arrayElemAt: [{ $ifNull: [`$${alias}`, [null]] }, 0] };
    }
    stages.push({ $addFields: addFields } as PipelineStage);
  }

  // 4. $project — flatten _id into top-level group-by keys.
  //
  // For plain (non-dotted) group-by fields, the projection key matches
  // the safe-id key (no transformation). For dotted-path group-by
  // fields (e.g. `'department.code'`), we project under the ORIGINAL
  // dotted key — Mongo interprets that as nested-object output, which
  // matches the cross-kit AggResult shape (see repo-core's
  // `nestDottedKeys`). The source path on the right pulls from the
  // safe-id key inside `_id`.
  //
  // Date-bucket aliases also flatten from `_id.<alias>` to the
  // top-level row. Their internal `__bucket_<alias>` field on each
  // input doc is intermediate scratch — never projected.
  const projection: Record<string, 0 | 1 | string | Record<string, unknown>> = {
    _id: 0,
  };
  for (const field of groupCols) {
    projection[field] = `$_id.${safeIdKey(field)}`;
  }
  for (const alias of bucketAliases) {
    projection[alias] = `$_id.${alias}`;
  }
  for (const alias of Object.keys(req.measures)) {
    projection[alias] = 1;
  }
  stages.push({ $project: projection } as PipelineStage);

  // 5. HAVING — post-aggregate filter on measure aliases / group keys
  if (req.having) {
    const match = compileFilterToMongo(req.having);
    if (Object.keys(match).length > 0) {
      stages.push({ $match: match });
    }
  }

  // 5b. Top-N-per-group — `$setWindowFields` + `$match`.
  //
  // Runs AFTER having so the rank applies to the post-having row set
  // (filtering out below-threshold groups before ranking). The
  // window stage adds an internal `__topNRank` column; the follow-up
  // `$match` keeps only rows within the rank limit; the final
  // `$project` strips the internal column from the output.
  //
  // Validates partition columns are subset of group + bucket aliases
  // — kits validate at compile time so the failure surface is the
  // buggy AggRequest, not a runtime "no rows because the partition
  // column doesn't exist".
  if (req.topN) {
    validateTopN(req.topN, groupCols, bucketAliases, req.measures);
    appendTopNStages(stages, req.topN);
  }

  const prePaginationIndex = stages.length;

  // 6–7. Sort + pagination.
  if (req.sort) {
    stages.push({ $sort: req.sort } as PipelineStage);
  }
  if (typeof req.offset === 'number' && req.offset > 0) {
    stages.push({ $skip: req.offset } as PipelineStage);
  }
  if (typeof req.limit === 'number') {
    stages.push({ $limit: req.limit } as PipelineStage);
  }

  return { pipeline: stages, prePaginationIndex };
}

/**
 * Validate the `topN` spec against the rest of the request:
 *
 *   1. `partitionBy` columns must each be a `groupBy` field, a
 *      `dateBuckets` alias, OR a measure alias — otherwise the
 *      partition resolves to the same key for every row and top-N
 *      becomes a global limit.
 *   2. `limit` must be a positive integer.
 *   3. `sortBy` must be non-empty (rank without an order is meaningless).
 *
 * All checks throw at request time with a message naming the bad
 * field — so the failure surface is the buggy AggRequest, not a
 * silent "no rows" downstream.
 */
function validateTopN(
  topN: NonNullable<AggRequest['topN']>,
  groupCols: readonly string[],
  bucketAliases: readonly string[],
  measures: AggRequest['measures'],
): void {
  if (!Number.isInteger(topN.limit) || topN.limit <= 0) {
    throw new Error(
      `mongokit/aggregate: topN.limit must be a positive integer — got ${String(topN.limit)}`,
    );
  }
  if (!topN.sortBy || Object.keys(topN.sortBy).length === 0) {
    throw new Error('mongokit/aggregate: topN.sortBy must declare at least one ranking field');
  }
  const partitionList = Array.isArray(topN.partitionBy) ? topN.partitionBy : [topN.partitionBy];
  const validKeys = new Set<string>([...groupCols, ...bucketAliases, ...Object.keys(measures)]);
  for (const key of partitionList) {
    if (!validKeys.has(key)) {
      throw new Error(
        `mongokit/aggregate: topN.partitionBy "${key}" is not a groupBy field, dateBucket alias, or measure alias`,
      );
    }
  }
}

/**
 * Append the `$setWindowFields` + `$match` + `$project` stages that
 * implement top-N-per-group. Runs after the post-group projection,
 * so partition / sort keys reference output column names directly
 * (no `_id.`-prefix juggling).
 *
 * Tie-breaking strategy maps:
 *   - `'rank'`        → `$rank`            (default; gaps after ties)
 *   - `'dense_rank'`  → `$denseRank`        (no gaps)
 *   - `'row_number'`  → `$documentNumber`   (each row unique)
 */
function appendTopNStages(stages: PipelineStage[], topN: NonNullable<AggRequest['topN']>): void {
  const partitionList = Array.isArray(topN.partitionBy) ? topN.partitionBy : [topN.partitionBy];

  // Mongo's `partitionBy` accepts either a single field path or an
  // expression. For compound partitions, build a `$concat`-with-
  // separator key — `$concat` requires every operand to be a string,
  // so we coerce via `$toString` to safely include numeric / bool
  // partition keys (rare but valid). Single-key partitions skip the
  // composite to give the planner a cleaner shape.
  const partitionExpr =
    partitionList.length === 1
      ? `$${partitionList[0]}`
      : {
          $concat: partitionList.flatMap((field, i) => {
            const ref = { $toString: { $ifNull: [`$${field}`, '__NULL__'] } };
            return i === 0 ? [ref] : ['\u0001', ref];
          }),
        };

  const tiesOp =
    topN.ties === 'dense_rank'
      ? '$denseRank'
      : topN.ties === 'row_number'
        ? '$documentNumber'
        : '$rank';

  const RANK_FIELD = '__topNRank';

  // Cast through `unknown` because mongoose's `SetWindowFields` types
  // require the rank operator (`$rank`/`$denseRank`/`$documentNumber`)
  // to be a literal property name on a tagged union — but we pick at
  // runtime via `tiesOp`. Shape is correct; the type machinery just
  // can't follow the dynamic key.
  stages.push({
    $setWindowFields: {
      partitionBy: partitionExpr,
      sortBy: topN.sortBy,
      output: {
        [RANK_FIELD]: { [tiesOp]: {} },
      },
    },
  } as unknown as PipelineStage);

  stages.push({
    $match: { [RANK_FIELD]: { $lte: topN.limit } },
  } as PipelineStage);

  // Strip the internal rank column. `$project: { __topNRank: 0 }`
  // is an exclusion that keeps every other field — works correctly
  // alongside the earlier `$project` that already shaped the row.
  stages.push({
    $project: { [RANK_FIELD]: 0 },
  } as PipelineStage);
}

/**
 * Fail loud when a date-bucket alias collides with a `groupBy` column
 * or measure alias. The output row would otherwise contain ambiguous
 * keys — last writer wins on the projection, silently swapping
 * group-key values for measure values (or vice versa).
 *
 * Caught at compile time so the failure surface is the buggy
 * AggRequest, not a downstream consumer reading the wrong column.
 */
function validateBucketAliases(
  bucketAliases: readonly string[],
  groupCols: readonly string[],
  measures: AggRequest['measures'],
): void {
  if (bucketAliases.length === 0) return;
  const groupSet = new Set(groupCols);
  const measureSet = new Set(Object.keys(measures));
  for (const alias of bucketAliases) {
    if (groupSet.has(alias)) {
      throw new Error(
        `mongokit/aggregate: dateBuckets alias "${alias}" collides with a groupBy field of the same name`,
      );
    }
    if (measureSet.has(alias)) {
      throw new Error(
        `mongokit/aggregate: dateBuckets alias "${alias}" collides with a measure of the same name`,
      );
    }
  }
}

/**
 * Compile `LookupSpec[]` into mongo `$lookup` stages and append them
 * to the running pipeline. Mirrors the lookup section of
 * `lookupPopulate()` so cross-operation behavior stays identical:
 *
 *   - Each lookup contributes one `$lookup` stage (pipeline-form when
 *     `where` / `select` is set, simple form otherwise).
 *   - `single: true` lookups also emit an `$addFields` coalesce so
 *     the joined value becomes `null` instead of `[]` when no row
 *     matches (so `$group._id` keys are stable instead of falling
 *     into a single empty-array bucket).
 */
/**
 * Convert a (potentially dotted) groupBy field name into a safe key
 * for use inside `$group._id`. BSON disallows `.` in field names
 * anywhere — including the `_id` document — so dotted paths get the
 * `.` replaced with `__`. Plain field names pass through unchanged.
 *
 * Pairs with the `$project` stage that rebuilds the original dotted
 * key on the OUTPUT row, which Mongo then nests automatically (e.g.
 * projection key `'department.code'` produces `{ department: { code }}`).
 *
 * Cross-kit shape contract: see repo-core's `AggRow` doc and
 * `nestDottedKeys` helper.
 */
function safeIdKey(field: string): string {
  return field.includes('.') ? field.replace(/\./g, '__') : field;
}

function appendLookupStages(stages: PipelineStage[], lookups: readonly LookupSpec[]): void {
  // `LookupSpec` (repo-core) and `LookupOptions` (mongokit) overlap on
  // every field the builder reads — `from`, `localField`, `foreignField`,
  // `as`, `single`, `select`, `where`. Cast at the boundary; runtime
  // shape is identical.
  const asLookupOptions = lookups as readonly LookupOptions[];
  stages.push(...LookupBuilder.multiple(asLookupOptions as LookupOptions[]));

  for (const lookup of lookups) {
    if (lookup.single) {
      const asField = lookup.as ?? lookup.from;
      stages.push({
        $addFields: { [asField]: { $ifNull: [`$${asField}`, null] } },
      } as PipelineStage);
    }
  }
}

/**
 * Split a filter into base-side and joined-side predicates so the
 * caller can emit two `$match` stages — one BEFORE `$lookup` (for
 * base columns, leveraging indexes) and one AFTER `$lookup` (for
 * joined-alias references that don't exist pre-lookup).
 *
 * Behavior by input shape:
 *
 *   - **`undefined`** → both sides `undefined`.
 *   - **Plain record** (Mongo-style query object) → keys split by
 *     prefix: `'<alias>.<col>'` → joined; everything else → base.
 *     Top-level mongo operators (`$or`, `$and`) that mix base + joined
 *     references can't be cleanly split — the whole record routes
 *     post-lookup so semantics stay correct (at the cost of losing
 *     pre-lookup index usage on those branches).
 *   - **Filter IR** — top-level `and(...)` splits children by joined-
 *     alias presence; non-AND nodes route entirely to one side based
 *     on whether any leaf references an alias.
 *
 * No lookups (`aliasSet` empty) — short-circuit: entire filter is
 * base-side. Matches the no-join legacy behavior exactly.
 */
function splitFilterByAlias(
  filter: unknown,
  aliasSet: ReadonlySet<string>,
): { base: unknown; joined: unknown } {
  if (filter === undefined || filter === null) return { base: undefined, joined: undefined };
  if (aliasSet.size === 0) return { base: filter, joined: undefined };

  // Plain record path
  if (!isFilter(filter)) {
    return splitRecordByAlias(filter as Record<string, unknown>, aliasSet);
  }

  // Filter IR path
  return splitIRByAlias(filter as Filter, aliasSet);
}

function splitRecordByAlias(
  record: Record<string, unknown>,
  aliasSet: ReadonlySet<string>,
): { base: Record<string, unknown> | undefined; joined: Record<string, unknown> | undefined } {
  const base: Record<string, unknown> = {};
  const joined: Record<string, unknown> = {};
  let hasMixedTopOp = false;

  for (const [key, value] of Object.entries(record)) {
    // Top-level mongo operators (`$or` / `$and` / `$nor`) wrap subtrees
    // we'd need to recursively split. For the MVP, route the whole
    // record post-lookup if any of these mixes — semantics stay
    // correct, index advantage on base branches lost.
    if (key.startsWith('$') && Array.isArray(value)) {
      const branchesReferenceAlias = (value as Array<Record<string, unknown>>).some((branch) =>
        recordReferencesAlias(branch, aliasSet),
      );
      if (branchesReferenceAlias) {
        hasMixedTopOp = true;
        continue;
      }
      // Pure base-side compound operator
      base[key] = value;
      continue;
    }

    const dot = key.indexOf('.');
    const prefix = dot > 0 ? key.slice(0, dot) : null;
    if (prefix && aliasSet.has(prefix)) {
      joined[key] = value;
    } else {
      base[key] = value;
    }
  }

  if (hasMixedTopOp) {
    // The whole record routes post-lookup. Base stays empty.
    return { base: undefined, joined: record };
  }

  return {
    base: Object.keys(base).length > 0 ? base : undefined,
    joined: Object.keys(joined).length > 0 ? joined : undefined,
  };
}

function recordReferencesAlias(
  record: Record<string, unknown>,
  aliasSet: ReadonlySet<string>,
): boolean {
  for (const key of Object.keys(record)) {
    const dot = key.indexOf('.');
    if (dot > 0 && aliasSet.has(key.slice(0, dot))) return true;
  }
  return false;
}

function splitIRByAlias(
  filter: Filter,
  aliasSet: ReadonlySet<string>,
): { base: Filter | undefined; joined: Filter | undefined } {
  if (filter.op === 'and') {
    const baseChildren: Filter[] = [];
    const joinedChildren: Filter[] = [];
    for (const child of filter.children) {
      if (irReferencesAlias(child, aliasSet)) {
        joinedChildren.push(child);
      } else {
        baseChildren.push(child);
      }
    }
    return {
      base: andOrSingle(baseChildren),
      joined: andOrSingle(joinedChildren),
    };
  }
  if (irReferencesAlias(filter, aliasSet)) {
    return { base: undefined, joined: filter };
  }
  return { base: filter, joined: undefined };
}

function andOrSingle(children: Filter[]): Filter | undefined {
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0] as Filter;
  return { op: 'and', children: Object.freeze(children) } as Filter;
}

function irReferencesAlias(filter: Filter, aliasSet: ReadonlySet<string>): boolean {
  // Walk recursively. Leaves carry `field`; compound nodes recurse.
  // biome-ignore lint/suspicious/noExplicitAny: structural walk over Filter union
  const node = filter as any;
  if (typeof node.field === 'string') {
    const dot = (node.field as string).indexOf('.');
    if (dot > 0 && aliasSet.has((node.field as string).slice(0, dot))) return true;
  }
  if (Array.isArray(node.children)) {
    return (node.children as Filter[]).some((c) => irReferencesAlias(c, aliasSet));
  }
  if (node.child) {
    return irReferencesAlias(node.child as Filter, aliasSet);
  }
  return false;
}
