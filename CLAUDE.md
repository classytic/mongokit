# CLAUDE.md — AI maintainer guidance for mongokit

Read this when opening this repo. It exists because we've shipped fix releases (3.10.1 + 3.10.2) after AI-authored patches silently drifted mongokit's `Repository<TDoc>` away from `@classytic/repo-core`'s `StandardRepo<TDoc>` contract. Every such drift breaks arc 2.10+ at every consumer boundary.

**Releases:** see [RELEASING.md](RELEASING.md) — canonical commit/push/publish for every `@classytic/*` package.

## The one thing you must not do

**Do not change any method signature on `Repository<TDoc>` (in `src/Repository.ts`) or any type in `src/types.ts` without running [`npm run typecheck:tests`](./tsconfig.tests.json) after the change.**

That script runs the compile-time conformance assertion at [`tests/unit/standard-repo-assignment.test-d.ts`](./tests/unit/standard-repo-assignment.test-d.ts). It proves `Repository<T>` assigns to `MinimalRepo<T>`, `StandardRepo<T>`, and arc's `RepositoryLike<T>` — whole-interface AND per-method binding AND function-arg passing. If it errors after your change, you have drifted from the contract.

**Do not silence a conformance error with a cast in the test file.** That hides the drift from the next consumer. Fix the signature instead.

## Before touching signatures — read this doc

[`docs/CONFORMANCE.md`](./docs/CONFORMANCE.md) lists the exact contravariance traps that have caused every drift we've shipped a fix for. Four categories:

