# Transactions, outbox, idempotency, locks, defaults

Transactions need a replica set (a single-node replica set is fine). `supportsTransactions`, `isTransactionUnsupported` and
`repo.capabilities.transactions` report what the deployment can do; the descriptor is observed from the live topology.

## Three transaction forms

```ts
import { batchTransaction, withTransaction } from '@classytic/mongokit';

// 1. one repo: callback gets a tx-bound repo and a handle with the raw session
await orderRepo.withTransaction(async (tx, uow) => {
  const order = await tx.create({ total: 100 });
  await tx.update(order._id, { confirmed: true });
  await outboxRepo.create(row, { session: uow?.session });   // work outside the repo joins the session
  return order;
});

// 2. several repos, each auto-bound to one session
await batchTransaction(mongoose.connection, { orders: orderRepo, events: eventRepo }, async ({ orders, events }) => {
  const created = await orders.create(data);
  await events.create({ type: 'order.placed', orderId: created._id });
});

// 3. raw session, for code that is not a repo
await withTransaction(mongoose.connection, async (session) => { await orderRepo.create(data, { session }); });
```

Options: `transactionOptions`, `allowFallback` (dev on standalone: runs once without a transaction), `onFallback(err)`. Transient errors retry
per the driver rules. Nested `tx.withTransaction` throws; reuse the outer bound repo. `isTransientConflictError(err)` marks retryable conflicts.

To serialise writers on a row, the write must change it. An update that sets a field to the value it already has (`$set: { at: now }` from two
writers at the same instant) is a no-op: it takes no write lock, so two transactions doing it never conflict. Make the write real, for example
`$inc: { writes: 1 }` on the row (the same holds for a lease or gate row you rely on to order concurrent work).

## Outbox (`@classytic/mongokit/outbox`)

```ts
import { createOutboxRepository } from '@classytic/mongokit/outbox';
const outboxRepo = createOutboxRepository(mongoose.connection, { visibleAtField: 'visibleAt' });
```

It is the Mongo half only: the model (`_id` is the event id, so replays are duplicate-key no-ops), four indexes for claim, dedupe and retention, and
a repository with the required registry and batch plugins. Wrap it with arc's `repositoryAsOutboxStore(repo, { visibleAtField })` (use the SAME
`visibleAtField`) and relay with arc's outbox module. Write the row in the same session as the business write. Delivered rows expire by TTL
(`ttlSeconds`, default 7 days); pending and dead-lettered rows never do. Statuses: `OUTBOX_STATUSES`. The repository has no `maxLimit` cap, so
the relay's `batchSize` is the claim window; pass `pagination: { maxLimit }` to set a ceiling (keep `batchSize` at or below it).

## Idempotency claims (`/idempotency`)

```ts
import { createIdempotencyModel, createIdempotencyStore } from '@classytic/mongokit/idempotency';
import { runIdempotent } from '@classytic/repo-core/idempotency';
const store = createIdempotencyStore(createIdempotencyModel(mongoose.connection), { retentionSeconds: 7 * 86400 });
```

Size `retentionSeconds` to the longest a caller may retry. Contract details are in skill `repo-core`.

## Locks, usage, sync, read models

| Subpath | Export | Use |
|---|---|---|
| `/lock` | `createMongoLockAdapter({ connection, nowFn })` | cross-process mutex with expiry (`nowFn` must track wall time: TTL index). `acquire(name, holder, leaseMs)` answers `{ acquired, holder, previousHolder?, acquiredAt, expiresAt }` from the one atomic write (no `inspect` first to learn who held it); `tryAcquire` stays a boolean |
| `/lock` | `createMongoDailyLedger({ connection, collectionName })` | arc `DailyLedger` for `createDailyGate`: one claim per key and civil day; every claim gets a unique token, and complete/release act only on the claim the calling invocation won (an older run never completes or releases a newer stale re-grant, a retry stays fenced). Host code: `claim(key, day, info)` returns a handle with fenced `complete()` / `release()`. Manual completion is the explicit `adminCompleteDay`, never a fallback |
| `/usage` | `createMongoUsageStore` | metered counters per period |
| `/sync` | `createChangeLogStore(models, { now, onSequenced })`, `createCommandStreamStore` | offline sync stores (models from `createChangeLogModels`, `sequencing: 'deferred'` with `sequencerLeaseMs` to keep writers off the counter row); `now` stamps `at`; `onSequenced({ cursor, numbered, by })` wakes a replay hub when entries got cursors, also after a read lost the sequencer lease to another holder; retention: schedule `prune(before)`; horizons are kept per `(tenantId, scope)`, so `since(cursor, { tenantId, scopes })` throws `CursorExpiredError` only when something that reader can see was pruned past its cursor, and it resyncs from `latestCursor(sameOptions)` (never below its horizon) |
| `/read-model` | `applyIncrements`, `rebuildInto`, `reconcile` | counter read models with drift reports |
| `/testkit` | `createTestRepository`, `withMongoMemory`, `createMongoMemory`, `clearCollections` | in-memory Mongo (replica set) for tests |
| `/testkit` | `assertQueryPlan`, `explainCommands` | gate or explain the commands a call really sent (`commands: ['findAndModify']` for a lease claim) |
| `/kernel-conformance` | conformance suite | prove a kernel behaves on this kit |

## Query defaults and comments

Resolution order: per call, then repository (`queryDefaults` option), then deployment.

```ts
import { assertQueryDefaultsConfigured, configureAggregateDefaults, configureQueryDefaults } from '@classytic/mongokit';
configureQueryDefaults({ maxTimeMS: 15000, readConcern: 'majority', comment: 'api' });
configureAggregateDefaults({ maxTimeMs: 30000, allowDiskUse: true });
assertQueryDefaultsConfigured(mongoose.connection);   // boot gate: throws without maxTimeMS or a client timeoutMS
await repo.getAll({ mode: 'offset', page: 1 }, { comment: 'orders.list', maxTimeMS: 5000, hint: { organizationId: 1, createdAt: -1 } });
```

Inside a transaction a default read or write concern is dropped (the transaction owns it); a per-call one is passed through.

## Verify indexes

```ts
import { formatIndexReport, verifyIndexes } from '@classytic/mongokit/indexes';
const report = await verifyIndexes(mongoose.connection, { includeModel: (name) => name !== 'AuthSession' });
if (report.missingUnique.length || report.incompatible.length) throw new Error(formatIndexReport(report));
```

`missingUnique` means duplicates may already exist; `incompatible` means the same keys with different `unique`, `partialFilterExpression`,
`sparse`, `collation` or TTL (fix by rebuild). Extra indexes in the database are not drift. Build indexes in a deploy step, never at serve time.

## Model registry

`defineModel(name, () => schema, { onExisting: 'reuse' | 'throw', connection })`: `reuse` for stubs and counters, `throw` (`ModelCollisionError`)
when you contribute fields or indexes a locked schema would silently drop. `defineModels({ models, assemble })` describes a model set without a
connection, then `blueprint.bind(connection)` registers it (policies `throw`, `reuse`, `replace` for tests only).
