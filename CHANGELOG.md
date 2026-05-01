# Changelog

All notable changes to this project are documented here.

This repository now keeps the top-level changelog short and archives detailed
history by major version:

- [v3 history](./changelog/v3.md)
- [v2 history](./changelog/v2.md)
- [v1 history](./changelog/v1.md)

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Current Line

### [3.12.0] - 2026-04-29

**Schema-builder additions** (paired with arc 2.12 cutting its mongoose-to-OpenAPI fallback) — see below.

**Tenant config alignment** — `MultiTenantOptions` now extends `Pick<TenantConfig, 'tenantField' | 'contextKey' | 'required' | 'fieldType'>` from `@classytic/repo-core/tenant`. Static field vocabulary locked to repo-core's canonical contract by structural typing; mongokit-specific runtime callbacks (`skipWhen`, `resolveContext`, `skipOperations`, `allowDataInjection`) extend on top. Zero new peer deps — mongokit already peer-dep'd repo-core.

**`SchemaGenerator<Model<unknown>>` conformance** — `buildCrudSchemasFromModel` ships a compile-time conformance assertion against repo-core's canonical schema-generator contract. Drift between mongokit's signature and the org-wide interface fails mongokit's typecheck before any arc / consumer sees it.

**Error contract alignment** — local `HttpError` interface in `src/types.ts` deleted. Now imports `HttpError` from `@classytic/repo-core/errors` directly. Public re-export of `HttpError` removed from `@classytic/mongokit` index. Hosts that imported `HttpError` from `@classytic/mongokit` must switch to `@classytic/repo-core/errors`. Field shapes are unchanged — repo-core's `HttpError` was extended in 0.3 with `code?: string` and `meta?: Record<string, unknown>` (the two fields mongokit had locally that repo-core was missing).

**Breaking — mongokit no longer re-declares pagination shapes.** Repo-core 0.3.0 owns them, and shipping a duplicate set in mongokit only invited drift.

**Schema-builder additions** — paired with arc 2.12 cutting its built-in mongoose-to-OpenAPI fallback, mongokit's `buildCrudSchemasFromModel` is now the canonical generator. Three substantive additions in this release:

- **Emits `response: JsonSchema` alongside `createBody` / `updateBody` / `params` / `listQuery`.** The response shape includes server-set fields (`createdAt`, `updatedAt`, `_id`, immutable / readonly / systemManaged fields) since those ARE returned to clients. Only `fieldRules[field].hidden: true` excludes a field from responses. `additionalProperties: true` so virtuals / computed fields pass through. `Object.keys(buildCrudSchemasFromModel(M))` returns 5 keys now (was 4).
- **`Schema.Types.Mixed` → `{ additionalProperties: true }` (no `type` keyword).** Aligned with `mongoose-schema-jsonschema`'s "any value" convention. Earlier shape `{ type: 'object', additionalProperties: true }` was too narrow — Mongoose's Mixed accepts strings, numbers, booleans, arrays, and null, not just objects. The pre-3.12 shape rejected primitives at AJV validation, breaking round-trips for hosts storing mixed primitives. Same fix applied to all three Mixed code paths (top-level, `[Mixed]` array, `{ type: [Mixed] }` shorthand).
- **Nullable enum widening.** `{ type: String, enum: [...], default: null }` now appends `null` to the enum so AJV's `enum` keyword accepts null on round-trips. Previously `default: null` widened `type` but left `enum` untouched, so AJV's enum validation rejected null even when the type allowed it.

#### Security

