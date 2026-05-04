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

### [3.13.0] - 2026-05-04

#### ⚠️ BREAKING — deprecated `UpdateInput<TDoc>` alias removed

- **`UpdateInput<TDoc>` no longer exported from `@classytic/mongokit`.** Renamed to `UpdatePatch<TDoc>` in 3.11.0 with a one-release-only alias kept for migration; that release cycle is done.
- **Migration:**
  - If you wrote `Partial<Omit<TDoc, '_id' | 'createdAt' | '__v'>>` patches: rename `UpdateInput` → `UpdatePatch`.
  - If you actually wanted the bulk/find-and-update union (`UpdateSpec | Record | Record[]`): `import type { UpdateInput } from '@classytic/repo-core/update'` (different type, same name — that's why the local alias was removed).

#### Changed — internal consolidation (zero behavioral change)

- **Aggregate normalize + keyset cursor helpers now delegate to `@classytic/repo-core/aggregate`.** `normalizeGroupBy`, `validateMeasures`, `encodeAggCursor`, `decodeAggCursor`, `isKeysetMode` were byte-identical to sqlitekit's copies; they now live in repo-core. Public mongokit imports (`from '@classytic/mongokit'`) work unchanged — kit-local files are thin shims that bind the `'mongokit'` error prefix.
- **`adminBypass` now delegates to `@classytic/repo-core/plugins`.** Same factory shape; reduces drift surface across the kit ecosystem.
- **`payloadHasTenantField` (multi-tenant plugin internal helper) now delegates to repo-core.**

#### Fixed — modern mongoose / mongodb-driver compat

- **`isTransactionUnsupported` now recognizes the new standalone-mongo error message.** Modern mongoose/mongodb-driver versions enable `retryWrites=true` by default, which standalone Mongo rejects with `"This MongoDB deployment does not support retryable writes"` BEFORE the transaction precondition fires. The `withTransaction({ allowFallback: true })` path was returning the retryable-writes error to callers instead of degrading to non-tx writes. The predicate now treats this message as equivalent to the older transaction-not-supported error — same root cause, same fallback semantics. (`src/transaction.ts`)

#### Fixed — security & robustness hardening

- **Stack-DoS hole in `_sanitizeExpressions`**: the `$addFields` / `$set` pipeline-stage sanitizer was missing the depth guard that its sibling `_sanitizeMatchConfig` already ships. A hostile `$cond` / `$switch` chain could recurse arbitrarily deep and exhaust the JS stack. Now bounded by `maxFilterDepth` like the match-side path. (`src/query/QueryParser.ts`)
- **`auditTrailPlugin` `onWriteError` callback for compliance hosts**: audit writes are still fire-and-forget by default (audit failures must not break the primary operation), but compliance-grade deployments (SOC 2 / PCI / HIPAA) can now wire `onWriteError(err, entry)` to forward failures to a dead-letter queue, page on-call, or short-circuit the request. The default `console.warn` log was invisible to compliance review. (`src/plugins/audit-trail.plugin.ts`)

#### ⚠️ BREAKING — `multiTenantPlugin` defaults to fail-closed (`allowDataInjection: false`)

The plugin's `allowDataInjection` option used to default to `true` — meaning if the
caller stamped the tenant onto `data` / `query` / `filters` themselves, the
`required` throw was bypassed. That was the wrong security posture for a production-
grade boundary: caller-supplied scope on the payload cannot be trusted as
authentication. The default now flips to **`false`** (fail-closed).

**Migration:** if you intentionally want the prior behavior — e.g. a host control-
plane has authenticated the tenant out-of-band and stamps it on every write — set
the option explicitly to make the trust model visible at the call site:

```ts
multiTenantPlugin({ tenantField: 'organizationId', allowDataInjection: true })
```

The vast majority of users pass tenant via context (`{ organizationId }` in the
options bag) and are unaffected.

#### Fixed — README contract drift

- `delete(id)` miss-shape: the README claimed `{ success: false, message: '...' }`;
  actual return is `null` (per the `MinimalRepo` contract). Documentation now matches code.
- Pagination envelope key: `docs` → `data` (rename landed in 3.10; README was stale).
- Peer-dep range: `>=0.3.0` → `>=0.4.0` (matches `package.json`).

**Field-grade primitives.** Four new shapes that turn hand-rolled `findOneAndUpdate` calls into one-liners — `claim()` (state-machine CAS), `claimVersion()` (optimistic-concurrency CAS), `cursor()` (tenant-scoped streaming reads), and `useMiddleware()` (wrap-style middleware). Plus `leasePlugin()` (distributed FIFO claim-lease), `incrementIfBelow()` (capacity-bounded counter increment), `batchTransaction()` (multi-repo session binding), `requirePlugins` (boot-time plugin assertion), and `createOptionsExtractor<TCtx>()` (typed ctx → options builder).

#### ⚠️ BREAKING — `getOrCreate()` returns `{ doc, created }` instead of bare `TDoc`

`getOrCreate()` previously returned the document directly; it now returns an object discriminating insert from match:

```ts
// Before (3.12)
const user = await repo.getOrCreate({ email }, { name });
console.log(user.email); // direct doc access

// After (3.13)
const { doc, created } = await repo.getOrCreate({ email }, { name });
console.log(doc.email);
if (created) console.log('first sign-in');
```

This aligns mongokit with `StandardRepo.getOrCreate?` from `@classytic/repo-core` 0.4.0 — every kit returns the same shape so cross-kit consumers can branch on `created` without driver-specific shims. The discriminator answers a question every caller was already asking out-of-band ("did THIS call insert, or match an existing row?") via second-trip exists-checks; doing it in the same round-trip is the whole point.

**Migration:** every `repo.getOrCreate(...)` call site needs destructuring or `.doc` access. Greppable diff:

```diff
- const user = await repo.getOrCreate({ email }, { name });
+ const { doc: user } = await repo.getOrCreate({ email }, { name });
```

If you don't care whether the row was inserted, the destructuring rename above is a one-line mechanical edit. Be-prod hit two sites (`cms.controller.ts`, `customer.repository.ts`); commission, yard, streamline don't use `getOrCreate`. Slip-of-the-keyboard prevention: TypeScript catches this at compile time — there's no silent-undefined path.

This change shipped between 3.12 and 3.13 but was not in the original 3.13 release notes; this entry corrects that. `getOrCreate` is also flagged in the conformance test (`tests/unit/standard-repo-assignment.test-d.ts`) so any future contract drift fails the prepublish gate.

#### `claim()` — three additions in response to consumer migration audits

The 3.13.0 release shipped `claim()` with a single-source `from` and hardcoded `upsert: false`. Consumer migrations (commission's 4 multi-source sites, yard's gate-event upsert-claim, media-kit's error path) surfaced three real friction points. Fixed in this update:

- **`from: T | T[]` — multi-source CAS.** `from` accepts an array; compiles to `[stateField]: { $in: [...] }`. Replaces the raw-`findOneAndUpdate` fallback every state machine with multiple non-terminal source states was reaching for. Real-world frequency: commission's `voidRecord` / `markClawedBack` / `endAgreement` / `_transition`, media-kit's `pending|processing → error` catch-block, every "from any non-terminal" pattern. Compounds with `where` predicates the same way single-value `from` does.
- **`options.upsert?: boolean` — insert-or-claim.** Default stays `false` (canonical CAS semantic — "match exactly, else null"). Setting `upsert: true` enables the upsert-claim pattern: insert when the row doesn't exist, else CAS-transition. Yard's `gate-event.append` and any idempotent first-write flow can now use claim directly. Pair with `$setOnInsert` in the operator patch for insert-only fields.
- **`from === to` is allowed — idempotent re-claim.** Yard's `reviseDeparture` writes `departed → departed` to update the row's payload while asserting the row hasn't moved on. The CAS still returns `null` on race-loss (row left the source state), so the safety property holds. Documented explicitly in the `claim()` JSDoc as a supported pattern.

#### `from === to` no-op write optimization

Once `from === to` was admitted as a supported semantic (see above), a follow-up complaint surfaced: every CAS-hit on a replay was writing `$set: { [stateField]: to }` over a value that the filter had already pinned to that exact same value. Functionally a no-op — but a **real** disk write. Under high-replay workloads (yard's `gate-event.append`, outbox dedup storms, idempotent first-write CAS), one redundant journal flush + replication-log entry per replay is non-trivial.

The optimization recognises the shape and skips the redundant write. Three observable cases:

- **Empty patch + `upsert: false`** → the call lowers to a plain `Model.findOne(filter)` round-trip. Pure assertion, zero writes. The plugin pipeline (before/after `claim` hooks) still fires correctly — only the internal driver shape changes.
- **Empty patch + `upsert: true`** → update becomes `{ $setOnInsert: { [stateField]: to } }`. On match: no-op (the `$setOnInsert` operator only fires on insert). On miss: inserts with the canonical state value via the filter literal + `$setOnInsert`. This is the yard `gate-event.append` shape — replay storms now do **zero disk writes** instead of one-per-replay.
- **Non-empty patch + `from === to`** → drops the redundant state-field key from `$set` while keeping all caller patch fields. `claim(id, { from: 'running', to: 'running' }, { workerId: 'w-1' })` writes `$set: { workerId: 'w-1' }` (no `status` key).

**Safety.** Optimization fires only when `from` is a literal AND `from === to`. Array `from` is unsafe to optimize (the matched value could be any of the `$in` members; the `to` write IS load-bearing for convergence). Non-equal `from`/`to` is the normal CAS path — the state-field write is the load-bearing transition, never dropped.

**Verification.** [tests/integration/claim.test.ts](mongokit/tests/integration/claim.test.ts) covers each case via spy-based assertions: `vi.spyOn(Model, 'findOne')` + `vi.spyOn(Model, 'findOneAndUpdate')` confirm which driver call fires on each shape, plus `before:claim` hooks inspect the constructed `context.data` to confirm the redundant key is absent. 12 new tests across two `describe` blocks (`from === to optimization` and `pure-dedup upsert (yard gate-event.append shape)`).

**Recipe.** [mongokit's CLAUDE.md](mongokit/CLAUDE.md) now carries a "Pure-dedup upsert via `claim()`" recipe block documenting the canonical yard pattern (`idField: 'externalEventId'` + `field: 'externalEventId'` + `from === to === id` + `upsert: true`) so future readers and AI maintainers don't have to reverse-engineer the idiom from the JSDoc. Includes the explicit "when to reach for `claim()` vs `getOrCreate()`" decision matrix.

#### Round-3 consumer feedback — what landed and what was deliberately rejected

After the round-3 review (flow, be-prod, commission), four real engineering improvements landed and four asks were deliberately rejected with rationale.

**Landed:**

- **`assertNoMixedPatchShape()` — named validator with louder error messages.** The mixed-patch check was an inline conditional in `claim()` and `claimVersion()`. Hoisted into a top-level helper so error stack traces point at the rule directly — debugging "why does my patch throw?" is now grep-friendly. Error message reframed from "Mongo would silently drop the flat keys" to "Mongo would silently DROP the flat keys — that's a write-loss bug we refuse to forward" so the data-loss risk is unmissable. JSDoc on both `claim` and `claimVersion` carries an explicit `@throws` line.
- **`claimVersion()` first-write CAS — version-field collision protection.** When `from === undefined`, the version is initialized via `$set` (since `$inc` can't apply to null). If the caller's update ALSO writes the version field — in `$set` OR `$inc` — the implicit init would silently fight the caller's intent. Now throws with a message that points at both fix paths ("remove `version` from your $set" OR "pass a numeric `from`") so the caller doesn't have to read the source.
- **`repoOptionsFromCtx(ctx)` — canonical request-context → options-bag extractor.** Consumers were repeatedly hand-rolling `{ organizationId: ctx.organizationId, userId: ctx.userId, session: ctx.session }` — sometimes correctly forwarding all three, sometimes only one, occasionally pre-casting `Types.ObjectId(orgId)` because the caller didn't trust `multiTenantPlugin` to handle the cast (it does). The helper extracts the canonical fields (`organizationId`, `userId`, `user`, `session`, `requestId`) and omits absent keys (no `undefined` writes that would erase parent values in spread merges). Exported from the public barrel.
- **Dotted-path `field` support — verified, locked in, documented.** `field: 'scheduling.status'` for nested state columns (lpn.state, package.condition.state) now has explicit test coverage including the `from === to` optimization on dotted paths. JSDoc on `claim()` calls it out as supported.

**Rejected (would degrade the design):**

- **Widening `from` to accept Mongo expressions (`$ne`, `$lt`, `$exists`, …).** The CAS contract is "match if the state field equals one of these specific values." Admitting arbitrary predicates would collapse `claim` into a generic filter primitive and defeat the point of a state-machine API. The `where` slot already covers compound predicates — JSDoc now documents this loudly with a worked `$ne` example pointing callers at `where`.
- **`idempotencyKey` slot on `leasePlugin`.** Idempotency-key dedup is a different shape from time-bounded leases. The `claim()` pure-dedup recipe (CLAUDE.md) is the answer for "first-writer-wins on an external event id" patterns; lease plugin stays focused on reaper-recoverable work-item leases.
- **`forEachOp(callback)` over `OP_REGISTRY`.** `Object.entries(OP_REGISTRY)` is already typed and discoverable. A `forEachOp` wrapper would just bloat the public surface without adding semantics. Custom-plugin authors iterate the registry directly.
- **`warmupCollection(model)` test utility.** Test infrastructure for `MongoMemoryReplSet` promotion isn't a runtime mongokit concern. Belongs in each consumer's test setup, not the public barrel.

**Documented (the answer is the existing primitive):**

- "State-machine + `claim()` pairing" recipe in CLAUDE.md showing how `defineStateMachine().assertTransition()` (compile-time + sync domain check) composes with `claim()` (runtime concurrency check) — the canonical CAS pattern. Explicit framing of "skip `assertTransition` → malformed transitions reach the database; skip `claim` → concurrent writers race, last-write-wins" so the two layers' value is unambiguous.
- "`useMiddleware()` for observability" recipe with the load-bearing security boundary note (middleware fires AFTER `before:*` hooks; cannot wrap policy failures; use `before:*` for security, `useMiddleware()` for ergonomics).
- "`skipPlugins` for backfills/migrations" recipe with the safety caveat (only audit + observability are skippable; never skip `multiTenantPlugin` / `softDeletePlugin` / `cachePlugin` — those are correctness, not observability).

```ts
// Multi-source: void any pending or approved record
await repo.claim(id, { from: ['pending', 'approved'], to: 'voided' });

// Upsert-claim: insert if missing, else transition
await repo.claim(id, { from: 'pending', to: 'sent' }, {
  $set: { sentAt: now },
  $setOnInsert: { createdBy, createdAt: now },
}, { upsert: true });

// Idempotent re-claim: refresh payload while asserting state hasn't moved
await repo.claim(id, { from: 'departed', to: 'departed' }, { revisedAt: now });
```

Same applies to repo-core 0.4: `ClaimTransition.from` widened to `unknown | readonly unknown[]` with full JSDoc on the multi-source semantic.

#### Round-4 consumer feedback — `batchTransaction`, `requirePlugins`, `createOptionsExtractor`, contract promotion

After round 4 (~10 packages with FSM verbs depending on `claim`, ~6 packages hand-rolling identical ctx → options forwarders, ~20 sites threading session manually across multi-repo transactions), four real engineering wins landed and four asks were deliberately rejected.

**Landed:**

- **`StandardRepo.claim` and `claimVersion` promoted from optional → required** in repo-core's contract. Both kits already ship them as concrete primitives; the optional-`?` was rollout scaffolding. Removes the `if (repo.claim) { ... }` boilerplate at every cross-kit call site and surfaces missing implementations at the conformance gate instead of at runtime. New `ClaimVersionTransition` type exported alongside `ClaimTransition`.

- **`batchTransaction(connection, repos, callback)` — multi-repo session binding.** Replaces the per-call-site `{ session }` threading that was repeated across ~20 sites. Each repo passed in becomes a session-bound proxy via `createTxBoundRepo` so callers don't have to remember to forward — every CRUD method (including `claim` / `claimVersion` / `findOneAndUpdate` and plugin-contributed methods) auto-injects. Same retry + fallback semantics as the existing `withTransaction`. 7 new integration tests cover commit, atomic rollback on throw, claim+claimVersion auto-threading, single-repo-in-bag edge case, repo-identity preservation, and `transactionOptions` forwarding.

- **`requirePlugins: string[]` constructor assertion — fail-closed at boot.** Replaces convention-by-documentation ("always wire `multiTenantPlugin`" repeated in 7+ CLAUDE.md files; "always wire `softDeletePlugin`" in 9+) with an enforcement gate. The constructor throws `TypeError` listing every missing plugin name in one shot (so the host fixes them all in one round-trip rather than bisecting through repeated boot failures), plus the names of installed plugins so a typo surfaces as a side-by-side diff. Names match each plugin's exported `name` property (kebab-case for some, camelCase for others — the JSDoc lists every bundled plugin's canonical name).

- **`createOptionsExtractor<TCtx>(fields)` — typed ctx → options builder.** Eliminates the ~150 lines of identical `repo-options.ts` boilerplate hand-rolled across 6 packages (commission, supplier-performance, pos, yard, order, plus implicit in leave / payrun / muster / people). Field list is constrained to `keyof TCtx & string` — typos become compile errors. Frozen at extractor creation so caller mutation of the input array can't silently change behaviour. Sits alongside the existing `repoOptionsFromCtx` (opinionated, hardcoded to mongokit's bundled-plugin fields) — reach for `createOptionsExtractor` when your domain has additional canonical fields (`actorRef`, `correlationId`, `idempotencyKey`, `sagaRunId`, …).

- **`createTxBoundRepo` proxy fix: `bound.Model` no longer returns `undefined`.** The proxy's "non-function values pass through" logic was bypassed for `Model` because mongoose Models ARE functions (constructors); the proxy was wrapping them in `Function.prototype.bind` which strips static properties (`modelName`, `schema`, `collection`). Special-cased `Model` to return as-is so callers can introspect schema or use the raw mongoose API inside a session-bound repo. Pre-existing limitation surfaced by `batchTransaction`'s repo-identity test.

**Rejected (would degrade the design):**

- **`Repository.aggregateScoped(pipeline)` as a new method.** `aggregatePipeline` already routes through the plugin pipeline (registered as `policyKey: 'query'` in `OP_REGISTRY`); `multiTenantPlugin` and `softDeletePlugin` already inject `$match` predicates. The bug is consumers reaching for `Model.aggregate(...)` raw and bypassing the plugin pipeline. Documented loudly in CLAUDE.md as "use `aggregatePipeline()`, NOT `Model.aggregate()`" — no new method needed.

- **`Repository.tx(callback)` as a new instance method.** `Repository.withTransaction(callback)` already exists as the single-repo bound primitive; `batchTransaction(...)` covers the multi-repo case; standalone `withTransaction(connection, fn)` covers the raw-session escape hatch. Adding `tx()` would just bloat the surface without filling a gap.

- **Soft-deprecation policy as CI-enforced rule.** A scanner that fails publish if a public export is removed without prior `@deprecated` marking is real but heavyweight — false positives block releases and need careful build-tool design. Documented as a process expectation; defer the scanner to dedicated tooling work.

- **Audit plugin consolidation (single switchable `audit` surface).** Out of scope for this round; `auditLogPlugin` and `auditTrailPlugin` solve adjacent-but-distinct problems (sink vs DB-persisted trail). Consolidation is a future API design pass, not a feedback-driven patch.

**Documented (existing primitive answers it):**

- "Scoped aggregations" recipe in CLAUDE.md — `aggregatePipeline()` IS the canonical scoped pipeline, with the plugin-routing path explained explicitly.
- "Transactions — three primitives, one for each shape" recipe in CLAUDE.md — single-repo `repo.withTransaction(fn)`, multi-repo `batchTransaction(conn, map, fn)`, raw-session escape `withTransaction(conn, fn)`. Decision matrix included.
- `leasePlugin()` discoverability section in CLAUDE.md — confirms it ships, is greppable, lease/extend/release semantics are stable. ~120 lines per package eliminated by migration.

#### Round-5 docs revision — `assertAndClaim`, decision matrix, contract framing

After primitives 0.3.1 shipped `assertAndClaim` + `validSources` + `validTargets`, three docs revisions landed:

- **State-machine recipe in CLAUDE.md now leads with `assertAndClaim`** as the canonical entry point. The manual two-step (`machine.assertTransition` + `repo.claim` separately) is documented as the edge-case form for callers who need to interleave logic between the two layers.
- **"Decision matrix — `claim` vs `claimVersion` vs `getOrCreate` vs `leasePlugin`"** added at the top of CLAUDE.md's Recipes section. Closes the "which CAS-shaped primitive do I reach for?" ergonomics gap with a concrete decision tree + a common-mistake flag (using `leasePlugin` for idempotency-key dedup is wrong — leases are time-bounded work claims, not first-writer-wins guarantees).
- **Type-alignment + stability framing now points at repo-core** instead of introducing a `RepositoryClaim<TDoc>` mongokit-specific type. The contract source-of-truth is `StandardRepo.claim` in `@classytic/repo-core/repository` (made required in repo-core 0.4.0). Mongokit's `Repository<TDoc>` conforms; primitives' `ClaimableRepo<TDoc>` is structurally compatible. **Adding a kit-specific `RepositoryClaim` was an explicit reject** — would have duplicated the contract and split the surface (`StandardRepo` for cross-kit, `RepositoryClaim` for mongokit-specific). Stability of the cross-package alignment lives in repo-core's `ClaimTransition` JSDoc (now carries the explicit "cross-package stability contract" note) + the conformance gate. Narrowing claim's options or transition shape is a contract-level break that has to land in repo-core first, not in any kit.

No new exports, no behavioural changes — pure documentation + contract-clarity revision in response to consumer feedback (round 5). Repo-core's `ClaimTransition` JSDoc updated alongside to carry the stability commitment at the source-of-truth, not in the kit.

#### Round-6 — multi-tenant host-composition primitives

Multi-tenancy + access control had a real ergonomic gap: super-admin / cross-tenant access was supported (`skipWhen` callback) but every consumer hand-rolled the same logic, the doc-claimed `bypassTenant` per-call escape didn't actually exist (drift introduced in round-4 docs), and bypassed queries couldn't be distinguished from tenant-scoped ones at the audit layer. Three additive primitives close the gap without making the plugin try to anticipate every domain shape:

- **`bypassTenant: true`** — per-call escape hatch in the options bag. Discoverable, explicit, scoped to a single call (NOT sticky on the repo). The plugin returns without injecting the tenant field; caller carries the responsibility. Ends the doc-drift from round-4 by making the documented option real.
- **`adminBypass({ roleField, adminRoles })` factory** — canonical `skipWhen` callback for role-based bypass. Replaces the hand-rolled `(ctx) => ctx.role === 'superadmin'` callback that ~6 packages each carry. Field list is frozen at factory creation (defensive against post-creation mutation). Composes with `bypassTenant: true` (per-call still wins; `adminBypass` is the always-on form). Exported alongside `multiTenantPlugin` from the barrel.
- **`after:tenant-bypass` event** — emitted whenever a bypass fires (option or callback) with `{ context, operation, reason }`. Audit / observability plugins distinguish bypassed queries from tenant-scoped ones in their logs without the host wiring it manually at every call site. Reason is `'option'` for `bypassTenant: true`, `'callback'` for `skipWhen`-driven bypass — `option` always wins on the precedence order so audit logs reflect the most-specific intent.

```ts
import { adminBypass, multiTenantPlugin } from '@classytic/mongokit';

const repo = new Repository(InvoiceModel, [
  multiTenantPlugin({
    tenantField: 'organizationId',
    required: true,
    skipWhen: adminBypass({ adminRoles: ['superadmin', 'platform_admin'] }),
  }),
]);

// Three distinct paths through the plugin's decision graph:
await repo.findAll({}, { role: 'user', organizationId: 'org-1' }); // scoped
await repo.findAll({}, { role: 'superadmin' });                    // bypassed (callback)
await repo.findAll({}, { bypassTenant: true });                    // bypassed (option)
```

#### Host-composition recipes (CLAUDE.md, no code changes)

The plugin deliberately stays narrow — it owns ONE field. Branches, teams, regional admins, owner-id scoping all compose via primitives without new plugin options. Three recipes added under the new "Multi-tenancy + access control" section in [CLAUDE.md](CLAUDE.md):

- **Branch / team / region — stacked plugin instances.** Multiple `multiTenantPlugin` instances scope different fields independently. Each instance ANDs its predicate; together they layer (org → branch → team). Required vs optional is a per-instance decision so org admins see all branches but branch managers see one. Verified by integration test: org admin sees both branches' rows, branch manager sees only their branch's, write goes to the right org+branch tag.
- **Owner / creator scoping — `before:*` hook in the domain layer.** Mongokit doesn't ship owner-rules as plugin options (every package carves them differently — some allow teammates, some don't, some have shared workspaces). The supported pattern: register a `before:findAll/getAll/getOne/getById` hook that injects `ownerId` into the filter when the caller isn't an admin. Composes with the tenant plugin's predicate (both fire before the driver call; mongo ANDs the keys). Hosts can wrap this in their own thin plugin if they want a reusable abstraction.
- **Audit composition — wire `after:tenant-bypass` to your sink.** Direct example showing how a host's audit log captures every bypass with reason + operation + actor. Load-bearing for SOC 2 / HIPAA / PCI compliance.

#### What this surface deliberately does NOT do (explicit rejects)

- **No RBAC / ABAC primitive.** Role-based + attribute-based access control is host territory — domain-specific role vocabulary, policy evaluation engine, cross-org permission matrices. Mongokit owns the integration surface (per-call bypass + role-based skipWhen + audit hook); the policy logic stays in the host.
- **No multi-value tenant scoping** (`organizationId: string[]` → `$in`). A `null` bug would silently skip scoping. For regional admins legitimately needing N-of-M tenant access, use `bypassTenant: true` + manual `{$in}` filter at the call site, OR a custom `before:*` hook with an explicit array predicate. Both keep bypass intent explicit.
- **No "owner-or-tenant" automatic scoping** — domain-specific; use the `before:*` hook recipe.

#### Tests

- New integration suite [`tests/integration/multi-tenant-primitives.test.ts`](tests/integration/multi-tenant-primitives.test.ts) — 19 tests covering: per-call bypass (with required: true, with subsequent calls, on writes, with bypassTenant: false), `adminBypass` factory (role match, custom roleField, frozen-array defense, integration with the plugin, `'admin'` ≠ `'superadmin'` precedence), `after:tenant-bypass` audit event (option reason, callback reason, no-emit on scoped calls, option-wins-over-callback precedence), and the host-composition patterns (branch sub-scoping via stacked instances, owner-id via `before:*` hook, audit-log sink wiring).
- All 2260 mongokit tests pass (was 2241 → +19 new).

#### Process note — future deprecations will use a two-step pattern

3.12's "Removed" section took out the pagination-result types, `HttpError`, and `CrudSchemas` from the mongokit barrel as part of the single-source-of-truth migration to repo-core. Real-world consumer impact: 3.11 → 3.13 jumpers (be-prod hit 3 files) saw a hard breakage with no compile-time bridge.

Migration path is unchanged — import from the canonical location in repo-core:

```ts
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
import type { HttpError } from '@classytic/repo-core/errors';
import type { CrudSchemas } from '@classytic/repo-core/schema';
```

`PaginationResult` (the union) is renamed to `AnyPaginationResult` in repo-core. Field shape and `method` discriminant are unchanged — runtime shape is identical.

**Lesson for future major cleanups:** soft-deprecate first (one minor with `@deprecated` re-exports), hard-remove second (the minor after). The 3.12 removal skipped step one; future deprecations will follow the two-step pattern by default. Not retroactively applied here — the migration target is small and well-documented.

#### `claim()` — atomic CAS state transition

Implements `StandardRepo.claim()` from repo-core 0.4.0. Race-safe `findOneAndUpdate({ _id, [field]: from }, { $set: { [field]: to, ...patch } })` in one round-trip. Multi-tenant scope, soft-delete filter, cache invalidation, and audit hooks all flow through automatically — `claim` is registered in `OP_REGISTRY` (`policyKey: 'query'`).

```ts
const claimed = await runRepo.claim(runId, { from: 'waiting', to: 'running' }, {
  workerId: 'w-12',
  lastHeartbeat: new Date(),
});
if (!claimed) return; // someone else got it (or no match)
```

**`transition.where` — compound CAS predicate.** Of streamline's 21 atomic-claim sites, only 1 fit the bare `{ [idField]: id, [field]: from }` shape; the other 20 carried compound predicates (paused guards, retry-time guards, heartbeat-staleness, `$elemMatch` sub-docs). Same pattern in commission, yard, revenue, order, invoice. `where` AND-merges arbitrary predicates alongside the canonical id + state-field match — the same shape that hand-rolled `findOneAndUpdate` calls were already encoding:

```ts
const claimed = await runRepo.claim(
  runId,
  {
    from: 'waiting',
    to: 'running',
    where: {
      paused: { $ne: true },
      'scheduling.retryAfter': { $lte: new Date() },
    },
  },
  { lastHeartbeat: new Date() },
);
```

Canonical CAS keys (`[idField]: id`, `[stateField]: from`) spread last — overlapping keys in `where` are dominated, so a wiring bug that puts the state field in `where` with the wrong value can't silently break the CAS.

**Operator patches (`$set`, `$inc`, `$unset`, …).** Of commission's 7 raw-bypass sites, every one had literal `from`/`to` values (the textbook claim shape) but only 1 fit because the rest also did `$inc: { version: 1 }`. Yard had 0 fits for the same reason. `claim`'s patch param now accepts BOTH flat (`{ field: value }`) and Mongo operator (`{ $set, $inc, $unset, $push, … }`) shapes:

```ts
await orderRepo.claim(orderId, { from: 'pending', to: 'shipped' }, {
  $set: { shippedAt: new Date() },
  $inc: { version: 1 },
});
```

The state transition merges into `$set` LAST so a caller's `$set` can't accidentally overwrite the target state. Mixing flat keys with `$`-keys throws (matches mongo's silent-drop behavior — a wiring bug we won't ship).

#### `claimVersion()` — optimistic-concurrency CAS

Sibling to `claim()` for version-stamped CAS:

```ts
const submitted = await orderRepo.claimVersion(
  orderId,
  { from: order.version },
  { $set: { status: 'submitted' } },
);
```

Builds `findOneAndUpdate({ _id, [versionField]: from }, { ...update, $inc: { [versionField]: by ?? 1 } })` in one round-trip. Caller's `$inc` on other fields coexists with the version bump.

**`transition.where` — compound CAS, same as `claim`.** Yard's `transition()` filter is `{ _id, status, version }` — state AND version both must match. Without `where`, callers were forced back to raw `findOneAndUpdate`:

```ts
const transitioned = await yardRepo.claimVersion(
  loadId,
  { from: load.version, where: { status: 'queued' } },
  { $set: { status: 'in-progress', startedAt: new Date() } },
);
```

**`from: undefined` tolerance.** Lean reads return `version: number | undefined` because field defaults are absent on fresh-from-mongo POJOs. Forcing `?? 0` at every call site was friction. Passing `from: undefined` matches docs whose version field is null OR missing — the safe first-write CAS semantics. When `from === undefined`, the version is initialized via `$set` (mongo's `$inc` can't apply to a null-valued field).

#### `cursor()` — tenant-scoped streaming reads

Replaces direct `Model.find().cursor()` (which bypasses every plugin — cross-tenant data leak waiting to happen). Goes through the standard `before:cursor` hook pipeline so multi-tenant scope, soft-delete, and access-control plugins inject before the underlying mongoose cursor is built. Async iterator with bounded memory (`batchSize`) and proper cleanup on early `break`.

```ts
for await (const doc of repo.cursor({ status: 'active' }, { organizationId: 'org-a' })) {
  await pipeline.send(doc);
}
```

Registered in `OP_REGISTRY` (`policyKey: 'query'`) — multi-tenant + soft-delete plugins iterate the registry and pick it up automatically. Emits `after:cursor` with `{count}` on completion. Consumer-thrown errors propagate via the normal throw path; `error:cursor` is reserved for stream-level driver failures.

#### `useMiddleware()` — wrap-style middleware

Composes around every op (including cache-hit branches of `getById` / `getOne` / `getAll`) so middleware sees every call, not just `_runOp`-routed ones. Composition order: registration = outermost-first.

```ts
repo.useMiddleware(async ({ operation, next }) => {
  const start = performance.now();
  try { return await next(); }
  finally { metrics.record(operation, performance.now() - start); }
});
```

**Middleware composes WITH `repo.on()`, doesn't replace it.** `_buildContext + before:<op>` runs BEFORE the middleware chain dispatches — middleware cannot wrap a `before:*` policy failure. That's by design: middleware as a security boundary would be impossible to audit, since registration order would determine whether tenant scope wins. **Middleware is for ergonomics (timing, short-circuit, input/output mutation in a single closure); use `before:*` hooks for security policy.**

#### `leasePlugin()` — distributed FIFO claim-lease

Standardises the pattern five repos hand-rolled (outbox relays, flow waves, promo pending-evaluation, fulfillment retry, cart idempotency). Three contributed methods:

```ts
const repo = new Repository(OutboxModel, [methodRegistryPlugin(), leasePlugin()]) as
  Repository<IOutbox> & LeaseMethods<IOutbox>;

const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-1' });
await repo.extend(id, { leasedBy: 'worker-1', leaseFor: 30_000 });
await repo.release(id, { leasedBy: 'worker-1', finalStatus: 'done' });
```

`lease()` claims the oldest pending row OR recovers a dead lease (`leaseExpiresAt < now`). `extend()` CAS-checks `leasedBy === ours AND leaseExpiresAt > now`, returns `null` if the lease was lost. `release()` enforces the same CAS — only the live holder may finalise the row, so a worker whose lease was recovered can't accidentally mark another worker's in-progress work as `done` / `failed`. Field names + statuses configurable.

#### `incrementIfBelow()` — capacity-bounded counter

Atomic `findOneAndUpdate({ _id, [field]: { $lt: cap } }, { $inc: { [field]: 1 } })`. Returns `null` when the capacity is full. Field-path validation rejects `$`-prefixed segments, `__proto__` / `constructor` / `prototype` / empty dotted segments — defensive against prototype-pollution-style writes.

#### `OP_REGISTRY` — single source of truth widened

`claim`, `claimVersion`, `cursor` registered in `OP_REGISTRY` (`policyKey: 'query'`, `mutates: true` for the first two, `false` for cursor). The strictQuery diagnostic now derives its filter-shaped op coverage from `operationsByPolicyKey('query')` and `operationsByPolicyKey('filters')` — adding a new query-shaped op means one map entry; the diagnostic auto-includes it. The hardcoded list was the exact redundancy the registry was meant to eliminate.

#### `warnOnStrictQueryStrip` — diagnostic

When `mongoose.set('strictQuery', true)` (mongoose 7+ default), filter keys not on the schema are silently stripped. That's a footgun for queries built from URL params. Opt-in:

```ts
const repo = new Repository(Model, plugins, paginationConfig, {
  warnOnStrictQueryStrip: { logger: console.warn },
});
```

Hooks every filter-shaped op at OBSERVABILITY priority (300 — runs AFTER policy plugins inject scope, so it checks the post-policy filter and avoids false-positives on plugin-injected keys).

#### `skipPlugins` — per-call escape hatch

`auditLogPlugin`, `auditTrailPlugin`, `observabilityPlugin` honor `context.skipPlugins?.includes(plugin-name)`. Use for backfills, migrations, internal sweeps that shouldn't fire audit / metrics:

```ts
await repo.update(id, data, { skipPlugins: ['auditLog', 'observability'] });
```

#### `MongoOperatorUpdate` — typed operator-update shape

Index-signature `[op: string]: unknown` allows typed operator updates to assign to `findOneAndUpdate`'s `Record<string, unknown>` slot without `as unknown as` casts. Streamline reported a clean migration: the historic `as unknown as Record<string, unknown>` footgun on every CAS site is gone.

```ts
const update: MongoOperatorUpdate = normalizeUpdate(input);
await repo.findOneAndUpdate(filter, update);
```

#### `Middleware`, `MiddlewareContext`, `MinimalRepoView` — middleware types

Exposed via the public barrel for typed middleware authoring. `MinimalRepoView<TDoc>` is the narrowed repo surface available inside middleware (no driver internals; the floor methods + idField).

#### Cache plugin — `after:restore` invalidation

Soft-delete restore was a silent gap: restoring a doc didn't invalidate its cached read entries, so the next `getById` returned the stale "not found" cache hit. Added `after:restore` to the cache plugin's invalidation listeners. Closes a tenant-context-leak shape that touched soft-delete-heavy repos.

#### LookupBuilder — caller pipelines + `where` always sanitized

`LookupBuilder.multiple()`'s caller-supplied stages now flow through `appendCallerStages()` which ALWAYS runs `sanitizePipeline()`. Two prior 3.12 patches forgot the rule (raw `where: { $where: 'js' }` records, raw `pipeline: [{ $out: ... }]` arrays). Kit-built stages stay trusted by construction.

#### Repository constructor — plugin-shape validation

`new Repository(Model, ['organizationId'], opts)` (passing a string array where a plugin array was meant) now throws a descriptive `TypeError` with the offending index and a hint about the common `tenantField` mistake — instead of crashing later with `TypeError: plugin.apply is not a function`. `assertValidPlugin()` lives in `@classytic/repo-core` 0.3.x.

#### `aggregate(req)` policy-scope merge respects Filter IR

`_injectPolicyScopeIntoAgg` was building `{ $and: [scope, req.filter] }` raw, leaving Filter IR nodes inside `$and` — Mongo couldn't match them, so aggregates silently returned 0 rows whenever caller passed IR + a policy plugin was installed. Each part now compiles via `compileFilterToMongo` BEFORE the merge.

#### `LookupSpec.where` honored on mongokit (cross-kit parity)

`repo-core/lookup/types.ts#LookupSpec.where` was implemented in sqlitekit but silently dropped by mongokit. `LookupOptions` now declares `where?: Filter | Record<string, unknown>` and `LookupBuilder.multiple()` compiles it into a sanitized `$match` after the join correlation.

#### `LookupSpec.select: readonly string[]` array form compiles

Repo-core allowed array-form `select`; mongokit only handled CSV strings + projection-map records, so `select: ['name']` was emitted as invalid `$project: ['name']`. Added explicit `Array.isArray()` branch handling both inclusion and exclusion forms.

#### Soft `deleteMany` reports real `deletedCount`

When the soft-delete plugin's `before:deleteMany` hook converted to `updateMany`, it discarded the result; `Repository.deleteMany` then returned `{ deletedCount: 0, soft: true }` even when rows transitioned. Plugin now stamps `context.softDeletedCount` and the envelope reads it.

#### `.gitattributes` — LF normalization

Committed `.gitattributes` with `* text=auto eol=lf` so reviewer / CI diff tools that don't honor `core.autocrlf=input` see clean diffs. Future commits stay LF-normalized regardless of contributor platform.

#### Conformance gate

`tests/unit/standard-repo-assignment.test-d.ts` widened to probe every documented public type from `docs/TYPES_GUIDE.md`. Removing any from the barrel without removing it from the doc fails the conformance gate (wired into `prepublishOnly`).

#### Migration

- **Cache adapter**: no API change.
- **`claim()` patch**: previously you'd write `findOneAndUpdate({ _id, status: 'pending' }, { $set: { status: 'shipped' }, $inc: { version: 1 } })`; now `claim(id, { from: 'pending', to: 'shipped' }, { $set: { shippedAt: now }, $inc: { version: 1 } })`. Same null-on-race semantics.
- **`claim` / `claimVersion` tenant context**: pass `{ organizationId: ctx.orgId }` in the options bag when `multiTenantPlugin` is mounted — same as every other op. The plugin throws "Missing organizationId" without it.
- **`leasePlugin.release()`**: signature is `release(id, { leasedBy, finalStatus? })`. Required `leasedBy` is the CAS holder check that prevents another worker from accidentally finalising a recovered lease. There is no shipped pre-3.13 release(), so no migration debt.

#### Heads-up for plugin authors — third-party hooks must register `before:claim` / `before:claimVersion` / `before:cursor`

Bundled plugins (`multi-tenant`, `soft-delete`, `cache`, `audit-log`, `audit-trail`, `observability`, `validation-chain`) iterate `MUTATING_OPERATIONS` / `READ_OPERATIONS` / `ALL_OPERATIONS` from `OP_REGISTRY`, so they auto-cover every new op once it's registered. Third-party plugins that hand-rolled their own per-op arrays must update those arrays — without it, the new ops aren't scoped:

- **Multi-tenant**: must add `'claim'`, `'claimVersion'`, `'cursor'` to its `before:*` hook list. Tenant scope leaks otherwise.
- **Soft-delete**: must filter on `'cursor'` (read) and `'claim'` / `'claimVersion'` (writes). Without it, soft-deleted rows surface in cursors / get claimed.
- **Cache invalidation**: must invalidate on `'claim'` / `'claimVersion'` (mutations).

Recommended migration: replace the per-op array with `import { MUTATING_OPERATIONS, READ_OPERATIONS } from '@classytic/mongokit'` (or `operationsByPolicyKey('query')` etc.) and iterate.

#### RFC follow-up — `before:write` / `before:read` category events

The pattern of "every new method = N plugin updates" is exactly what the original `before:<category>` RFC was trying to address. A category event (e.g. `before:write` firing for every mutating op, `before:read` for every read) lets a plugin subscribe ONCE and cover the entire registry — including future additions — without code changes. `OP_REGISTRY` already classifies; the hook fanout is the missing layer.

Marked as a roadmap candidate for **mongokit 4.0 / repo-core 1.0**. Not in 3.13 because:
- It's a hook-engine surface change (per-method events still fire; category events are additive); compatible but worth deliberation.
- Cross-kit story (sqlitekit, prismakit) needs a shared spec — this is a repo-core contract, not a mongokit-only addition.

If you ship a third-party plugin and want to drive your op coverage from `OP_REGISTRY` today (rather than re-syncing per-op arrays on every kit bump), import it from `@classytic/mongokit` and iterate. The shape is forward-compatible with the future category events.

### [3.12.0] - 2026-04-29

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