1. Declaring `session?: ClientSession` anywhere public — must be `unknown`, narrow at mongoose call sites.
2. Inheriting `[key: string]: unknown` index signatures into types that mirror a repo-core contract type (which won't have one).
3. Using `string[]` instead of `readonly string[]` for array fields mirrored from the contract.
4. Adding extra generic parameters to methods that map onto `StandardRepo<TDoc>`.

If your work involves any of these, read the doc. If the report you're responding to mentions any of these, the doc probably already explains the right fix.

## Verifying a community drift report

1. Reproduce the drift by adding a per-method binding to the conformance test first. If TS errors in the test file, the drift is real.
2. If it compiles, the report is overstated — reply with the verified test (3.10.2 did this for 5 of the 7 claims in the inventory).
3. Fix only the real drifts. Don't widen preemptively.

## Release flow

[`docs/RELEASE_CHECKLIST.md`](./docs/RELEASE_CHECKLIST.md) is the source of truth. Non-negotiable steps:

1. `npm run typecheck` — src only.
2. `npm run typecheck:tests` — **the conformance gate, wired into `prepublishOnly`**. Must pass.
3. `npm test` — runtime verification. Session widening etc. can cascade; tests catch regressions the type-checker can't.
4. `npm run build` — declaration emit matches source.
5. Bump `package.json` version AND `skills/mongokit/SKILL.md` frontmatter version AND `C:\Users\Siam\.claude\skills\mongokit\SKILL.md` (user's global skill).
6. CHANGELOG entry — follow the 3.10.1 + 3.10.2 format: explicit "Real drifts resolved" vs "Claims audited and confirmed NOT drift" so future maintainers see which patterns are settled.
7. Stage ONLY files relevant to the release. Other uncommitted files in the repo are pre-existing work; don't bundle them.
8. Commit message: NO `Co-Authored-By:` trailer. User has vetoed it.
9. Tag `vMAJOR.MINOR.PATCH`. Push main + tag.

## Repository layout

- [`src/Repository.ts`](./src/Repository.ts) — the main class. Every method declaration here is a potential drift point.
- [`src/types.ts`](./src/types.ts) — boundary types. Every `session?:`, every `select?:`, every option interface lives here.
- [`src/actions/`](./src/actions/) — internal pure functions called by Repository methods. Types here may differ from boundary types; cast at the mongoose call, not at the interface.
- [`src/plugins/`](./src/plugins/) — plugin methods contributed at runtime (e.g. `updateMany`, `deleteMany`, `bulkWrite` via `batchOperationsPlugin`). Not declared on the class type; not checked by the conformance test per-method (optional via `Partial<StandardRepo>`).

## Recipes

### Decision matrix — `claim` vs `claimVersion` vs `getOrCreate` vs `leasePlugin`

Four CAS-shaped primitives, each for a different problem. Pick the narrowest one that fits — overlap exists but each has a load-bearing distinction.

| Primitive | Mental model | Race-loss signal | Reach for it when |
|---|---|---|---|
| **`claim(id, { from, to }, ...)`** | State-machine transition: "move from A to B, atomically." | `null` | Status field has a typed transition graph (workflow runs, orders, leases, anything with `defineStateMachine`). Pair with `assertAndClaim` from primitives. |
| **`claimVersion(id, { from }, ...)`** | Optimistic locking: "I read at version N; commit only if no one's bumped since." | `null` | Last-writer-wins is wrong; concurrent writes need to surface as race-losses. Versioned aggregates (orders with editable line items, leave requests with approval workflows). |
| **`claim(...)` + `upsert: true` + `from === to === id`** | Pure-dedup insert: "first call inserts, replays are no-ops." | Inserted doc on miss; existing doc on match | Idempotency keys, outbox replay storms, webhook receivers, gate-event ledgers — no real state machine, just dedup-by-id with optional `$setOnInsert` payload. See the "Pure-dedup upsert" recipe below. |
| **`getOrCreate(filter, data)`** | Lookup-or-insert: "give me the row matching this filter; insert if missing." | `{ doc, created }` discriminator (no race-loss — both paths return the doc) | Same dedup problem as above but you don't need claim's compound `where` / operator patches / custom `idField`. Lighter primitive, no plugin-pipeline routing differences. |
| **`leasePlugin().lease({ leaseFor, leasedBy })`** | Time-bounded work claim: "give me the next pending row, with a TTL — extend or release before it expires." | `null` if no row available | Background workers picking up work items: outbox relays, retry queues, fulfillment loops. The lease has dead-lease recovery built in (a worker that crashes mid-lease releases its claim when the TTL elapses). NOT a dedup primitive. |

Decision tree:
- **First-writer-wins on an external id, no state transition?** → `getOrCreate` (simpler) OR `claim` with `upsert+from===to===id` (when you need operator patches, custom `idField`, or compound `where`).
- **Atomic state transition with race-safety?** → `claim` (or `assertAndClaim` for the canonical state-machine-paired form).
- **Versioned write with optimistic locking?** → `claimVersion`.
- **Background worker picking up work items with a heartbeat?** → `leasePlugin` (lease + extend + release, with reaper recovery).

Common mistake: using `leasePlugin` for idempotency-key dedup. The lease is a *time-bounded work claim*, not a *first-writer-wins guarantee* — a lease that expires and gets re-claimed by another worker is correct behaviour for "this work needs to land somewhere," wrong behaviour for "this event must land exactly once." Reach for `claim`-with-upsert when the question is "did someone else already process this id?"

### Multi-tenancy + access control — primitives, not pre-baked patterns

`multiTenantPlugin` is deliberately narrow: it owns ONE thing — deterministic injection of a single tenant field into queries / payloads / bulkWrite ops. Everything richer (branches, teams, regional admins, owner-id scoping, RBAC) **composes on top** using primitives mongokit gives you, NOT plugin options that try to anticipate every domain shape.

Three primitives ship for the host-composition layer:

- **`bypassTenant: true`** in the options bag — per-call escape hatch. The plugin returns without injecting; the caller carries the responsibility. Use for support tooling, migrations, scheduled cross-tenant rollups.
- **`adminBypass({ roleField, adminRoles })`** factory — canonical role-based `skipWhen` callback. Replaces the hand-rolled `(ctx) => ctx.role === 'superadmin'` that ~6 packages were each carrying. Composes with `bypassTenant: true` (per-call still wins; this is the always-on form).
- **`after:tenant-bypass`** event — emitted whenever a bypass fires, with `{ context, operation, reason: 'option' | 'callback' }`. Audit / observability plugins distinguish bypassed queries from tenant-scoped ones in their logs without the host wiring it manually at every call site.

```ts
import { adminBypass, multiTenantPlugin } from '@classytic/mongokit';

const repo = new Repository(InvoiceModel, [
  multiTenantPlugin({
    tenantField: 'organizationId',
    required: true,
    skipWhen: adminBypass({ adminRoles: ['superadmin', 'platform_admin'] }),
  }),
]);

// Regular user — auto-scoped to their org:
await repo.findAll({}, { role: 'user', organizationId: 'org-1' });

// Super-admin — sees all orgs (skipWhen fires):
await repo.findAll({}, { role: 'superadmin' });

// Per-call escape (no role check, deliberate intent):
await repo.findAll({}, { bypassTenant: true });
```

#### Branch / team / region — stacked plugin instances

Sub-tenancy (a tenant has branches, branches have teams) composes by **stacking multiple `multiTenantPlugin` instances**. Each instance scopes one field; together they layer the predicates:

```ts
const repo = new Repository(InvoiceModel, [
  // Always-required org scope:
  multiTenantPlugin({
    tenantField: 'organizationId',
    contextKey: 'organizationId',
    required: true,
  }),
  // Optional branch scope — only branch managers pass `branchId`;
  // org admins omit it and see every branch.
  multiTenantPlugin({
    tenantField: 'branchId',
    contextKey: 'branchId',
    required: false,
  }),
  // Optional team scope — same pattern, third level.
  multiTenantPlugin({
    tenantField: 'teamId',
    contextKey: 'teamId',
    required: false,
  }),
]);

// Org admin — sees all branches, all teams in org-a:
await repo.findAll({}, { organizationId: 'org-a' });

// Branch manager — sees their branch only:
await repo.findAll({}, { organizationId: 'org-a', branchId: 'br-1' });

// Team lead — sees their team only:
await repo.findAll({}, { organizationId: 'org-a', branchId: 'br-1', teamId: 'team-x' });
```

The stacked instances merge into the same `context.query` / `context.filters` slot — each instance ANDs in its field. Writes get tagged with all fields present in context. `bypassTenant: true` skips ALL stacked instances (they each check the flag); use a custom `skipWhen` per-instance if you need finer control (e.g. bypass org but keep branch).

#### Owner / creator scoping — `before:*` hook in your domain layer

"Only show rows whose `ownerId === currentUserId`" is domain logic, not tenancy. Mongokit deliberately doesn't ship this as a plugin option — every package's owner-rules look slightly different (some carve out admins, some allow team-mates to see each other's rows, some have shared workspaces). Wire it as a `before:*` hook:

```ts
const ownerScopeOps = ['findAll', 'getAll', 'getOne', 'getById'] as const;
for (const op of ownerScopeOps) {
  repo.on(`before:${op}`, (ctx) => {
    const userId = ctx.userId as string | undefined;
    const role = ctx.role as string | undefined;
    if (!userId || role === 'admin') return; // admins see all org rows
    // Non-admin: scope to their own rows.
    if (op === 'getAll') ctx.filters = { ...ctx.filters, ownerId: userId };
    else ctx.query = { ...ctx.query, ownerId: userId };
  });
}
```

The hook composes with the tenant plugin's predicate (both run before the driver call; mongo ANDs the filter keys). Hosts that want a reusable pattern can ship their own thin plugin wrapping this — it's ~15 lines and you control the role vocabulary.

#### Audit composition — wire `after:tenant-bypass` to your sink

Compliance-heavy domains (healthcare, fintech) need to distinguish bypassed queries from tenant-scoped ones in audit logs. The plugin emits `after:tenant-bypass` for every bypass; the host wires it to whatever sink they use:

```ts
repo.on('after:tenant-bypass', async ({ context, operation, reason }) => {
  await auditLog.write({
    type: 'tenant-bypass',
    operation,
    reason,                                   // 'option' | 'callback'
    actorId: context.userId,
    role: context.role,
    timestamp: new Date(),
  });
});
```

Without this hook, a super-admin's cross-tenant read is indistinguishable from a normal scoped read at the audit layer. With it, every bypass shows up as its own log line with the actor + reason — load-bearing for SOC 2 / HIPAA / PCI audits.

#### What this surface deliberately does NOT do

- **No RBAC / ABAC primitive.** Role-based + attribute-based access control is host territory — the role vocabulary, the policy evaluation engine, the cross-org permission matrix are all domain-specific. The composition primitives above (per-call bypass + role-based skipWhen + audit hook) cover the integration surface mongokit owes hosts; the policy logic itself stays in the host.
- **No multi-value tenant scoping** (`organizationId: string[]` → `$in`). A bug that sets the value to `null` would silently skip scoping — exactly the silent-leak shape the explicit-bypass model prevents. For regional admins who legitimately need N-of-M tenant access, use `bypassTenant: true` + manual filter (`{ organizationId: { $in: regions } }`) at the call site, OR a custom `before:*` hook that applies the array predicate. Both keep the bypass intent explicit.
- **No "owner-or-tenant" automatic scoping.** Owner rules are domain-specific — see the `before:*` hook recipe above.

These rejections aren't "we'll get to it later" — they're "the right place for this is the host, not a plugin option that pretends to anticipate every business shape."

### Pure-dedup upsert via `claim()` (no real state column)

For "first writer wins, replays are no-ops" landing — outbox dedup, idempotent webhook receivers, gate-event ledgers, anything where the dedup key is an external identifier and there's no real state machine. The canonical worked example is yard's `gate-event.append`.

```ts
const repo = new Repository<IGateEvent>(GateEventModel);

await repo.claim(
  externalEventId,                                    // id = the dedup key
  {
    field: 'externalEventId',                         // state field === id field
    from: externalEventId,                            // from === id
    to: externalEventId,                              // to   === id (same value)
  },
  { $setOnInsert: { receivedAt: new Date(), … } },    // insert-only payload
  { idField: 'externalEventId', upsert: true },
);
```

**What's happening.** The state field IS the dedup key, and `from === to === id` is the trick that makes `claim()` work as a pure dedup primitive. The match-or-insert behaviour comes from `upsert: true`. The `from === to` optimization (in 3.13.0) recognises this shape and:

- On first call (miss): inserts with the filter literals + `$setOnInsert` payload.
- On replay (match): drops the redundant `$set: { [stateField]: to }` write entirely, swapping to `{ $setOnInsert: { [stateField]: to } }` which is a no-op on match. Zero disk write per replay — no journal flush, no replication-log entry, no `updatedAt` bump.

**When to reach for this vs `getOrCreate()`.** `getOrCreate(filter, data)` does the same insert-or-return pattern but returns `{ doc, created }`. Reach for it for plain key-only dedup with no extra knobs. Reach for `claim()` when you want one or more of:

- Operator-shape patches (`$setOnInsert`, `$inc` on insert via $setOnInsert, `$push` for ledger-style appends).
- Multi-tenant scope / soft-delete / audit / cache plugins running through the `before:claim` / `after:claim` pipeline (rather than `before:getOrCreate`).
- A custom `idField` that's NOT `_id` (the dedup key is a business identifier).
- Compound `where` predicates beyond the bare id match.

If none of those apply, `getOrCreate` is the lighter primitive — use it.

**What the optimizer will NOT do.** With `upsert: false` and a non-empty patch, the patch IS the load-bearing write — only the redundant state-field key is dropped from `$set`. With array `from`, the optimizer is disabled (the matched-state value could be any of the `$in` members, which may differ from `to`).

### State-machine + `claim()` pairing — the canonical CAS pattern

`@classytic/primitives/state-machine` answers the **modelling** question ("is `from → to` legal in the domain?"); `claim()` answers the **concurrency** question ("did we win the transition vs concurrent writers?"). They compose — neither replaces the other:

- `assertTransition` is fast (sync, in-memory, no I/O) and produces a clear domain error when the call site got the transition graph wrong — that's a programmer bug, surface it loudly.
- `claim()` is a database round-trip but enforces the actual invariant under concurrency — that's a runtime race, surface it as `null` so the caller can branch on retry / backoff / give-up.

Skipping `assertTransition` means malformed transitions reach the database. Skipping `claim` means concurrent writers race and the last write wins. Run both.

#### One-liner — `assertAndClaim` (PREFERRED)

`@classytic/primitives` 0.3.1 ships `assertAndClaim(machine, repo, id, args)` — pairs the modelling check + concurrency CAS into a single call. **This is the canonical entry point**; reach for it by default. The manual two-step below is only for edge cases where the caller needs to interleave logic between the two layers.

```ts
import { defineStateMachine, assertAndClaim } from '@classytic/primitives/state-machine';

const ORDER_MACHINE = defineStateMachine<OrderStatus>({
  name: 'Order',
  transitions: {
    pending:   ['approved', 'cancelled'],
    approved:  ['shipped',  'cancelled'],
    shipped:   [],
    cancelled: [],
  },
});

async function shipOrder(id: string, current: 'approved', ctx: RequestContext) {
  const claimed = await assertAndClaim(ORDER_MACHINE, orderRepo, id, {
    from: current,
    to: 'shipped',
    patch: { shippedAt: new Date(), $inc: { version: 1 } },
    options: repoOptionsFromCtx(ctx),
  });
  if (!claimed) throw new ConcurrentTransitionError(id, current, 'shipped');
  return claimed;
}
```

For multi-source transitions, use the machine's reverse-adjacency (`validSources(to)`) — one source-of-truth for "every status that can transition INTO `to`":

```ts
// "Cancel from any legal predecessor"
const cancelled = await assertAndClaim(ORDER_MACHINE, orderRepo, id, {
  from: ORDER_MACHINE.validSources('cancelled'), // ['pending', 'approved']
  to: 'cancelled',
  patch: { cancelledAt: new Date(), reason },
  options: repoOptionsFromCtx(ctx),
});
```

`assertAndClaim` runs `assertTransition` for every candidate source before the database round-trip — a single illegal source aborts synchronously.

#### Manual two-step — `assertTransition` + `claim` separately

Reach for the manual form only when you need to interleave logic between the two layers (e.g. read another collection between modelling-check and CAS, emit a side effect contingent on the modelling check alone, or pre-compute parts of the patch from the matched-but-not-yet-claimed doc):

```ts
ORDER_MACHINE.assertTransition(id, current, 'shipped'); // sync — throws on illegal transition

// ... interleaved logic, side effects, additional reads ...

const claimed = await orderRepo.claim(
  id,
  { from: current, to: 'shipped' },
  { shippedAt: new Date(), $inc: { version: 1 } },
  repoOptionsFromCtx(ctx),
);
if (!claimed) throw new ConcurrentTransitionError(id, current, 'shipped');
return claimed;
```

The two are functionally equivalent when no interleaved logic is needed — `assertAndClaim` is just shorter + harder to forget one of the layers.

#### Typing your domain helpers — use `StandardRepo<TDoc>` from repo-core

The typed contract for "anything with `claim`" lives in `@classytic/repo-core/repository` as `StandardRepo<TDoc>`. As of repo-core 0.4.0, `claim` and `claimVersion` are required (not optional) — every conforming kit (mongokit, sqlitekit, future pgkit/prismakit) MUST implement them. Type your domain helpers against `StandardRepo<TDoc>` and they accept every kit:

```ts
import type { StandardRepo } from '@classytic/repo-core/repository';
import { assertAndClaim } from '@classytic/primitives/state-machine';

async function shipOrder<TDoc extends IOrder>(
  repo: StandardRepo<TDoc>, // any kit; not mongokit-specific
  id: string,
  current: 'approved',
) {
  return assertAndClaim(ORDER_MACHINE, repo, id, { from: current, to: 'shipped' });
}
```

`StandardRepo<TDoc>` is structurally accepted by primitives' `ClaimableRepo<TDoc>` (which `assertAndClaim` declares as its parameter shape) — primitives keeps its dep-free design while consumers get the full typed contract from repo-core.

**Mongokit does NOT export a separate `RepositoryClaim<TDoc>` type**, deliberately — `StandardRepo` already covers the use case. Adding a kit-specific mirror would duplicate the contract and split the surface (`StandardRepo` for cross-kit, `RepositoryClaim` for mongokit-specific). The contract lives in repo-core; mongokit's `Repository<TDoc>` conforms to it (enforced by the `tsconfig.tests.json` conformance gate).

#### Stability commitment — owned by repo-core

The structural alignment between mongokit's `Repository.claim`, sqlitekit's `claim`, primitives' `ClaimableRepo`, and consumer code typing against `StandardRepo<TDoc>` is load-bearing. The contract source-of-truth is **repo-core's `StandardRepo.claim` declaration** — not mongokit's class signature. Specifically:

- **`StandardRepo.claim`'s parameter types** (`ClaimTransition` shape, `Partial<TDoc>` patch, `WriteOptions`) are the canonical shape every kit conforms to. Repo-core promises these don't narrow without a major version bump.
- **`WriteOptions`** in `@classytic/repo-core/repository` is the canonical options-bag shape — has an index signature so kits can extend it. Mongokit's `SessionOptions & { idField?, upsert? }` is one such extension; it MUST remain assignable to `WriteOptions`. The conformance test in `tests/unit/standard-repo-assignment.test-d.ts` enforces this at the `tsc` boundary every prepublish.
- **Primitives' `ClaimableRepo<TDoc>`** uses `Record<string, unknown>` for the options slot deliberately — keeps primitives dep-free while staying structurally compatible with anything `StandardRepo<TDoc>`-shaped. The minimal ceiling is intentional; adding fields would force every consumer to upgrade.

If a kit (mongokit, sqlitekit, future pgkit) needs to **add** options keys, that's additive — fine. If a kit wants to **constrain** the existing shape, that's a contract change that has to land in repo-core first, not in the kit.

### `useMiddleware()` for observability — single closure per repo

For metrics / timing / error-rate tracking, prefer `useMiddleware()` over per-method `repo.on()` listeners. One closure wraps every op (including cache-hit branches), runs at OBSERVABILITY priority, and composes with `repo.on()` hooks rather than replacing them:

```ts
const userRepo = new Repository(UserModel, plugins);

userRepo.useMiddleware(async ({ operation, next }) => {
  const start = performance.now();
  try {
    const result = await next();
    metrics.timing(`repo.${operation}.success`, performance.now() - start);
    return result;
  } catch (err) {
    metrics.increment(`repo.${operation}.error`);
    throw err;
  }
});
```

**Don't** use middleware for security policy (tenant scope, soft-delete filtering, audit). The execution order is `_buildContext + before:<op>` → middleware chain → driver call. Policy hooks fire **before** middleware sees the op, so middleware can never wrap a policy failure. That's by design — see [README.md#Middleware](README.md) for the full execution-order diagram. Use `before:*` hooks for policy, `useMiddleware()` for ergonomics.

### Portable aggregation IR — `aggregate(req: AggRequest)`

**Reach for the portable IR first.** Compiles identically across mongokit + sqlitekit + future kits. Cross-kit row shape is byte-stable. Only drop to `aggregatePipeline` when you need a mongo-specific stage (`$facet`, `$graphLookup`, `$bucketAuto`, pipeline-form `$lookup let:`).

#### Decision matrix — which surface to call

| Need | Reach for |
|---|---|
| Group + measures + having + sort + limit | `aggregate(req)` — portable, conformance-tested |
| Same + offset pagination | `aggregatePaginate({ page, limit })` |
| Same + cursor / infinite scroll | `aggregatePaginate({ pagination: 'keyset', sort, limit })` — scales past 100k groups (**needs the right index — see `AggPaginationRequest` JSDoc**) |
| Time-series rollup | `aggregate({ dateBuckets: { month: { field: 'createdAt', interval: 'month' } } })` |
| 15-minute / 6-hour bins | `dateBuckets: { ..., interval: { every: 15, unit: 'minute' } }` |
| KPI tile (paid_revenue + total_revenue + refund_count) | One call with filtered measures: `{ paid: { op: 'sum', field: 'amt', where: eq('status','paid') }, total: { op: 'sum', field: 'amt' } }` |
| Top-3 products per category | `topN: { partitionBy: 'category', sortBy: { revenue: -1 }, limit: 3 }` |
| P50 / P95 / P99 latency | `{ p95: { op: 'percentile', field: 'duration', p: 0.95 } }` (Mongo 7+ via `$percentile`) |
| `$lookup`-with-`let` / window funcs / `$facet` | `aggregatePipeline(stages)` — kit-native escape hatch |

#### Filtered measures — never run two queries to KPI-tile

Anti-pattern (TWO round-trips):
```ts
const paid = await repo.aggregate({ filter: eq('status', 'paid'), measures: { sum: { op: 'sum', field: 'amount' } } });
const total = await repo.aggregate({ measures: { sum: { op: 'sum', field: 'amount' } } });
```

Right pattern (ONE round-trip):
```ts
const { rows } = await repo.aggregate({
  measures: {
    paid:  { op: 'sum', field: 'amount', where: eq('status', 'paid') },
    total: { op: 'sum', field: 'amount' },
    refunds: { op: 'count', where: eq('status', 'refunded') },
  },
});
```

`where` accepts Filter IR (`eq`, `gt`, `and(...)`, etc.) — NOT a kit-native query object inside `$cond`. Compiles to `$sum: { $cond: [<expr>, '$amount', 0] }`. Op-correct fallbacks (0 for sum/count, null for avg/min/max, `$$REMOVE` for countDistinct).

#### Top-N tie strategies

| `ties` | SQL/Mongo | Use when |
|---|---|---|
| `'rank'` (default) | `RANK()` / `$rank` | Ties share rank; gaps after. Show all top-3 even if 4 tied for #3. |
| `'dense_rank'` | `DENSE_RANK()` / `$denseRank` | Ties share rank; no gaps. Show all rows in top-3 distinct values. |
| `'row_number'` | `ROW_NUMBER()` / `$documentNumber` | Exactly N per partition; ties broken arbitrarily. Use when downstream consumer must get exactly K. |

`partitionBy` must reference a `groupBy` column, `dateBuckets` alias, or measure alias. Validation throws at request time with the bad field name — don't try-catch it.

#### Percentile op — kit asymmetry

`{ op: 'percentile', field, p }` works on **mongokit only** (Mongo 7+ `$percentile`). Sqlitekit throws `"'percentile' op is not supported on SQLite"` by design — no native function and emulating via window functions sacrifices correctness. **Pin your kit if percentile dashboards are load-bearing.**

The conformance suite gates percentile via `features.aggregateOps.percentile` — see `tests/integration/conformance.test.ts` for the harness pattern. Adding a new asymmetric op? Same pattern: declare it in `AggregateOpsSupport`, gate scenarios via `it.skipIf(skipNoX)`.

#### Aggregate result cache — per-request opt-in, SWR + tag invalidation

```ts
import { createMemoryCacheAdapter } from '@classytic/repo-core/cache';

const repo = new Repository(OrderModel, plugins, {}, {
  aggregateCache: createMemoryCacheAdapter(), // or Redis adapter, etc.
});

// Hot dashboard tile — cache for 60s
const { rows } = await repo.aggregate({
  measures: { revenue: { op: 'sum', field: 'amount' } },
  cache: { ttl: 60, tags: ['orders'] },
});

// "Refresh" button — bypass + overwrite
await repo.aggregate({ ..., cache: { ttl: 60, bypass: true } });

// SWR — stale-serve while background-refresh
await repo.aggregate({
  ..., cache: { ttl: 60, staleWhileRevalidate: true, staleTime: 300 },
});

// After a write — bust by tag
await orderRepo.create(newOrder);
await repo.invalidateAggregateCache(['orders']);
```

| Knob | Default | Use when |
|---|---|---|
| `ttl` (seconds) | undefined → cache disabled | Always set when caching; `0` = same as omit |
| `tags` | none | Group invalidation. Convention: `'<resource>'` + `'<resource>:<id>'` |
| `bypass: true` | false | "Refresh" buttons; admin overrides |
| `staleWhileRevalidate: true` | false | High-traffic tiles where edge latency > strict freshness |
| `staleTime` | equals `ttl` | Extra seconds past TTL where stale-serve is allowed |
| `key` | auto-hash of request | Explicit cross-call sharing / debugging |

**Anti-patterns:**
- Caching tenant-scoped queries WITHOUT a `multiTenantPlugin` configured — cache key derives from the post-policy filter; without scoping the same key serves data across tenants. Always wire `multiTenantPlugin` first.
- Long TTL + no tags + no SWR — entries go stale silently after writes. Either add tags + invalidate after writes, OR enable SWR so reads always touch the executor periodically.
- Caching the SAME query at different TTLs from different call sites — each call uses its own TTL but they share the cache key (TTL doesn't affect the key). The first writer wins; subsequent reads of any TTL get the same entry.

#### Stddev — kit asymmetry (same pattern as percentile)

`{ op: 'stddev', field, where? }` (sample) and `{ op: 'stddevPop', field, where? }` (population) work on **mongokit** via native `$stdDevSamp` / `$stdDevPop` (numerically-stable Welford). Sqlitekit throws — no native STDDEV, computational formula too unstable for typical dashboard data.

Use `'stddev'` (sample) by default — that's what every BI tool reports without qualification, and matches `numpy.std(ddof=1)`. Use `'stddevPop'` only when you have the full population (e.g. survey results, not a sample).

#### `executionHints` — driver knobs without leaving the IR

`executionHints: { allowDiskUse, maxTimeMs, indexHint }` forwards to `Aggregate.allowDiskUse()` / `.option({ maxTimeMS, hint })`. Unsupported hints are silently ignored by sqlitekit (the contract guarantees this — never throws on unknown hint keys). Keeps the IR portable while letting hosts opt into mongo-specific levers.

### Boundary — what stays kit-native, what's portable

| Concern | Lives where | Why |
|---|---|---|
| Portable group-by + measures + filter + having + sort + lookups | `aggregate(req)` IR | Cross-kit conformance-tested |
| Date buckets (named + custom bins) | IR `dateBuckets` slot | Both kits emit identical canonical labels |
| Top-N-per-group | IR `topN` slot | Mongo via `$setWindowFields`, sqlitekit JS post-processor |
| Percentile (P50/P95/P99) | IR `percentile` measure (mongokit-only) | Sqlitekit throws cleanly |
| `$lookup` with `let:` / pipeline-form | `aggregatePipeline(stages)` | Mongo-specific syntax |
| `$facet` parallel sub-pipelines | `aggregatePipeline(stages)` | No SQL equivalent |
| `$bucketAuto` / `$graphLookup` / window operators | `aggregatePipeline(stages)` | Mongo-specific |
| Per-doc UX timeline (visible to end user) | `mongoose-timeline-audit` plugin (separate package) | Mongo-shaped embedded array, NOT cross-kit. **Do not migrate into mongokit's plugin slot** — different concern from `auditTrailPlugin`. |
| System audit ledger (cross-model, compliance) | `auditTrailPlugin` (in mongokit) | Hooks into kit's `before:*` / `after:*`, portable contract |

### Composing with mongoose-level plugins — DON'T absorb them

Recurring question: "should mongokit ship `mongoose-timeline-audit` (or `mongoose-slug-plugin`, or any other mongoose plugin) as a built-in?" **Answer: no.** They compose cleanly without absorption — the mongoose plugin attaches to the schema before the model hits mongokit, and both layers fire on every write.

```ts
const orderSchema = new mongoose.Schema({ ... });
orderSchema.plugin(timelineAuditPlugin, { ownerField: 'customerId' });  // mongoose layer
const Order = mongoose.model('Order', orderSchema);
const repo = new Repository(Order, [multiTenantPlugin({ ... })]);       // mongokit layer

await repo.create({ ... });
// fires: mongoose pre('save') (timeline-audit) → mongokit before:create (multi-tenant, audit, cache)
```

**Why we don't absorb (each one is load-bearing):**

1. **Different event surface.** Mongoose plugins hook `schema.add()` + `pre('save')` / `post('save')`. Mongokit plugins hook `before:create` / `after:update` / `useMiddleware`. Wrapping a mongoose plugin as a mongokit plugin is a rewrite of its event triggers, not a wrapper. Maintenance compounds at every mongokit version bump.
2. **Not cross-kit.** Mongokit's value is being one of several kits implementing `StandardRepo<TDoc>`. An embedded-array timeline (`order.timeline = [{event, actor, at}, ...]`) is mongo-shaped — sqlitekit / pgkit can't implement it identically. Adding it to mongokit pollutes the cross-kit surface with non-portable methods.
3. **Already works without us.** `schema.plugin(...)` doesn't need mongokit's permission. The composition path is the documented path; absorbing it would just add a second way to do the same thing.
4. **Different concerns get conflated.** `mongoose-timeline-audit` (per-doc UX timeline visible to end users) vs `auditTrailPlugin` (compliance ledger across models, separate collection) — both look like "audit" but solve different problems. Keeping them in separate packages makes the choice trivial; absorbing both into mongokit forces a "which audit do I pick?" decision on every consumer.

When asked about a NEW mongoose plugin for absorption, walk this same checklist. If all four reasons hold, refuse and document the composition recipe in the README under "Composing with mongoose-level plugins".

### Scoped aggregations — use `aggregatePipeline()`, NOT `Model.aggregate()`

`Model.aggregate([...]).exec()` (raw mongoose) **bypasses every plugin** — multi-tenant scope NOT injected, soft-delete filter NOT applied. Packages reaching for raw mongoose to use `$lookup` / `$facet` / window operators then hand-write `$match: { organizationId, deletedAt: null }` at the head of every pipeline — and forget half the time.

**`Repository.aggregatePipeline(stages, options)`** is the canonical scoped pipeline. It routes through the standard `before:aggregatePipeline` hook (registered as `policyKey: 'query'` in `OP_REGISTRY`), so `multiTenantPlugin` and `softDeletePlugin` inject their `$match` predicates into `context.query` and the runtime prepends them to your pipeline as the FIRST stage:

```ts
// ❌ Bypasses tenant scope + soft-delete:
const stats = await Model.aggregate([
  { $match: { organizationId, deletedAt: null } }, // hand-rolled defensive
  { $lookup: { ... } },
  { $group: { ... } },
]);

// ✅ Plugin-routed; tenant + soft-delete auto-injected as the leading $match:
const stats = await repo.aggregatePipeline([
  { $lookup: { ... } },
  { $group: { ... } },
], { organizationId: ctx.orgId });
```

Same shape for `aggregatePipelinePaginate(opts)` when the result needs pagination. For backend-portable aggregations (the `filter + group + measures + sort + limit` subset every kit supports), prefer `aggregate(req: AggRequest)` — that's the IR-shape that compiles identically across mongokit + sqlitekit.

### Transactions — three primitives, one for each shape

Mongokit ships three transaction primitives. Pick the narrowest one that fits:

- **`repo.withTransaction(async (txRepo) => { … })`** — single-repo. The callback receives a session-bound proxy of the same repo; CRUD calls auto-inject the session. Reach for this when every write in the transaction lives on one repo.

- **`batchTransaction(connection, { a: repoA, b: repoB }, async ({ a, b }) => { … })`** — multi-repo. Each repo in the map becomes a session-bound proxy inside the callback. Eliminates the per-call `{ session }` threading that was repeated across ~20 sites in the classytic codebase. Same retry + fallback semantics as `withTransaction`.

- **`withTransaction(connection, async (session) => { … })`** — raw session. Reach for this only when you need to pass the session into something that isn't a mongokit repo (third-party adapters, mongoose models you don't own, custom driver calls). For 99% of cases the bound-proxy primitives above are cleaner.

```ts
// Single-repo:
await ordersRepo.withTransaction(async (txRepo) => {
  const order = await txRepo.create({ ... });
  await txRepo.update(order._id, { confirmed: true });
});

// Multi-repo:
await batchTransaction(
  mongoose.connection,
  { orders: ordersRepo, events: eventRepo, inventory: inventoryRepo },
  async ({ orders, events, inventory }) => {
    const order = await orders.create({ ... });
    await events.create({ type: 'order.placed', orderId: order._id });
    await inventory.claim(skuId, { from: 'available', to: 'reserved' });
  },
);

// Raw session (escape hatch):
await withTransaction(mongoose.connection, async (session) => {
  await someAdapter.write(data, { session }); // not a mongokit repo
  await orderRepo.create(orderData, { session });
});
```

All three honour `{ allowFallback: true, onFallback: (err) => … }` for standalone-mongo dev environments where transactions aren't supported.

### `requirePlugins` — fail-closed at boot

`Repository` accepts a `requirePlugins: string[]` option that throws a `TypeError` from the constructor if any listed plugin name isn't installed. Replaces convention-by-documentation with an enforcement gate.

```ts
new Repository(OrderModel, [
  methodRegistryPlugin(),
  multiTenantPlugin({ tenantField: 'organizationId' }),
  softDeletePlugin(),
  auditLogPlugin({ logger }),
], paginationConfig, {
  requirePlugins: ['multi-tenant', 'softDelete', 'auditLog'],
});
```

Names match each plugin's exported `name` property — kebab-case for some (`multi-tenant`, `audit-log`), camelCase for others (`softDelete`, `auditTrail`). The error message lists "Installed plugins" verbatim so a typo surfaces as a side-by-side diff.

### `repoOptionsFromCtx(ctx)` and `createOptionsExtractor<TCtx>(fields)`

Forward the request-scoped context fields mongokit's bundled plugins read (`organizationId`, `userId`, `user`, `session`, `requestId`) without hand-rolling the extractor:

```ts
import { repoOptionsFromCtx } from '@classytic/mongokit';

await ordersRepo.update(id, data, repoOptionsFromCtx(ctx));
await ordersRepo.claim(id, { from: 'pending', to: 'shipped' }, {}, repoOptionsFromCtx(ctx));
```

For domain-package contexts with additional canonical fields (`actorRef`, `correlationId`, `idempotencyKey`, `sagaRunId`, …) build a typed extractor once:

```ts
import { createOptionsExtractor } from '@classytic/mongokit';

export const repoOptionsFromCtx = createOptionsExtractor<MyCtx>([
  'organizationId', 'actorRef', 'actorKind', 'correlationId',
  'session', 'idempotencyKey',
]);
```

The field list is constrained to `keyof TCtx & string` — typos are compile errors. Both helpers omit absent keys (no `undefined` values that would erase parent options on spread merges). Across the classytic codebase this drops ~150 lines of identical hand-rolled forwarding code.

### `leasePlugin()` — distributed FIFO claim-lease

Five repos in the classytic codebase hand-rolled the FIFO claim-lease pattern (outbox relays, flow waves, promo pending-evaluation, fulfillment retry, cart idempotency). `leasePlugin()` is the canonical primitive — ~120 lines per repo eliminated by the migration.

```ts
import { leasePlugin, methodRegistryPlugin } from '@classytic/mongokit';

const repo = new Repository<IOutbox>(OutboxModel, [
  methodRegistryPlugin(),
  leasePlugin({ /* statusField, leasedByField, ... */ }),
]) as Repository<IOutbox> & LeaseMethods<IOutbox>;

const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-1' });
await repo.extend(claimed._id, { leasedBy: 'worker-1', leaseFor: 30_000 });
await repo.release(claimed._id, { leasedBy: 'worker-1', finalStatus: 'done' });
```

Three contributed methods — `lease()`, `extend()`, `release()` — backed by `findOneAndUpdate` CAS so multi-tenant + soft-delete + audit hooks compose. Dead-lease recovery (`leaseExpiresAt < now`) is built in. `release()` enforces that only the live holder may finalise (the `leasedBy` parameter is required and CAS-checked) — a worker whose lease was recovered by a reaper can't accidentally mark another worker's in-progress work as `done` / `failed`. Field names + statuses configurable.

### `skipPlugins` — per-call escape hatch for backfills + migrations

`auditLogPlugin`, `auditTrailPlugin`, and `observabilityPlugin` honor `context.skipPlugins?.includes(name)`. Use for migrations / backfills / internal sweeps that shouldn't pollute audit trails or trigger observability alerts:

```ts
// Backfill: denormalize `lotCode` onto every order without firing audit
for (const order of await orderRepo.findAll({ lotCode: { $exists: false } })) {
  await orderRepo.update(
    order._id,
    { lotCode: deriveLotCode(order) },
    { skipPlugins: ['auditLog', 'auditTrail', 'observability'] },
  );
}
```

**Caveat — never skip `multiTenantPlugin`, `softDeletePlugin`, or `cachePlugin`.** Those are correctness plugins, not observability — skipping them creates cross-tenant writes, ignores soft-deleted state, or leaves stale cache entries. The opt-out is intentionally scoped to audit + metrics only. If your migration genuinely needs to write across tenants, use the `bypassTenant` option on `multiTenantPlugin` (a deliberate cross-tenant escape hatch with explicit semantics) — not `skipPlugins`.

## Do not

- Edit `@classytic/repo-core` types from within mongokit work. That's a separate package.
- Add AI attribution (`Co-Authored-By: Claude ...`) to git commits in this workspace.
- Use `git add -A` / `git add .`. Stage specific files only — this repo often has in-progress work from prior sessions.
- Silence type errors with `as unknown as ...` or `@ts-ignore` in the conformance test file. The whole point of the test is to fail loudly.
- Create new files unless necessary. Prefer editing.
