# @classytic/mongokit

[![npm version](https://badge.fury.io/js/@classytic%2Fmongokit.svg)](https://www.npmjs.com/package/@classytic/mongokit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production-ready repository layer for Mongoose apps: tenant-safe CRUD, soft delete, pagination, hooks, retries, transactions, change streams, and plugins.

Mongokit is built on `@classytic/repo-core` and implements the shared `StandardRepo<TDoc>` contract, so controller code can target one repository interface across MongoDB and SQLite.

## Install

```bash
npm install @classytic/mongokit @classytic/repo-core mongoose
```

Requirements:

- Node.js `>=22`
- Mongoose `>=9.4.1`
- `@classytic/repo-core >=0.6.0`

## Quick Start

Use `createRepository(model, config)` for the common path. It composes plugins in the safe order for you.

```ts
import { createRepository } from '@classytic/mongokit';
import UserModel from './models/User.js';

const userRepo = createRepository<UserDoc>(UserModel, {
  tenant: { tenantField: 'organizationId' },
  softDelete: true,
  timestamps: true,
  batch: true,
});

const user = await userRepo.create(
  { name: 'Ada', email: 'ada@example.com' },
  { organizationId },
);

const page = await userRepo.getAll({
  page: 1,
  limit: 20,
  filters: { status: 'active' },
  organizationId,
});

await userRepo.update(user._id, { name: 'Ada Lovelace' }, { organizationId });
await userRepo.delete(user._id, { organizationId });
```

For manual plugin control, use the constructor directly:

```ts
import {
  Repository,
  methodRegistryPlugin,
  multiTenantPlugin,
  softDeletePlugin,
  timestampPlugin,
} from '@classytic/mongokit';

const userRepo = new Repository(UserModel, [
  methodRegistryPlugin(),
  multiTenantPlugin({ tenantField: 'organizationId' }),
  softDeletePlugin(),
  timestampPlugin(),
]);
```

## Why Mongokit?

- **Tenant safety:** tenant filters are injected by policy hooks before driver calls.
- **Soft delete:** default soft delete with `restore`, `getDeleted`, TTL support, and hard-delete escape hatches.
- **Pagination:** offset and keyset pagination with index warnings for unsafe keyset queries.
- **Hooks and middleware:** deterministic `before:*`, `after:*`, `error:*` hooks plus wrap-style middleware.
- **Retries and cancellation:** `retryPolicy` and `AbortSignal` support across the repository surface.
- **Transactions:** helper APIs for single-repo and cross-repo MongoDB transactions.
- **Change streams:** portable `watch()` API over Mongo change streams.
- **Cross-kit contract:** assignable to `StandardRepo<TDoc>` from `@classytic/repo-core`.

## Core API

Reads:

```ts
await repo.getById(id, options);
await repo.getByQuery({ email }, options);
await repo.getOne({ slug }, options);
await repo.findAll({ status: 'active' }, options);
await repo.getAll({ page: 1, limit: 20, filters });
await repo.count(filters, options);
await repo.exists(filters, options);
await repo.distinct('status', filters, options);
```

Writes:

```ts
await repo.create(data, options);
await repo.createMany(rows, options);
await repo.update(id, patch, options);
await repo.updateMany(filter, patch, options);
await repo.delete(id, options);
await repo.deleteMany(filter, options);
await repo.findOneAndUpdate(filter, update, options);
```

Miss semantics follow the `MinimalRepo` contract:

- `getById`, `update`, and `delete` return `null` on miss.
- Invalid ObjectId-shaped input returns `null` instead of surfacing a Mongoose `CastError`.
- Pass `{ throwOnNotFound: true }` to opt into 404-style errors.

## Common Recipes

### Multi-Tenant Reads And Writes

```ts
const repo = createRepository(OrderModel, {
  tenant: { tenantField: 'organizationId', required: true },
});

await repo.create({ total: 120 }, { organizationId });
await repo.findAll({ status: 'paid' }, { organizationId });
```

If `required: true` is set and no tenant can be resolved, the call fails closed before any driver call.

### Soft Delete And Hard Delete

```ts
const repo = createRepository(UserModel, {
  softDelete: { deletedField: 'deletedAt' },
});

await repo.delete(userId);                    // soft delete
await repo.restore(userId);                   // plugin method
await repo.delete(userId, { mode: 'hard' });  // physical delete
```

Hard delete still runs tenant, audit, cache, and validation hooks.

### Pagination

```ts
const offsetPage = await repo.getAll({
  mode: 'offset',
  page: 1,
  limit: 25,
  sort: { createdAt: -1 },
});

const first = await repo.getAll({
  mode: 'keyset',
  limit: 25,
  sort: { createdAt: -1 },
});

const next = await repo.getAll({
  mode: 'keyset',
  limit: 25,
  sort: { createdAt: -1 },
  after: first.next,
});
```

### Transactions

```ts
import { withTransaction } from '@classytic/mongokit';

await withTransaction(mongoose.connection, async (session) => {
  const order = await orderRepo.create(orderData, { session, organizationId });
  await ledgerRepo.create({ orderId: order._id, amount: order.total }, { session, organizationId });
});
```

Single-repo convenience:

```ts
await orderRepo.withTransaction(async (txRepo) => {
  return txRepo.create(orderData, { organizationId });
});
```

### Change Streams

```ts
const ac = new AbortController();

for await (const change of repo.watch({ status: 'pending' }, {
  signal: ac.signal,
  organizationId,
} as { signal: AbortSignal; organizationId: string })) {
  if (change.operation === 'create') enqueue(change.doc);
}
```

`watch()` is plugin-routed like other reads, so tenant and soft-delete filters are applied before the Mongo change-stream pipeline opens.

### Query Parser

```ts
import { QueryParser } from '@classytic/mongokit';

const parser = new QueryParser({
  schema: InvoiceModel.schema,
  allowedFilterFields: ['status', 'total', 'customerId'],
  allowedSortFields: ['createdAt', 'total'],
  searchMode: 'auto',
});

const parsed = parser.parse(req.query);
const result = await invoiceRepo.getAll(parsed);
```

Supports common URL operators such as `_gt`, `_gte`, `_lt`, `_lte`, `_in`, `_nin`, `_regex`, geo filters, populate, and schema-aware coercion.

## Built-In Plugins

| Plugin | Purpose |
| --- | --- |
| `methodRegistryPlugin` | Adds plugin-contributed methods safely |
| `multiTenantPlugin` | Tenant scoping and tenant stamping |
| `softDeletePlugin` | Soft delete, restore, deleted-list queries, TTL |
| `timestampPlugin` | `createdAt` / `updatedAt` management |
| `batchOperationsPlugin` | `bulkWrite` and batch helpers |
| `cachePlugin` | Pluggable read-through cache |
| `auditLogPlugin` / `auditTrailPlugin` | Operational and compliance audit trails |
| `observabilityPlugin` | Metrics hook points |
| `cascadePlugin` | Hook-routed cascade delete |
| `customIdPlugin` | Prefixed or sequential public IDs |
| `fieldFilterPlugin` | Role-aware field visibility |
| `validationChainPlugin` | Layered sync and async validation |
| `mongoOperationsPlugin` | Hook-routed Mongo update helpers |
| `aggregateHelpersPlugin` | Common aggregation helpers |
| `subdocumentPlugin` | Nested array document helpers |

Import only the plugins you use.

## Events And Middleware

Every operation emits hooks:

```ts
repo.on('before:delete', (context) => {
  if (!context.user) throw new Error('unauthorized');
});

repo.on('after:create', ({ context, result }) => {
  audit.info({ model: context.model, id: result._id });
});
```

Middleware wraps successful operation execution:

```ts
repo.useMiddleware(async ({ operation, next }) => {
  const start = performance.now();
  try {
    return await next();
  } finally {
    metrics.record(operation, performance.now() - start);
  }
});
```

Use `before:*` hooks for security policy. Use middleware for ergonomics such as timing, tracing, and input/output shaping.

## TypeScript

```ts
import type {
  Repository,
  RepositoryContext,
  SoftDeleteMethods,
  BatchOperationsMethods,
} from '@classytic/mongokit';

type UserRepo = Repository<UserDoc> &
  SoftDeleteMethods<UserDoc> &
  BatchOperationsMethods;
```

### Type your Mongoose model — never cast `as never`

Declare the model with its doc type so `Model<UserDoc>` flows straight into
`Repository<UserDoc>` and `createMongooseAdapter` with no casts:

```ts
// ✅ Typed — flows cleanly into Repository + the arc adapter
export type UserDoc = InferSchemaType<typeof UserSchema> & { _id: Types.ObjectId };
export const UserModel = model<UserDoc>('User', UserSchema);
export const userRepo = new Repository<UserDoc>(UserModel, [/* plugins */]);

// ❌ Untyped — the inferred doc type diverges from `UserDoc`, and
//    `mongoose.Model<T>` is INVARIANT in T, so it won't unify. The
//    tempting "fix" is `as never` — don't; type the model instead.
export const UserModel = model('User', UserSchema);          // Model<inferred>
new Repository<UserDoc>(UserModel as never, []);             // ⛔ cast smell
```

The cast isn't a mongokit typing gap — it's a symptom of an untyped model.
One generic at the `model<Doc>(...)` call site removes it everywhere
(`Repository`, `createMongooseAdapter`, and any `RepositoryLike<Doc>` site).

Feature-detect portable behavior with:

```ts
if (repo.capabilities.changeStreams) {
  // repo.watch is available
}
```

## Subpath Imports

```ts
import { parseGeoFilter } from '@classytic/mongokit/query/primitives/geo';
import { coerceFieldValue } from '@classytic/mongokit/query/primitives/coercion';
import { extractSchemaIndexes } from '@classytic/mongokit/query/primitives/indexes';
```

Optional bridges:

```ts
import { createBetterAuthOverlay } from '@classytic/mongokit/better-auth';
```

## Advanced Documentation

The GitHub repository includes deeper guides for:

- security hardening
- lookup and aggregation patterns
- type architecture
- contribution workflow
- release checks

See the `docs/` directory in the repository for those long-form references.

## Testing

```bash
npm test
npm run typecheck
npm run build
```

The test suite uses `mongodb-memory-server` by default. Set `MONGODB_URI` to run against an external MongoDB deployment.

## License

MIT
