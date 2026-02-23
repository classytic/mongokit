# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[3.2.0]: https://github.com/classytic/mongokit/compare/v3.1.1...v3.2.0
[3.1.1]: https://github.com/classytic/mongokit/compare/v3.0.1...v3.1.1
[3.0.1]: https://github.com/classytic/mongokit/compare/v2.0.0...v3.0.1
[2.0.0]: https://github.com/classytic/mongokit/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/classytic/mongokit/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/classytic/mongokit/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/classytic/mongokit/releases/tag/v1.0.0
