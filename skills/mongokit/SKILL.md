---
name: mongokit
description: Mongoose 9 repositories for MongoDB, implementing repo-core StandardRepo. Use for models, repositories, plugins (tenant, soft delete, cache, audit), offset and keyset pagination, status transitions with history, transactions, outbox, search, geo, index checks. Triggers - mongokit, Repository, applyTransition, getAll, withTransaction, QueryParser.
metadata:
  minVersion: "3.43.1"
  package: "@classytic/mongokit"
  peers: "@classytic/repo-core >=0.31.1, mongoose >=9.11.2, node >=22"
---

# @classytic/mongokit

Repository layer over Mongoose with the shared `StandardRepo<TDoc>` contract. Misses return `null` (or `{ success: false }`), not a thrown 404, unless `throwOnNotFound: true`.

## Do not hand-roll

| Need | Use |
|---|---|
| Register a model twice safely | `defineModel`, `defineModels` (explicit `onExisting`) |
| Repo with tenant, soft delete, timestamps, cache, audit in the safe order | `createRepository` |
| Status change with legality check, history row, race diagnosis | `repo.applyTransition` + `TransitionMachine` |
| Compare-and-set on a version stamp | `repo.claimVersion` |
| Multi-document atomic write | `withTransaction`, `batchTransaction`, `repo.withTransaction` |
| Duplicate key (E11000) detection | `isDuplicateKeyError` |
| URL query string to filter, sort, page, populate | `QueryParser` |
| Indexed search-as-you-type | `searchMode: 'prefix'`, `searchKeysPath`, `searchKeysIndex`, `rebuildSearchKeys` |
| Transactional outbox table and repo | `createOutboxRepository` (`/outbox`) |
| HTTP idempotency replay store | `createIdempotencyStore` (`/idempotency`) |
| Cross-process lock | `createMongoLockAdapter` (`/lock`) |
| "Are my declared indexes built?" | `verifyIndexes`, `formatIndexReport` (`/indexes`) |
| Tenant field plus tenant-led indexes on a schema | `injectTenantField`, `declareIndexes` (`/tenant`) |
| Query timeout, read concern, profiler comment | `configureQueryDefaults`, `assertQueryDefaultsConfigured` |
| Skip the per-page count at scale | `configurePaginationDefaults`, `countStrategy` |
| Soft delete, append-only, immutable states | `softDeletePlugin`, `appendOnlyPlugin`, `immutableStatesPlugin` |
| Sequential or prefixed ids | `customIdPlugin`, `sequentialId`, `prefixedId` |
| Worker lease on pending rows | `leasePlugin` |
| Bypass tenant scope on purpose | `systemContext`, `adminBypass` |
| Forward request scope to a repo call | `repoOptionsFromCtx` |
| arc DataAdapter for a repo | `createMongooseAdapter` (`/adapter`) |
| Throwaway Mongo in tests | `createTestRepository`, `withMongoMemory` (`/testkit`) |

## Golden path

Model and repo (one registration, tenant and soft delete in the canonical order):

```ts
import { createRepository, defineModel } from '@classytic/mongokit';
import { Schema } from 'mongoose';

const Order = defineModel('Order', () => {
  const schema = new Schema({ organizationId: String, status: String, total: Number,
    statusHistory: { type: [new Schema({ status: String, occurredAt: Date, by: String, note: String }, { _id: false })], default: [] } },
    { timestamps: true });
  schema.index({ organizationId: 1, createdAt: -1, _id: -1 }); // keyset order + _id tiebreak
  return schema;
}, { onExisting: 'reuse' });

export const orderRepo = createRepository(Order, {
  tenant: { tenantField: 'organizationId', required: true }, softDelete: true, batch: true,
});
```

List (envelope is `{ method, data, ... }`; pass `mode` explicitly):

```ts
const page = await orderRepo.getAll({ mode: 'offset', page: 1, limit: 20, filters: { status: 'open' }, sort: { createdAt: -1 } }, { organizationId });
const first = await orderRepo.getAll({ mode: 'keyset', limit: 20, sort: { createdAt: -1 } }, { organizationId });
const next = await orderRepo.getAll({ mode: 'keyset', after: first.next, limit: 20, sort: { createdAt: -1 } }, { organizationId });
```

Status transition (machine is `{ name, assertTransition }`; `defineStateMachine` satisfies it):

```ts
const moved = await orderRepo.applyTransition(id, MACHINE, { from: 'open', to: 'paid', by: actorId, note }, { organizationId });
```

Atomic write plus outbox row in one transaction (needs a replica set):

```ts
import { withTransaction } from '@classytic/mongokit';
await withTransaction(mongoose.connection, async (session) => {
  await orderRepo.create(data, { session, organizationId });
  await outboxRepo.create(row, { session });
});
```

HTTP query: `const parsed = new QueryParser({ schema: OrderSchema }).parse(req.query); await repo.getAll(parsed, scope);`

## Gotchas

- Tenant scope rides in the options bag (`{ organizationId }`), not in `filters`. Missing it throws; cross-tenant ids return `null`.
- Offset and keyset are chosen by `mode`, else `page`, else `after`, else a non-default `sort` means keyset. Always pass `mode`.
- Keyset needs a compound index on the sort keys plus `_id` (tenant field first when scoped).
- `applyTransition` pushes `{ status, occurredAt, by, note }` to `statusHistory` in the same atomic write; `history: false` skips it. Loss throws `TRANSITION_RACE_LOST` (409) or `TRANSITION_TARGET_MISSING` (404), codes are upper-case.
- `repo.withTransaction` hands you a tx-bound repo; the standalone `withTransaction` hands you a raw session. Standalone mongod cannot transact.
- Filter keys missing from the schema are stripped by `strictQuery`; develop with `warnOnStrictQueryStrip: true`.
- `QueryParser` throws 400 `INVALID_QUERY_INPUT` on blocked input by default; `search` text is escaped, never rejected.
- Reads through the raw model skip tenant, soft delete and cache.
- Prefix search keys are derived; writes outside the repo need `rebuildSearchKeys`.

## Never

- Hand-roll `findOneAndUpdate({ status })` CAS, E11000 string matching, or `mongoose.models.X ?? model()`.
- Deep-import; use the subpaths in `llms.txt`.
- Look for pagination result or error types here: they live in `@classytic/repo-core`.

## References

- `references/repository-api.md`: read for the method list, options bag, bulk, createMany, claim, aggregate, soft delete.
- `references/pagination-search.md`: read for keyset indexes, count strategy, prefix search, QueryParser grammar, geo, lookups.
- `references/plugins-tenancy.md`: read for plugin order, tenant indexes, cache, audit, cascade, field filter, hooks.
- `references/transactions-outbox.md`: read for transactions, outbox, idempotency, lock, query defaults and comments, index verification.
- Cross-package: contract types, errors, envelopes in skill `repo-core`; arc wiring in skill `arc`.
