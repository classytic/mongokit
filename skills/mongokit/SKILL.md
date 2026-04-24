---
name: mongokit
description: |
  @classytic/mongokit — Production-grade MongoDB repository pattern for Node.js / TypeScript.
  Use when: building MongoDB CRUD, repository pattern with Mongoose 9+, pagination (offset / keyset),
  plugin-composed multi-tenancy / soft-delete / caching / audit / custom IDs, or mongo-side of a
  kit-portable app (swap with sqlitekit via `@classytic/repo-core` StandardRepo<TDoc>).
  Triggers: mongokit, mongoose repository pattern, mongo pagination, soft delete mongo, multi-tenant
  mongo, audit trail mongo, query parser mongo, BaseController mongo, repo-core mongo adapter.
version: 3.10.0
license: MIT
metadata:
  author: Classytic
  version: "3.10.0"
tags:
  - mongodb
  - mongoose
  - repository-pattern
  - crud
  - pagination
  - typescript
  - plugins
  - caching
  - soft-delete
  - audit-trail
  - multi-tenant
  - custom-id
  - query-parser
  - rest-api
  - conformance
progressive_disclosure:
  entry_point:
    summary: "Type-safe MongoDB repository. Implements @classytic/repo-core StandardRepo<TDoc> — swap-able with sqlitekit. 17 plugins: pagination, cache, soft-delete, audit, multi-tenant, custom IDs."
    when_to_use: "Mongo CRUD + REST APIs with Mongoose 9+. Pick mongokit when you need MongoDB specifically; pick sqlitekit when a file / edge DB is enough; same controller code works on both."
    quick_start: "1. npm install @classytic/mongokit @classytic/repo-core mongoose  2. new Repository(Model, [plugins])  3. repo.create / getAll / update / delete — misses return null, not throw"
  context_limit: 500
---

# @classytic/mongokit

Production-grade MongoDB repository pattern. Implements the `StandardRepo<TDoc>` contract from `@classytic/repo-core` — the same contract sqlitekit + future pgkit / prismakit implement. **Controller code written against the contract runs unchanged on any kit.** 2009 integration tests + cross-kit conformance suite.

**Requires:** Mongoose `>=9.4.1` | `@classytic/repo-core` `>=0.1.0` | Node.js `>=22`

## Install

```bash
npm install @classytic/mongokit @classytic/repo-core mongoose
```

Both `@classytic/repo-core` and `mongoose` are peer deps — kit never bundles them.

## Core pattern

```typescript
import { Repository } from "@classytic/mongokit";

const repo = new Repository(UserModel);

const user = await repo.create({ name: "Alice", email: "a@example.com" });
const page = await repo.getAll({ page: 1, limit: 20 });
const found = await repo.getById(id);        // null on miss
const updated = await repo.update(id, {...}); // null on miss
const result = await repo.delete(id);         // { success: false, ... } on miss
```

### Miss semantics (MinimalRepo contract)

`getById` / `update` / `delete` return `null` / `{ success: false }` on miss by default — **not** a thrown 404. Invalid-shape ids (`'not-a-valid-id'` on an ObjectId `_id`) short-circuit to the same miss result rather than raising mongoose `CastError`.

Legacy throw behavior is one opt-in away:

```typescript
await repo.getById(id, { throwOnNotFound: true });   // throws { status: 404 }
await repo.update(id, data, { throwOnNotFound: true });
await repo.delete(id, { throwOnNotFound: true });
```

## Full API

