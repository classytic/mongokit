/**
 * Mongokit's runtime capability descriptor — the `RepoCapabilities`
 * declaration required by `StandardRepo<TDoc>` (repo-core 0.6.0+).
 *
 * One source of truth, two consumers:
 *   - Runtime: `repo.capabilities.changeStreams` lets kit-portable hosts
 *     and arc feature-detect at boot instead of try/catching per call.
 *   - Conformance: the cross-kit harness (`ConformanceFeatures` is an
 *     alias of `RepoCapabilities`) spreads this constant so the flags the
 *     kit declares at runtime are exactly the scenarios the suite runs.
 *
 * Flags here describe what MongoDB itself supports through mongokit's
 * surface. Environment-specific limits (e.g. a standalone mongod without
 * an oplog) are overridden where the harness is constructed, not here.
 */

import type { RepoCapabilities } from '@classytic/repo-core/repository';

export const MONGOKIT_CAPABILITIES: RepoCapabilities = {
  // Multi-document transactions via sessions (requires replica set / mongos).
  transactions: true,
  // Mongo's driver supports withTransaction nesting on the same session.
  nestedTransactions: true,
  upsert: true,
  // `isDuplicateKeyError` classifies Mongo error code 11000.
  duplicateKeyError: true,
  distinct: true,
  aggregate: true,
  aggregateOps: {
    // Mongo 7+ `$percentile` (approximate t-digest accumulator).
    percentile: true,
    // Native `$stdDevSamp` / `$stdDevPop` (numerically stable Welford).
    stddev: true,
    // `$setWindowFields` (Mongo 5+) gives in-engine top-N per partition.
    topN: true,
    // `$dateTrunc` (Mongo 5+) handles `{ every, unit }` custom bins.
    customDateBuckets: true,
    // `$dateToString` `%H:%M` formats cover minute/hour named buckets.
    dateBucketSubMinute: true,
    // Per-request `cache?` slot routes through repo-core's SWR engine
    // when `aggregateCache` is wired on the Repository constructor.
    cache: true,
  },
  getOrCreate: true,
  countAndExists: true,
  // `purgeByField` chunks via `_id`-keyed batches through deleteMany /
  // updateMany so audit + cache plugins compose automatically.
  purgeByField: true,
  // `archiveByFilter(filter, sink)` — chunked cold-storage extraction
  // (write-before-delete) via `runChunkedArchive` + the mongo archive port.
  archiveByFilter: true,
  // Native `$push` / `$pull` / `$addToSet` / `$pop` / `$pullAll`.
  arrayOperators: true,
  // Filter IR `regex` op compiles to native `$regex`.
  regexFilter: true,
  // `watch()` via Mongo change streams (requires a replica set at runtime).
  changeStreams: true,
  // Read ops honor `lean: true` (plain objects instead of hydrated docs).
  lean: true,
  // Portable `lookupPopulate` join IR compiles to `$lookup` stages.
  lookupPopulate: true,
  // `cursor(filter, options)` streaming reads over mongoose cursors.
  streaming: true,
};
