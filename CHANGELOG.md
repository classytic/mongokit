# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.4.1] - 2026-03-31

### Added
- **Compound keyset sort** — keyset pagination now supports 3+ sort fields (e.g. `{ priority: -1, createdAt: -1, _id: -1 }`). Cascading `$or` filter for correct cursor positioning.
- **Collation support** — `collation` option on `getAll`, offset, and keyset pagination for locale-aware and case-insensitive sorting.
- **lookupPopulate keyset mode** — lookups now support cursor-based pagination (O(1) performance). Auto-detected when `sort` without `page` is passed with lookups.
- **lookupPopulate `countStrategy`** — pass `countStrategy: 'none'` to skip `$facet` count pipeline, avoiding 16MB BSON limit on large documents.

### Fixed
- **Lookup count inflation** — `lookupPopulate` ran `$count` after `$lookup`/`$unwind`, inflating totals. Count now runs before lookups.
- **Select strips lookup fields** — `$project` after `$lookup` dropped joined `as` fields. Now auto-includes lookup aliases in inclusion projections.
- **Single lookup no-match returns `undefined`** — `$unwind` with `preserveNullAndEmptyArrays` left field missing. Now coalesces to `null` via `$ifNull`.
- **Lookup `select` caused cartesian join** — `LookupBuilder.multiple()` created pipeline-form `$lookup` without join condition when `select` was set. Now auto-generates `let`/`$match.$expr`.
- **Keyset cursor rejects plain ObjectId** — passing a raw 24-char hex string as `after` threw "not valid JSON". Now accepts plain ObjectIds as fallback.
- **Simple populate inconsistency** — `?populate=author` returned raw string in `populate` but no `populateOptions`. Now normalizes to `populateOptions` array.
- **Custom $lookup pipeline uncorrelated join** — `LookupBuilder.build()` with custom pipeline + `localField`/`foreignField` silently produced a cartesian join. Now auto-generates `let`/`$match.$expr` correlation while still sanitizing user pipeline stages.
- **`countStrategy: 'estimated'` wrong total with filters** — `estimatedDocumentCount()` ignores filters. Now falls back to exact `countDocuments()` when filters are present.
- **`countStrategy: 'none'` lost `hasNext` in lookup path** — `lookupPopulate` computed `hasMore` correctly but `getAll` mapped it to `hasNext: false` (derived from `total: 0`). Now propagates `hasMore` directly.
- **Invalid sort direction accepted** — keyset pagination accepted values like `2` or `0` as sort direction. Now rejects anything other than `1` or `-1`.
- **Unbounded lookup count** — no limit on number of `$lookup` stages. Now capped at 10 with a clear 400 error.
- **`$expr` wrongly blocked in lookup sanitizer** — `$expr` was listed as a dangerous operator alongside `$where`/`$function`/`$accumulator`, breaking legitimate `let`+`$expr` pipeline correlations. Removed from blocklist — `$expr` is a comparison operator, not code execution.
- **`aggregate.lookup()` inconsistent with `LookupBuilder`** — low-level helper had its own pipeline-form logic that didn't auto-correlate. Now delegates to `LookupBuilder.build()` for consistent behavior across all APIs.

### Changed
- **Node.js requirement** — bumped from `>=18` to `>=22`
- **`AggregatePaginationOptions.countStrategy`** — narrowed type from `'exact' | 'estimated' | 'none'` to `'exact' | 'none'` (aggregate has no `estimatedDocumentCount`)
- **`RepositoryInstance` properly typed** — `_buildContext`, `_handleError`, `update`, `aggregate`, `getByQuery`, `_executeQuery` now have typed signatures. Plugins no longer need `any` casts.
- **`CollationOptions` exported** — available for app devs extending Repository or building typed wrappers

## [3.4.0] - 2026-03-31