| Method                                 | Returns on miss                          |
| -------------------------------------- | ---------------------------------------- |
| `create(data, opts)`                   | —                                        |
| `createMany(items[], opts)`            | —                                        |
| `getById(id, opts)`                    | `null`                                   |
| `getByQuery(query, opts)`              | `null`                                   |
| `getOne(filter, opts)`                 | `null`                                   |
| `getAll(params, opts)`                 | envelope with empty `docs`               |
| `findAll(filter?, opts)`               | `[]`                                     |
| `getOrCreate(query, data, opts)`       | inserts + returns new doc                |
| `update(id, data, opts)`               | `null`                                   |
| `findOneAndUpdate(filter, update, opts)` | `null`                                 |
| `delete(id, opts)`                     | `{ success: false, ... }`                |
| `count(filter, opts)`                  | `0`                                      |
| `exists(filter, opts)`                 | `null`                                   |
| `distinct(field, filter, opts)`        | `[]`                                     |
| `aggregate(req: AggRequest)`           | portable cross-kit IR                    |
| `aggregatePipeline(stages[])`          | kit-native mongo pipeline                |
| `aggregatePaginate(req)`               | portable IR + pagination envelope        |
| `aggregatePipelinePaginate(opts)`      | pipeline + pagination envelope           |
| `bulkWrite(operations[])`              | heterogeneous insert/update/delete batch |
| `lookupPopulate(params)`               | `{ docs, total, pages, hasNext, ... }`   |
| `withTransaction(async txRepo => ...)` | tx-bound repo (see Transactions)         |
| `isDuplicateKeyError(err)`             | `true` for E11000 / wrapped 409          |

All filter arguments accept either plain mongo queries (`{ status: 'active' }`) or Filter IR from `@classytic/repo-core/filter` (`eq('status', 'active')`). Same code works on sqlitekit.

## Pagination (auto-detected)

```typescript
// Offset — pass `page`
await repo.getAll({ page: 1, limit: 20, filters: { status: "active" }, sort: { createdAt: -1 } });
// → { method: 'offset', docs, total, pages, hasNext, hasPrev }

// Keyset — pass `sort` without `page` (or `after` for next page)
const first = await repo.getAll({ sort: { createdAt: -1 }, limit: 20 });
// → { method: 'keyset', docs, hasMore, next: 'eyJ2...' }
const second = await repo.getAll({ after: first.next, sort: { createdAt: -1 }, limit: 20 });
```

**Detection:** `page` → offset | `after` → keyset | `sort` only → keyset | default → offset.

**Keyset indexes:** create a compound index on the sort keys + `_id`:

```javascript
Schema.index({ createdAt: -1, _id: -1 });
Schema.index({ organizationId: 1, createdAt: -1, _id: -1 }); // multi-tenant
```

## Aggregation — two surfaces

**`aggregate(req: AggRequest)`** — portable IR, same input + output on mongokit and sqlitekit:

```typescript
const { rows } = await repo.aggregate({
  filter: { active: true },
  groupBy: 'category',
  measures: { total: { op: 'sum', field: 'amount' }, n: { op: 'count' } },
  having: gt('total', 1000),
  sort: { total: -1 },
});
// rows: [{ category: 'admin', total: 1200, n: 5 }, ...]
```

**`aggregatePipeline(stages)`** — kit-native mongo pipeline. Use for `$lookup`, `$unwind`, `$facet`, `$graphLookup`, `$bucket`, window fields — anything that doesn't translate across backends:

```typescript
const stats = await repo.aggregatePipeline([
  { $match: { active: true } },
  { $lookup: { from: 'orders', localField: '_id', foreignField: 'userId', as: 'orders' } },
  { $addFields: { orderCount: { $size: '$orders' } } },
]);
```

Rule of thumb: reach for portable `aggregate` first. Drop to `aggregatePipeline` only when the query needs MongoDB-specific stages.

## Plugins (17)

Order matters — plugins run at declared priorities (POLICY → CACHE → OBSERVABILITY → DEFAULT):

```typescript
const repo = new Repository(UserModel, [
  timestampPlugin(),
  multiTenantPlugin({ tenantField: 'organizationId' }),
  softDeletePlugin(),
  cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
]);
```

