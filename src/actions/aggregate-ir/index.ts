/**
 * Aggregate IR action — portable `AggRequest` → MongoDB pipeline
 * compiler.
 *
 * Takes repo-core's backend-agnostic `AggRequest` and emits a mongo
 * aggregation pipeline that produces the same row shape sqlitekit
 * emits. The IR stays portable; this module knows the MongoDB
 * dialect.
 *
 * Public surface — two entry points consumed by the Repository layer:
 *
 *   - `executeAgg(Model, req, options)` — runs the aggregate, returns
 *     rows flattened to the portable shape (no raw `_id`)
 *   - `countAggGroups(Model, req, options)` — counts distinct groups
 *     for `aggregatePaginate`'s `total` field
 *
 * Internals split into focused modules, matching sqlitekit's layout:
 *
 *   - `normalize.ts` — input normalization (groupBy / measures)
 *   - `measure.ts`   — measure IR → `$group` accumulator
 *   - `pipeline.ts`  — full pipeline assembler
 *   - `execute.ts`   — pipeline run + row extraction
 *   - `count.ts`     — distinct-group counting strategies
 *
 * Kit-native mongo features that don't fit the portable IR — `$lookup`,
 * `$unwind`, `$facet`, `$graphLookup`, `$bucket`, window operators —
 * live on `Repository.aggregatePipeline(stages)` instead.
 */

export { countAggGroups } from './count.js';
export { executeAgg } from './execute.js';