### Added
- **Soft-delete batch operations** — `deleteMany` now soft-deletes instead of hard-deleting; `updateMany` auto-excludes soft-deleted documents
- **`parseDuplicateKeyError()`** — exported utility; duplicate-key errors (E11000) now return 409 with field name and value instead of 500
- **Parallel pagination** — `find` and `countDocuments` now run concurrently via `Promise.all`
- **Lookup auto-routing in `getAll`** — pass `lookups` to `getAll()` and it auto-routes to `lookupPopulate` with proper offset pagination result
- **Lookup field selection** — `LookupOptions.select` shorthand converts to `$project` pipeline on joined collection (URL: `?lookup[dept][select]=name,code`)

### Fixed
- `updateMany` now reads hook-modified `context.data` instead of always using original payload

### Improved
- Replaced `Model<any>` with proper `Model<TDoc>` generics in action functions
- Removed unnecessary `as any` casts in query chain

## [3.3.0] - 2026-03-16

### Fixed
- **CRITICAL: `deleteByQuery()` runtime crash** — referenced undefined variable `id` instead of `document._id`. Any call to `deleteByQuery()` would throw `ReferenceError`.
- **`hasNext` false positive in pagination** — `countStrategy: 'none'` in both `paginate()` and `aggregatePaginate()` returned `hasNext: true` when exactly `limit` docs existed. Now uses limit+1 fetch-and-pop pattern consistently across all three pagination methods.
- **Cursor boolean serialization** — `Boolean('0')` returns `true` in JavaScript. Keyset pagination with boolean sort fields corrupted cursor values. Fixed to use strict equality check.
- **`Repository.delete()` return type** — return type narrowed to `{ success, message }` but actual result included `id` and `soft` fields. Now properly typed as `DeleteResult`.
- **Soft delete result** — `Repository.delete()` with soft-delete plugin now returns `{ id, soft: true }` in the result for consistency with `DeleteResult` interface.
- **Cascade plugin `_hooks` manipulation** — replaced direct `repo._hooks.get/set` internal access with public `repo.on()` API. Eliminates race condition with hook ordering.
- **Multi-tenant `createMany` null guard** — added null/type check when iterating `context.dataArray` items to prevent crashes on malformed input.
- **`uniqueField` validator silent failure** — now logs warnings via `warn()` instead of silently returning when `repo` or `getByQuery` is unavailable.
- **Batch `updateMany` empty query safety** — rejects empty query filters to prevent accidental mass updates.
- **Cache error tracking** — added `errors` counter to `CacheStats` interface. Adapter failures are now tracked separately from cache misses.
- **Transaction fallback detection** — checks MongoDB error codes (263, 20) first before string matching for faster standalone detection.
- **Cursor version graceful degradation** — accepts older cursor versions for rolling deploys, only rejects newer versions.
- **Soft-delete schema introspection** — logs warnings on failure instead of crashing. TTL index creation ignores error codes 85/86 (duplicate index).
- **Custom ID `null` assertion** — replaced non-null assertion (`result!.seq`) with proper null check and descriptive error.
- **Cascade delete test assertion** — fixed pre-existing test that didn't account for `id` field in delete response.

### Changed
- `CacheStats` interface now includes `errors: number` field
- `DeleteResult` is now the return type for `Repository.delete()` (was `{ success: boolean; message: string }`)

## [3.2.0] - 2025-02-16