- **`LookupBuilder.multiple()` — caller pipelines + `where` are sanitized before append.** The implicit "remember to scrub" rule was forgotten twice during the 3.12 refactors: (a) the initial `where` patch unconditionally called `builder.sanitize(false)`, letting `lookups: [{ pipeline: [{ $out: ... }] }]` push `$out` / `$merge` / `$where` / `$function` / `$accumulator` straight into the assembled pipeline; (b) the follow-up forgot that raw Mongo-shaped `where: { $where: 'js' }` records pass through `compileFilterToMongo` unchanged. Caller-supplied stages now flow through a single `appendCallerStages()` helper that ALWAYS runs `LookupBuilder.sanitizePipeline()` on its input. Kit-built stages (`$expr` join correlation, projected `$project`) stay trusted by construction. Lock-in: `tests/integration/lookup-sanitize-and-array-select.test.ts` + `tests/integration/lookup-where-sanitize.test.ts`.

#### Fixed — contract

- **`Repository` constructor: plugin-shape validation.** Passing the wrong arg position (e.g. `new Repository(Model, ['organizationId'], opts)`) now throws a descriptive `TypeError` from `RepositoryBase.use()` with the offending index and a hint about the common `tenantField` mistake, instead of crashing later with `TypeError: plugin.apply is not a function`. `assertValidPlugin()` lives in `@classytic/repo-core` 0.3.x. Lock-in: `repo-core/tests/unit/repository/base-plugin-validation.test.ts`.

- **`aggregate(req)` policy-scope merge respects Filter IR.** `_injectPolicyScopeIntoAgg` was building `{ $and: [scope, req.filter] }` raw, leaving Filter IR nodes (`eq('status', 'paid')`) sitting inside `$and` as `{ op, field, value }` literals — Mongo can't match those against real documents, so aggregates silently returned 0 rows whenever the caller passed IR + a policy plugin was installed. Each part now goes through `compileFilterToMongo` BEFORE the `$and` merge. Lock-in: `tests/integration/policy-scope-agg-ir.test.ts`.

- **`LookupSpec.where` honored on mongokit (cross-kit parity).** `repo-core/lookup/types.ts#LookupSpec.where` was implemented in sqlitekit but silently dropped by mongokit — same contract input, different rows returned. Mongokit's `LookupOptions` now declares `where?: Filter | Record<string, unknown>` and `LookupBuilder.multiple()` compiles it into a sanitized `$match` after the join correlation. Lock-in: `tests/integration/lookup-where.test.ts`.

- **`LookupSpec.select: readonly string[]` array form compiles.** Repo-core allows array-form select; mongokit only handled CSV strings and projection-map records, so `select: ['name']` was emitted as `$project: ['name']` (invalid Mongo). Added `compileSelectToProjection()` with explicit `Array.isArray()` branch handling both `['name']` inclusion and `['-status']` exclusion.

- **Soft `deleteMany` reports real `deletedCount`.** When the soft-delete plugin's `before:deleteMany` hook converted to `updateMany`, it discarded the result; `Repository.deleteMany` then returned a hardcoded `{ acknowledged: true, deletedCount: 0, soft: true }` even when rows transitioned. The plugin now stamps `context.softDeletedCount = result.modifiedCount` and the envelope reads it. Lock-in: `tests/integration/soft-delete-many-count.test.ts`.

#### Restored to public barrel (regression in earlier 3.12 work)

Some mongokit-owned types declared in `src/types.ts` were silently dropped from `src/index.ts` during the type-relocation work, even though `docs/TYPES_GUIDE.md` still advertised them. They have no canonical home outside mongokit, so they belong in the barrel. Restored:

- `BasePaginationOptions`
- `CursorPayload`
- `ValueType`
- `PrioritizedHook`

#### Conformance gate widened

`tests/unit/standard-repo-assignment.test-d.ts` now imports every mongokit-owned type listed in `docs/TYPES_GUIDE.md` and asserts each resolves. Removing any from the barrel without removing it from the doc fails `tsc -p tsconfig.tests.json` (the gate wired into `prepublishOnly`) with `TS2305 / TS2614`. Adding a new public type to the doc requires adding a probe — making docs and the public surface co-evolve instead of drifting.

#### Documentation