| Plugin                              | Adds                                         |
| ----------------------------------- | -------------------------------------------- |
| `timestampPlugin()`                 | `createdAt` / `updatedAt`                    |
| `softDeletePlugin(opts)`            | `deletedAt` mark + auto read-filter          |
| `auditLogPlugin(logger)`            | external CUD log                             |
| `auditTrailPlugin(opts)`            | DB-persisted audit trail + field-diffs       |
| `cachePlugin(opts)`                 | Redis/memory read cache + auto-invalidation  |
| `validationChainPlugin(validators)` | custom validation rules                      |
| `fieldFilterPlugin(preset)`         | role-based field visibility (RBAC)           |
| `cascadePlugin(opts)`               | auto-delete related docs                     |
| `multiTenantPlugin(opts)`           | tenant scope injection (`fieldType` casting) |
| `customIdPlugin(opts)`              | sequential / random ID generation            |
| `observabilityPlugin(opts)`         | timing + metrics + slow-op callback          |
| `methodRegistryPlugin()`            | base for `mongoOperations` / `batchOps` / …  |
| `mongoOperationsPlugin()`           | `increment`, `pushToArray`, `upsert`         |
| `batchOperationsPlugin()`           | `updateMany`, `deleteMany`, `bulkWrite`      |
| `aggregateHelpersPlugin()`          | `groupBy`, `sum`, `average`                  |
| `subdocumentPlugin()`               | array-subdoc CRUD methods                    |
| `elasticSearchPlugin(opts)`         | delegate `?search=` to ES / OpenSearch       |

### Soft delete

```typescript
const repo = new Repository(UserModel, [
  methodRegistryPlugin(),
  batchOperationsPlugin(),
  softDeletePlugin({ deletedField: 'deletedAt' }),
]);

await repo.delete(id);                         // sets deletedAt
await repo.getAll();                            // excludes soft-deleted
await repo.getAll({ includeDeleted: true });   // includes them
await repo.delete(id, { mode: 'hard' });       // actually removes
await repo.deleteMany({ status: 'draft' });    // soft-deletes in batch
```

Use partial unique indexes so soft-deleted rows don't block new inserts:

```javascript
Schema.index({ email: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
```

### Cache

```typescript
cachePlugin({ adapter, ttl: 60, byIdTtl: 300, queryTtl: 30 });
```

Adapter shape:

```typescript
const redisAdapter: CacheAdapter = {
  async get(key)          { return JSON.parse((await redis.get(key)) || 'null'); },
  async set(key, v, ttl)  { await redis.setex(key, ttl, JSON.stringify(v)); },
  async delete(key)       { await redis.del(key); },       // 3.10: renamed from del()
  async clear(pattern)    { /* bulk invalidation */ },
};
```

### Multi-tenant

```typescript
multiTenantPlugin({
  tenantField: 'organizationId',
  contextKey: 'organizationId',
  required: true,
  fieldType: 'objectId',  // cast to ObjectId for $lookup / .populate() to work
});

await repo.getAll({ organizationId: 'org_123' }); // auto-scoped
await repo.update(id, data, { organizationId: 'org_attacker' }); // → null (cross-tenant miss)
```

Use `createTenantContext()` with `AsyncLocalStorage` to avoid passing `organizationId` on every call.

### Custom IDs

```typescript
import { customIdPlugin, sequentialId, prefixedId, dateSequentialId } from '@classytic/mongokit';

customIdPlugin({ generate: sequentialId({ counterModel, field: 'sku' }) });      // 1, 2, 3
customIdPlugin({ generate: prefixedId({ prefix: 'USR_', length: 8 }) });          // USR_a1b2c3d4
customIdPlugin({ generate: dateSequentialId({ counterModel, pattern: 'YYYYMM' }) }); // 2026040001
```

## QueryParser (HTTP → mongo)

Turns URL query strings into mongo filters + pagination params:

```typescript
import { QueryParser } from '@classytic/mongokit';

const parser = new QueryParser({ schema: UserSchema });
const parsed = parser.parse(req.query); // { filters, sort, page, limit, lookups, select, populate }

const result = await repo.getAll(parsed);
```

