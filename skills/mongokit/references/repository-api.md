# Repository API

`new Repository(Model, plugins?, paginationConfig?, options?)` or `createRepository(Model, config)`. `config` keys:
`tenant`, `softDelete`, `timestamps`, `batch`, `cache`, `audit`, `customId`, `plugins` (appended last), `pagination`, plus
`RepositoryOptions` (`idField`, `searchMode`, `searchFields`, `pluginOrderChecks`, `requirePlugins`, `queryDefaults`, `hooks`).
The factory installs plugins in the safe order (registry, tenant, soft delete, timestamps, custom id, cache, audit, batch) and
fails fast on a bad order.

Every method takes an options bag last: `{ session, organizationId, select, populate, lean, throwOnNotFound, bypassTenant, includeDeleted, comment, maxTimeMS }`.

## Reads

| Method | Miss result |
|---|---|
| `getById(id, opts)` | `null` (a malformed id is a miss, not a CastError) |
| `getOne(filter, { sort })`, `getByQuery` | `null` |
| `getByIds(ids)` | `Map` of found rows |
| `getAll(params, opts)` | envelope with empty `data` |
| `findAll(filter, opts)` | `[]` |
| `count`, `exists`, `distinct` | `0`, `null`, `[]` |
| `iterate(filter, { batchSize, after })` | async batches `{ docs, checkpoint }`, resumable |
| `cursor`, `watch` | streams (watch needs a replica set) |

Filters accept Mongo objects or repo-core Filter IR (`eq`, `and`, `in_` from `@classytic/repo-core/filter`).

## Writes

| Method | Notes |
|---|---|
| `create`, `createMany` | `createMany` rejects on a partial write; `isCreateManyPartialError(err)` then read the report |
| `update(id, data, opts)` | `null` on miss; `ifVersion` adds a stamp check |
| `findOneAndUpdate(filter, update, { sort })` | atomic claim of the oldest row |
| `getOrCreate(filter, data)` | `{ doc, created }`, no race |
| `delete(id, { mode })` | soft when `softDeletePlugin` is on; `mode: 'hard'` removes |
| `updateMany`, `deleteMany`, `bulkWrite` | need `batchOperationsPlugin` (or `batch: true`) after soft delete |
| `bulkUpsert(rows, { key, set, inc, setOnInsert })` | one command, per-row outcome; MongoDB 8; refused without a unique index on key plus scope |
| `purgeByField`, `purgeByFilter`, `archiveByFilter` | chunked, abortable, plugin-composed cleanup; index the field first |

## Compare-and-set family

| Primitive | Use when | Loss signal |
|---|---|---|
| `claim(id, { from, to, where }, patch)` | state move, `from` may be an array | `null` |
| `applyTransition(id, machine, args)` | state move with legality, history, diagnosis | throws 409, 404 or the machine's error |
| `claimVersion(id, { from, where }, update)` | optimistic lock, `$inc` on `version` | `null` |
| `claim` with `upsert` and `from === to` | first-writer-wins insert | existing doc |
| `leasePlugin().lease()` | worker takes the next pending row with a TTL | `null` |

`applyTransition` args: `from`, `to`, `set`, `push`, `inc`, `unset`, `where`, `by`, `note`, `history` (field name or `false`), `field`, `at`,
`priorAt`, `historyExtra`. Options also take `target` (forwarded to `claim`).
A `TransitionMachine` is `{ name, assertTransition(entityId, from, to) }`; throw your domain error from it. Legality is checked before the
write; on a lost race the row is re-read and the error reflects its CURRENT state. It does no read of its own, so pass `priorAt` (when the
row entered its current state, from your read) to record `durationInPriorMs`, and guard that read with `where: { updatedAt }` or `target`.
`historyExtra` merges extra fields into the entry; reserved keys and either arg with `history: false` are a 400.

Codes: `TRANSITION_RACE_LOST` (409, still legal, re-read and retry), `TRANSITION_TARGET_MISSING` (404). An idempotent event handler
treats both as "already moved". Tenant scope must be passed in the options bag.

## Aggregation

`aggregate(req)` is the portable IR (`groupBy`, `measures`, `having`, `sort`, date buckets), identical on other kits. `aggregatePipeline(stages)`
is native Mongo (`$lookup`, `$facet`). `aggregatePaginate` and `aggregatePipelinePaginate` return envelopes. `lookupPopulate(params)` joins by
any field without a `ref`. `compileFilterToMongo(filterIR)` reuses the filter compiler inside a custom pipeline.

## Soft delete

`softDeletePlugin({ deletedField: 'deletedAt', filterMode })` adds `restore(id)` and `getDeleted(params)`; reads hide deleted rows unless
`includeDeleted: true`. Make unique indexes partial so deleted rows do not block inserts:

```ts
schema.index({ email: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
```

## Events and hooks

`repo.on('before:update' | 'after:create' | 'error:delete', handler, { priority })` with `HOOK_PRIORITY` (POLICY 100, VALIDATION 150, CACHE 200,
OBSERVABILITY 300, DEFAULT 500). `before:*` handlers may mutate `context.data` and `context.query`. `registerRepositoryEvents` (from
`@classytic/repo-core/events`) publishes domain events from repo operations.

## Errors

Repo errors are `HttpError` shaped (`status`, `code`, `meta`, `duplicate`, `validationErrors`); see skill `repo-core`.
`isDuplicateKeyError(err)` and `parseDuplicateKeyError(err)` (field names only unless `exposeValues`) classify E11000.
