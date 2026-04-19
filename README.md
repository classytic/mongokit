# @classytic/mongokit

[![npm version](https://badge.fury.io/js/@classytic%2Fmongokit.svg)](https://www.npmjs.com/package/@classytic/mongokit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production-grade MongoDB repository pattern for Node.js. Zero runtime deps — Mongoose and `@classytic/repo-core` are peers.

```bash
npm install @classytic/mongokit @classytic/repo-core mongoose
```

Requires Mongoose `>=9.4.1`, `@classytic/repo-core` `>=0.1.0`, Node.js `>=22`.

> **Swap-able with sqlitekit.** Mongokit implements the `StandardRepo<TDoc>` contract from `@classytic/repo-core/repository`. Controller code written against the contract runs unchanged on [@classytic/sqlitekit](https://www.npmjs.com/package/@classytic/sqlitekit) — both kits share an identical conformance suite.

### Miss semantics (MinimalRepo contract)

- `getById(id)` → returns `null` on miss (not thrown). Invalid-shape ids (e.g. `'not-a-valid-id'` on an ObjectId `_id`) short-circuit to `null` rather than raising mongoose `CastError`.
- `update(id, data)` → returns `null` on miss.
- `delete(id)` → returns `{ success: false, message: 'Document not found' }` on miss.
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

---

## Pagination

`getAll` supports offset, keyset (cursor), and aggregate pagination. Pass `mode: 'offset' | 'keyset'` explicitly or let it auto-detect.

```ts
// Offset — dashboards, admin panels
await repo.getAll({ mode: 'offset', page: 1, limit: 20, sort: { createdAt: -1 } });
// → { method: 'offset', docs, total, pages, hasNext, hasPrev }

// Keyset — feeds, infinite scroll
const p1 = await repo.getAll({ mode: 'keyset', sort: { createdAt: -1 }, limit: 20 });
const p2 = await repo.getAll({ mode: 'keyset', sort: { createdAt: -1 }, after: p1.next });
// → { method: 'keyset', docs, hasMore, next }
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
import { RedisEventTransport } from '@classytic/arc/events';

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
