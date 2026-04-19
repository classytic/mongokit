# Migration guide — mongokit 3.9 → 3.10

This release contains **one breaking change** and several internal improvements. The break affects every `repo.withTransaction(...)` call site; everything else is drop-in.

## TL;DR

- **Breaking:** `repo.withTransaction`'s callback now receives a transaction-bound repository (`txRepo`) instead of a mongoose `ClientSession`. Every call inside the callback uses `txRepo` instead of `repo`, and you **drop `{ session }` from every options bag** — session threading happens automatically.
- **Breaking (trivial):** custom `CacheAdapter` implementations must rename the `del(key)` method to `delete(key)`. One-line change. Apps using the bundled `createMemoryCache` adapter need no change.
- **Runtime dep added:** `@classytic/repo-core ^0.1.0` is now required (it's listed in `dependencies`, not `peerDependencies` — npm installs it transitively, no action needed).
- **New warning:** plugin stacks with `multi-tenant` installed **after** `soft-delete` now emit a plugin-order warning. Swap the order or set `pluginOrderChecks: 'off'`.

All other 3.9 APIs — every CRUD method, every plugin, every exported type, the constructor signature, `HOOK_PRIORITY`, `isDuplicateKeyError`, the entire pagination surface, the QueryParser, `AggregationBuilder`, `LookupBuilder`, `mongoOperationsPlugin`, etc. — are byte-stable. No changes required outside `withTransaction` call sites.

## What changed and why

### The single `withTransaction` contract

In 3.9, mongokit's `Repository.withTransaction` was the only kit in the `@classytic` ecosystem whose callback signature didn't match repo-core's `StandardRepo.withTransaction` contract. The contract at `@classytic/repo-core/repository` specifies:

```ts
withTransaction?<T>(fn: (txRepo: StandardRepo<TDoc>) => Promise<T>, options?): Promise<T>;
```

Sqlitekit always implemented this signature. Mongokit 3.9 passed a raw `ClientSession` instead, which meant any cross-kit plugin or app touching `withTransaction` had to branch on the backend:

```ts
// 3.9-era — cross-kit compatibility required kit detection
if (isMongokit(repo)) {
  await repo.withTransaction(async (session) => {
    await repo.create(doc, { session });
  });
} else {
  await repo.withTransaction(async (txRepo) => {
    await txRepo.create(doc);
  });
}
```

3.10 collapses the two into one shape. A plugin or app written against the `StandardRepo.withTransaction` contract now runs identically on mongokit, sqlitekit, and future pgkit / prismakit — no shims.

### How session threading still works

You didn't lose anything — the session is still threaded through every operation, you just don't hold it anymore. The `txRepo` is a Proxy over the outer repository. Every CRUD call on it auto-injects the mongoose `ClientSession` into its options bag before delegating.

Wrapped methods include the full `MinimalRepo` + `StandardRepo` surface (`create`, `update`, `delete`, `getById`, `getAll`, `createMany`, `findOneAndUpdate`, `updateMany`, `deleteMany`, `getOne`, `getByQuery`, `findAll`, `count`, `exists`, `distinct`, `getOrCreate`), mongokit's own surface (`aggregate`, `aggregatePaginate`, `lookupPopulate`), and every plugin-installed session-aware method (`upsert`, `increment`, `decrement`, `multiplyField`, `setMin`/`setMax`, `pushToArray`, `pullFromArray`, `addToSet`, `setField`, `unsetField`, `renameField`, `atomicUpdate`, `bulkWrite`, `restore`, `getDeleted`, `addSubdocument`, `getSubdocument`, `updateSubdocument`, `deleteSubdocument`, `groupBy`, `sum`, `average`, `min`, `max`). Non-session-aware utility methods (`isDuplicateKeyError`, `buildAggregation`, `buildLookup`, hook API `on`/`off`/`emit`/`emitAsync`, internal `_*` methods) pass through unchanged.

### When to reach for the standalone helper

Three scenarios still need raw session access — use the **standalone `withTransaction`** export from `@classytic/mongokit` for these:

1. **Cross-repo transactions.** Coordinating writes across multiple repositories in one transaction.
2. **Direct mongoose calls inside a transaction.** Calling `TestModel.create([...], { session })` / `TestModel.find({}).session(session)` / any mongoose query that needs the session explicitly.
3. **Sessions as a primitive.** Any custom code that takes a `ClientSession` as a parameter.

The standalone helper is session-based by design and unchanged from 3.9. See the "Cross-repo + direct-mongoose" section below.

## Migration patterns

### 1. Simple single-repo transaction

**Before (3.9):**

```ts
const order = await orderRepo.withTransaction(async (session) => {
  const created = await orderRepo.create({ total: 100 }, { session });
  await orderRepo.update(created._id, { confirmed: true }, { session });
  return created;
});
```

**After (3.10):**

```ts
const order = await orderRepo.withTransaction(async (txRepo) => {
  const created = await txRepo.create({ total: 100 });
  await txRepo.update(created._id, { confirmed: true });
  return created;
});
```

Mechanical rewrite: `session` → `txRepo` in the callback param, `repo` → `txRepo` on method calls inside, drop `{ session }` from every options bag.

### 2. Plugin methods inside a transaction

Plugin-added methods (`upsert`, `increment`, `restore`, etc.) are auto-wrapped — same migration.

**Before:**

```ts
await userRepo.withTransaction(async (session) => {
  await userRepo.upsert({ email }, { name: 'Alice' }, { session });
  await userRepo.increment(userId, 'loginCount', 1, { session });
  await auditRepo.create({ action: 'login', userId }, { session });
  // ↑ auditRepo is a different repo — see pattern 4 for cross-repo
});
```

**After (single repo):**

```ts
await userRepo.withTransaction(async (txRepo) => {
  await txRepo.upsert({ email }, { name: 'Alice' });
  await txRepo.increment(userId, 'loginCount', 1);
});
// See pattern 4 for the auditRepo line — cross-repo needs the standalone helper.
```

### 3. With `allowFallback` for standalone dev / MongoMemoryServer

**Before:**

```ts
await repo.withTransaction(
  async (session) => {
    await repo.create(doc, { session });
  },
  { allowFallback: true, onFallback: (err) => log.warn('fallback', err) },
);
```

**After:**

```ts
await repo.withTransaction(
  async (txRepo) => {
    await txRepo.create(doc);
  },
  { allowFallback: true, onFallback: (err) => log.warn('fallback', err) },
);
```

Options bag is unchanged. Only the callback shape moved.

### 4. Cross-repo or direct-mongoose operations

This is where the **standalone `withTransaction(connection, fn)` helper** shines. It's unchanged from 3.9 — session-based, runs on a raw mongoose connection.

```ts
import { withTransaction } from '@classytic/mongokit';
import mongoose from 'mongoose';

const order = await withTransaction(mongoose.connection, async (session) => {
  // Call any repo with explicit { session }
  const created = await orderRepo.create({ total: 100 }, { session });
  await inventoryRepo.decrement('sku-1', 1, { session });
  await auditRepo.create({ action: 'order.created' }, { session });

  // Or call mongoose directly
  await OrderModel.findOneAndUpdate(
    { _id: created._id },
    { $set: { confirmed: true } },
    { session },
  );

  return created;
});
```

Use this form whenever:
- More than one repository participates in the transaction, OR
- Your callback does anything with mongoose models directly (`Model.xxx({ session })`), OR
- You need to pass the session to custom code.

### 5. Nested `withTransaction` — now throws

Nested transactions in MongoDB are rarely what callers want (the inner callback runs under the outer session). 3.10 makes this explicit:

```ts
await repo.withTransaction(async (txRepo) => {
  await txRepo.create(doc);
  // ❌ Throws at runtime — "Nested withTransaction is not supported on a tx-bound repository."
  await txRepo.withTransaction(async () => { /* ... */ });
});
```

If you genuinely need nested semantics, reuse the outer `txRepo` directly or restructure. If you need parallel sibling transactions, extract them to separate `repo.withTransaction(...)` calls.

## Other 3.10 notes

### Plugin-order warning: multi-tenant before soft-delete

Repo-core's plugin-order validator enforces three rules. The third is new in 3.10:

| Must precede | Reason |
|---|---|
| `soft-delete` before `batch-operations` | Bulk ops must see the soft-delete filter |
| `multi-tenant` before `cache` | Cache key must include tenant scope |
| **`multi-tenant` before `soft-delete` (new)** | Tenant scope applies before deletion state |

If you construct a repository with `[softDeletePlugin(), multiTenantPlugin({...})]` (in that order), 3.10 emits a `warn` pointing this out. Swap them to `[multiTenantPlugin({...}), softDeletePlugin()]` or silence with `pluginOrderChecks: 'off'`.

### `HOOK_PRIORITY` — reference-equal to repo-core

`import { HOOK_PRIORITY } from '@classytic/mongokit'` and `from '@classytic/repo-core/hooks'` now return the **same reference**. Values unchanged (`POLICY=100, CACHE=200, OBSERVABILITY=300, DEFAULT=500`). Apps that imported either form keep working.

### `repo._hooks` — live read-through getter

The public `_hooks: Map<string, PrioritizedHook[]>` property is preserved as a read-through getter over the new repo-core `HookEngine`. Observability patterns like `repo._hooks.size`, `repo._hooks.get('before:getAll')` still work; it's a fresh snapshot per access and read-only. Use `repo.on(event, listener, options)` to register — `_hooks` is diagnostic only.

### `_buildContext` always awaits `before:*` hooks

Previously, `hooks: 'sync'` made `before:*` hooks fire-and-forget, which raced against policy plugins (multi-tenant, soft-delete, validation). 3.10 always awaits the before-phase regardless of `hooks` mode. After- and error-hooks still honor `hooks: 'sync'` for fire-and-forget observability. If you've ever used `hooks: 'sync'` with a policy plugin stack, this silently fixes a latent bug — no code change required.

## Verifying your migration

After updating call sites, these assertions should hold in your own test suite:

1. **`repo.withTransaction(async (txRepo) => {...})`** compiles. If TypeScript complains about the callback parameter type, you still have `(session) => ...` somewhere.
2. **Inside the callback, every `repo.method(...)` is `txRepo.method(...)`** and no `{ session }` option appears. Search your tests for `{ session }` inside a `withTransaction` block — each one is a missed migration.
3. **Your mongoose-direct code (if any) switched to the standalone helper.** Search your tests for `Model.xxx(..., { session })` patterns — each one likely lives inside a `withTransaction` block that should use `withTransaction(mongoose.connection, ...)` instead.
4. **Plugin stack order honors the new rule.** If you see `[mongokit] plugin order issue — multi-tenant must precede soft-delete` at construction, swap those two lines.

Mongokit's own test suite already migrated — see [`tests/transaction.test.ts`](../tests/transaction.test.ts), [`tests/safety.test.ts`](../tests/safety.test.ts), [`tests/fixes-coverage.test.ts`](../tests/fixes-coverage.test.ts), and [`tests/with-transaction.test.ts`](../tests/with-transaction.test.ts) for canonical before/after examples. [`tests/transaction-edge-cases.test.ts`](../tests/transaction-edge-cases.test.ts) demonstrates the standalone-helper pattern for mongoose-direct inside a transaction.

## Scope of what's wrapped by `txRepo`

The full list of auto-session-threading methods, for reference when writing custom extensions or third-party plugins that need to behave correctly inside `withTransaction`:

```
MinimalRepo + StandardRepo:
  create, createMany, update, findOneAndUpdate, updateMany,
  delete, deleteMany, getById, getAll, getByQuery, getOne,
  findAll, getOrCreate, count, exists, distinct, restore, getDeleted

Mongokit-specific:
  aggregate, aggregatePaginate, lookupPopulate

mongoOperationsPlugin:
  upsert, increment, decrement, multiplyField, setMin, setMax,
  pushToArray, pullFromArray, addToSet, setField, unsetField,
  renameField, atomicUpdate

batchOperationsPlugin:
  updateMany, deleteMany, bulkWrite

subdocumentPlugin:
  addSubdocument, getSubdocument, updateSubdocument, deleteSubdocument

aggregateHelpersPlugin:
  groupBy, sum, average, min, max
```

Plugin authors adding a new session-aware method to `registerMethod(...)` should add the method name + options-position index to `src/tx-bound.ts`'s `SESSION_OPTIONS_INDEX` map. Unknown methods pass through unwrapped — the standalone helper remains the escape hatch.

## Appendix: why a Proxy, not a subclass

Mongokit's plugin system installs methods onto repo **instances** via `registerMethod(...)`. A subclass wouldn't inherit those because they live on the instance, not the prototype. A Proxy over the outer repo catches every property lookup so plugin-added methods are transparently reachable on `txRepo` as well.

See [`src/tx-bound.ts`](../src/tx-bound.ts) for the full implementation — ~100 LOC, covers every edge case (options-position per method, undefined-padding for optional intermediate args, pass-through for non-wrapped names, nested-transaction guard).
