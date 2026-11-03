# Plugins, tenancy, indexes

## Order

Prefer `createRepository`: it installs the canonical order and sets `pluginOrderChecks: 'throw'`. Hand-built chains
(`new Repository(Model, [...])`) must keep: `methodRegistryPlugin` first; `multiTenantPlugin` before soft delete and cache (cache keys need
the tenant); `softDeletePlugin` before `batchOperationsPlugin` (bulk ops must see the deletion filter). `requirePlugins: [MONGOKIT_PLUGIN_NAMES.multiTenant]`
makes a missing plugin a boot error instead of a tenant leak.

## Bundled plugins

| Plugin | Adds |
|---|---|
| `timestampPlugin` | `createdAt`, `updatedAt` |
| `softDeletePlugin` | `deletedAt` mark, read filter, `restore`, `getDeleted` |
| `multiTenantPlugin` | tenant filter and payload injection (`tenantField`, `contextKey`, `required`, `fieldType`, `skipWhen`, `resolveContext`) |
| `cachePlugin` | read-through cache with write invalidation |
| `auditTrailPlugin` | persisted audit ledger with field diffs (`mode: 'transactional'` is atomic only inside a transaction) |
| `auditLogPlugin` | structured log lines through your logger |
| `changeLogPlugin` | change feed for sync (`@classytic/mongokit/plugins`) |
| `cascadePlugin` | delete related rows (`relations`, `parallel`, `batchSize`) |
| `fieldFilterPlugin` | role-based field visibility (`createFieldPreset`) |
| `validationChainPlugin` | `requireField`, `immutableField`, `uniqueField`, `blockIf`, `autoInject` |
| `customIdPlugin` | `sequentialId`, `prefixedId`, `dateSequentialId` |
| `appendOnlyPlugin`, `immutableStatesPlugin` | refuse updates and deletes, or freeze rows in terminal states |
| `leasePlugin` | time-bounded work claims (`nowFn` or per-call `now`, `attemptsField`, `maxAttempts`, `pendingFilter` object or `(now) => filter`, `deadLeaseStatuses`; `extend`/`release` need the row still in `processingStatus`) |
| `batchOperationsPlugin`, `mongoOperationsPlugin`, `aggregateHelpersPlugin`, `subdocumentPlugin` | extra methods through the registry |
| `observabilityPlugin` | timing, metrics, slow-op callback |
| `elasticSearchPlugin` | delegate `search` to Elasticsearch |
| `searchKeysPlugin` | prefix keys (installed by `searchMode: 'prefix'`) |

Counters: `getNextSequence(key, inc, connection, session)` uses `_mongokit_counters`; `createSequenceCounter({ connection, collection })`
binds `next`, `read`, `ensureAtLeast` (each with an optional session) to your own collection name; `sequentialId` / `dateSequentialId` take `counterCollection` for the same collection.
Period-scoped: `getNextPeriodSequence(base, { period: 'year' | 'month' | 'day', timeZone, at?, session? })` (or `nextInPeriod`) derives the
key from the civil date of `at` in an IANA zone and returns `{ seq, period, counterKey }`; `dateSequentialId` takes `timeZone`, `at(ctx)`, `counterKey`.
Retention purge (append-only or frozen rows): build `appendOnlyPlugin` and/or `immutableStatesPlugin` with `allowPurge: true`, then
`purgeByFilter(filter, { type: 'hard' }, { retentionPurge: { reason, actor } })` (or `deleteMany(filter, { mode: 'hard', retentionPurge })`).
Each delete call emits `after:append-only-purge` / `after:immutable-states-purge` with `deletedCount` and `session`. Listeners are awaited and a
throwing one fails the purge; write the audit row with `{ session: event.session }` so it commits or aborts with the delete. Ordinary deletes stay refused.
Function-form anonymize writes through the guarded `updateMany` (frozen / append-only rows refused); `immutableStatesPlugin` reads state in the call's session.

`leasePlugin` (after `methodRegistryPlugin`): `lease({ filter, leaseFor, leasedBy, now })` claims a pending row or a dead lease (a row
still in `processingStatus` whose expiry passed); the caller filter, its `$or` included, is ANDed in. `extend` and `release` CAS on
`leasedBy` plus a live expiry, so make `leasedBy` unique per claim. Cancelling a leased row from outside should also `$unset` the lease fields.
With `maxAttempts`, set `exhaustedStatus: 'failed'` (and `exhaustedAtField`) and schedule `reapExhausted({ now, limit })`: it moves rows at the cap
whose lease lapsed (or that sit pending) to that status by CAS and returns them once, for the host to audit and alert.

## Tenancy

```ts
multiTenantPlugin({ tenantField: 'organizationId', contextKey: 'organizationId', required: true, fieldType: 'objectId' });
await repo.getAll({ mode: 'offset', page: 1 }, { organizationId });          // scoped
await repo.update(id, data, { organizationId: 'other' });                     // null: cross-tenant miss
await repo.getAll({ mode: 'offset', page: 1 }, systemContext());              // bypassTenant for jobs
```

`createTenantContext()` (AsyncLocalStorage) removes the need to pass the scope on each call. `repoOptionsFromCtx(ctx)` forwards a request scope.
Richer rules (branches, owners, roles) compose on top with `skipWhen` and `adminBypass({ adminRoles })`; do not widen the plugin.

## Tenant-led indexes

`@classytic/mongokit/tenant` mutates the schema so every declared compound index leads with the tenant field:

```ts
import { injectTenantField } from '@classytic/mongokit/tenant';
import { resolveTenantConfig } from '@classytic/repo-core/tenant';

injectTenantField(schema, resolveTenantConfig({ tenantField: 'organizationId' }), {
  skipIndexes: ['event_id_unique'],
  indexes: [{ fields: { buyerId: 1, createdAt: -1 }, scope: 'global', options: { name: 'buyer_history_global' } }],
});
```

`scope: 'global'` keeps the index as written for an identity read across tenants; it must be named, must not name the tenant field, and must be
paired with a `bypassTenant` read. TTL indexes are never prefixed.

## Cache

```ts
import { cachePlugin, createMemoryCache } from '@classytic/mongokit';
cachePlugin({ adapter: createMemoryCache(), defaults: { staleTime: 30, gcTime: 300, swr: true }, prefix: 'orders' });
await repo.getById(id, { cache: { bypass: true } });          // per call
```

An adapter is `{ get, set(key, value, ttlSeconds), delete, clear? }`. Writes invalidate by tag; `autoTagsFromScope` tags with the tenant.

## Audit trail

```ts
auditTrailPlugin({ mode: 'transactional', collectionName: 'audit_trail', ttlDays: 365, excludeFields: ['password'], metadata: (ctx) => ({ actor: ctx.actorId }) });
await ensureAuditTrailReady();   // at boot, so the first transaction does not create the collection
const query = new AuditTrailQuery(Model);
```

`best-effort` (default) is fire and forget and is observability only.

## Index discipline

- Declare every index in the schema (`schema.index(fields, { name })`); name each one so drift reports are readable.
- Sort, cursor, purge and prefix-search fields all need a supporting index; unindexed purge is O(n squared).
- Run `verifyIndexes(connection)` in CI or a deploy check (see `transactions-outbox.md`); it is read-only and never builds indexes.
- Tag slow queries with `comment` (per call or `configureQueryDefaults({ comment })`) so they are findable in the profiler.