### Added
- **Vector search plugin** (`@classytic/mongokit/ai`) — semantic similarity search via MongoDB Atlas `$vectorSearch`. Unified `EmbedFn` supports text, image, audio, and arbitrary media through a single `EmbeddingInput` interface. Includes `searchSimilar()`, `embed()`, auto-embed on create/update with multimodal `sourceFields`/`mediaFields`, batch embedding, and text-to-vector queries.
- **`vectorSearch()`** method on `AggregationBuilder` — fluent `$vectorSearch` pipeline stage with `withVectorScore()` helper.
- **`allowDiskUse()`** on `AggregationBuilder` — chainable option for large aggregations exceeding 100MB memory limit.
- **`exec(model, session?)`** on `AggregationBuilder` — build and execute pipeline in one call with options applied.
- **`plan()`** on `AggregationBuilder` — returns `{ pipeline, allowDiskUse }` for consumers that need execution options.
- **Multi-tenant plugin** — auto-injects tenant isolation filters into all queries/writes. Configurable `tenantField`, `contextKey`, `required`, `skipOperations`, `skipWhen`, and `resolveContext`. Enforces tenant scoping on update/delete to prevent cross-tenant mutations. `skipWhen` enables role-based bypass (e.g., super admin) without a separate repo. `resolveContext` resolves tenant ID from external sources like AsyncLocalStorage.
- **Observability plugin** — operation timing with `onMetric` callback, `slowThresholdMs` threshold, per-operation success/failure tracking. Works with any APM (DataDog, New Relic, OpenTelemetry).
- **`configureLogger()`** — centralizes all internal logging. Users can silence warnings (`configureLogger(false)`), redirect to custom loggers, or enable debug output for cache diagnostics.
- **`onEmbedError`** callback on `VectorPluginOptions` — controls what happens when the embedding service fails during auto-embed. If provided, the write continues without an embedding; if not, the error propagates.
- `allowedLookupCollections` option for `QueryParser` — whitelist collections allowed in `$lookup` stages.
- `transactionOptions` option for `withTransaction` — forward `readConcern`, `writeConcern`, etc. to the MongoDB driver.
- `LookupBuilder.sanitizePipeline()` static method for external pipeline sanitization.
- `docs/SECURITY.md` — comprehensive security documentation.
- **`off()` and `removeAllListeners()`** on `Repository` — allows removing event listeners to prevent memory leaks in long-lived applications. Also exposed on `RepositoryInstance` interface for plugin authors.
- New test files: `repository.advanced.test.ts`, `hooks.advanced.test.ts`, `multi-tenant-observability.test.ts` (20 tests including cross-tenant isolation), `vector.test.ts` (29 tests including multimodal embedding, full-doc update, error handling, numCandidates bounds), LookupBuilder unit tests, lookup pipeline security tests, plugin interaction tests.

### Fixed
- **Transaction resilience**: `withTransaction` now uses the MongoDB driver's `session.withTransaction()` with automatic retry on `TransientTransactionError` and `UnknownTransactionCommitResult`.
- **Hook contract consistency**: `getAll` now reads all query parameters (`sort`, `search`, `limit`, `page`, `after`) from context with params as fallback, matching the existing behavior for `filters` and `select`. Plugins can now reliably override any query parameter via `before:getAll` hooks.
- **Cache key accuracy**: Cache keys now include `search` and use the same resolved values as the actual query, preventing stale cache hits when plugins modify query parameters.
- **Keyset pagination null values**: Cursor encoding/decoding now handles `null` values. `buildKeysetFilter` correctly generates `$or` conditions for null cursor values respecting MongoDB's null sort ordering.
- **Read path error handling**: `getById`, `getByQuery`, and `getAll` now emit `error:*` hooks and normalize errors via `_handleError`, matching the pattern already used by write operations.
- **Auto-embed on update**: Now fetches the full document and merges with update data before embedding, so partial updates (e.g., changing only `title`) still produce embeddings from all source fields.
- **`numCandidates` bounds**: Clamped to `[limit, 10000]` (Atlas maximum). Consistent `Math.max(limit * 10, 100)` default in both the plugin and `AggregationBuilder`.
- **`includeScore:false` + `minScore`**: Score extraction is now auto-enabled when `minScore` is set, preventing silent zero-result queries.
- **`AggregationBuilder.vectorSearch()`**: Now enforces `$vectorSearch` as the first pipeline stage (throws if pipeline already has stages).
- **Dot-path `sourceFields`**: Nested paths like `'metadata.title'` now resolve correctly instead of silently returning `undefined`.
- **Vector plugin N+1 query**: `before:update` hook now fetches the existing document once (with session) instead of once per vector field, eliminating redundant DB calls when multiple vector fields are configured.
- **Cascade delete partial failures**: Parallel cascade deletes now use `Promise.allSettled` instead of `Promise.all`, ensuring all cascades execute even if one fails. Errors are collected and re-thrown after all cascades complete.
- **Cursor token validation**: `decodeCursor` now validates the structure and value types of cursor payloads before processing, preventing downstream errors from malformed or tampered tokens.
- **Memory cache performance**: `createMemoryCache` no longer runs a full expired-entry scan on every `get()`/`set()`. Expired entries are checked lazily per-key on `get()`, with periodic full cleanup only on `set()` when at capacity. Eviction upgraded from FIFO to LRU.
- **Mongoose 9 deprecation**: Replaced all `new: true` options with `returnDocument: 'after'` across `findOneAndUpdate`/`findByIdAndUpdate` calls (9 occurrences in actions, soft-delete plugin, and subdocument plugin). Silences Mongoose 9 deprecation warnings.

