# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.6.1] - 2026-04-14

### Added

- **`multiTenantPlugin` — `fieldType` option for tenant ID casting.** Controls how the tenant ID is stored and queried: `'string'` (default, backward-compatible) injects the raw string as-is; `'objectId'` casts to `mongoose.Types.ObjectId` before injection. Choose `'objectId'` when the schema declares the tenant field as `Schema.Types.ObjectId` — this enables `$lookup` joins and `.populate()` against the referenced collection (e.g., `organization`), which fail silently with string values due to MongoDB's strict type matching in `localField`/`foreignField` comparisons. The cast applies to all injection points: filters, queries, create data, createMany arrays, constrained writes, batch operations, and bulkWrite sub-operations. Exported `MultiTenantOptions` type updated with the new `fieldType` property.

## [3.6.0] - 2026-04-12

### Added

- **`delete(id, { mode: 'hard' | 'soft' })` — unified delete API**. Pass `mode: 'hard'` for GDPR / admin cleanup paths that must physically remove a record even when `softDeletePlugin` is wired. All policy hooks (multi-tenant scope, audit trail, cache invalidation, cascade) still fire — only the soft-delete interception is bypassed. `deleteMany(query, { mode })` mirrors this for bulk cleanups via `batchOperationsPlugin`. One canonical method, auditable via `grep 'mode: .hard.'`, no `Model.deleteOne` escape hatch needed. Powered by `context.deleteMode` which `softDeletePlugin` short-circuits on.
- **`before:restore` hook** — symmetric with `before:delete`, fires at POLICY priority so multi-tenant scoping and custom policy hooks run before the `findOneAndUpdate`. Existing `after:restore` payload shape normalized to `{ context, result }` matching every other `after:*` hook. Enables cascade-restore flows (re-increment counters, revalidate state, re-index search projections).
- **Module-level `withTransaction(connection, callback, options)`** — cross-repo transaction helper. `withTransaction(mongoose.connection, async (session) => { await orderRepo.create(data, { session }); await ledgerRepo.create(journal, { session }); })` no longer requires picking one repository to hang the transaction off. `Repository#withTransaction` now delegates to the same helper so retry, fallback, and session lifecycle semantics are single-sourced. `isTransactionUnsupported(error)` exported alongside for callers that classify errors themselves. New module at `src/transaction.ts`.
- **Schema-index-aware keyset pagination warning** — `PaginationEngine.stream()` now introspects `Model.schema.indexes()` via `hasCompatibleKeysetIndex` and only warns when no schema-declared compound index matches the effective filter + sort shape (ESR rule: equality prefix → sort suffix, with reverse-walk tolerance and `_id`-tiebreaker stripping). Eliminates false positives in packages like `@classytic/invoice` where policy plugins inject `deletedAt` / `organizationId` into filters that already have a matching compound index. Silent in `NODE_ENV=test`. New module at `src/pagination/utils/index-hint.ts`; warning text clarified to "no matching schema-declared compound index" to make the `schema.indexes()` caveat explicit (collection-level indexes from migrations aren't visible here). Lazy-cached per PaginationEngine instance.
- **Cascade plugin — repo-routed relations (the correctness fix)**. `CascadeRelation` now accepts `{ repo: targetRepo, foreignKey, softDelete? }` as the preferred routing path. When set, cascade calls `targetRepo.deleteMany({ [fk]: parentId }, { mode, session, organizationId, user })`, so the target's full hook pipeline fires: multi-tenant scoping stays enforced on cascade targets, audit logs capture the delete, cache invalidates, AND the target's own `softDeletePlugin` (with its custom `deletedField` — e.g. `archivedAt`) handles the write correctly. The legacy `{ model: 'Name', foreignKey }` path is kept for backwards compatibility but bypasses target hooks — documented caveat, recommended to migrate. Forwards `organizationId` / `tenantId` / `user` from the parent context via `collectScopeForward` so the target's multi-tenant plugin can resolve its scope from a cascade call.
- **Outbox recipe — composition over plugin**. New reference implementation at `tests/_shared/outbox-recipe.ts` shows hosts how to wire the transactional outbox pattern in ~100 lines using primitives that already exist: mongokit's `before:create/update/delete` hooks for session-bound writes, an `OutboxStore` that writes to a Mongo collection with `context.session`, and arc's `EventTransport` for delivery. Includes `wireOutbox({ repos, store, shouldEnqueue?, enrichMeta? })` helper, `MongoOutboxStore` class (structurally compatible with arc's `OutboxStore`), and a locally-defined `DomainEvent` shape matching arc. **No `outboxPlugin` ships in mongokit** — the recipe is documented in the README and validated end-to-end by `tests/outbox-recipe.test.ts` (13 tests including real-replica-set atomicity: when the enclosing `withTransaction` callback throws, both the business write AND the outbox row roll back together).
- **`RepositoryOperation` extended** with `'restore'` — the domain verb is now first-class in the operation enum alongside create / update / delete / etc.

### Changed

- **PaginationEngine schema-index warning text** — from "requires a compound index for O(1) performance" (unconditional) to "has no matching schema-declared compound index" (emitted only on false negatives). More accurate, less noisy, and explicit about the `schema.indexes()` visibility caveat.
- **README fully rewritten** — 1709 → ~320 lines. Concise quick-start, core concepts, pagination, delete semantics, transactions, outbox pattern section, plugin table, QueryParser sketch, TypeScript helpers, subpath imports, testing.
- **Test infrastructure — shared global-setup with parallel forks** — `tests/_shared/global-setup.ts` spins up ONE shared `MongoMemoryReplSet` (single-node replica set) per `vitest run` invocation. All forks connect to it via `MONGODB_URI`. Test files reuse collection-name prefixes for isolation. Previously `singleFork: true` + per-file `MongoMemoryServer` start/stop made the full suite take ~76s; now it runs in **~16s** with 1616 tests passing. Setting `MONGODB_URI` externally still works (CI replica sets, sharded clusters). `disconnectDB()` is a no-op in shared-server mode so mongoose stays connected across files within a fork.
- **`withTransaction` tests now exercise real transactions** — previously every assertion ran through `{ allowFallback: true }` because CI used standalone mongod. With the replica-set switch, the suite now verifies real commit, real rollback atomicity (both multi-repo writes discarded when the callback throws), and the `onFallback` path is confirmed to NOT fire when the topology supports transactions. `isTransactionUnsupported` classification retained as pure unit tests.
- **Two previously-skipped transaction safety tests un-skipped** — `tests/safety.test.ts` "should properly start and use session" and "should rollback on error" now run on the replica set and assert real transactional behavior. **Zero skipped tests** in the suite.

### Fixed

- **Cascade plugin was writing `deletedAt` directly via `Model.updateMany`** — bypassing the target repository's `before:delete` / `before:deleteMany` hooks. Cross-tenant cascade deletes were possible (tenant scoping never ran on the target), custom `deletedField` configurations were silently ignored (the plugin only wrote `deletedAt` regardless of the target's soft-delete config), and audit hooks on the target never fired for cascaded rows. Fixed by the new repo-routed path described in "Added". Exact edge case ("parent hard-delete + `relation.softDelete: true` on a target using a custom `archivedAt` field") is now covered by a test.
- **Soft-delete `after:restore` payload shape** — was `{ id, result, context }`, now `{ context, result }` matching every other `after:*` event. Minor breaking change but consistent with the rest of the hook contract; no in-tree consumers relied on the old shape.

### Removed

- **`context.forceHardDelete` flag** — renamed to `context.deleteMode` (`'hard' | 'soft' | undefined`). Softer semantics, reads as configuration instead of an escape hatch.

## [3.5.5] - 2026-04-07

### Added
- **Mongoose 9.4.1 alignment** — peer dep bumped from `^9.0.0` to `^9.4.1`. Dev dep upgraded to 9.4.1. The coercion primitive now reads `embeddedSchemaType.instance` (Mongoose 9.x+) with a `caster.instance` fallback for older versions, fixing array element type detection that was silently broken across both `[Type]` and `[{ type: Type }]` declaration forms. Full suite (1482 tests) verified against 9.4.1.
- **Geo query support** in QueryParser via 4 ergonomic operators that compile to canonical GeoJSON-shaped MongoDB queries:
  - `?location[near]=lng,lat[,maxDist]` → `$near` with `$geometry` Point + optional `$maxDistance`. Distance-sorted, MongoDB applies implicit ordering.
  - `?location[nearSphere]=lng,lat[,maxDist]` → `$nearSphere` (same shape, spherical Earth model).
  - `?location[withinRadius]=lng,lat,radiusMeters` → `$geoWithin: $centerSphere` — count-compatible alternative to `[near]` for paginated radius queries.
  - `?location[geoWithin]=minLng,minLat,maxLng,maxLat` → `$geoWithin: $box` for bounding-box queries (works without a 2dsphere index).
  - All operators validate coordinate ranges (-180/180 lng, -90/90 lat), reject malformed input by dropping the filter (not silently widening), and compose with non-geo filters via the standard merge path.
- **Repository geo integration** — `getAll()` auto-detects `$near` / `$nearSphere` in filters and:
  - Skips the default `-createdAt` sort injection (MongoDB forbids any explicit sort with `$near`).
  - **Warns and drops** any caller-supplied sort that conflicts, with actionable guidance pointing to `[withinRadius]` for sortable radius queries.
  - Rewrites the count query via `$geoWithin: $centerSphere` so `total` is accurate without breaking MongoDB's "no count with `$near`" rule. Falls back to `countStrategy: 'none'` for unbounded `$near` queries.
  - All existing concerns (populate, readPreference, plugins, hooks, multi-tenant scoping) compose unchanged. Verified end-to-end against a real 2dsphere index in `tests/queryParser.geo.test.ts` (16 tests), `tests/queryParser.geo-edge.test.ts` (5 tests), and `tests/queryParser.geo-advanced.test.ts` (8 tests covering `$geoNear` aggregation, `$near` + populate, and replica-set readPreference forwarding).
- **Schema index introspection** — new `parser.schemaIndexes` getter exposes `{ geoFields, textFields, other }` extracted from the schema's `indexes()` output. Useful for downstream tools (Arc MCP, query planners, doc generators) that need to know which fields support which query types. Enables early warning of geo-operator-without-index gaps before queries hit MongoDB.
- **Query primitive modules** in `src/query/primitives/` — pure, testable, tree-shake friendly functions powering QueryParser internals:
  - `primitives/coercion.ts` — `coerceHeuristic`, `coerceToType`, `coerceFieldValue`, `buildFieldTypeMap`, `normalizeMongooseType`. The single source of truth for value coercion, both heuristic and schema-aware.
  - `primitives/geo.ts` — `parseGeoFilter`, `buildNearFilter`, `buildWithinRadiusFilter`, `buildGeoWithinBoxFilter`, `parseCoordinateList`, `isValidLngLat`, `isGeoOperator`, `hasNearOperator`, `rewriteNearForCount`. The full geo translation pipeline + Repository sort-safety helpers.
  - `primitives/indexes.ts` — `extractSchemaIndexes`. Schema-version-decoupled index introspection.
  - 100+ dedicated unit tests across `tests/query/primitives/{coercion,geo,indexes}.test.ts`. Each primitive is independently exercised; QueryParser composes them as a thin orchestrator.
- **Subpath exports for query primitives** — published as separate entry points so downstream consumers can import individual modules without dragging in QueryParser, Repository, or Mongoose:
  - `import { parseGeoFilter } from '@classytic/mongokit/query/primitives/geo'`
  - `import { coerceFieldValue } from '@classytic/mongokit/query/primitives/coercion'`
  - `import { extractSchemaIndexes } from '@classytic/mongokit/query/primitives/indexes'`
  - Each ships a `.mjs` + `.d.mts` pair under `dist/query/primitives/`. Top-level barrel does NOT re-export primitives — tree-shake friendly by construction.
- **`PaginationEngine.paginate` `countFilters` option** — alternate filter used for the count query only while the primary `filters` is used for `.find()`. Powers Repository's `$near` count rewrite (find with `$near`, count with `$geoWithin: $centerSphere`) and is exposed for any caller that needs the same find-vs-count split.
- **Architectural guidance in SKILL.md** — new "Choosing the right mongokit primitive" section with a scenario → tool table. Documents when `getAll` is the right shape (CRUD, geo radius, search) vs when to reach for `aggregate` (recommendation engines, social graph traversal, time-series rollups), `findAll({ stream })` (bulk ETL), or a search-resolver plugin (external backends). Includes a concrete subclass example for domain methods like `getRecommendations`.
- **QueryParser schema-aware value coercion** — pass `schema: Model.schema` (Mongoose) or `fieldTypes: { stock: 'number', ... }` (DB-agnostic) and the parser coerces filter values to each field's declared type instead of guessing from the string shape. `?stock=50` against a `Number` field becomes `50`, `?name=12345` against a `String` field stays `'12345'`, `?releasedAt=2026-04-07` against a `Date` field becomes a `Date` instance, `?address.zip=01234` against a nested `String` field preserves the leading zero. Direct equality (`?stock=50`) and operator syntax (`?stock[gte]=50`) now coerce identically — closing the long-standing asymmetry where one path produced numbers and the other produced strings. `fieldTypes` overrides `schema` per path for runtime/computed fields. Unknown fields fall through to the legacy heuristic so ad-hoc filters keep working. New types: `FieldType` (`'string' | 'number' | 'boolean' | 'date' | 'objectid' | 'mixed'`), `SchemaLike`. 17 new dedicated tests in `tests/queryParser.schemaAware.test.ts` covering Mongoose schema, fieldTypes map, override semantics, nested paths, array element coercion, `$or` branch coercion, and fallback behavior.
- **Repository `searchMode` + `searchFields` options** — `Repository.getAll({ search })` now supports an index-free regex strategy at the repository level, not just inside `QueryParser`. Configure `new Repository(Model, [], {}, { searchMode: 'regex', searchFields: ['title', 'body'] })` and search works without a MongoDB text index. Modes: `'text'` (default, unchanged — uses `$text`), `'regex'` (case-insensitive `$or` of `$regex` across `searchFields`, user input regex-escaped), `'auto'` (text if a text index exists, otherwise regex). Pre-existing `$or` filters are preserved by promoting both clauses to `$and`. Makes mongokit a drop-in smart engine behind any HTTP framework (Express, Nest, raw handlers) — callers that hand `search` straight to `getAll` without first parsing through `QueryParser` now get the regex fallback for free instead of throwing `"No text index found"`.
- **Search-resolver plugin contract** documented as a first-class extension point for custom search backends (Elasticsearch, Meilisearch, Typesense, Algolia, pgvector, Pinecone, hybrid BM25+vector). 4-line contract: hook `before:getAll`, resolve `ctx.search` against your backend, mutate `ctx.filters` to `{ _id: { $in: ids } }`, set `ctx.search = undefined`. Composes cleanly with cache, multi-tenant, soft-delete, and audit plugins. No mongokit-core dependency on any backend; one plugin works in Arc, Express, Nest, or any HTTP framework. README has a dedicated "Custom Search Backends" subsection under Plugins with a complete Meilisearch example, and `tests/repository-search-mode.test.ts` exercises the contract end-to-end with realistic plugin stacks.
- **Composition test coverage** for the production stack: `searchMode: 'regex'` + `multiTenantPlugin` + `softDeletePlugin` + caller filter (proves all four constraints survive together with explicit negative assertions for tenant leaks, deleted docs, and non-matching docs); search-resolver plugin contract + `cachePlugin` (proves cache keys reflect post-hook filters and different search terms produce isolated cache entries).

### Fixed
- **Dangerous `$or` branches degraded into match-all `{}` placeholders.** When a `$or` array contained a branch composed only of dangerous operators (e.g. `or=[{$where: '...'}, {status: 'active'}]`), URL-side parsing in `_parseOr` and aggregation `$match` sanitization in `_sanitizeMatchConfig` stripped the dangerous keys but left an empty `{}` branch, which silently widens the query to match every document. Both code paths now drop empty branches, and if every branch was eliminated the surrounding `$or`/`$and`/`$nor` operator is omitted entirely (with a warning) rather than emitting an invalid empty array. This is a security fix: the bug effectively bypassed `dangerousOperators` for any caller using `$or`. Repro tests in `tests/queryParser.review-gaps.test.ts`.
- **Direct-equality numeric values stayed strings while operator syntax coerced.** `?stock=50` produced `{ stock: '50' }` while `?stock[gte]=50` produced `{ stock: { $gte: 50 } }`, breaking equality lookups against numeric fields unless callers knew to use operator syntax. `_convertValue` now applies safe numeric coercion as a fallback heuristic (rejects leading zeros, scientific notation, strings >15 chars to preserve zip codes, phone codes, and long numeric IDs that exceed JS safe-integer precision). For deterministic behavior, configure schema-aware coercion (above). Bracket-syntax `[in]`/`[nin]` and `[eq]` operators now also coerce per-element through the schema-aware path, so `?ratings[in]=1,2,3` against a `[Number]` field produces `[1, 2, 3]` and `?tags[in]=01234,sale` against a `[String]` field stays `['01234', 'sale']`.
- **Search-resolver plugin clears were silently ignored.** `Repository.getAll` previously read `search` as `context.search ?? params.search`, so a `before:getAll` plugin that set `ctx.search = undefined` (the documented way to delegate search to an external backend like Elastic/Meili) was overridden by the original `params.search`, and the text-index check still threw. Repository now reads `search` only from the post-hook context — `ctx.search = undefined` is a real clear, making the plugin contract actually work. This is the framework-level guarantee that makes search backends composable without mongokit knowing about them.
- `Repository.getAll` no longer unconditionally throws `"No text index found"` when `search` is provided on collections without a text index, provided the repository is configured with `searchMode: 'regex'`/`'auto'` **or** a `before:getAll` plugin clears `ctx.search`. The default `'text'` mode without a clearing plugin preserves prior throwing behavior for backwards compatibility.

### Internal
- `Repository` constructor now uses the project's `warn()` logger utility (via `configureLogger`-respecting helper) instead of `console.warn` for the `searchMode: 'regex'` misconfiguration warning. Consistent with other internal warnings.
- Removed an unnecessary type cast in `Repository.getAll` — `RepositoryContext.search` is already declared on the canonical type, no `(context as { search?: string })` needed. The cast was a leftover from initial defensive coding.
- **`PaginationEngine.paginate` no longer hardcodes a default `{ _id: -1 }` sort.** Callers (Repository) now supply the sort explicitly, and an `undefined` sort skips the `.sort()` call entirely so MongoDB's implicit `$near` distance ordering works without conflict. Repository defaults to `-createdAt` for non-geo queries before reaching PaginationEngine, so behavior is unchanged for existing callers.
- **QueryParser refactored to delegate coercion / geo parsing / index introspection to primitives.** The orchestrator class shrank substantially; all 100+ primitive unit tests run independently of QueryParser, and the same primitives are now reusable by Arc, custom parsers, and migration scripts.
- `tsdown.config.ts` adds the three primitive modules as separate entry points so each is emitted as its own `.mjs` / `.d.mts` pair under `dist/query/primitives/` for the new subpath exports.

## [3.5.4] - 2026-04-07

### Added
- **`softRequired` schema option** — mark a Mongoose path as DB-required but HTTP-body optional, for draft/state-machine resources (journal drafts, multi-step wizards). DB `required: true` still rejects null on save; only the generated `createBody.required[]` array excludes the field. Two APIs: per-path (`{ type: String, required: true, softRequired: true }` — type-safe via global declaration merge, zero import) or per-build (`buildCrudSchemasFromModel(Model, { softRequiredFields: ['journalType', 'date'] })` for upstream-owned models).

## [3.5.2] - 2026-04-04

### Added
- **`idField` option** — `new Repository(Model, [], {}, { idField: 'slug' })`. Per-call override: `repo.getById('laptop', { idField: 'slug' })`.
- **`getOne(filter, opts)`** — find single doc by compound filter (for controllers/frameworks).
- **`findAll(filters, opts)`** with sort support. `noPagination: true` on `getAll()` delegates to `findAll()`.
- **`maxLimit: 0`** = unlimited. QueryParser `allowedFilterFields`/`allowedSortFields`/`allowedOperators` getters.

### Changed
- `createMany()` defaults to `ordered: false` (partial inserts succeed). Pass `ordered: true` for old behavior.
- `getById()` with invalid ObjectId returns null/404 instead of 400 CastError.
- `noPagination: true` uses `context.filters` (not `params.filters`) — fixes tenant isolation bypass.

### Fixed
- All plugins respect `idField`: cascade, audit-log, audit-trail, validation-chain, elastic, soft-delete.
- Removed 23 dead `export default` lines (knip clean).
- `||` → `??` in PaginationEngine — `maxLimit: 0`, `defaultLimit: 0` now work correctly.

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