- `docs/TYPES_GUIDE.md` — removed four phantom entries that were never exported (`FieldRules`, `JsonSchema`, `SchemaBuilderOptions`, `ValidationResult`); split repo-core-owned types into their own section pointing at `@classytic/repo-core/{pagination,errors,schema}` with a worked migration `import` example.

#### Removed

- `OffsetPaginationResult<T>`, `KeysetPaginationResult<T>`, `AggregatePaginationResult<T>`, `PaginationResult<T>` — both as standalone declarations in `src/types.ts` and as named exports from `src/index.ts`. Internal mongokit code now imports these directly from `@classytic/repo-core/pagination`.

#### Migration

```diff
- import type { OffsetPaginationResult, KeysetPaginationResult, AggregatePaginationResult, PaginationResult } from '@classytic/mongokit';
+ import type { OffsetPaginationResult, KeysetPaginationResult, AggregatePaginationResult, AnyPaginationResult } from '@classytic/repo-core/pagination';
```

Note: the union type `PaginationResult` is renamed to `AnyPaginationResult` in repo-core to disambiguate from the singular result types. Field names and the `method` discriminant are unchanged — runtime shape is identical.

The `warning?: string` field that mongokit baked into Offset/Aggregate result is now opt-in via the `TExtra` slot:

```ts
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';

type MongokitOffset<T> = OffsetPaginationResult<T, { warning?: string }>;
```

Mongokit's own internal returns continue to surface `warning` at runtime; consumers who need it in the type should declare with the parameterised `TExtra` form above.

#### Why now

Repo-core has been the contract layer for pagination since mongokit started consuming it; the local copies were a back-compat artifact from before. With repo-core 0.3.0 also adding aggregate shapes plus HTTP wire envelopes (`OffsetPaginationResponse`, etc.) and a `toCanonicalList()` normaliser, the org gets one place for repo-shaped types — arc, sqlitekit, future kits, and SDK clients all consume the same vocabulary.

#### Peer-dep bump

`@classytic/repo-core` peer dep `>=0.2.0` → `>=0.3.0`.

### [3.11.1] - 2026-04-25

- Added structured `SEARCH_NOT_CONFIGURED` errors for index-free search setup
  issues.
- Added warnings for nested reserved query keys like
  `?filters[limit]=5`.
- Widened CRUD schema builder return typing for framework adapters without
  changing runtime behavior.
- Tightened tests and refreshed docs.

### [3.11.0] - 2026-04-22

- Promoted `updateMany` and `deleteMany` to core `Repository` methods.
- Added portable update IR support in `findOneAndUpdate` and `updateMany`.
- Renamed the single-document patch type to `UpdatePatch<TDoc>` and kept the
  old name as a deprecated alias.
- Locked repo-core / arc conformance with compile-time tests.

### [3.10.x] - 2026-04-20 to 2026-04-21

- Aligned mongokit with `@classytic/repo-core` contracts.
- Standardized miss semantics, lookup result envelopes, transaction callback
  shape, and cache adapter naming.
- Added portable lookup, filter, aggregate, and bulk-write surfaces.
- Hardened structural compatibility with arc and cross-kit conformance tests.

## Archive Policy

- `CHANGELOG.md` stays focused on the current line and recent releases.
- Older details live under [`changelog/`](./changelog/).
- Archive files are grouped by major version, which is a common pattern once a
  package changelog becomes too long to scan comfortably.

## Major History

- `v3`:
  portability, repo-core alignment, stronger pagination, search, multi-tenancy,
  vector support, and transaction hardening.
- `v2`:
  zero-dependency architecture, built-in plugins, query parser hardening, JSON
  Schema / OpenAPI support.
- `v1`:
  initial repository, hooks, and pagination foundation.

[3.11.1]: https://github.com/classytic/mongokit/compare/v3.11.0...v3.11.1
[3.11.0]: https://github.com/classytic/mongokit/compare/v3.10.3...v3.11.0
