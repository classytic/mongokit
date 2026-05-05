# @classytic/mongokit

[![npm version](https://badge.fury.io/js/@classytic%2Fmongokit.svg)](https://www.npmjs.com/package/@classytic/mongokit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production-grade MongoDB repository pattern for Node.js. Zero runtime deps — Mongoose and `@classytic/repo-core` are peers.

```bash
npm install @classytic/mongokit @classytic/repo-core mongoose
```

Requires Mongoose `>=9.4.1`, `@classytic/repo-core` `>=0.4.0`, Node.js `>=22`.

> **Swap-able with sqlitekit.** Mongokit implements the `StandardRepo<TDoc>` contract from `@classytic/repo-core/repository`. Controller code written against the contract runs unchanged on [@classytic/sqlitekit](https://www.npmjs.com/package/@classytic/sqlitekit) — both kits share an identical conformance suite.

### Miss semantics (MinimalRepo contract)

- `getById(id)` → returns `null` on miss (not thrown). Invalid-shape ids (e.g. `'not-a-valid-id'` on an ObjectId `_id`) short-circuit to `null` rather than raising mongoose `CastError`.
- `update(id, data)` → returns `null` on miss.
- `delete(id)` → returns `null` on miss. On hit, returns a `DeleteResult` (e.g. `{ message: 'Soft deleted successfully', id, soft: true }` when `softDeletePlugin` is wired; the driver's hard-delete result otherwise).
- Pass `{ throwOnNotFound: true }` to opt back into the legacy 404-throw behavior for any of the three.

---

## Quick start

```ts
import { Repository } from '@classytic/mongokit';
import UserModel from './models/User.js';

const userRepo = new Repository(UserModel);

const user = await userRepo.create({ name: 'John', email: 'john@example.com' });
const page = await userRepo.getAll({ page: 1, limit: 20, filters: { status: 'active' } });
await userRepo.update(user._id, { name: 'Jane' });
await userRepo.delete(user._id);
```

Every Repository method is event-driven, pluggable, and returns raw Mongoose documents — no custom envelopes.

---

## Core concepts

### Repository

A `Repository<TDoc>` wraps a Mongoose model and exposes a small, uniform CRUD surface:

- **Reads:** `getById`, `getByQuery`, `getOne`, `getAll`, `findAll`, `count`, `exists`, `distinct`, `aggregate`, `aggregatePaginate`, `lookupPopulate`
- **Writes:** `create`, `createMany`, `update`, `updateMany` (via plugin), `delete`, `deleteMany` (via plugin), `bulkWrite` (via plugin)
- **Restore / trash bin:** via `softDeletePlugin`

Extend it by subclassing; add domain verbs on the subclass. Do not wrap it in a service layer.

```ts
class InvoiceRepository extends Repository<InvoiceDoc> {
  async markPaid(id: string, ctx: RepositoryContext) {
    return this.update(id, { status: 'paid', paidAt: new Date() }, ctx);
  }
}
```

### Plugins

Plugins register hooks and/or methods on a repository. Order matters — they run at declared priorities:

```ts
import {
  Repository,
  methodRegistryPlugin,
  batchOperationsPlugin,
  multiTenantPlugin,
  softDeletePlugin,
  cachePlugin,
} from '@classytic/mongokit';

const repo = new Repository<Invoice>(InvoiceModel, [
  methodRegistryPlugin(),
  batchOperationsPlugin(),
  multiTenantPlugin({ tenantField: 'organizationId' }), // POLICY (100)
  softDeletePlugin({ deletedField: 'deletedAt' }),      // POLICY (100)
  cachePlugin({ adapter: redisAdapter }),                // CACHE  (200)
]);
```

Hook priorities ensure deterministic ordering: `POLICY (100) → CACHE (200) → OBSERVABILITY (300) → DEFAULT (500)`.

### Events

Every operation emits `before:*`, `after:*`, `error:*`:

```ts
repo.on('before:delete', (ctx) => { /* mutate ctx, throw to veto */ });
repo.on('after:create',  ({ context, result }) => { /* audit, notify */ });
```

The `before:*` hook receives the context directly; `after:*` and `error:*` receive `{ context, result | error }`.

### Middleware

`useMiddleware()` composes around every op (including cache-hit branches), wrap-style. Inputs and outputs both pass through; registration order = composition order (first registered runs outermost).

```ts
repo.useMiddleware(async ({ operation, next }) => {
  const start = performance.now();
  try { return await next(); }
  finally { metrics.record(operation, performance.now() - start); }
});

// Short-circuit by returning without calling next()
repo.useMiddleware(async ({ operation, context, next }) => {
  if (operation === 'getById' && readOnlyMaintenance) return cachedReadOnlyResponse(context.id);
  return next();
});
```

**Middleware is for ergonomics, NOT security.** This is the load-bearing distinction. The execution order on every call is:

```text
_buildContext + before:<op>     ← repo.on('before:*') hooks
  [outer middleware pre]        ← repo.useMiddleware() registrations
    [...inner middleware pre]
      fn (driver call)
      after:<op> | error:<op>   ← repo.on('after:*' / 'error:*')
    [...inner middleware post]
  [outer middleware post]
```

Build/`before:*` hooks fire BEFORE the middleware chain dispatches. A throw from a `before:*` policy hook (tenant scope, soft-delete, access-control) unwinds before middleware ever fires — middleware **cannot wrap, observe, or short-circuit a policy failure**.

That's by design. Middleware as a security boundary would be impossible to audit because registration order would determine whether tenant scope wins. Use `before:*` hooks for security policy (tenant scope, soft-delete filtering, audit, cache invalidation) and `useMiddleware()` for ergonomics (timing, metrics, input/output mutation in a single closure).

If you want middleware to observe a policy rejection, listen on `error:<op>` — that fires from inside the middleware chain and is reachable.

---

## Pagination

`getAll` supports offset, keyset (cursor), and aggregate pagination. Pass `mode: 'offset' | 'keyset'` explicitly or let it auto-detect.

```ts
// Offset — dashboards, admin panels
await repo.getAll({ mode: 'offset', page: 1, limit: 20, sort: { createdAt: -1 } });
// → { method: 'offset', data, total, pages, hasNext, hasPrev, page, limit }

// Keyset — feeds, infinite scroll
const p1 = await repo.getAll({ mode: 'keyset', sort: { createdAt: -1 }, limit: 20 });
const p2 = await repo.getAll({ mode: 'keyset', sort: { createdAt: -1 }, after: p1.next });
// → { method: 'keyset', data, hasMore, next, limit }
```

Keyset pagination with `filters + sort` warns once if no matching schema-declared compound index exists. Silent in `NODE_ENV=test`. Route warnings via `configureLogger({ warn })`.

---

## Delete semantics

`delete(id)` respects the plugin stack by default — soft when `softDeletePlugin` is wired, physical otherwise. Pass `mode: 'hard'` for GDPR / admin cleanup while keeping every policy hook firing:

```ts
// Default — soft when plugin wired
await repo.delete(userId, { organizationId });

// Hard — physical delete, audit + tenant scoping still enforced
await repo.delete(userId, { organizationId, mode: 'hard' });

// Bulk hard delete (requires batchOperationsPlugin)
await repo.deleteMany(
  { createdAt: { $lt: cutoff } },
  { organizationId, mode: 'hard' },
);
```

Never drop to `repo.Model.deleteOne` — that bypasses every hook you wired.

---

## Transactions

Two entry points, identical semantics, shared retry/fallback logic:

```ts
import { withTransaction } from '@classytic/mongokit';

// Cross-repo — pass a Mongoose connection
await withTransaction(mongoose.connection, async (session) => {
  const order = await orderRepo.create(data, { session });
  await ledgerRepo.create({ orderId: order._id, amount }, { session });
  return order;
});

// Single-repo convenience
await orderRepo.withTransaction(async (session) => {
  return orderRepo.create(data, { session });
});
```

Both auto-retry on `TransientTransactionError` / `UnknownTransactionCommitResult`. Pass `{ allowFallback: true, onFallback }` to run the callback non-transactionally on standalone MongoDB (dev).

---

## Outbox pattern — compose, don't plugin

mongokit does **not** ship an `outboxPlugin`. It doesn't need to.

The only thing outbox requires is the ability to write an event row **in the same MongoDB session** as the business write — otherwise a crash between the two writes loses the event. Mongokit's hook system already hands you `context.session` at the exact moment of the write, so hosts can wire outbox with a ~60-line recipe that composes:

- **mongokit's hooks** (`before:create` / `before:update` / `before:delete`) for session-bound writes
- **arc's `EventTransport`** (Memory / Redis / Kafka / etc.) for delivery
- **a Mongo collection** (with a TTL index on `deliveredAt`) as the outbox store

See [`tests/_shared/outbox-recipe.ts`](./tests/_shared/outbox-recipe.ts) for the full reference implementation and [`tests/outbox-recipe.test.ts`](./tests/outbox-recipe.test.ts) for end-to-end coverage of the pattern (session threading, FIFO relay, failure retry, `shouldEnqueue` / `enrichMeta` extension points).

Sketch:

```ts
// host: src/outbox/wire.ts
import { wireOutbox, MongoOutboxStore } from './outbox-recipe.js';
import { RedisEventTransport } from '@classytic/arc/events/redis';

const store = new MongoOutboxStore({ connection: mongoose.connection, name: 'outbox' });
const transport = new RedisEventTransport({ url: process.env.REDIS_URL });

wireOutbox({
  repos: {
    'catalog:product':    catalog.repositories.product,
    'revenue:transaction': revenue.repositories.transaction,
    'order:order':         order.repositories.order,
  },
  store,
  // optional: skip internal audit repos, add tenant/correlation meta, etc.
  shouldEnqueue: ({ resource }) => resource !== 'audit:log',
  enrichMeta:    (ctx) => ({ correlationId: ctx.correlationId as string | undefined }),
});

// relay worker — runs on app startup
setInterval(async () => {
  const pending = await store.getPending(100);
  for (const event of pending) {
    try {
      await transport.publish(event);
      await store.acknowledge(event.meta.id);
    } catch {
      break; // retry next tick
    }
  }
}, 1000);
```

That's the entire outbox. No plugin, no custom base class, no opinions baked into the data layer. The host decides:

- Which repos emit events (`wireOutbox.repos`)
- What the event type naming convention is (map keys → `${resource}.created`)
- Which transport to publish to (any `EventTransport` implementation)
- When the relay runs (`setInterval`, BullMQ, scheduled worker…)
- How to enrich meta (AsyncLocalStorage, request ctx, tenant keys)

mongokit's job stops at "the hook has `context.session`." Everything else is composition.

---

## Built-in plugins

| Plugin | Purpose |
|---|---|
| `methodRegistryPlugin` | Prerequisite for plugins that attach new methods |
| `batchOperationsPlugin` | `updateMany`, `deleteMany`, `bulkWrite` with hook support |
| `multiTenantPlugin` | Inject tenant scope at POLICY priority — supports `fieldType: 'objectId'` for `$lookup`/`.populate()` |
| `softDeletePlugin` | `deletedAt` / custom field, `restore`, `getDeleted`, TTL, `before:restore` / `after:restore` hooks |
| `cascadePlugin` | Cascade delete; prefer `{ repo: targetRepo, foreignKey, softDelete? }` to route through the target's hook pipeline |
| `customIdPlugin` | Stripe-style prefixed public IDs (`txn_a7b3xk9m`) on top of `_id` |
| `cachePlugin` | Pluggable adapter (memory, Redis); list-cache versioning for multi-pod correctness |
| `auditLogPlugin` / `auditTrailPlugin` | Who/when/what capture to a sibling collection |
| `observabilityPlugin` | Metric hooks for OpenTelemetry / Prometheus bridges |
| `timestampPlugin` | `createdAt` / `updatedAt` management |
| `validationChainPlugin` | Layered sync + async validators |
| `fieldFilterPlugin` | Role-based field visibility on reads |
| `subdocumentPlugin` | Helpers for nested array document CRUD |
| `mongoOperationsPlugin` | Low-level Mongo helpers (`$inc`, `$push`, etc.) with hooks |
| `aggregateHelpersPlugin` | Common aggregation builders |
| `elasticPlugin` | Mirror writes to Elasticsearch |

Each plugin is tree-shakeable. Import only what you use.

---

## Composing with mongoose-level plugins

mongokit deliberately doesn't reabsorb mongoose plugins that already work via `schema.plugin(...)`. They compose cleanly: the mongoose plugin attaches to the schema before the model lands at mongokit, both layers fire on every write.

Canonical examples — install + wire as documented by the upstream package, then hand the model to mongokit:

```ts
import mongoose from 'mongoose';
import { Repository, multiTenantPlugin } from '@classytic/mongokit';
import timelineAuditPlugin from 'mongoose-timeline-audit';
import slugPlugin from 'mongoose-slug-plugin';

const orderSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  status: String,
  title: String,
});

// 1. Wire mongoose-level plugins on the schema
orderSchema.plugin(timelineAuditPlugin, {
  ownerField: 'customerId',
  eventLimits: { 'order.updated': 20 },
});
orderSchema.plugin(slugPlugin, { tmpl: '<%=title%>' });

// 2. Build the model
const Order = mongoose.model('Order', orderSchema);

// 3. Hand the model to mongokit — kit plugins layer on top
const orderRepo = new Repository(Order, [
  multiTenantPlugin({ tenantField: 'organizationId' }),
]);

// Now every write fires BOTH layers:
//   - mongoose pre('save') / post('save') (timeline-audit, slug)
//   - mongokit before:create / after:create (multi-tenant, audit, cache)
await orderRepo.create({ customerId, status: 'pending', title: 'New order' });
```

**Why this composition over absorbing into mongokit:** mongoose plugins hook `schema.add()` + `pre('save')`; mongokit plugins hook `before:create` / `after:update`. Different event models, different concerns. Wrapping a mongoose plugin as a mongokit plugin would be a fork, not a wrapper — and the mongoose plugin already works without mongokit being involved at all. Keeping the layers separate also lets each package version independently.

**When to use which audit surface:**

| Need | Reach for |
|---|---|
| Per-doc UX timeline visible to end users (`order.timeline = [{event, actor, at}, ...]`) | `mongoose-timeline-audit` (mongoose plugin) — embedded array on the doc |
| Compliance audit ledger across models, immutable, queryable | `auditTrailPlugin` (mongokit, ships in this package) — separate collection |

The two are complementary, not alternatives. A typical app wires both — timeline for the customer-facing order page, auditTrail for the compliance officer's quarterly export.

---

## QueryParser (URL → filter)

Turn Express / Fastify query strings into sanitized Mongo filters + sort + pagination.

```ts
import { QueryParser } from '@classytic/mongokit';

const parser = new QueryParser({
  schema: InvoiceModel.schema,           // enables type coercion + geo/text detection
  allowedFilterFields: ['status', 'total', 'customerId'],
  allowedSortFields: ['createdAt', 'total'],
  searchMode: 'auto',                     // 'text' | 'regex' | 'auto'
});

// GET /invoices?status=paid&total_gte=1000&sort=-createdAt&page=1&limit=20
const { filters, sort, page, limit, search } = parser.parse(req.query);
const result = await invoiceRepo.getAll({ filters, sort, page, limit, search });
```

Supports URL operators: `_gt/_gte/_lt/_lte/_ne/_in/_nin/_regex`, geo (`[near]`, `[withinRadius]`, `[geoWithin]`), populate, and schema-aware coercion. ReDoS protection + allowlisted operators for hardening.

**Nested subdocument filters.** Dotted paths pass through to MongoDB directly — Mongoose's strict-mode casting handles the nested-schema lookup, no special config required:

```
?contact.email[contains]=foo  → { 'contact.email': { $regex: /foo/i } }
?name.given=sadman             → { 'name.given': 'sadman' }
?name.given[in]=a,b            → { 'name.given': { $in: ['a', 'b'] } }
```

Dot-in-key semantics follow `qs` parsing: `?name.given=x` produces `{ 'name.given': 'x' }` (NOT nested into `{ name: { given: 'x' } }`). For the nested-object form use bracket notation: `?name[given]=x`.

---

## TypeScript

Full type safety for repository methods, plugin method combinations, events, and query contexts.

```ts
import type {
  Repository,
  RepositoryContext,
  RepositoryEvent,
  SoftDeleteMethods,
  BatchOperationsMethods,
} from '@classytic/mongokit';

type InvoiceRepo = Repository<Invoice> &
  SoftDeleteMethods<Invoice> &
  BatchOperationsMethods;
```

---

## Subpath imports

Import pure primitives without pulling the full package surface:

```ts
import { extractSchemaIndexes } from '@classytic/mongokit/query/primitives/indexes';
import { parseGeoFilter } from '@classytic/mongokit/query/primitives/geo';
import { coerceFieldValue } from '@classytic/mongokit/query/primitives/coercion';
```

---

## Better Auth bridge — `@classytic/mongokit/better-auth`

When [Better Auth](https://better-auth.com) writes to your Mongo collections via `@better-auth/mongo-adapter`, mongokit ships a kit-owned bridge so you can expose those collections as full repositories — pagination, query parser, OpenAPI, audit, all of it.

**Two helpers**:

```ts
import {
  registerBetterAuthStubs,    // bulk stubs for `populate('user')` etc.
  createBetterAuthOverlay,    // per-collection DataAdapter for arc/your host
} from '@classytic/mongokit/better-auth';

// 1. Bulk-register stubs so populate() works app-wide.
registerBetterAuthStubs(mongoose, { plugins: ['organization'] });

// 2. Per-resource overlay — async because we read BA's resolved schema.
//    Resolves once at boot, picks up additionalFields + modelName overrides
//    + plugin schema additions automatically.
const orgAdapter = await createBetterAuthOverlay({
  auth,                                // your betterAuth() instance
  mongoose,
  collection: 'organization',
});

// Plug the adapter into any host that consumes `DataAdapter<TDoc>`:
defineResource({ name: 'organization', adapter: orgAdapter });
```

Need custom validators / Repository methods / `toJSON` transforms (e.g., strip `password`)? Drop the factory and hand-roll the schema + Repository — that's the recommended path when you outgrow the defaults. The factory and the hand-roll produce structurally identical adapters; you can switch back and forth without touching consumer code.

`better-auth` is an **optional peer dependency** — only required when you import this subpath. Mongokit users who don't touch BA don't get an install warning.

---

## Testing

Uses `mongodb-memory-server` by default; override via `MONGODB_URI` for a real replica set when running transaction tests locally.

```bash
npm test                    # full suite (~80 files, 1500+ tests)
npx vitest run tests/X.ts   # single file while iterating
```

See [`tests/`](./tests) for real-world plugin composition examples (multi-tenant + soft-delete + cascade + audit).

---

## Mongoose compatibility

Aligned with **Mongoose 9.4.x**. Earlier versions (8.x) are untested — pin a mongokit v3.x release if you need 8.x support.

---

## License

MIT