URL syntax:

```bash
GET /users?status=active&age[gte]=18&sort=-createdAt&page=1&limit=20
GET /users?populate=orders,profile
GET /users?populate[orders][select]=id,total&populate[orders][match][status]=paid
GET /products?lookup[category][from]=categories&lookup[category][localField]=categorySlug&lookup[category][foreignField]=slug&lookup[category][single]=true
```

Ref-less `$lookup` via `lookup[...]`: join by any field (slug, code, SKU) without declaring a Mongoose `ref`. See `docs/LOOKUP_GUIDE.md` for the full grammar.

## BaseController (auto-CRUD)

```typescript
import { BaseController } from '@classytic/mongokit/examples/api/BaseController.js';

class UserController extends BaseController<IUser> {
  constructor(model: Model<IUser>) {
    super(new Repository(model), {
      fieldRules: { role: { systemManaged: true } },
      query: { allowedLookups: ['orders', 'profile'] },
    });
  }
}

// Framework-agnostic: returns { success, data, status, error } responses.
// Integrate with Express, Fastify, NestJS, Next.js Router — see examples/.
```

## Transactions

`withTransaction` receives a tx-bound repo (NOT a raw mongoose session — that's the standalone helper). Every method on `txRepo` auto-threads the session:

```typescript
await ordersRepo.withTransaction(async (txRepo) => {
  const order = await txRepo.create({ total: 100 });
  await txRepo.update(order._id, { confirmed: true });
  return order;
});
// Both writes commit, or neither does.
```

Cross-repo transactions need the standalone export (raw session, exported as `withTransaction` from `@classytic/mongokit`):

```typescript
import { withTransaction } from '@classytic/mongokit';

await withTransaction(mongoose.connection, async (session) => {
  await ordersRepo.create({ ... }, { session });
  await outboxRepo.create({ ... }, { session });
});
```

**Standalone MongoDB doesn't support transactions** — need a replica set (even single-node). Tests use `mongodb-memory-server` with `MongoMemoryReplSet`.

## Events

```typescript
import { HOOK_PRIORITY } from '@classytic/mongokit';

repo.on('after:create', async ({ context, result }) => {
  await kafka.publish('users.created', { doc: result, tenant: context.organizationId });
}, { priority: HOOK_PRIORITY.OBSERVABILITY });

repo.on('before:update', async ({ context }) => { /* mutate context.data */ });
repo.on('error:delete', async ({ context, error }) => { /* metric / alert */ });
```

Events per op: `before:<op>`, `after:<op>`, `error:<op>`. Priority ordering: `POLICY` → `CACHE` → `DEFAULT` → `OBSERVABILITY`.

## Swap-ability with sqlitekit

Both kits implement `StandardRepo<TDoc>` from `@classytic/repo-core/repository`. Cross-kit dashboard / admin / test code can target the contract and run on either backend unchanged:

```typescript
import type { StandardRepo } from '@classytic/repo-core/repository';

function listActive<T>(repo: StandardRepo<T>): Promise<T[]> {
  return repo.findAll!({ status: 'active' });
}
```

Conformance: `tests/integration/conformance.test.ts` runs the shared suite from `@classytic/repo-core/testing`. When both kits pass, swap-ability is provable.

## Further reading

- [`docs/MIGRATION_3.10.md`](../../docs/MIGRATION_3.10.md) — 3.9 → 3.10 migration (transactions, aggregate split, lookupPopulate envelope, cache adapter).
- [`docs/LOOKUP_GUIDE.md`](../../docs/LOOKUP_GUIDE.md) — ref-less `$lookup` URL grammar.
- [`docs/TYPES_GUIDE.md`](../../docs/TYPES_GUIDE.md) — type architecture, `FilterQuery`, generic helpers.
- [`docs/SECURITY.md`](../../docs/SECURITY.md) — lookup pipeline sanitization, operator blocking, ReDoS protection.
- [`README.md`](../../README.md) — package-level overview.
