# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.11.0] - 2026-04-22

### Added — `updateMany` and `deleteMany` promoted to `Repository` class primitives

Previously these lived in `batchOperationsPlugin` and silently went missing when consumers forgot to wire it — `repo.updateMany is not a function` at runtime. They're now always on `Repository<TDoc>`, matching sqlitekit's always-available surface. The existing plugin code is moved into the class byte-faithfully — same `_buildContext` / policy-hook flow, same empty-filter guards (pre- AND post-policy), same `context.softDeleted` short-circuit on the soft-delete path.

- `repo.updateMany(filter, update, options?)` — `update` accepts the new portable `UpdateInput` (see below), raw Mongo operator records, or aggregation pipelines (with `updatePipeline: true`).
- `repo.deleteMany(filter, options?)` — honors `mode: 'hard' | 'soft'`. Defaults to soft when `softDeletePlugin` is wired; returns `{ acknowledged, deletedCount, soft: true }` on the soft path (the `soft` field is new, sourced from repo-core's `DeleteManyResult` contract).
- `batchOperationsPlugin` shrunk to contributing **only** `bulkWrite` — the Mongo-shaped batch API that has no clean SQL analogue. Drop `batchOperationsPlugin` from your plugin stack if you only wired it for `updateMany` / `deleteMany`.
- Hook emission unified through `_emitHook` / `_emitErrorHook` (the same path every other class method uses), so `hooks.mode: 'sync'` now behaves consistently across all operations. The plugin's older `emitAsync` / `emit` pair (always-async) was the outlier.

**Conformance**: `tests/unit/standard-repo-assignment.test-d.ts` now has per-method bindings for both methods. They satisfy repo-core 0.2.0's tightened `StandardRepo<TDoc>` (where `updateMany` / `deleteMany` are required members).

### Added — portable Update IR dispatch in `findOneAndUpdate` + `updateMany`

- `Repository.findOneAndUpdate(filter, update, options)` and `Repository.updateMany(filter, update, options)` accept the new `UpdateInput` shape from `@classytic/repo-core/update`.
- When `update` is an `UpdateSpec` (built via `update({ set, unset, inc, setOnInsert })` / `setFields(...)` / `incFields(...)` / `unsetFields(...)` / `setOnInsertFields(...)`), it is compiled to the `$set` / `$unset` / `$inc` / `$setOnInsert` Mongo operator record **before** the hook pipeline runs, so `before:*` listeners (tenant scope, soft-delete) see the exact operator shape they always did.
- Raw Mongo-operator records (`{ $set: {...} }`) and aggregation pipelines (`[{ $set: { ... } }]`) flow through unchanged — 100% backward-compatible.
- **Why**: arc's infrastructure stores (outbox, idempotency, audit) were coupled to Mongo operator grammar at the `RepositoryLike` call site, which made them non-portable to sqlitekit / prismakit. The IR closes the gap without changing runtime behavior on mongokit.

### Changed — `UpdateInput<TDoc>` renamed to `UpdatePatch<TDoc>` (deprecated alias)

To end the name collision with repo-core 0.2.0's `UpdateInput` (the `UpdateSpec | Record | Record[]` union), mongokit's single-doc patch shape (`Partial<Omit<TDoc, '_id' | 'createdAt' | '__v'>>`, used by `repo.update(id, data)`) is now `UpdatePatch<TDoc>`. The old name stays as a `@deprecated` alias for one release and will be removed in 3.12. Editors strike through the old import at every call site to signal the migration.

```ts
// Old:
import type { UpdateInput } from '@classytic/mongokit';

// New:
import type { UpdatePatch } from '@classytic/mongokit';
// and for the bulk union:
import type { UpdateInput } from '@classytic/repo-core/update';
```

### Changed — peer dep bump: `@classytic/repo-core` >= 0.2.0

Update IR lives at `@classytic/repo-core/update` (new subpath in 0.2.0). `StandardRepo.updateMany` / `deleteMany` are required members as of 0.2.0. mongokit 3.11.0 satisfies both.

### Housekeeping

- `cascadePlugin` error messages updated — no longer suggest wiring `batchOperationsPlugin` to get `deleteMany` on cascade target repos (it's always there now).
- `tx-bound.ts` comment updated — batch ops section heading reflects the class-primitive / plugin-method split.
- `AllPluginMethods<TDoc>` aggregator type no longer declares `updateMany` / `deleteMany` (they come from `Repository<TDoc>` directly).
- `BatchOperationsMethods` interface shrunk to `bulkWrite` only.

## [3.10.3] - 2026-04-21

### Added — `multiTenantPlugin` honors tenant fields already present on the payload

New `allowDataInjection: boolean` option on `multiTenantPlugin` (default **`true`**). When set, the plugin no longer throws "Missing 'organizationId' in context" on a write whose payload (`data` / `dataArray` / `query` / `filters` / bulkWrite `operations`) already carries the tenant field. It skips both the required-throw AND its own injection, so a host-supplied tenant value is preserved verbatim (not overwritten).

**Why:** hosts like arc stamp the tenant column directly onto the payload rather than threading it through the hook context. Before 3.10.3 every such write tripped the `required: true` default, forcing each downstream package (flow, pricelist, accounting…) to hand-roll the same `skipWhen` boilerplate that inspected `ctx.data[tenantField]`. Now the check is built-in.

```ts
// Works out of the box — plugin sees data[tenantField], skips the throw.
const repo = new Repository(Invoice, [multiTenantPlugin()]);
await repo.create({ name: 'Inv-1', organizationId: 'org_arc' });

// Context still wins when both are present:
await repo.create(
  { name: 'Inv-2', organizationId: 'org_data' },
  { organizationId: 'org_context' },
);
// → saved doc has organizationId = 'org_context'
```

**Safety model:**

- The plugin only trusts a payload tenant when `resolveContext` and the context key both come back empty. Anything resolved from context/resolveContext still overwrites `data[tenantField]`, so policy plugins upstream cannot be circumvented by payload stamping.
- On `createMany` + `bulkWrite`, the bypass requires **every** row/sub-op to carry the tenant field. Partial stamping is ambiguous (no resolver value to fill the gap) and falls through to the `required` throw.
- `skipWhen` runs first, unchanged. `allowDataInjection` is consulted only on the path where `resolveContext` came back empty.
- Strict pre-3.10.3 behavior is one flag away: pass `allowDataInjection: false`.

**Back-compat:** existing hosts that pass the tenant via context are unaffected — the new check only fires when the context is empty AND the data is populated, which used to throw and now succeeds. No caller relying on the old throw (e.g. as a negative test) should break silently; the throw still fires when BOTH are missing.

Test coverage added in `tests/multi-tenant-observability.test.ts`:
- Single-row data injection (create)
- Context preference over data (no silent overwrite regression)
- `createMany` all-or-nothing stamping
- `filters[tenantField]` bypass on reads
- Strict mode via `allowDataInjection: false`
- Composition with `skipWhen` and `resolveContext` (ordering verified)

## [3.10.2] - 2026-04-20

### Fixed — full `StandardRepo<TDoc>` conformance at every arc boundary

`Repository<TDoc>` now satisfies `MinimalRepo<TDoc>`, `StandardRepo<TDoc>`, AND `RepositoryLike<TDoc> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>` structurally without casts. Community drift report audit (inventory A–G): **two real drifts found and fixed**; the remaining five were latent or overstated and pass conformance unchanged. A compile-time conformance test locks this against future drift.

**Real drifts resolved:**

1. **`SelectSpec` mutability widened.** `string[]` → `readonly string[]` so repo-core's `LookupPopulateOptions.select: readonly string[] | ...` assigns through. Every existing `string[]` caller stays compatible (mutable is assignable to readonly). Internal array-narrowing sites in `PaginationEngine` + `Repository.lookupPopulate` take a localized cast because `Array.isArray`'s predicate (`x is any[]`) does not narrow `readonly T[]` out of a union.

2. **`session` field widened from `ClientSession` to `unknown`.** Repo-core's `QueryOptions.session?: RepositorySession = unknown` is the cross-kit contract — SQL/Prisma kits pass their own handle types. Narrowing to mongoose's `ClientSession` at the boundary broke structural assignment under `Partial<StandardRepo<TDoc>>` where strict function-type contravariance applies. Every public option interface (`SessionOptions`, `ReadOptions`, `OperationOptions`, `CacheableOptions`, `CreateOptions`, `UpdateOptions`, `FindOneAndUpdateOptions`, `AggregateOptions`, `AggregatePaginationOptions`, `OffsetPaginationOptions`, `LookupPopulateOptions`, `RepositoryContext`) now types `session?: unknown`. Internal mongoose calls (`.session(...)`, `{ session }` spreads) get a localized `as ClientSession | undefined` cast — mongokit narrows at the use site per repo-core's documented pattern.

3. **`LookupPopulateOptions` flattened** so it no longer inherits `[key: string]: unknown` from `SessionOptions`. Repo-core's `LookupPopulateOptions<TBase>` has no index signature; inheritance made mongokit's version structurally incompatible under strict contravariance. Fields now declared directly: `session`, `readPreference`, `organizationId` (the ones that were actually used).

**Claims audited and confirmed NOT drift:**

- **C. `FilterInput` contravariance on read methods** — `Record<string, unknown>` is a literal member of `FilterInput = Filter | Record<string, unknown>`, and method-parameter bivariance accepts both forms through `StandardRepo<TDoc>` references. Verified via call-site tests in the conformance file.
- **D. `FindOneAndUpdateOptions.sort`** — inherited `[key: string]: unknown` from `OperationOptions` already satisfies repo-core's wider `sort?: Record<string, unknown>`.
- **E. `findOneAndUpdate<TResult>` extra generic** — default-binds to `TDoc`, matches the contract.
- **F. `aggregatePaginate` return type** — `OffsetPaginationResultCore<TRow>` and `OffsetPaginationResult<TRow>` are structurally identical; conformance passes.
- **G. `getAll` param shape** — mongokit's inline shape already structurally satisfies `PaginationParams<TDoc>`.

### Added — conformance gate to prevent re-drift

`tests/unit/standard-repo-assignment.test-d.ts` compile-time asserts `Repository<Branch>` assigns to `MinimalRepo<Branch>`, `StandardRepo<Branch>`, and arc's `RepositoryLike<Branch>` — whole-interface AND per-method binding AND direct function-arg passing (the original arc `BaseController` repro). `tsconfig.tests.json` + `npm run typecheck:tests` runs it under strict mode; wired into `prepublishOnly` so CI catches future drift before a release ships. Per-method bindings force strict `strictFunctionTypes` checks that method-shorthand bivariance otherwise masks — any new drift fails loudly at the specific method.

## [3.10.1] - 2026-04-20

### Fixed — `Repository.lookupPopulate` now satisfies `StandardRepo<TDoc>` structurally

`Repository<TDoc>` instances assign to `RepositoryLike<TDoc>` / `StandardRepo<TDoc>` at arc boundaries without casts. Before 3.10.1, the `lookupPopulate` declaration drifted from the `@classytic/repo-core` contract — missing the `TExtra` generic, the `TDoc` parameterization on options, and a filter shape wide enough for repo-core's `Filter | (Partial<TDoc> & Record<string, unknown>)`. arc 2.10's `BaseController`, `createMongooseAdapter`, and the `repositoryAs{Audit,Outbox,Idempotency}Store` helpers all TS2345'd at the structural boundary. Aligned:

```ts
// Before (3.10.0) — drifted signature
lookupPopulate(options: LookupPopulateOptions): Promise<LookupPopulateResult<TDoc>>

// After (3.10.1) — matches StandardRepo<TDoc>.lookupPopulate bit-for-bit
lookupPopulate<TExtra extends Record<string, unknown> = Record<string, unknown>>(
  options: LookupPopulateOptions<TDoc>,
): Promise<LookupPopulateResult<TDoc, TExtra>>
```

`LookupPopulateOptions` gains a `<TBase = unknown>` generic (default keeps legacy non-generic usage compiling) and `filters` now accepts `Filter | (Partial<TBase> & Record<string, unknown>) | Record<string, unknown>` — the union covers repo-core's contract shape and arc's typed literals, so callers drop their `as unknown as RepositoryLike<TDoc>` wrapper at every `new BaseController(repo, ...)` / `createMongooseAdapter(model, repo)` site. Runtime behavior unchanged.

## [3.10.0] - 2026-04-20

### BREAKING — `getById` / `update` / `delete` miss semantics align with MinimalRepo contract

**Callers that relied on `rejects.toThrow('Document not found')` need to switch to `toBeNull()` / `toEqual({ success: false, ... })`.** The three methods now implement the `MinimalRepo<TDoc>` contract from `@classytic/repo-core/repository`: a miss is a value, not an error.

```ts
// Before — miss throws 404
await repo.getById(fakeId);         // throws { status: 404, message: 'Document not found' }
await repo.update(fakeId, { ... }); // throws
await repo.delete(fakeId);          // throws

// After — miss returns null / success:false
await repo.getById(fakeId);         // → null
await repo.update(fakeId, { ... }); // → null
await repo.delete(fakeId);          // → { success: false, message: 'Document not found' }
```

Structurally invalid ids (e.g. `'not-a-valid-id'` on an ObjectId `_id`) short-circuit to the same miss result rather than propagating mongoose's `CastError` — the same outcome any caller would want for "this id cannot exist in the collection." Invalid-id + `throwOnNotFound: true` still throws 404 the same way a valid-but-missing id does.

**Opt-in throw-on-miss preserved via `{ throwOnNotFound: true }`.** Pass it in the options bag to any of the three methods to recover the legacy 404 behavior — arc's `BaseController` patterns that were reading `error?.status === 404` already work with the new default by checking `doc == null` first, then catching any thrown error.

This matches `sqlitekit`'s miss semantics and is enforced by the cross-kit conformance suite. `error:getById` / `error:update` / `error:delete` hooks no longer fire on a default miss (miss is not an error); they still fire when `throwOnNotFound: true` is set or when the underlying mongoose op throws for other reasons.

### BREAKING — `Repository.lookupPopulate` returns the standard pagination envelope

**Callers reading `result.data` need to switch to `result.docs`.** The result shape now matches `getAll`'s envelope so the same code paginates plain reads and joined reads identically:

```ts
// Before — kit-specific shape
const result = await repo.lookupPopulate({ ... });
result.data;      // T[]
result.hasMore;   // boolean (offset path used hasMore for "more after this page")
result.next;      // string | null
// result lacked: method, pages, hasNext, hasPrev

// After — standard envelope (same shape getAll returns)
const result = await repo.lookupPopulate({ ... });
if (result.method === 'keyset') {
  result.docs;      // (TDoc & { joined keys })[]
  result.hasMore;
  result.next;
} else {
  result.docs;
  result.page;
  result.total;
  result.pages;
  result.hasNext;
  result.hasPrev;
}
```

The portable shape is defined in `@classytic/repo-core/repository` (`LookupPopulateResult` / `LookupRow`) and shared with sqlitekit / future kits — `result.docs[i]` carries the base doc plus one key per `LookupSpec.as` (defaults to `from`), array for `single: false` and object-or-null for `single: true`. Cross-kit dashboard code stops branching on the backend.

Mongokit's auto-route from `getAll` into `lookupPopulate` (when `lookups` is in the params) collapses to a passthrough — `lookupPopulate` already produces the envelope `getAll` needs.

Migration: search-and-replace `lookupPopulate(...).data` → `lookupPopulate(...).docs`. The keyset path still has `next` / `hasMore`; the offset path adds `pages` / `hasNext` / `hasPrev`.

### Added — Portable lookup IR (`StandardRepo.lookupPopulate?`)

`LookupSpec` / `LookupPopulateOptions` now live in `@classytic/repo-core/repository`. App code that imports them and calls `repo.lookupPopulate({ lookups: [...] })` works identically on mongokit and sqlitekit. The `LookupPopulateOptions` here in mongokit widens the portable type to ALSO accept mongokit's kit-native `LookupOptions[]` (`pipeline` / `let` / `sanitize`) for callers that need MongoDB-correlated joins — pass `LookupSpec[]` for cross-kit code, pass `LookupOptions[]` when you need the mongo extras.

### BREAKING — `Repository.aggregate` is now the portable IR; pipeline form moved to `aggregatePipeline`

**Callers passing a MongoDB pipeline array to `repo.aggregate(...)` need to rename to `repo.aggregatePipeline(...)`.** The change splits aggregation into two clean surfaces:

- **`aggregate(req: AggRequest)`** — portable cross-kit IR. Same input shape and same output rows on mongokit, sqlitekit, and future pgkit/prismakit. Use this for dashboards, summaries, and any aggregation that should work regardless of the backend.
- **`aggregatePipeline(stages: PipelineStage[])`** — kit-native MongoDB pipeline. Use this for `$lookup`, `$unwind`, `$facet`, `$graphLookup`, `$bucket`, change-stream tail operators, and anything else that doesn't translate to SQL. Behavior is byte-identical to the old `aggregate(pipeline)` — only the name changed.

`aggregatePaginate(options)` (paginated mongo pipeline) was renamed to `aggregatePipelinePaginate(options)` for symmetry; the new portable counterpart is `aggregatePaginate(req: AggPaginationRequest)`.

```ts
// Before — mongo pipeline form via `aggregate`
const stats = await repo.aggregate([
  { $match: { active: true } },
  { $group: { _id: '$category', total: { $sum: '$amount' } } },
]);

// After — option A: portable IR (works on every kit)
const { rows } = await repo.aggregate({
  filter: { active: true },
  groupBy: 'category',
  measures: { total: { op: 'sum', field: 'amount' } },
});
// rows: [{ category: 'admin', total: 1200 }, ...]

// After — option B: keep mongo pipeline, just rename
const stats = await repo.aggregatePipeline([
  { $match: { active: true } },
  { $group: { _id: '$category', total: { $sum: '$amount' } } },
]);
```

Migration is a search-and-replace for app code that was using the pipeline form. The portable IR is the recommended path for any aggregation that doesn't reach for `$lookup` / `$unwind` — it produces the same row shape on mongokit and sqlitekit, so dashboards stop being kit-specific.

Plugin authors: hooks renamed too. `before:aggregate` / `after:aggregate` now fire for the portable IR; the kit-native pipeline path fires `before:aggregatePipeline` / `after:aggregatePipeline`. The multi-tenant + soft-delete plugins were updated automatically — third-party plugins that observed the old hook names need to subscribe to both events if they want full coverage.

`OP_REGISTRY` (in `@classytic/mongokit/operations`) now carries entries for `aggregate`, `aggregatePaginate`, `aggregatePipeline`, and `aggregatePipelinePaginate`. Custom plugins iterating `ALL_OPERATIONS` will see all four — this is additive, not a behavior change.

### Added — Portable Filter IR support across every read/write method

`Repository._buildContext` now coerces `@classytic/repo-core/filter` IR nodes (`eq`, `and`, `gt`, `in_`, `like`, ...) into MongoDB query objects on `query` / `filters` / `having` slots. Plain Mongo queries pass through unchanged via `isFilter` discrimination. Lets app code that imports the portable Filter IR call `repo.findAll(eq('status', 'active'))` and have it work identically on mongokit and sqlitekit. Compiled by the new `compileFilterToMongo` (in `src/filter/compile.ts`).

### Added — `Repository.bulkWrite(operations)`

Heterogeneous bulk writes against the portable `BulkWriteOperation<TDoc>` shape from `@classytic/repo-core/repository`. Same signature as sqlitekit's `bulkWrite` so arc code that orchestrates mixed insert/update/delete batches doesn't branch on the backend.

### Added — Cross-kit conformance test suite

`@classytic/repo-core/testing` now ships `runStandardRepoConformance(harness)` — a vitest-driven scenario suite that exercises every `StandardRepo<TDoc>` method against a kit-supplied harness. Mongokit's harness lives at `tests/integration/conformance.test.ts`. Sqlitekit ships the same suite against better-sqlite3. When both stay green, swapping kits in app code is a provable claim.

### Fixed — `isDuplicateKeyError` recognizes wrapped `HttpError 409`

`Repository._handleError` wraps E11000 errors into a 409 `HttpError` with a `.duplicate.fields` payload. The classifier previously only matched the raw mongo driver error (`code === 11000`), missing the wrapped form arc's idempotency / outbox adapters actually see. Now classifies both shapes — without this fix, `repo.create()` followed by `isDuplicateKeyError(err)` could silently return `false` and break idempotent upsert flows.

### Re-exports — Standard contract types now live in `repo-core`

`DeleteResult`, `UpdateManyResult`, `BulkWriteResult` re-export from `@classytic/repo-core/repository` instead of being redefined locally. Imports from `@classytic/mongokit` continue to work — the names resolve to the same shape, just with a single source of truth.

### BREAKING — `Repository.withTransaction` callback signature

**Callers migrating from 3.9.x need to update `withTransaction` call sites.** The instance method's callback now receives a transaction-bound repository (`txRepo`) instead of a raw mongoose `ClientSession`. This aligns mongokit with `StandardRepo.withTransaction` from `@classytic/repo-core/repository` — the same contract sqlitekit / future pgkit / prismakit all follow — so cross-kit plugins and apps are portable without a shim layer.

```ts
// 3.9 — before
await repo.withTransaction(async (session) => {
  const order = await repo.create({ total: 100 }, { session });
  await repo.update(order._id, { confirmed: true }, { session });
  return order;
});

// 3.10 — after
await repo.withTransaction(async (txRepo) => {
  const order = await txRepo.create({ total: 100 });
  await txRepo.update(order._id, { confirmed: true });
  return order;
});
```

Session threading happens transparently — every CRUD method on `txRepo` auto-injects the session into its options bag, including plugin-added methods (`upsert`, `increment`, `updateMany`, `restore`, `bulkWrite`, `addSubdocument`, ...). See `src/tx-bound.ts` for the full list of wrapped methods.

Nested `txRepo.withTransaction(...)` throws — MongoDB nested transactions are a footgun (the inner callback runs under the outer session, rarely what callers want). Reuse the outer `txRepo` or collapse the nesting.

**Raw session access is still available via the standalone `withTransaction(connection, fn)` export** — unchanged, session-based, the right primitive for cross-repo workflows where multiple repositories coordinate writes on the same session. Internal migration inside mongokit's own test suite: the transaction-edge-cases integration tests that call mongoose directly (`TestModel.create([...], { session })`) switched to the standalone helper.

### BREAKING — `CacheAdapter.delete(key)` replaces `CacheAdapter.del(key)`

Also breaking, but a trivial one-liner for consumers: the cache-adapter method name aligns with JavaScript's native `Map.delete` / `Set.delete`, `Repository.delete(id)` in this same package, arc's `RepositoryLike.delete`, and every higher-level cache library (Keyv, etc.). One consistent name across every layer.

```ts
// 3.9 — before
const adapter: CacheAdapter = {
  async get(key) { ... },
  async set(key, value, ttl) { ... },
  async del(key) { await redis.del(key); },
  async clear(pattern) { ... },
};

// 3.10 — after
const adapter: CacheAdapter = {
  async get(key) { ... },
  async set(key, value, ttl) { ... },
  async delete(key) { await redis.del(key); },  // ← the inner redis client keeps `.del`; the adapter surface translates
  async clear(pattern) { ... },
};
```

Apps using the bundled `createMemoryCache` reference implementation need no change — just upgrade.

### Internal — migration to `@classytic/repo-core`

Mongokit extends `RepositoryBase` from `@classytic/repo-core/repository` for its driver-agnostic plumbing. **No other public API changes** beyond `withTransaction` and `CacheAdapter.delete` above — the `Repository(Model, plugins, paginationConfig, options)` constructor, every CRUD method, every plugin, and every type export is otherwise byte-stable with 3.9. 1838/1838 integration + 104/104 unit tests pass against the new surface.

- **Hook engine replaced.** The priority-sorted listener registry (`on` / `off` / `emit` / `emitAsync`) is now `@classytic/repo-core/hooks`'s `HookEngine`. Same ordering guarantees (ascending priority, stable for equal priorities, sync-mode fire-and-forget routes errors to `error:hook`). `repo._hooks: Map<string, PrioritizedHook[]>` is preserved as a read-through getter so existing observability patterns (`repo._hooks.size`, `repo._hooks.get('before:getAll')`) keep working.
- **`HOOK_PRIORITY` re-exported from repo-core.** `import { HOOK_PRIORITY } from '@classytic/mongokit'` and `from '@classytic/repo-core/hooks'` return the same reference — priorities (POLICY=100, CACHE=200, OBSERVABILITY=300, DEFAULT=500) unchanged.
- **`_buildContext` inherits from base.** Always awaits `before:*` hooks regardless of `hooks` mode — fixes a latent footgun where `hooks: 'sync'` would let the driver call fire before policy plugins (multi-tenant, soft-delete) injected scope into the context. After- and error-hooks still honor `hooks: 'sync'` for fire-and-forget observability.
- **Plugin order validation via `@classytic/repo-core/repository`.** Same engine that sqlitekit / pgkit / prismakit will use, so mis-ordering warnings are identical across every kit.
- **Plugin install deferred to post-construction.** `super()` initializes hooks + plugin-order check, but plugin `apply()` runs AFTER `this.Model`, `this._pagination`, `this.idField` are live — several mongokit plugins (softDelete TTL index, cascade, audit-trail) read `repo.Model` during install.

### Added

- `@classytic/repo-core ^0.1.0` is now a runtime dependency (plain `dependencies`, not peer — it's an implementation primitive). Adds zero transitive runtime deps; repo-core itself has no runtime deps.

### Behavior

- **New plugin-order warning** when `multi-tenant` is installed after `soft-delete` in the same stack — repo-core's validator enforces "multi-tenant scope before soft-delete filter" as a third rule (mongokit 3.9 only enforced "soft-delete before batch-operations" and "multi-tenant before cache"). Correctly ordered stacks emit no new warnings; the existing `pluginOrderChecks: 'off'` silences the check as before.

### Unchanged — deliberately

- **Error helpers stay in mongokit.** `createError`, `isDuplicateKeyError`, `parseDuplicateKeyError` still live in `@classytic/mongokit/utils/error` and still detect Mongoose `ValidationError` / `CastError`. Migrating these to `@classytic/repo-core/errors` is deferred — the generic contract is there but moving mongokit's call sites adds risk without user-visible benefit for this release.
- **Cursor codec stays in mongokit.** Keeps ObjectId rehydration logic alongside keyset SortSpec validation in `pagination/utils/`. Migrating to `@classytic/repo-core/pagination` requires a `tagValue` extension wire-up that's not worth destabilizing a minor release.

## [3.9.0] - 2026-04-17

### Added — `Repository.isDuplicateKeyError(err)`

- **`Repository.isDuplicateKeyError(err: unknown): boolean`.** Authoritative duplicate-key classifier that lives on the kit that knows its driver. Unblocks `@classytic/arc` 2.9.1's cross-driver consolidation: its outbox / idempotency adapters need to distinguish "write already landed (idempotent no-op)" from "transient DB error (must retry)", and every backend signals dup-key differently — MongoDB `code: 11000`, Prisma `P2002`, Postgres `23505`. Moving the predicate back to mongokit lets arc drop the `11000` literal from its adapters and depend on the boolean contract instead.
- **Deliberately narrow.** Matches ONLY `code === 11000` and `codeName === 'DuplicateKey'`. Does NOT match `err.name === 'MongoServerError'`, which is also true for `WriteConflict` (112), `NotWritablePrimary` (10107), `ExceededTimeLimit`, and every other server-side Mongo error. Treating those as duplicate keys would cause arc's outbox to silently swallow transactional retries and lose events.
- Also exported as a pure utility: `isDuplicateKeyError` alongside `createError` and `parseDuplicateKeyError` from `@classytic/mongokit` top-level.
- `parseDuplicateKeyError` now internally delegates to the same classifier, so the two stay in lockstep (previously only checked `code === 11000` — adding `codeName === 'DuplicateKey'` is a pure superset, no regressions).

## [3.8.0] - 2026-04-17

### Added — Repository

- **`Repository.findOneAndUpdate(filter, update, options)`.** Atomic compare-and-set primitive exposed as a first-class method. Mongokit already used mongoose's `findOneAndUpdate` internally (in `soft-delete`, `custom-id`, `subdocument` plugins) but never surfaced it publicly. Consumers building **transactional outbox**, **distributed lock**, or **workflow semaphore** patterns needed `returnDocument: 'after'` semantics with `sort` for FIFO claim-lease and were reaching for `repo.Model.findOneAndUpdate` directly — bypassing hooks, plugins, and the request-context pipeline. The new method routes through the standard `before:` / `after:` / `error:` hook lifecycle so multi-tenant scope, soft-delete filtering, audit logging, and timestamp stamping all apply.
  - `sort?: SortSpec` — disambiguate when filter matches multiple docs (claim-oldest semantics).
  - `returnDocument?: 'before' | 'after'` (default `'after'`).
  - `upsert?: boolean` — insert when no doc matches; default returns the inserted doc.
  - `arrayFilters`, `collation`, `maxTimeMS`, `runValidators`, `updatePipeline` (array form, default off — same opt-in as `update()`).
  - Returns the matched document (post-update by default) or `null` when no doc matches and `upsert` is false.
  - `lean: true` by default — outbox/lock workloads don't need hydrated mongoose docs. Pass `lean: false` to opt back in.

### Added — plugin coverage for `findOneAndUpdate`

- **`multiTenantPlugin`** now scopes `findOneAndUpdate` filters by tenant via `context.query` (added to `constrainedWriteOps`). Cross-tenant docs cannot be matched.
- **`softDeletePlugin`** now excludes deleted docs from `findOneAndUpdate` matches (added to the query-style filter injector). Pass `includeDeleted: true` to override.
- **`timestampPlugin`** now stamps `updatedAt` on `findOneAndUpdate`. Operator-style updates (`$set`, etc.) get `updatedAt` injected via `$set`; upserts get `createdAt` via `$setOnInsert`. Aggregation-pipeline updates are left alone — pipelines are user-driven and should set timestamps explicitly.

### Added — operation registry (single source of truth for plugin op classification)

- **`src/operations.ts` — `OP_REGISTRY`, `ALL_OPERATIONS`, `MUTATING_OPERATIONS`, `READ_OPERATIONS`, `operationsByPolicyKey()`.** Adding a new repository operation previously required touching 5 bundled plugins (multi-tenant, soft-delete, observability, audit-trail, validation-chain) — each maintained its own duplicated op array. The registry classifies every op by `{ policyKey, mutates, hasIdContext }`. Bundled plugins now switch on the classification:
  - `multi-tenant` collapses 6 op arrays into one switch over `OP_REGISTRY[op].policyKey`.
  - `soft-delete` drives its filter-injection loop from the registry; incidentally fixes a long-standing double-registration of `before:aggregate` and `before:aggregatePaginate`.
  - `observability` derives `DEFAULT_OPS` from `ALL_OPERATIONS` instead of a hand-maintained array.
- Exported publicly so third-party plugin authors (and forthcoming sibling kits — `pgkit`, `prismakit`) can drive op-iteration loops from the same source. Cross-driver plugins (multi-tenant, audit, observability) become portable: only the *filter grammar* differs across drivers, not the context shape.
- Migration impact: zero. Custom plugins that maintained their own op lists continue to work; nothing prevents that pattern. Plugins that want auto-classification of future ops can opt in by importing from `@classytic/mongokit`.

### Changed — `findAll` context key (plugin contract alignment)

- **`findAll` now exposes its filter on `context.query` instead of `context.filters`.** Public method signature is unchanged — `repo.findAll(filter, options)` still takes the filter as its first positional arg. The change is in the hook contract: `findAll`'s primary input is a raw filter (same shape as `getOne` / `update` / `findOneAndUpdate` / `count` / `exists`), so it now joins the dominant `context.query` convention. Paginated list ops with a `{ filters, page, limit, ... }` options bag (`getAll`, `aggregatePaginate`, `lookupPopulate`, soft-delete's `getDeleted`) keep `context.filters` — that key is genuinely a sub-property of the options for those ops.
- Bundled plugins updated to match: `multiTenantPlugin` and `softDeletePlugin` now write to `context.query` for `before:findAll`.
- Migration impact: zero for users of `repo.findAll(...)`. Custom plugin/hook authors who registered a `before:findAll` listener that mutated `context.filters` must rename to `context.query`. Reasoning documented inline in `Repository.findAll` so the split is discoverable when adding new methods.

### Why this matters beyond mongokit

Locks the convention that plugins universally read **`context.query`** for any op whose primary input is a filter. Future repos following this contract (a `pgkit`, `prismakit`, etc.) ship plugins (multi-tenant, soft-delete, audit) that work identically across drivers — the difference is the filter *grammar*, not the context shape. `@classytic/arc` 2.10's `RepositoryLike` will document this guarantee in the interface JSDoc.

### Why `findOneAndUpdate`

Unblocks `@classytic/arc` 2.10's consolidation of mongo-backed stores (audit, idempotency, outbox) onto `RepositoryLike`. The outbox relay needs FIFO claim-lease via `findOneAndUpdate(sort + returnDocument: 'after')`, which has no equivalent in `batchOperationsPlugin` / `mongoOperationsPlugin` (`bulkWrite` can do conditional upsert but doesn't return the post-update doc).

## [3.7.0] - 2026-04-17

This release closes the "deep-test before ship" gaps surfaced by a thorough enterprise review. All changes are additive — no breaking APIs. Existing code runs untouched unless it relied on the PII-leaking duplicate-key message (which was already a footgun).

### Added — pagination

- **`PaginationConfig.minCursorVersion`.** Reject stale client cursors below this version with a clear `"Pagination must restart"` error. Bump alongside `cursorVersion` on breaking format changes so URLs with cached cursors don't silently paginate from the wrong position. Default `1` (legacy behavior preserved).
- **`PaginationConfig.strictKeysetSortFields`.** Allowlist of primary keyset sort fields. Protects against the MongoDB type-boundary gap where keyset pagination on a nullable field leaves some docs unreachable — sort validation now throws at construction / call site if the field isn't on the list.

### Added — multi-tenancy

- **`createTenantContext()`.** Batteries-included AsyncLocalStorage helper (`run`, `getTenantId`, `requireTenantId`, `getStore`). Wires directly into `multiTenantPlugin({ resolveContext })` so handlers don't have to thread `organizationId` on every call — addresses the quiet "forgot the tenant" failure mode.

### Added — Repository hardening

- **`RepositoryOptions.pluginOrderChecks`.** Validates plugin composition at construction (`'warn'` default, `'throw'` for production, `'off'` to disable). Flags known foot-guns: soft-delete must precede batch-operations; multi-tenant must precede cache.

### Added — cache

- **`CacheOptions.jitter`.** Per-entry TTL jitter to prevent cache stampedes at scale. Accepts a number in `[0, 1]` (symmetric fractional spread) or a function `(ttl) => ttl` for full control.

### Added — query hardening

- **QueryParser `$match` depth guard.** `_sanitizeMatchConfig` was previously an unbounded recursion — a hostile nested `$or`/`$and` in aggregation input could blow the stack. Now capped by `maxFilterDepth`.
- **Static regex complexity budget.** Defense-in-depth behind the existing heuristic `dangerousRegexPatterns` detector: counts unbounded quantifiers, groups, alternations; escapes the pattern when thresholds are crossed even if the heuristic missed it.

### Added — vector plugin

- **`VectorPluginOptions.allowedMediaOrigins`.** SSRF allowlist for media URLs the plugin reads from document data before handing to `embedFn`. Supports exact origins (`https://cdn.example.com`) and wildcard hosts (`https://*.example.com`).
- **`VectorPluginOptions.blockPrivateIpUrls`.** When true, rejects URLs whose literal IP is private/loopback/link-local — catches `http://169.254.169.254/…` cloud-metadata exfil, RFC1918, `127.0.0.1`, IPv6 loopback and ULA. DNS-based rebinding must still be handled at the network layer.

### Changed — error handling

- **`parseDuplicateKeyError` is PII-safe by default.** The 409 message no longer includes the duplicate value — previously it inlined `keyValue` (emails, tokens) into error text that routinely lands in logs and crash reports. Structured field names are attached to `error.duplicate.fields`. Pass `{ exposeValues: true }` to opt into the legacy inline behavior for dev / trusted server-to-server contexts.

### Testing infrastructure

- **Vitest projects — tiered per `testing-infrastructure.md`.** New `unit` project (`tests/unit/**`, 10s budget, no mongo) and `integration` project (`tests/integration/**` + legacy flat tests, 30s budget, shared MongoMemoryServer). Canonical `test:unit` / `test:integration` / `test:all` / `test:watch` scripts. Existing 89 flat test files continue to run under the integration project — no re-org needed.
- **+84 new tests** across 10 new test files (unit and integration) covering: cursor version negotiation, pagination edge cases at scale, AsyncLocalStorage tenant context, plugin-order assertions, cache TTL jitter + stampede mitigation, E11000 PII scrub, QueryParser depth bombs, regex complexity budget, vector URL policy, concurrent update + bulkWrite partial failure, cache adapter outage resilience, keyset strict-sort, createMany partial failure hook semantics.

### Known limitations (now documented in code)

- Keyset pagination on a sort field that mixes typed values and null/undefined is lossy across the type boundary — some docs are unreachable. Use `strictKeysetSortFields` to lock keyset sort to fields your schema guarantees non-null, or sort by `_id` alone.

## [3.6.4] - 2026-04-15

### Fixed

- **`x-ref` vendor extension is now opt-in via `openApiExtensions: true`.** 3.6.3 emitted `x-ref: '<ModelName>'` on every ObjectId field with a `ref` declaration. This regressed consumers running Ajv in **strict mode**, which throws `strict mode: unknown keyword: "x-ref"` on any unknown `x-*` vendor extension. Default is now OFF — generated schemas are keyword-clean and compile under Ajv strict without adjustment. Pass `{ openApiExtensions: true }` to `buildCrudSchemasFromMongooseSchema` / `buildCrudSchemasFromModel` when the output is headed to OpenAPI / Swagger / docgen.

  Migration: no action needed for validation consumers (arc, Fastify schema validation) — the default now matches their expectation. Docgen consumers that previously relied on `x-ref` being emitted by default should set the flag explicitly.

### Added

- **`openApiExtensions?: boolean` in `SchemaBuilderOptions`.** Top-level flag that gates OpenAPI vendor extensions (`x-*` keywords). Currently controls `x-ref`; future vendor extensions will be gated by the same flag so Ajv strict-mode consumers can always rely on a keyword-clean default.

### Internal

- `builderOptions` now threads through `schemaTypeToJsonSchema` → `subSchemaToJsonSchema` → `introspectArrayItems` → `jsonTypeFor` so vendor-extension flags reach every recursion level. Previously `introspectArrayItems` passed an empty `{}` to `jsonTypeFor` and `jsonTypeFor`'s bare-Schema branch dropped options; both fixed.

### Test coverage

Regression guards added to `mongooseToJsonSchema-parity.test.ts`:
- Default output (flag off) compiles under Ajv `strict: true` for ObjectId-with-ref schemas — asserts the bug cannot silently return.
- Opt-in output (flag on) produces `x-ref` at every nesting level: top-level, inside DocumentArray subdocs, in `[{type:ObjectId,ref}]` shorthand items, and in **array-of-array-of-subdocs with ref fields** — guards against any future regression that stops threading `builderOptions` through `jsonTypeFor` or the array-of-array recursion.
- Opt-in output under Ajv `strict: true` predictably throws `unknown keyword: x-ref` (expected — docgen path).
- Opt-in output under Ajv `strict: false` compiles cleanly (standard docgen pipeline).
- Default output of array-of-array-of-subdocs-with-ref also compiles under Ajv `strict: true` (the deepest realistic nested ref shape stays keyword-clean).

## [3.6.3] - 2026-04-15

### Fixed

- **`listQuery` schema — page/limit declared as `integer`, lean/includeDeleted as `boolean`.** Previously every pagination/filter query-string field was typed `{type:'string'}`, including numeric (`page`, `limit`) and boolean (`lean`, `includeDeleted`) fields. Any consumer merging numeric constraints (e.g. `{minimum:1}`) onto the page/limit string declaration triggered Ajv's strict-mode warning `"keyword minimum is not allowed for type string"`. Now:
  - `page` → `{type:'integer', minimum:1, default:1}`
  - `limit` → `{type:'integer', minimum:1, default:20}`
  - `lean` / `includeDeleted` → `{type:'boolean', default:false}`
  - `sort` / `populate` / `search` / `select` → unchanged (genuinely strings)
  - `after` (keyset cursor) → added as `{type:'string'}`

  HTTP query strings still work — Fastify's default `coerceTypes` flips `?page=2` into a number at validation time. Declaring semantic types lets Ajv reject `?page=0`/`?page=-1`/`?lean=maybe` AND delivers typed values to handlers. Runtime `defaultLimit`/`maxLimit`/`maxPage` enforcement on the Repository is unchanged. Covered by `tests/utils/mongooseToJsonSchema-listQuery.test.ts` (14 tests).

- **`buildCrudSchemasFromModel` / `buildCrudSchemasFromMongooseSchema` — array items now match the declared element type.** Previously, every Mongoose array path emitted `items: { type: 'string' }` (acknowledged by an inline TODO in `src/utils/mongooseToJsonSchema.ts`). This made Fastify reject any non-string array payload with `body/<field>/0 must be string`, breaking primitive arrays (`[Number]`, `[Boolean]`, `[ObjectId]`, `[Date]`), `{ type: [X] }` shorthand with element validators, subdocument arrays (`[{ name: String, url: String }]`), explicit `[new Schema({...}, { _id: false })]` declarations, and `[Schema.Types.Mixed]` arrays.

  Now introspects the array's inner type via a four-tier fall-through: (1) recurse into a DocumentArray's inner `.schema.paths`; (2) legacy Mongoose v6/v7 via `schemaType.caster.instance`; (3) modern Mongoose v8+/v9 via `schemaType.options.type[0]` handed to `jsonTypeFor`; (4) permissive `{ type: 'object', additionalProperties: true }` fallback (never the old `{ type: 'string' }` default). DocumentArray recursion preserves per-field `required` arrays and strips auto-`_id` fields from the client-facing schema.

### Added

- **Single-embedded subdocs** — `{ field: SubSchema }` (instance `'Embedded'`) now recurses into the inner schema's paths instead of falling through to a generic open object. Triggered by the same `hasInnerSchema` structural predicate that powers DocumentArray introspection.
- **Nullable types** — `{ type: X, default: null }` widens the JSON Schema type to `[X, 'null']` and echoes `default: null`. Matches `mongoose-schema-jsonschema`'s convention; Ajv accepts `null` only on those fields.
- **`description` / `title` passthrough** — when declared on a path, both are surfaced into the generated JSON Schema for OpenAPI / Swagger / docgen consumers. Clean output when not declared.
- **`x-ref` vendor extension** — ObjectId fields with `ref: 'ModelName'` emit `x-ref: 'ModelName'` alongside the pattern. Lets docgen render the populated relationship without affecting Ajv-level validation. Cleanly absent when `ref` isn't declared.
- **Array-of-array introspection** — `{ type: [[Number]] }` produces `{ type: 'array', items: { type: 'array', items: { type: 'number' } } }`. `[[InnerSchema]]` recurses through `subSchemaToJsonSchema` for the leaf subdoc. Ajv validates 2D matrices and grid-of-subdoc payloads correctly.
- **Custom SchemaType extension point** — if a SchemaType instance exposes `jsonSchema()` (via prototype subclass, per-instance assignment `schema.path('x').jsonSchema = fn`, or because `mongoose-schema-jsonschema` is installed and monkey-patches the prototypes), mongokit defers to it. Buggy implementations that throw or return non-objects are isolated — built-in introspection always fires as a fallback. Drop-in compatibility with the broader Mongoose ecosystem.
- **Mongoose option aliases** — `minLength`/`maxLength` (camelCase) accepted alongside `minlength`/`maxlength` (legacy lowercase). `enum: { values, message }` object form accepted alongside `enum: [...]`. `match: 'string'` accepted alongside `match: RegExp`.
- **Map type** — `{ type: Map }` and `{ type: Map, of: X }` produce `{ type: 'object', additionalProperties: <of>|true }`. Map's synthetic `$*` value-template paths (Mongoose internal) are filtered from the output so the Map renders cleanly instead of as a nested object with junk keys.

### Test coverage

116 new schema-converter tests across 6 files: structural shapes (`mongooseToJsonSchema-arrays.test.ts`, 36), Ajv behavioral round-trips (`mongooseToJsonSchema-ajv.test.ts`, 13), portability against the `mongoose-schema-jsonschema` reference (`mongooseToJsonSchema-portability.test.ts`, 28), custom SchemaType extension (`mongooseToJsonSchema-custom-types.test.ts`, 6), feature parity (`mongooseToJsonSchema-parity.test.ts`, 19) covering nullable, description/title, x-ref, array-of-array, and cycle safety, and list-query shape (`mongooseToJsonSchema-listQuery.test.ts`, 14) pinning the correct pagination/filter types and Ajv-coerced round-trip. Full suite: 1759 passing, 4 perf opt-in skipped, 17.8s.

### Documentation

- `skills/mongokit/SKILL.md` — added a concise array-shape → items table, the custom-type extension convention, accepted Mongoose option aliases, and the strip-by-design list.

## [3.6.2] - 2026-04-15

### Added

- **`getNextSequence` — optional `session` parameter.** New fourth positional argument: `getNextSequence(counterKey, increment, connection, session?)`. When a `ClientSession` is passed, the atomic counter bump (`findOneAndUpdate` with `$inc` + `upsert`) participates in the caller's transaction — if the surrounding `withTransaction` callback throws, the counter does NOT advance, and a retry reuses the same sequence value. Without a session, behavior is unchanged (legacy callers are not affected). The built-in `sequentialId` and `dateSequentialId` generators now forward `context.session` automatically, so `customIdPlugin` + `repo.create(data, { session })` inside `withTransaction` just works — no extra wiring. Closes the gap where an aborted insert left a counter gap (e.g. `INV-0001` skipped and the next successful insert becoming `INV-0002`). Covered by three new suites on the replica-set global setup:
  - **`tests/custom-id-transaction.test.ts`** (6 tests) — unit-level `findOneAndUpdate` spy verifying session forwarding, single-tx commit/abort, no-gap retry, `dateSequentialId` atomicity, legacy (no-session) path.
  - **`tests/custom-id-transaction-scenarios.test.ts`** (7 tests) — real-world scenario replays: 40 parallel committing transactions produce contiguous `INV-0001..INV-0040`; 20 parallel txs with alternating commit/abort produce N/2 contiguous IDs with zero gaps; multi-entity atomic write (invoice + ledger + stock decrement) commits and rolls back atomically; `createMany(25)` inside one tx; `createMany` batch abort leaves no residue; 50 back-to-back sequential txs on one counter.
  - **`tests/perf-custom-id-session.test.ts`** (4 tests, opt-in via `RUN_PERF=1`) — measures raw counter-bump overhead (session pass-through ~+0.37 ms/op — within noise), `sequentialId` create latency inside vs outside transactions, 100 concurrent contending transactions on one counter (~80 txs/s on a memory-server replica set), and `createMany(50)` vs 50 single creates in one tx (~1.7x speedup).

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