### Security
- **Multi-tenant update/delete scoping**: `update()` and `delete()` now enforce tenant isolation via `findOneAndUpdate`/`findOneAndDelete` with `context.query` constraints. Previously, knowing a cross-tenant `_id` allowed mutation.
- **lookupPopulate tenant bypass**: `lookupPopulate` now uses `context.filters` (plugin-modifiable) instead of raw `options.filters`, so multi-tenant filters are applied correctly.
- Lookup pipelines parsed from user input are now sanitized (closes pipeline injection vulnerability).
- `_sanitizePipeline` and `_sanitizeExpressions` methods added to `QueryParser`.
- QueryParser JSDoc security claims updated to accurately reflect implementation.

### Changed
- All internal `console.warn`/`console.log` calls replaced with centralized logger (`src/utils/logger.ts`). No behavior change for default configuration.

## [3.2.1] - 2025-02-16

### Added
- Comprehensive `returnDocument: 'after'` integration tests (21 tests covering all update/upsert/soft-delete/restore paths)

### Fixed
- **Soft-delete type cast**: Removed unnecessary `(context as any).softDeleted` cast in Repository

## [3.1.1] - 2024-12-XX

### Fixed
- Minor bug fixes and cleanup

### Added
- Lookup aggregation support (`lookupPopulate`, `LookupBuilder`, `AggregationBuilder`)
- Fallback transaction support with `allowFallback` option
- New types for better TypeScript inference

## [3.0.1] - 2024-XX-XX

### Added
- Async event support (`emitAsync`, configurable hook mode)
- Cascade delete plugin
- Enhanced soft-delete plugin with TTL support

### Changed
- Migrated entire codebase to TypeScript
- Added comprehensive caching support with Redis adapter

## [2.0.0] - 2024-XX-XX

### Changed
- **BREAKING**: Zero dependencies architecture (mongoose as peer dep only)
- Production-ready release with battle-tested plugins

### Added
- 12 built-in plugins (timestamp, soft-delete, cache, audit-log, validation, etc.)
- QueryParser with security hardening
- JSON Schema generator for OpenAPI/Fastify

## [1.0.2] - 2024-XX-XX

### Added
- Mongoose 9 support (`^8.0.0 || ^9.0.0`)

## [1.0.1] - 2024-XX-XX

### Fixed
- Dependency updates

## [1.0.0] - 2024-XX-XX

### Added
- Initial release
- Repository pattern with CRUD operations
- Offset and keyset pagination
- Plugin system architecture
- Event-driven hooks

[3.4.0]: https://github.com/classytic/mongokit/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/classytic/mongokit/compare/v3.2.1...v3.3.0
[3.2.0]: https://github.com/classytic/mongokit/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/classytic/mongokit/compare/v3.0.1...v3.1.1
[3.0.1]: https://github.com/classytic/mongokit/compare/v2.0.0...v3.0.1
[2.0.0]: https://github.com/classytic/mongokit/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/classytic/mongokit/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/classytic/mongokit/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/classytic/mongokit/releases/tag/v1.0.0
