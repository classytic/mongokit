# Changelog

All notable changes to this project are documented here.

This repository now keeps the top-level changelog short and archives detailed
history by major version:

- [v3 history](./changelog/v3.md)
- [v2 history](./changelog/v2.md)
- [v1 history](./changelog/v1.md)

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Current Line

### 3.45.0 — 2026-11-06

#### ⚠ Changed: time bounds are server-side `maxTimeMS`, not CSOT `timeoutMS` (MongoDB driver 7.8)

`mongodb` 7.8 (mongoose 9.12) deprecated `timeoutMS` / `timeoutMode` and made them a no-op, after CVE-2026-119179 (connection-pool desync after an operation timeout can expose other users' data). Every time bound in this kit rode on per-op `timeoutMS`, so on 7.8 reads, aggregates and writes would have gone out with no bound and no error. The bound is now the command's `maxTimeMS`:

- `queryDefaults` / `aggregateDefaults` / per-call `maxTimeMS` reach find, findOne, count, distinct, findOneAndUpdate, aggregate, `createMany` (insertMany), update/delete and `bulkWrite` as `maxTimeMS` (verified on the wire for each). `bulkWrite` now accepts `maxTimeMS`; `timeoutMS` is still refused there, with a message pointing at `maxTimeMS`.
- A single `create()` goes through Mongoose `save()`, which forwards no `maxTimeMS` (it never forwarded the old `timeoutMS` either), so it is not server-bounded. Use `createMany` where a bound matters.
- `cursor()` bounds its initial find only; later batches (getMore) are not server-bounded. `iterate()` is one bounded find per batch and keeps a bound on every batch. `applyCursorTimeoutMode` is removed.
- `withTransaction({ transactionOptions: { timeoutMS } })` keeps its name but is now mongokit's own budget for the whole transaction: every mongokit op inside gets `maxTimeMS` = what remains, the commit gets `maxCommitTimeMS` = what remained when the attempt started, and retries stop at the deadline. The client's `timeoutMS` is no longer read.
- `assertQueryDefaultsConfigured()` takes no connection and checks only the deployment `maxTimeMS`. The driver drops a client `timeoutMS` from its options (it only logs a process warning), so there is nothing to check; do not pass it to `mongoose.connect()`. `QUERY_DEFAULTS_ERROR_CODES.TIMEOUT_IN_TRANSACTION` is removed: a per-call `maxTimeMS` inside a transaction is capped by the remaining budget instead of refused.
- Tests: `csot-transaction-matrix` is now `transaction-budget-matrix`; `query-defaults`, `bulkwrite-options` and `governance` assert the `maxTimeMS` wire behaviour.

Peers: mongoose `>=9.12.0` (driver 7.8, which carries the fix), repo-core `>=0.38.0`.

#### Fixed: Better Auth with `generateId: 'uuid'` silently 404'd every overlay lookup

`BetterAuthIdType` is now `'objectid' | 'string' | 'uuid'`. With `advanced.database.generateId: 'uuid'` Better Auth stores real BSON UUIDs; an ObjectId-typed stub cast the string id to an ObjectId that matched nothing, so `getById` returned null and `update`/`delete` were no-ops with no error. Pass `idType: 'uuid'` to `registerBetterAuthStubs` / `createBetterAuthOverlay`. Verified against the real adapter in `tests/integration/better-auth-adapter-coexistence.test.ts` (fails with `'objectid'`).

#### Fixed: `ensureBetterAuthIndexes` built a second index on `deviceCode` and `userCode`

The device-authorization plugin declares unique table-level indexes on both and Better Auth's mongo adapter creates them on first use. This kit declared the same keys under other names (one non-unique), leaving a redundant index on every write. The two specs are removed (the `expiresAt` TTL stays). Core indexes (`user.email`, `session.token`, ...) are still ours: the adapter creates none.

Dev pins `better-auth`, `@better-auth/mongo-adapter` and `@better-auth/api-key` move to `^1.7.18`.

#### Added: `MongoChangeLogStore.snapshot()`, the bootstrap for a reader `since()` expired

After `prune`, `since(cursor)` below the reader's horizon throws `CursorExpiredError`, and there was no way to rebuild that reader's state. `snapshot(cursor, { ...view, limit, upTo })` pages each document's latest entry at or below `upTo` (the reader's horizon, fixed by the first page and returned on every page as `upTo`), in feed order. Tombstones are left out, so a deleted document is never resurrected. Then `since(upTo)` delivers every change above it. This is complete because `prune` and `compactSuperseded` never delete a document's latest entry. A feed that was never pruned answers an empty page with `upTo: ''`. Additive (`tests/integration/change-log-store-snapshot.test.ts`).

#### Fixed: `prune` and `compactSuperseded` could keep a document's stale entry

Both kept each document's LAST entry (highest cursor), but a client keeps the HIGHEST VERSION and skips anything not newer. A writer whose versions do not follow the feed, such as branch stock, which stamps its read time and can record a lower version after a higher one, therefore lost its newest state on every compaction. A till bootstrapping afterwards showed the older stock. Retention, compaction and `snapshot()` now keep the entry a reader ends on. A tombstone applies unconditionally, because `changeLogPlugin` writes it at version 0. So the kept entry is the last tombstone, or, when upserts follow it, the highest-version one of them (the first recorded on a tie). Falsified by `change-log-store-snapshot.test.ts`: the last-cursor rule fails 4 cases, and the highest-version rule that ignores tombstones fails 2 (it resurrects a deleted document).

#### Fixed: `archiveByFilter` could never finish on an append-only or immutable-states repository

`archiveByFilter` did not forward `retentionPurge` to its chunk deletes, so `appendOnlyPlugin` refused every chunk after the sink had written it (journal entries, stock events): nothing lost, but the run could never complete. `archiveByFilter(filter, sink, { retentionPurge: { reason, actor? } })` now validates the request before reading anything and sends it on every chunk delete together with an ARCHIVE ATTESTATION minted only after the sink acknowledged that chunk (the port also refuses to delete a row the sink did not acknowledge).

- **Added `allowArchive`** on `appendOnlyPlugin` and `immutableStatesPlugin`: admits exactly the attested archive deletes, nothing else. A `retentionPurge` delete without the attestation is still `RETENTION_PURGE_DISABLED`; an attestation that is forged or does not cover every id the delete targets is `RETENTION_PURGE_ARCHIVE_UNATTESTED` (403). `allowPurge` implies it.
- `RetentionPurgeEvent` gains `archived: boolean`; `after:append-only-purge` / `after:immutable-states-purge` fire for attested archive deletes when either option is set.
- Internal: `createMongoArchivePort` is replaced by `createMongoArchiveRun` (sink + port pair).

#### Fixed: `archiveByFilter` deleted a row edited after export, losing the edit

A row edited between the chunk read and its delete that still matched the filter was deleted, while the sink held the pre-edit version. Each chunk delete now pins every row to its exported `updatedAt` (mongoose timestamps, maintained on every mongoose write path) plus the repository's `versionField` when the schema has it; an edited row stays live, and the next run archives the new version. Progression is now a keyset over `_id`, so the run does not revisit a row it left live.

- **BREAKING (fail loud):** a schema without a maintained `updatedAt` is refused `ARCHIVE_NO_CHANGE_TOKEN` (400) before anything is read. Pass `immutable: true` for a collection whose rows never change (append-only ledgers without timestamps).
- `__v` alone is not used as the token: mongoose does not bump it on update queries.

Tests: `tests/integration/archive-append-only.test.ts` (edit mid-run stays live with the edit and is archived by the next run; no-timestamps schema refused unless `immutable`) — both fail on 3.44.0.

Tests: `tests/integration/archive-append-only.test.ts` (completes on both fences and audits each chunk as archived; deletes outside a run stay refused; forged / stretched attestation refused; without the option the delete half is refused and nothing is lost; a row that leaves the filter mid-run stays hot; malformed request refused before any read).

### [3.44.0] - 2026-11-03

#### Changed: peer floors to the latest published

`@classytic/repo-core >=0.37.0` (the lock `acquire` contract), `mongoose >=9.11.4`, `mongodb-memory-server >=11.3.0` (testkit). Dev toolchain: TypeScript 7, tsdown 0.23, vitest 5, Biome 2.6; `check:forgotten-exports` parses declarations with an aliased TypeScript 5.9 (`ts-api`) because TypeScript 7 has no JS compiler API.

#### Fixed: review findings (daily ledger, change-log prune, retention audit, usage, testkit, packaging, purge)

- **P1 daily ledger fencing** (`./lock`): ownership is per invocation. Every won claim gets a unique `claimToken` on the row; `completeDay` / `releaseDay` act only while the row still carries the token of the claim the calling invocation won (bound to the async flow that awaited `claimDay`), so an older run can no longer complete or release a newer stale re-grant made by the same ledger instance, and a retried completion stays fenced. A ledger holding no claim on the day no longer completes it ("admin" fallback removed): new explicit `adminCompleteDay(key, civilDate, result?)`. New `claim(key, civilDate, info)` returns a per-invocation handle (`MongoDailyClaim`: `token`, `complete()`, `release()`, each fenced by the token). Tests: `tests/integration/daily-ledger.test.ts` (same-instance re-grant: release and complete by the older invocation; retried stale completion; no-claim completion; handles).
- **P1 change-log prune horizon** (`./sync`): `prune()` deleted `seq < latest` while the recorded horizon came from an earlier snapshot, so an old entry appended or numbered during the prune was deleted above the advertised horizon and `since(horizon)` silently skipped it. The delete is now bounded to exactly the range the horizon covers (`seq <= deletedMax`). Test (both sequencing modes): `tests/integration/change-log-store-prune.test.ts`.
- **P2 retention purge audit**: `after:append-only-purge` / `after:immutable-states-purge` are emitted with `emitAsync` (awaited); a failing listener fails the purge call. The event carries `session`: a listener that writes its audit row with it commits or aborts together with the delete. Tests: `tests/integration/retention-purge.test.ts`.
- **P2 usage summaries** (`./usage`): `summary()` sums in a `Map` and returns `Object.fromEntries`, so kinds named `constructor`, `toString` or `__proto__` are plain counters. Tests: `tests/integration/usage-conformance.test.ts`; contract scenario added to repo-core's `runUsageStoreContract`.
- **P2 testkit shutdown** (`./testkit`): a stop marks the server stopped and leaves the process-exit list only after it succeeded. A failed `stop()` now rejects (it used to be swallowed), can be retried, and `stopSync()` / the exit handler still kill mongod; the signal handler runs `stopSync()` for any server its async stop could not stop before re-raising. `createTestConnection().close()` is retryable the same way. Tests: `tests/integration/testkit-mongo-tmp.test.ts`.
- **P2 packaging**: `files` ships `llms.txt` and `skills/**/*.md`. Test: `tests/package.publish-ready.test.ts` (reads `npm pack --dry-run --json`).
- **ID-bounded purge** (`utils/id-chunks.ts`): the keyset cursor (and the narrowed write) replaced a caller's own `_id` predicate, so `purgeByFilter({ _id: { $nin: keep } }, ...)` processed excluded rows after the first chunk. A base filter with `_id` is now combined with `$and`. Tests: `tests/integration/purge-by-filter.test.ts` (hard, soft, static and function anonymize, `$lte` bound).
- **Function-form anonymize through the fences** (`actions/purge.ts`): it wrote with a raw `Model.bulkWrite`, bypassing `immutableStatesPlugin` and `appendOnlyPlugin`. It now writes each chunk with one guarded `repo.updateMany` (pipeline picking each row's value by `_id`; scalar values cast by the schema type), so frozen / append-only rows are refused like the static form and `after:updateMany` reaches the change log. Tests: `tests/integration/immutable-states-purge.test.ts`.
- **immutableStatesPlugin in a transaction**: the state checks for `update`, `delete`, `claimVersion`, `restore`, different-field `claim`, `findOneAndUpdate`, `updateMany` and `deleteMany` now read in the call's session, so a row frozen earlier in the same transaction is refused. Tests: `tests/integration/immutable-states.plugin.test.ts`.

#### Added: lock `acquire()`, the outcome of the acquire from its own atomic write (G-MON-4)

`createMongoLockAdapter()` now returns `MongoLockAdapter` (the repo-core `LockAdapter` with `inspect` and `acquire` always present; new exported types `MongoLockAdapter`, `MongoLockAcquisition` from `@classytic/mongokit/lock`). `acquire(name, holderId, leaseMs)` takes the lock under the same rule as `tryAcquire` (free, lapsed, or the caller's own) and answers `{ acquired, holder, previousHolder?, acquiredAt, expiresAt }` from the ONE `findOneAndUpdate` (update pipeline, `returnDocument: 'before'`) that took it: `previousHolder` is the holder on the row before the write (the caller on a renewal, another holder on a takeover of its lapsed lease, absent when the lock was free); a refused acquire writes nothing and reports the live holder and its times. A caller that records a change of holder no longer reads `inspect` before `tryAcquire` (a race window: the holder it read might not be the one it replaced). A racing first insert (E11000) retries and reads the winner. `tryAcquire`, `release` and `inspect` are unchanged. The shape matches repo-core's new optional `LockAdapter.acquire` / `LockAcquisition` (repo-core [Unreleased]); mongokit declares its own copy so its repo-core peer floor stays. Tests: `tests/integration/lock-acquire.test.ts` (free, renewal keeps `acquiredAt`, takeover names the lapsed holder, refusal writes nothing, release frees, 12 parallel acquirers: one winner named by every loser, mixed with `tryAcquire`, `$` holder kept literal, default lease).

FLOW OCC (G-MON-4, G-MON-4b): `apps/server/src/modules/console/console.service.ts` heartbeat calls `leases.acquire` / `leases.release` without reading the lease first (the change of master and its `from` come from the acquire's `previousHolder`; a renewal of its own lapsed lease is no change); `claimMaster` reads only the live holder it must release. "Master since" is `inspect().acquiredAt`; the presence row's `masterSince` and the `SoundLeases` cast are deleted.

#### Added: change log store clock and `onSequenced` (G-PB06-1 follow-ups)

`createChangeLogStore(models, { now?, onSequenced? })` (new optional second argument; exported types `ChangeLogStoreOptions`, `ChangeLogSequencedEvent` from `@classytic/mongokit/sync`):

- `now` stamps every entry's `at` (staged under `sequencing: 'deferred'`, and in-transaction appends), so `at` and a `prune(before)` cutoff read the same (test-driven) clock. The deferred sequencer's lease stays on the database clock (`$$NOW`): it is shared by every process and must not follow any one process's clock.
- `onSequenced({ cursor, numbered, by })` is called after entries got cursors: when this store's pass numbered them (`by: 'self'`, `cursor` = the new top), and when a read of this store found the sequencer lease held by another holder. In that case the store retries in the background (backoff from `min(50, lease / 10)` ms, unref'd timers, one follow-up per store, for at most three leases) and reports what the other holder numbered meanwhile (`by: 'other'`), or takes over a lease left by a holder that died and numbers the entries itself (`by: 'self'`). A host replay hub passes `() => hub.notify()`, so a tail that lost the lease race is woken when the entries land instead of at its next poll. Without the hook nothing runs in the background. A throwing hook is ignored. Never called under in-transaction sequencing.

Additive: one argument stores behave as before (`new Date()` for `at`, no hook). Not in this change: a standalone `append` still waits for its cursor with a short sleep loop (bounded by the lease plus 1 s). Tests: `tests/integration/change-log-sequenced-hook.test.ts` (clock on staged, deferred and in-transaction appends; `self` report with the top cursor and no call when nothing was staged; a reader that lost the lease woken with `by: 'other'` and the same cursor its next read returns; a holder that died mid-pass taken over by the woken reader within one lease while the dead pass is fenced; a throwing hook).

FLOW OCC (G-PB06-1): `apps/server/src/modules/alerts/alerts.models.ts` passes `sequencerLeaseMs: ALERT_STREAM_SEQUENCER_LEASE_MS` (2 s) and `createChangeLogStore(models.stream, { now: clock, onSequenced })`; `alerts.module.ts` wires `onSequenced` to `hub.notify()`. The hub keeps its 1 s poll only for what no wake covers (a best-effort bus wake, record frames staged on another replica).

#### Docs: an update that changes nothing takes no lock (G-PB06-2)

README "Transactions" and `skills/mongokit/references/transactions-outbox.md`: to serialise writers on a row, the write must change it; a `$set` to the value already there is a no-op, takes no write lock, and two transactions doing it never conflict.

#### Fixed: `./testkit` no longer leaves `mongo-mem-*` temp dirs behind

Test runs that were killed, crashed or timed out never reached `stop()`, so their mongodb-memory-server data dirs stayed in the temp dir (one machine: 3,698 dirs, about 57 GB in `%TEMP%`).

- `createMongoMemory` (and so `createTestConnection`, `withMongoMemory`, `createTestRepository`, `mongoMemoryBackend`) starts servers through `launchMongoMemory`: stop passes `{ doCleanup: true }` (mongodb-memory-server 11), a server that fails to start is cleaned up (mongodb-memory-server keeps that dir "for investigation"), and each server is registered with `stopOnProcessExit`: SIGINT / SIGTERM / SIGHUP / SIGBREAK stop it and re-raise the signal; `exit` (also after an uncaught exception) kills mongod synchronously, waits for it and removes the dir. `stop()` unregisters it.
- Before its first server, each process sweeps `mongo-mem-*` dirs in the temp dir in the background. A dir is removed only when its `mongod.lock` names no live process AND nothing in it changed for `TEST_MONGO_SWEEP_HOURS` (default 6; `0` / `off` disables). Keyfile dirs and anything else are never touched.
- `TEST_MONGO_TMPDIR` puts the data dirs under a dedicated base dir (for example a project-local `.tmp/mongo`); they are force-removed on stop and swept there too.
- New exports from `./testkit`: `sweepStaleMongoMemoryDirs`, `launchMongoMemory`, `stopOnProcessExit`, `isPidAlive`, `mongoMemoryTmpBase`, `staleMongoMemoryAgeMs`, `MONGO_MEM_DIR_PREFIX` and their types. The same module ships in `@classytic/arc-testkit/mongo` (same env vars).
- mongokit's own `tests/_shared/global-setup.ts` and `tests/setup.ts` now start their servers through `createMongoMemory`.
- Tests: `tests/integration/testkit-mongo-tmp.test.ts` (a dir with a dead pid and an old mtime is removed; a live pid, a recent dir, keyfile and foreign dirs are kept; a real mongod's dir survives a sweep at age 0, is removed on stop, on `stopSync` and after a failed start; replica set members get dirs under the base).

Adoption: none. Apps on `createMongoMemory` / `mongoMemoryBackend` get it on upgrade. Optional: `process.env.TEST_MONGO_TMPDIR ??= '.tmp/mongo'` at the top of `vitest.config.ts` plus `.tmp/` in `.gitignore`.

#### Added: period-scoped sequences (civil year / month / day in an IANA time zone) (G-OCC-2)

A counter that resets every civil period no longer needs the caller to compute the period key.

- `getNextPeriodSequence(baseKey, { period: 'year' | 'month' | 'day', timeZone, at?, increment?, keySeparator?, connection?, session? })` bumps the counter `'<baseKey><sep><period>'` and returns `{ seq, period, counterKey }` (`period` is `'2026'`, `'2026-03'` or `'2026-03-14'`, for formatting the id). `at` (default now) is the instant whose civil date picks the period, so a backdated record numbers in its own year. `keySeparator` defaults to `':'`; pass `'.'` to keep counters already created by hand as `app.thing.2026`.
- `createSequenceCounter(...).nextInPeriod(baseKey, options)`: the same on a host-named collection, with a session.
- `periodCounterKey(baseKey, options)` returns `{ counterKey, period }` for `read` / `ensureAtLeast` on the same counter; `civilPeriodKey(at, period, timeZone)` returns the period alone.
- `dateSequentialId` takes `timeZone?: string` (IANA, wins over `timezone`), `at?: (context) => Date | undefined | null` and `counterKey?: string` (base key, default `model.modelName`).

The civil date is read through `Intl.DateTimeFormat` with the zone's own rules, never a fixed offset, so DST transitions and zone-rule changes (Samoa's skipped 30 December 2011) land on the date a wall clock there shows, and every replica agrees whatever its `TZ`. An unknown zone throws (`dateSequentialId`: when the generator is built). No new dependency. Additive: `getNextSequence`, `sequentialId` and `dateSequentialId` without the new options are unchanged. Tests: `tests/integration/sequence-period.test.ts` (Riyadh year boundary at 21:00Z on 31 December, New York DST days, Samoa, process `TZ` independence, separator, collection and transaction rollback, `dateSequentialId` with `at`).

FLOW OCC (G-OCC-2): `occurrences.service.ts` `open()` calls `getNextPeriodSequence('occ.occurrence', { period: 'year', timeZone: deps.zone, at: reportedAt, keySeparator: '.', connection: deps.connection, session })` and formats the reference from `{ seq, period }`. `occurrenceCivilYearOf` and `occurrenceSequenceKeyOf` in `packages/contracts/src/occurrences.ts` and their unit tests at 31 December / 1 January can go (the existing `occ.occurrence.<year>` counters carry on because of `keySeparator: '.'`).

#### Added: audited retention purge through `appendOnlyPlugin` and `immutableStatesPlugin` (`allowPurge` + `retentionPurge`) (G-OCC-3, G-EL-1)

Rows behind an integrity fence could not be removed through the guarded repository: `immutableStatesPlugin` refused frozen rows, `appendOnlyPlugin` refused every delete, and `purgeByFilter` / `purgeByField` forwarded only `{ session, bypassTenant }` to their chunk deletes, so a retention job either built a second, unguarded repository or reached for the private engine flag. Now there is one public path:

- Construct the fence with `allowPurge: true`: `appendOnlyPlugin({ allowPurge: true })`, `immutableStatesPlugin({ ..., allowPurge: true })`, or both on the same repository.
- Purge with `repo.purgeByFilter(filter, { type: 'hard' }, { retentionPurge: { reason, actor? } })` (or `purgeByField`); the option rides every chunk's `deleteMany` with `mode: 'hard'`. A single call: `repo.deleteMany(filter, { mode: 'hard', retentionPurge })` or `repo.delete(id, { mode: 'hard', retentionPurge })`.
- Each fence lets that call through and audits it: `after:append-only-purge` (`AppendOnlyPurgeEvent`) and `after:immutable-states-purge` (`ImmutablePurgeEvent`, adds `states`), both with `operation`, `reason`, `actor`, `id` or the final `filter`, and `deletedCount`. `purgeByFilter` emits one event per chunk per plugin. The purge does not emit `after:append-only-bypass`.
- Refused: the option on a fence without `allowPurge` (403 `RETENTION_PURGE_DISABLED`, also on an `allow`-listed delete), a missing or blank `reason` (400 `RETENTION_PURGE_REASON_REQUIRED`), a blank or non-string `actor` (400 `RETENTION_PURGE_INVALID_ACTOR`), a delete without `mode: 'hard'` or a `soft` / `anonymize` purge strategy (400 `RETENTION_PURGE_HARD_ONLY`). `purgeByFilter` / `purgeByField` validate the reason and strategy before the first chunk. A refusal by a plugin inside a chunk comes back in the purge envelope (`ok: false`, `error.message`), as any chunk failure does.
- Ordinary deletes stay refused. On any other op (`update`, `updateMany`, `findOneAndUpdate`, ...) the option is ignored, so rows never become editable through it. Tenant scope still applies on direct `delete` / `deleteMany`.

New exports: `RetentionPurgeRequest`, `RetentionPurgeEvent`, `RETENTION_PURGE_ERROR_CODES`, `AppendOnlyPurgeEvent`, `RetentionTenantPurgeOptions` (`ImmutablePurgeRequest` is an alias of `RetentionPurgeRequest`). `SessionOptions` gains the typed `retentionPurge` field. `createMongoPurgePort` / `createMongoPurgePortFromFilter` take an optional trailing `{ retentionPurge }`. Additive: without `allowPurge` both plugins behave as before (`bypassAppendOnly` and `allow` are unchanged), except that passing `retentionPurge` is refused. Tests: `tests/integration/retention-purge.test.ts` (both plugins together: ordinary deletes and purges without the option refused, chunked `purgeByFilter` audited per chunk by both plugins, `deleteMany` / `delete` / `purgeByField`, append-only alone, opt-in on each plugin, validation before any chunk, no edit unlock) and `tests/integration/immutable-states-purge.test.ts` (frozen rows: event shape, miss audited with 0, tenant scope, soft-delete repository).

FLOW OCC (G-OCC-3, G-EL-1, review item 9 / A-R7 / O-R2 / E-R1): remove the private `_immutableInternal` flag from retention.
- Assist: add `allowPurge: true` to the messages repository's `appendOnlyPlugin` and to the cases repository's `immutableStatesPlugin`. In `assist.jobs.ts` `retention()` (~92-94) replace `{ bypassAppendOnly: true } as never` and `{ ...ENGINE_WRITE } as never` with `repo.purgeByFilter(filter, { type: 'hard' }, { retentionPurge: { reason: 'retention', actor: 'job:assist.retention' } })` (sum `processed`), and feed the audit from `after:append-only-purge` / `after:immutable-states-purge`. `assist.cases.ts` ~775-778 (`setOccurrence`, a `claimVersion` edit of a closed case) is NOT a purge: `retentionPurge` never unlocks edits, so that engine write keeps the plugin's `internalFlag` handshake (or the case model makes `occurrenceId` a field the freeze does not cover).
- Occurrences: add `allowPurge: true` to the occurrences repository's `immutableStatesPlugin`, run `occurrences.retention` through `purgeByFilter` (or `deleteMany({ _id: { $in: ids } }, { mode: 'hard', retentionPurge: { reason: 'retention', actor: 'job:occurrences.retention' } })`), and drop `repos.purge` (the second repository on `models.Occurrence` in `occurrences.models.ts`).
- Event log: `POST /event-log/purges` deletes with `purgeByFilter(..., { type: 'hard' }, { retentionPurge: { reason, actor } })` on the append-only repository (`appendOnlyPlugin({ allowPurge: true })`) and drops the batch delete loop and the per-batch audit row (`events-log.purge.ts:556-569`); `after:append-only-purge` carries the per-chunk `deletedCount`.

#### Added: change log `latestOf(scope, docId, { tenantId?, session? })`, a point read of one document's latest change

`MongoChangeLogStore.latestOf` returns the latest recorded change of one document (`(tenantId, scope, docId)`; `tenantId` omitted or `null` reads the untenanted one) as a `ChangeEntry`, or `null` when the feed holds none. Under `sequencing: 'deferred'` it reads the document's last STAGED entry first (committed or in the caller's `session`, not numbered yet: `cursor: ''`, as `append` answers inside a transaction), then its highest numbered entry; under `'in-transaction'`, the numbered entry. It only reads: it never runs the sequencer, so a writer can use it on a hot path (the last recorded state of a record before appending its next change). Served by the existing `doc_versions` index; the staged collection is small by design (drained on every read). A pruned or compacted document still answers with its latest entry. Additive: a new method on the store `createChangeLogStore` returns; nothing else changes. Tests: `tests/integration/change-log-latest-of.test.ts` (both sequencings: none, highest numbered with its cursor, tombstone, tenant identity, own-transaction visibility, staged before numbered without numbering).

FLOW OCC (G-A1-1): the alerts record feed's `lastScope` reads `changes.latestOf(RECORD_STREAM_SCOPE, docId)` and drops the `streamStaged` and `streamEntries` repositories it built over the feed's models (`apps/server/src/modules/alerts/alerts.records.ts`, `alerts.models.ts`; its record entries are untenanted, so no `tenantId` is passed).

#### Fixed — lock adapter: `acquiredAt` now belongs to the current holder

`createMongoLockAdapter().tryAcquire` took over an expired lease with `$set: { holder, expiresAt }` and `$setOnInsert: { acquiredAt }`, so after a takeover the row (and `inspect().acquiredAt`) still carried the FIRST holder's time. Now one atomic update pipeline stamps `acquiredAt` with the acquire time (on the injected `nowFn` clock) on a fresh acquire and on a takeover by a different holder, and keeps it on a renewal by the same holder. `expiresAt` is unchanged. A failed acquire writes nothing. Holder ids are written via `$literal`, so an id starting with `$` is stored as given. Backward compatible: same-holder renewals behave as before (repo-core lock conformance passes). Tests: `tests/integration/lock-adapter.test.ts` ("acquiredAt tracks the current holder": fresh, renew-keeps, takeover-resets, contended, `$` holder).

FLOW OCC (G-MON-4b): the console can read "master since" from the sound-master lease's `inspect().acquiredAt` and drop its own `masterSince` record on the presence row.

#### Fixed — change log deferred sequencer: a crash mid-pass stalled numbering for 30 s

Under `sequencing: 'deferred'` the sequencer lease was a fixed 30 s taken on the process clock and never renewed, so a process that died during a pass stopped numbering for every reader for up to 30 s. Now:

- `createChangeLogModels(connection, { sequencing: 'deferred', sequencerLeaseMs })` sets the lease (integer ms, at least 100; default `DEFAULT_SEQUENCER_LEASE_MS` = 5,000, exported from `@classytic/mongokit/sync`). The models object carries it as `sequencerLeaseMs`; a hand-built models object without it gets the default.
- The holder renews the lease with every batch it commits, so the lease bounds one batch (about four round trips), not one pass, and a dead holder delays numbering by at most one lease.
- Expiry is judged on the database clock (`$$NOW`), so clock skew between processes does not stretch or shorten it.
- Fencing: each batch (insert into the feed, counter raise and lease renewal gated on the pass's token, delete of the staged rows) commits in ONE transaction. A holder that wakes after a takeover aborts and writes nothing, including where no unique key would have stopped it (an entry already compacted away). A crash no longer leaves a half batch. On a deployment without transactions (standalone) the batch runs unfenced, as before.
- A standalone `append` (outside a transaction) waits up to the lease plus 1 s for its cursor, instead of a fixed 50 x 20 ms, so it outlasts a lease left by a crashed holder instead of throwing "a sequencer lease is stuck".

Cost: one extra round trip per batch (the commit). Additive: the default `'in-transaction'` sequencing is unchanged. Tests: `tests/integration/change-log-sequencer-lease.test.ts` (crash and takeover within one lease, fenced stale holder, per-batch renewal against a racing reader, standalone append across a dead lease). Not in this change: an injected clock for `at`, and an `onSequenced` hook to wake readers that lost the lease race (G-PB06-1 follow-ups).

#### Fixed — `createMongoUsageStore` lost counts on a brand-new collection

Writes ran before Mongoose's `init()` had built the unique `(actor, period, kind)` index. Concurrent first upserts then inserted duplicate cells instead of failing with E11000, and `summary()` read only one of them. In a reproduction, 50 concurrent increments counted as 1. The duplicates then also make the unique index build fail. Writes now wait for `model.init()`, and `summary()` sums cells. With `autoIndex` off, the index is still built by the operator's `syncIndexes` step.

#### Fixed — `claim` / `claimVersion` with a Filter IR `where` transitioned the wrong row

The `where` guard was spread raw into the CAS match, so `isFilter` read the merged object as IR and compiled the guard ALONE — dropping the `_id` and state (or version) match. `claim(id, …, { where: ne('paused', true) })` transitioned whichever row matched the guard first, from any state. The IR guard is now compiled and ANDed with the id + state match; a plain Mongo record is unchanged. Pinned by repo-core's conformance claim cases.

#### Security — `multiTenantPlugin` now scopes `searchSimilar`

`vectorPlugin`'s `searchSimilar` (`@classytic/mongokit/ai`) bypassed the tenant plugin, so a repo with both could return other tenants' documents from vector search. It now fires `before:searchSimilar`. The tenant clause is merged into `$vectorSearch.filter` as a pre-filter, so top-K is ranked inside the tenant. It is never a post-`$match`. The call honours `bypassTenant`, `skipWhen`, `skipOperations`, `resolveContext`, `allowDataInjection` and `onMismatch` like every other read.

**Behaviour change (fail-closed):** with `required: true`, a call with no tenant in context now throws `Missing '<contextKey>' in context for 'searchSimilar'`. A tenant in `filter` alone does not count unless `allowDataInjection: true` is set. Pass it as a context key: `searchSimilar({ query, organizationId })`. Atlas rejects filters on undeclared paths, so the vector index must declare `{ type: 'filter', path: '<tenantField>' }`.

#### Fixed — `leasePlugin` revived rows in any status and dropped a caller `$or`

`lease()` treated any row with `leaseExpiresAt < now` as a dead lease, whatever its status, so a cancelled or terminal row that still carried a stale expiry was re-leased and set back to `processingStatus`. The dead-lease arm is now `{ status: <deadLeaseStatuses>, leaseExpiresAt < now }`, default `[processingStatus]`. The claim condition also used to be written to the top-level `$or`, overwriting a caller filter's own `$or`; it is now ANDed through `$and` and the caller filter is kept as given (plain keys stay top-level, so tenant and soft-delete scoping are unchanged).

**Behaviour change / migration:** a row in a status other than `processingStatus` with an expired lease is no longer recovered. Rows that must be recoverable have to sit in `processingStatus` (what `lease()` writes), or pass `leasePlugin({ deadLeaseStatuses: ['processing', 'retrying'] })` to name the extra statuses. `extend()` now validates `leasedBy` like `lease()` and `release()` (400 on an empty value). `extend()` and `release()` now also require the row to still be in `processingStatus`: a row the host moved out mid-lease (e.g. cancelled without clearing the lease fields) returns `null` instead of being kept alive or overwritten with `doneStatus`. A caller `filter.$and` that is not an array is now a 400 instead of being silently replaced.

#### Added — `leasePlugin` clock, attempts and pending filter

- `nowFn?: () => Date` plugin option and a per-call `now?: Date` on `lease`, `extend` and `release`. One reading drives both the CAS comparison and the new expiry; per-call wins; an invalid Date is a 400.
- `attemptsField?: string`: every successful `lease()` (first claim and recovery) applies `$inc: { [attemptsField]: 1 }`.
- `maxAttempts?: number` (requires `attemptsField`, throws at construction otherwise): rows with the counter `>= maxAttempts` are not leased; rows missing the field are. Exhausted rows stay where they are until `reapExhausted()` (below) moves them.
- `pendingFilter` (plugin option or per-call, per-call replaces): ANDed into the pending arm only, so a dead lease is still recovered. The object form is static; for a time-relative predicate pass the function form `(now) => ({ dueAt: { $lte: now } })`, called per claim with the resolved `now` (per-call `now`, else `nowFn()`). Type `LeasePendingFilter`.
- Documented: `leasedBy` is the fencing token, so make it unique per claim (`${instanceId}:${randomUUID()}`).
- sqlitekit's `leasePlugin` has the same options and semantics (sqlitekit [Unreleased]), with three storage differences: its clock returns the column's representation (ISO string or epoch ms, not a `Date`); a caller filter record cannot carry `$or` / `$and` (pass Filter IR such as `or(...)`, kept as given); and validation errors are plain `Error`s, not HTTP 400s.

#### Added — `applyTransition` `priorAt` / `historyExtra`

- `priorAt?: Date` adds `durationInPriorMs: max(0, occurredAt - priorAt)` to the history entry (the field primitives' `appendStatus` writes) with no pre-read. Pair it with a `where` such as `{ updatedAt: current.updatedAt }`, or pass `options.target`, so a write after the caller's read makes the claim miss.
- `historyExtra?: Record<string, unknown>` merges extra fields into the entry. Reserved keys (`status`, `occurredAt`, `by`, `note`, `durationInPriorMs`) are a 400 (`TRANSITION_HISTORY_RESERVED_KEY`).
- Either with `history: false` is a 400 (`TRANSITION_HISTORY_DISABLED`); an invalid `priorAt` is a 400 (`TRANSITION_INVALID_PRIOR_AT`), as is an invalid `at` alongside `priorAt` (`TRANSITION_INVALID_AT`) and a `historyExtra` that is not a plain object (`TRANSITION_INVALID_HISTORY_EXTRA`).
- `options.target` is now typed on `applyTransition` and forwarded to `claim()` (it already passed through at runtime).
- Without the new args the history entry is unchanged: `{ status, occurredAt, by?, note? }`.

#### Added — `createSequenceCounter({ connection?, collection? })`

The atomic counter API bound to a connection and a host-named collection (for apps with a collection-prefix rule), with an optional session on every call: `next(key, increment?, session?)`, `read(key, session?)`, `ensureAtLeast(key, floor, session?)`. `getNextSequence`, `readSequence` and `ensureSequenceAtLeast` keep using `_mongokit_counters`; `readSequence` and `ensureSequenceAtLeast` gain an optional trailing `session` (additive). `sequentialId` and `dateSequentialId` take `counterCollection?: string` so `customIdPlugin` ids can use the same host-named collection.

#### Added — `createMongoDailyLedger` and a lock-adapter clock (`@classytic/mongokit/lock`)

- `createMongoDailyLedger({ connection?, collectionName?, modelName?, nowFn?, session? })` structurally implements arc's `DailyLedger` (`createDailyGate`, `ScheduleDefinition.daily`): one row per `(key, civilDate)`, exactly one replica wins `claimDay`, an uncompleted claim older than `info.staleAfterMs` is re-granted, a completed day never is, `releaseDay` drops only an uncompleted claim. Plus `inspect(key, civilDate)`. `civilDate` must be `YYYY-MM-DD`; `staleAfterMs` must be a finite number `>= 0`.
  - Fenced: each instance remembers the `claimedAt` it won, and `completeDay` / `releaseDay` only touch the row while it still carries that claim, so a replica whose run outlived `staleAfterMs` cannot delete or complete the claim another replica re-granted. A ledger holding no claim for the row: `releaseDay` is a no-op, `completeDay` completes the uncompleted claim (admin completion).
  - The `session` getter applies to `completeDay`, `releaseDay` and `inspect` only; `claimDay` never runs in a session (a losing claim's E11000 would abort the surrounding transaction).
- `createMongoLockAdapter({ nowFn })`: injectable clock for `tryAcquire` and `inspect`. Default unchanged (`new Date()`). The TTL index on `expiresAt` deletes by server time, so in production `nowFn` must track wall-clock time; skewed clocks are for tests.

#### Fixed — `createOutboxRepository` clamped every relay claim window to 100 rows (G-PLAT-1)

The repository was built with the generic pagination default (`maxLimit: 100`), so arc's `repositoryAsOutboxStore` candidate read `getAll({ limit: batchSize })` was silently capped: a relay configured for `batchSize: 500` claimed 100, saw "fewer than batchSize" and stopped its multi-pass drain after one pass. The outbox repository now defaults to `maxLimit: 0` (the caller's `limit` is the bound; a read with no `limit` still gets `defaultLimit`), and takes `pagination?: PaginationConfig` (type `OutboxRepositoryOptions`) to set a ceiling.

**Behaviour change / migration:** an outbox read with an explicit `limit` above 100 now returns that many rows. If you list the outbox to a client with a client-chosen limit, bound it there or pass `pagination: { maxLimit }`. Apps that capped `batchSize` at 100 to work around this (OCC `OUTBOX_MAX_BATCH` in `platform.module.ts`, removal ticket PLAT-1) can raise it.

#### Added — `leasePlugin` `exhaustedStatus`, `exhaustedAtField` and `reapExhausted()` (G-PHASEB-3)

With `maxAttempts` alone an exhausted row stayed in the processing status forever, never leased and never surfaced. `leasePlugin({ attemptsField, maxAttempts, exhaustedStatus: 'failed', exhaustedAtField: 'failedAt' })` plus `repo.reapExhausted({ now?, limit?, filter?, status?, pendingFilter?, options? })` moves every row at the cap whose lease lapsed (or that sits pending and passes `pendingFilter`) to the terminal status by compare-and-set, clears the lease fields, stamps `exhaustedAtField`, and returns the moved rows: each exactly once, even with concurrent reapers. A live lease and a row under the cap are left alone. It runs through the hook pipeline (tenant scoping applies). `limit` default 100: call it again until it returns `[]` (a short batch can mean a concurrent reaper moved some of the rows read, not that none are left). `exhaustedStatus` must differ from the pending, processing and dead-lease statuses and requires `maxAttempts`; `exhaustedAtField` requires `maxAttempts` (both checked at construction). Without these options nothing changes.

**Migration:** delete the app sweep that found exhausted rows and CAS-moved them (OCC `strandFailed()` in `apps/server/src/modules/alerts/alerts.service.ts`, removal ticket PHASEB-3); schedule `reapExhausted()` and audit what it returns.

#### Added — `prune(before)` and a compaction horizon on the Mongo `ChangeLogStore` (G-ALERTS-5)

`createChangeLogStore(...)` now implements repo-core's optional `ChangeLogStore.prune(before): Promise<string>`. It deletes entries with `at < before` that a later entry of the same `(tenantId, scope, docId)` replaced (each document's latest entry stays, tombstone or not). Before deleting, it records the horizon (the highest deleted cursor, never lowered) per `(tenantId, scope)` in a new `<collection>_horizon` collection (one row per pair, `tenantId: null` for untenanted entries, unique index `tenant_scope_horizon` plus `scope_horizon`; `createChangeLogModels` returns it as `horizons`) and feed-wide on the counter document, then returns the feed-wide one (`''` while nothing was ever pruned). `since(cursor, options)` with a cursor below the horizon of what that reader can see (its `tenantId`, `sharedScopes`, narrowed by `scopes`; the feed-wide horizon when unfiltered; `''` included) now throws repo-core's `CursorExpiredError(cursor, horizon)`, which arc's `createReplayHub` answers with `resync 'cursor_expired'`. Pruning tenant B never expires tenant A's cursor, a tenant with no entries reads `''` without throwing, and `latestCursor(options)` never answers below the reader's horizon, so a reader that resyncs from it always resumes (no resync livelock for quiet tenants or scopes). Also `horizon(options?)`, and `prune(before, { batchSize })`. Works under both `sequencing` modes. A new `{ at: 1 }` index (`feed_age`) serves the cutoff.

#### Fixed — `compactSuperseded()` treated tenants sharing a docId as one document

It grouped by `(scope, docId)`, so when two tenants used the same docId in one scope, one tenant's only (latest) entry was deleted as "superseded" by the other tenant's. It now groups by `(tenantId, scope, docId)`; an untenanted entry is its own document.

**Behaviour change:** `since()` makes one extra indexed read for the reader's horizon (the counter document when unfiltered, the `_horizon` rows otherwise), after the page read, so a concurrent prune is never missed. `latestCursor()` makes the same read. Nothing throws until `prune` has run. repo-core's `runChangeLogStoreConformance` has no prune cases yet (0.36.0); the store is pinned by `tests/integration/change-log-store-prune.test.ts`.

**Migration:** do not delete change-log rows by TTL or `deleteMany` by age (silent gaps); schedule `prune(new Date(Date.now() - 24 * 3600_000))` instead. OCC had no interim (no retention, removal ticket ALERTS-5): add the planned hourly `alerts.stream-prune` schedule.

#### Added — `explainCommands` and `assertQueryPlan({ commands })` (`@classytic/mongokit/testkit`) (G-M4-1)

`explainCommands(run, { connection, commands?, collections?, verbosity? })` runs `run` with command monitoring and returns `{ result, explains }`: the server's explain (default `executionStats`) of every command `run` actually sent, writes included (`findAndModify`, `update`, `delete`; explained, never re-run; a bulk update or delete is explained per statement). So a test can plan the filter, sort and update a plugin built (a `leasePlugin` claim) instead of a copy. It throws when nothing matched or a name cannot be explained. `assertQueryPlan` takes `commands?` to gate those writes too; its default (reads only) is unchanged. Types `ExplainCommandsOptions`, `ExplainedCommand`.

**Migration:** OCC `tests/acceptance/p1-alarm.story.test.ts` captures the claim through `mongoose.set('debug', fn)` and explains the copy (removal ticket M4-1): use `explainCommands(() => service.claim(...), { connection, commands: ['findAndModify'] })` and hand `explains[0].explain` to `assertIndexServed`, or use `assertQueryPlan({ commands: ['findAndModify'] })`.

### [3.43.1] - 2026-10-21

Narrow the Better Auth overlay context port to the table model names it consumes. New Better Auth field types no longer make otherwise compatible contexts fail type checking.

Peer floors to the latest published: `@classytic/repo-core >=0.31.1`, `mongoose >=9.11.2`.


### [3.34.0] - 2026-08-20

#### ⚠ BREAKING in a MINOR — Better Auth overlay writes are sealed

`createBetterAuthOverlay` now returns a READ-ONLY repository: writes throw
`ReadOnlyRepositoryError`, and under arc a resource mounting write routes over
it fails at BOOT. Reads are unchanged. The overlay always described itself as
"read-side" but returned a mutable repository, so generic CRUD could write
`user` / `session` / `account` / `member` rows bypassing Better Auth's hashing,
session revocation, org cascades, and plugin hooks. Shipped as a minor because
the old behaviour was a security hole, not a feature.

Route identity mutations through `auth.api`, disable the write routes, or — for
administrative repair only — pass `unsafeWritable: true`. Requires
`@classytic/repo-core` >=0.23.0. Full detail, including the capability-declaration
fixes, in [v3 history](./changelog/v3.md).

### [3.31.1] - 2026-08-10

#### Fixed — `lookupCoerce` was silently ignored on the pipeline branch

When `LookupOptions` included any of `select` / `pipeline` / `where`, `LookupBuilder` took the pipeline branch which hardcoded the raw field path in `let.lookupJoinVal`, overwriting the coercion. The join matched nothing and raised no error — exactly the failure `coerce` exists to prevent. The pipeline branch now passes `localCorrelation(localField, coerce)` for its `let` assignment. Also removed a duplicate `builder.coerce()` call in the simple branch.

### [3.31.0] - 2026-08-10

#### Added — timezone-aware `dateBucket` (`AggDateBucket.timezone`)

`compileDateBucket` previously hardcoded `'UTC'` on every `$dateTrunc` / `$dateToString` call, making business-day/month rollups wrong in any non-UTC deployment. The `timezone` field on `AggDateBucket` (from `@classytic/repo-core` 0.21.0) is now passed through. Mongo accepts any IANA zone on both operators natively; an unknown zone is caught at compile time (`assertValidTimeZone`) with a named-field error rather than a server-side failure attached to a random later request. `MONGOKIT_CAPABILITIES.dateBucketTimezone` declared `true`.

#### Added — `lookupCoerce` capability + `LookupOptions.coerce: 'objectId'`

A `$lookup` comparing a `string` field to an `ObjectId` `_id` matches nothing and raises no error — a join that always comes back empty is indistinguishable from "no matches". `LookupOptions.coerce: 'objectId'` wraps the local field in `$convert` (with `onError/onNull: null` so one bad value drops that row rather than failing the whole aggregation). `MongoRepoCapabilities.lookupCoerce: boolean` lets a host detect support before issuing the join. `LookupOptions.let` widened from `Record<string, string>` to `Record<string, unknown>` (expressions, not just field paths).

#### Added — `QueryParser.maxLimit` getter

Exposes the configured page-size cap so downstream layers (arc's `QueryResolver`, a resource adapter) can read it instead of applying their own default. Without it the lowest of three independent caps silently won — which is how a resource configured for 1000, a repository capped at 1000, and arc defaulting to 100 showed 100 of 696 rows with no signal.

#### Fixed — `buildQuerySchema` no longer emits `maximum` on the `limit` field

`QueryParser.parse` clamps an over-large limit rather than rejecting it. But the JSON Schema emitted by `buildQuerySchema` had `maximum: maxLimit`, which Fastify validated before the parser ran — so the clamp was unreachable and `?limit=200` became a hard 400. A 400 disguised as "no results" (because both UI callers swallowed the query error) was the actual symptom. The `maximum` is removed; the parser's clamp comment already documents the policy. Paired with the `PaginationEngine` warning below.

#### Added — `PaginationEngine` warns when a requested limit is clamped

A caller asking for 1000 and receiving 100 previously got an arbitrary slice with no signal. The engine now attaches a `warning` to the paginated result when clamping fires, naming the requested and effective limits and advising to filter server-side or sort deterministically. Deep-pagination warnings take precedence when both apply.

### [3.30.0] - 2026-08-05

#### Changed — dev toolchain now tests AHEAD of consumers, not behind them

mongokit's dev dependency on Mongoose was `^9.4.1`, resolving to **9.6.1**,
while every consumer ran 9.7.4–9.8.0. Deprecations therefore landed on
consumers before mongokit ever saw them: `Document.prototype.validateSync()`
was deprecated in Mongoose **9.7.0** and produced zero warnings across
mongokit's 2779 tests while order/pos/ledger were emitting it. Mongoose 9 does
not use `util.deprecate` — it calls
`process.emitWarning(msg, { code: 'MONGOOSE' })` (`lib/utils.js` → `utils.warn`),
a plain `Warning`, so `--trace-deprecation` shows nothing.

- **`mongoose` dev dependency `^9.4.1` → `^9.9.1`** (resolves 9.9.1, ahead of
  every consumer). Full suite green: 2779 passed / 178 files, zero
  `[MONGOOSE]` warnings.
- **`@classytic/repo-core` dev dependency `^0.19.0` → `^0.20.0`.**
- **`tsdown` `^0.22.5` → `^0.22.14`.** No config migration needed —
  `deps.neverBundle`, `publint: 'ci-only'` and `attw: 'ci-only'` are all still
  the current surface; emitted layout is unchanged.
- **Removed the `overrides` pin `mongodb`/`bson` → `7.2.0`.** Mongoose 9.9.1
  declares `mongodb: ~7.5`, so the override forced mongokit's own tests onto a
  driver its ODM does not support **while every consumer resolved 7.5** — the
  same dev/consumer drift one layer down, and undocumented. The `mongodb`
  dev dependency now tracks the ODM at `^7.5.0`. Suite green on 7.5.0.

#### Fixed — `getSchemaMetadata()` cast was resting on `Model.schema` being `any`

Mongoose **9.8.1** (`types(model): keep Model.schema typed when TSchema is
omitted`) started typing `Model.schema` properly. `MongooseAdapter.getSchemaMetadata()`
cast each path `as MongooseSchemaType`, which had been a silent no-op while the
source was `any` and became a `TS2352` once it was not. The cast is gone: the
three fields actually read (`instance`, `isRequired`, `options`) are present on
every Mongoose version, typed or `any`, so a narrow `Pick<…>` annotation needs
no cast at all. No behaviour change; no public-API change.

#### Fixed — `registerBetterAuthStubs({ exclude })` was silently inert

`ResolveBetterAuthCollectionsOptions.exclude` was added in `@classytic/repo-core`
**0.20.0**, but mongokit forwards it through a conditional spread
(`...(excluded.size ? { exclude } : {})`), which bypasses TypeScript's
excess-property check. Against repo-core 0.19.0 the option was accepted, dropped,
and the excluded collection registered anyway — so the very collision the option
exists to prevent (`registerBetterAuthStubs` racing `createBetterAuthOverlay` for
`user`) still happened, with no error anywhere.

- **`@classytic/repo-core` peer floor `>=0.19.0` → `>=0.20.0`** — the honest
  floor: `exclude` is reachable from mongokit's own source.

#### Added — guards, both falsified before shipping

- **`tests/_shared/no-mongoose-warnings.ts`** — wraps `process.emitWarning` in
  every test worker (unit, integration, e2e) and **fails the test** that emits
  any warning carrying `code: 'MONGOOSE'`, naming the message and the call site.
  The original emitter is always forwarded, so `--trace-warnings` is unaffected.
  The only opt-out is `ALLOWED_MONGOOSE_WARNINGS` — a named entry with a regex,
  a written reason and a date. There is no env var and no silent skip; the list
  is empty today. Falsified by reintroducing a `validateSync()` call and
  confirming the run fails.
- **`scripts/check-exports.mjs`** (`npm run check:exports`, wired into
  `lint:package` ahead of publint/attw) — asserts every `exports` /
  `main` / `module` / `types` target exists on disk and that at least one
  `types` target is declared. This exists because **`attw --pack` exits 0 when
  the package contains no types at all** — it prints "This package does not
  contain types" and reports success, so `ci` / `prepublishOnly` would have
  passed on a build that shipped zero `.d.mts` files. Falsified by moving
  `dist/` aside and confirming a non-zero exit.

#### Removed

- `schemaDateOracle` is no longer `export`ed from `src/filter/compile.ts`. It
  never reached any entrypoint (not in `dist/index.d.mts`, no importers), so
  this is **not** a public-API change — but `knip` flagged it and exited 1,
  which meant `npm run ci`, and therefore `prepublishOnly`, was already failing.

### [3.29.0] - 2026-07-29

#### Fixed — schema-aware casting for aggregation `$match` (ObjectId / Date columns)

`Model.aggregate()` receives no Mongoose find-time query casting: a string
bound against an `ObjectId`- or `Date`-typed column silently matches nothing
(BSON compares by type). This was invisible on `find`-family calls (Mongoose
casts there) but hit every aggregation — most critically the multi-tenant
preset, which resolves the tenant id off the auth scope as a STRING and
conjoins it as a `_policyFilters` entry; against an `ObjectId` tenant column
every aggregation returned zero rows while the equivalent list call worked.

- **`castFilterToSchema(filter, schema)`** (`src/filter/cast-schema.ts`) —
  walks a Filter IR or Mongo-shaped record and casts scalar values against the
  Mongoose `SchemaType.cast()` API for each path. Handles `$eq`/`$ne` and
  range operators as scalars; `$in`/`$nin` element-wise; recurses through
  `$and`/`$or`/`$nor`/`$not`. Deliberately non-throwing: a value that cannot
  cast is left untouched rather than raising (a `CastError` here would turn a
  previously-empty result into a 500 — the silent-empty behaviour is the
  correct regression-safe fallback).
- **`buildAggPipeline(req, schema?)`** — accepts an optional `Schema` and
  applies `castFilterToSchema` before the filter split, so the base-side
  `$match` stage and any joined filter both receive correctly-typed values.
  Schema is optional to keep the builder pure/testable without a Model.
- **`countAggGroups`** — applies the same cast on the direct `$match` paths
  (strategies 2 + 3 that bypass `buildAggPipeline`).
- **`executeAgg`** — passes `Model.schema` to `buildAggPipeline`.
- **`coerceFilterDates`** — `compile.ts`'s inline ISO-date coercion is replaced
  by `coerceFilterDates` from `@classytic/repo-core/filter` (0.19.0). One
  definition, one pattern; the URL boundary and compile boundary now agree.
  Peer floor updated: `@classytic/repo-core >= 0.19.0`.
- New integration tests: `aggregate-date-coercion.test.ts` (ISO-date strings
  on range operators through the aggregation path) and
  `aggregate-schema-cast.test.ts` (ObjectId string cast for tenant-id
  `$match`).

### [3.28.0] - 2026-07-24 (unpublished)

#### Fixed — keyset progression in both purge ports (soft/anonymize termination)

The purge ports (`createMongoPurgePort`, `createMongoPurgePortFromFilter`,
including the function-form anonymize path) now select `_id`-ascending with an
internal `_id > lastSeen` keyset cursor, satisfying repo-core 0.16.0's
mandatory `PurgePort` progression contract. Previously every chunk re-ran the
bare base predicate: `hard` self-advanced (deleted rows leave the match set),
but `soft`/`anonymize` mutate rows that STILL match, so a match set larger
than `batchSize` re-selected the same first chunk forever — callers had to
hand-add exclusion predicates (`deleted: { $ne: true }`) to terminate. The
cursor advances only after the chunk's write succeeds, so a retried chunk
re-selects the same rows (at-least-once, idempotent by outcome). The
narrowed-write base-filter re-assertion is unchanged.

- Peer floor: `@classytic/repo-core >= 0.16.0`.
- New `tests/integration/purge-conformance.test.ts` runs the shared
  `runPurgeConformance` suite against BOTH port shapes (16 scenarios).
- The old "resume-by-reselection" soft test now proves termination WITHOUT
  caller exclusion predicates; added a multi-batch anonymize sibling.

### [3.27.0] - 2026-07-24 (unpublished)

#### Added — `Repository.purgeByFilter(filter, strategy, options)`

Implements repo-core 0.15.0's `StandardRepo.purgeByFilter` — the range/
filter-scoped sibling of `purgeByField`. Composes the kit-agnostic
`runChunkedPurge` orchestrator with a new **`createMongoPurgePortFromFilter`**
port (`src/actions/purge.ts`): the same per-strategy chunk logic as the
equality-bound port, but the base predicate is an arbitrary compiled filter
(a `civilDate` window, a retention cutoff, a compound cohort) rather than
`{ [field]: value }`. The filter is compiled once via `compileFilterToMongo`
(Filter IR or Mongo-shaped record, the same dual-dialect rule as
`archiveByFilter`); the narrowed write re-asserts the full base filter on
`{ _id: { $in: ids }, ...filter }`, so a row that leaves the matching set
between the id-select and the write is spared. Routes through `deleteMany` /
`updateMany` (`bypassTenant: true`) so audit + cache plugins compose. Declares
`capabilities.purgeByFilter: true`. New integration suite
`tests/integration/purge-by-filter.test.ts` (12 tests): hard/soft/anonymize
(static + function) over a range, skip, tenant + soft-delete-plugin interplay,
chunking with resume-by-reselection, and the narrowed-write re-assertion.
Strictly additive — `purgeByField` and its port are untouched.

### [3.26.0] - 2026-07-24 (unpublished)

#### Added — `idempotencyStorePlugin()`: keyed exactly-once operation claims

The Stripe idempotency-key model as a repository primitive. FOUR stores in
the field hand-rolled the same `getOrCreate` + lease-CAS protocol (flow's
`MongoIdempotencyStore`, cart's idempotency repository, order's
`OrderIdempotencyRepository`, be-prod's refund-operation store); this plugin
standardises the superset:

- `claimKey(key, { leaseMs, seed })` — atomic claim decision matrix:
  `acquired` (fresh or stale-lease re-acquire, with prior `progress` for
  crash resume) / `completed(result)` + `failed(code)` terminal replay /
  `busy` (live peer — surfaces persisted progress + holder token so domain
  layers can act on completed pivots) / `exhausted` (bounded re-acquisition
  via `maxAttempts`).
- `saveClaimProgress` (lease-token-guarded pivot markers), `completeClaim`
  (stores the replayable result), `failClaim` (terminal failure replay),
  `releaseClaim` (pre-side-effect retry reset), `expireClaim`
  (ambiguous-error lease lapse for immediate sweep pickup).
- Pluggable field/status names — existing stores adopt WITHOUT a data
  migration. All steps route through `Repository` verbs (hooks fire).

Distinct from `leasePlugin` (FIFO *queue* claims) — this claims a *specific
deterministic key* exactly once. Guarantee boundary documented: exactly-once
execution CLAIM; make the external side effect idempotent on the same key to
close the last window (the Stripe model end-to-end).

### [3.25.0] - 2026-07-22

Production-hardening wave for the audit trail and query-parser boundaries
(external review findings — all seven confirmed and fixed), folded together
with the previously staged (unreleased) `aggregatePipeline` widening and
`toObjectId` utility at the end of this entry.

Added — **`auditTrailPlugin({ mode: 'transactional' })`**. The audit insert is
awaited inside the operation and joins the operation's `session` when one is
present: inside `withTransaction` the business write and its audit entry
commit or roll back **atomically**, and a failed audit insert fails the
operation (after `onWriteError`). Atomicity requires an actual transaction —
without one the mode still guarantees "no success without an audit entry",
but an audit failure rejects after the business write has committed. The
default stays `'best-effort'` (fire-and-forget) — now honestly documented as
observability-grade, not a compliance ledger. `'transactional'` on a
`hooks: 'sync'` repository throws at registration (after-hooks there are
fire-and-forget, the guarantee cannot be honored). For durable *asynchronous*
auditing, write an outbox entry in the same transaction
(`@classytic/primitives/outbox`) and relay it separately.

Added — **`ensureAuditTrailReady({ connection?, collectionName?, ttlDays? })`**.
Boot-time helper that creates the audit collection and builds its indexes
before traffic begins — lazy creation inside the first transaction forces
MongoDB catalog locks and transient transaction retries. Idempotent; call it
once after registering the plugin, especially with `mode: 'transactional'`.

Added — **`auditTrailPlugin({ connection })` + `AuditTrailQuery({ connection })`**.
Audit models now register on the connection you pass (default:
`mongoose.connection`), matching the lock/usage stores. Apps using
`mongoose.createConnection()` previously had audit entries silently land in
the default connection's database. The model cache is per-connection
(WeakMap), so equal collection names on different connections no longer
collide.

Changed — **deterministic audit TTL**. `getAuditModel`'s cache previously kept
whichever `ttlDays` the *first* caller passed and silently ignored later
values. Retention is now collection-level configuration: for the writing
plugin, a conflicting `ttlDays` (including TTL vs no-TTL) for the same
collection on the same connection **throws at registration**. Readers
(`AuditTrailQuery`, `ensureAuditTrailReady`) that omit `ttlDays` reuse
whatever retention the plugin configured — querying history doesn't require
knowing it; an explicitly passed value is still conflict-checked.
Pre-existing compiled models (hot reload) are introspected via their schema
indexes before reuse. Changing retention on a live collection is an index
migration, deliberately outside the plugin.

Fixed — **pre-update audit snapshot honors repository semantics**. The
before-update snapshot used `Model.findById(context.id)`, which bypassed the
configured `idField` (an `idField: 'slug'` repo produced NO change-diff),
ignored the operation's policy filters (`context.query`), and read outside the
transaction session. It now queries `{ [idField]: id, ...context.query }` with
the operation's session — same document the update touches, correct in-tx
state.

⚠ Breaking — **`QueryParser` is fail-closed by default:
`invalidInput: 'throw'`**. Blocked operators, disallowed filter/sort fields,
over-deep filters, malformed operator values, blocked lookup
collections/stages, dangerous populate paths, unparseable `between` ranges,
and pathological `regex` patterns now raise HTTP 400
(`code: 'INVALID_QUERY_INPUT'`) instead of being warn-dropped — because
dropping the only supplied filter silently broadens the query to every record
in tenant scope. Literal-semantics input (`search` terms, `like`/`contains`)
still escapes rather than rejects — `?search=c++` never 400s — and limit
capping remains clamping, not an error. Pass `invalidInput: 'drop'` to keep
the legacy warn-and-drop behavior for trusted migration/compat tooling.

Changed — **QueryParser split into focused modules** (`src/query/parser/`):
filter compiler, regex safety, pipeline sanitizer, lookup, aggregation,
populate, sort/select, search, schema-docs, and a shared runtime carrying the
`invalidInput` policy. `QueryParser` itself is now a thin facade (~330 lines,
was ~2,000) with an unchanged public API.

Changed — **`src/types.ts` (1,700 lines) split into domain modules** —
`types/core`, `types/type-utils`, `types/pagination`, `types/operations`,
`types/repository`, `types/plugin-options`. No compatibility barrel: the old
`types.ts` is deleted and every internal import points at the owning module.
The package surface (`@classytic/mongokit` root export) is unchanged.

Changed — **`lookupPopulate` pipeline math extracted** to
`src/repository/lookup-populate.ts` (`buildLookupProjection`,
`appendLookupStages`, cursor-field projection guard) — pure, unit-testable
functions; the facade method keeps orchestration. The remaining large
orchestrators (`claim`/`applyTransition`/`watch`/`getAll`) deliberately stay
on the class: they compose hooks + middleware + resilience, where extraction
would add callback-threading indirection, not modularity.

Fixed — **flat `field[between]=a,b` produced a bogus `$between` operator**.
The flat operator-syntax path never routed `between` to the range expander (only
the nested bracket path did), shipping `{ field: { $between: '…' } }` to
MongoDB. Both paths now expand correctly; an unparseable `between` value drops
the filter entirely (previously it emitted `{ field: {} }` — an equality match
against the literal empty object) or 400s in `'throw'` mode.

Removed — **framework controller contracts** (`IController`,
`IControllerResponse`, `IRequestContext`, `IResponseFormatter`), the
`examples/{api,express,fastify,nextjs}` controller example set, and the
positional `AuditTrailQuery(collectionName, ttlDays)` constructor (options
object only). Mongokit is a database kit — HTTP/controller vocabulary is owned
by `@classytic/arc` (`defineResource()`). Clean break, no deprecation shims.

Changed — **CI now runs the full release gate**. New canonical `npm run ci`
(biome check → src typecheck → tests/conformance typecheck → build → publint +
attw → knip → unit + integration tests) used by both `prepublishOnly` and
GitHub Actions — previously CI skipped lint, `typecheck:tests`, publint/attw,
and knip, so contract drift could merge green.

Changed — **TypeScript pinned to stable `~5.9.0`** (was the experimental
`^7.0.2` native preview, whose API tsdown explicitly warns is unstable —
declaration-build risk on a published library).

Changed — **`aggregatePipeline` accepts `readonly unknown[]` pipelines** (additive widening).

`Repository.aggregatePipeline<TResult>(pipeline, options?)` now types its
pipeline parameter as `PipelineStage[] | readonly unknown[]` (was
`PipelineStage[]` only). Real-world stage arrays are assembled from exported
fragment builders and spreads (`[...profitRollupStages(...)]`) whose element
type degrades to `unknown` — mongoose's `PipelineStage` union could not be
satisfied without an `as unknown as` at every such call site, and structural
repo ports declaring `aggregatePipeline(pipeline: unknown[])` (e.g.
arc-order's `OrderAnalyticsRepoLike`) failed strict contravariant parameter
checks against the old signature.

- Literal arrays still get full `PipelineStage` contextual checking through
  the first union member; runtime validation remains MongoDB's job.
- The single documented narrowing to mongoose's stage union now lives inside
  the method (spine PACKAGE_RULES §7.1 residual-`as` budget) instead of N
  host-side casts.
- Purely additive: every existing caller compiles unchanged; no runtime
  change. `aggregatePipelinePaginate` is untouched (its pipeline arrives via
  a typed options bag, which no known consumer needs widened).

Added — **`toObjectId` in `./utils`** (null-tolerant `string → ObjectId | null`
coercion, exported alongside the id-resolution primitives). The single seam
for optional reference/audit-stamp fields (`approvedBy`, `submittedBy`, …)
where an absent actor is a legitimate `null`; invalid non-empty strings still
throw via mongoose's constructor. Hosts hand-rolled this identically at every
approval-hook write site — import it instead.

### [3.24.0] - 2026-07-19

Fix — **ESR-aware keyset index compatibility checker** (`PaginationEngine` + `index-hint`).

The keyset pagination warning previously required ALL filter fields — including
range predicates (`$ne`, `$elemMatch`, `$gt`, `$regex`, `$exists`, …) — to
appear in the leading index prefix, which violated MongoDB's ESR (Equality →
Sort → Range) rule and caused two problems:

1. **False-positive warnings** for correctly-indexed queries whose range fields
   legitimately trail the sort keys (the optimal ESR shape). The Streamline
   scheduler (`status + workflowId` equality, `paused: { $ne: true }` range,
   `updatedAt` sort) was the concrete trigger.
2. **Wrong index recommendations**: the old message suggested wedging the range
   field into the equality prefix, which would strand the selective equality
   fields behind it and degrade planner performance.

Changes:
- **`classifyFilterFields(filters)`** (new export from `pagination/utils/index-hint`) —
  splits top-level filter fields into `equality` (`$eq`, `$in`, scalars, embedded
  docs) and `range` (all other operators). `$all` is intentionally in the range
  bucket: multikey data prevents the planner from using a multikey-prefix compound
  index to serve a subsequent sort, so leading with `$all` is unsafe.
- **`PaginationEngine`** — the compatibility check now accepts an index that leads
  with the equality fields + sort keys, even when range predicates are residuals
  (the ESR-correct shape). Purely additive: the change can only silence warnings,
  never add new ones.
- **Recommended index format** changed from `filter → sort` to
  `equality → sort → range` — the correct ESR order.
- Four new test cases covering: `classifyFilterFields` classification rules
  (including `$all`-as-range regression), no-warning on a good ESR index,
  no-warning when all filters are ranges and a sort-only index exists, and
  correct ESR recommendation when no index is declared.

### [3.23.0] - 2026-07-18

Feature — **`MongooseAdapter.matchesFilter`** (the `DataAdapter.matchesFilter`
seam). Hosts can now validate an already-fetched document against Mongo-shaped
policy filters IN PROCESS, without a DB round-trip.

- The adapter exposes `matchesFilter` as an arrow field (keeps its binding when
  passed by reference) that delegates to repo-core's **canonical**
  `matchesRecordFilter` (repo-core ≥0.14.0) — the SINGLE shared implementation
  across every kit (no per-kit matcher, one contract, one Filter IR). repo-core's
  evaluator is id-coercion aware, so a Mongo `ObjectId` `_id` matches its string
  form. **Impact for arc ≥2.22**: unblocks the realtime change feed and
  in-process access validation for operator-shaped filters — a `requireGrant`
  list-resolution subscriber (`{ $or: [{ ownerId }, { _id: { $in } }] }`) now
  streams correctly instead of hitting the fail-closed 501.
- The `@classytic/repo-core` peer floor is now `>=0.14.0` (raised from 0.13)
  and aligned with the dev dependency. The existing open-ended Mongoose peer
  range remains `>=9.4.1`.
- Added `MONGOKIT_PLUGIN_NAMES`, `MongoKitPluginName`, and the extensible
  `RepositoryPluginName` type. `requirePlugins` now provides autocomplete for
  bundled identifiers while continuing to accept third-party plugin names.
  Its documentation now uses the real `multi-tenant` runtime identifier.
- Refreshed the lockfile from vulnerable `fast-uri@3.1.0` to `3.1.3`; `npm
  audit` now reports zero known vulnerabilities.

### [3.22.2] - 2026-07-18

Fix — **scalar `from === to` must hit the table** (payee's already-verified
rejection test caught 3.22.1's over-broad re-claim exemption).

- 3.22.1 exempted ANY from-member equal to `to` from machine assertion —
  including SCALAR `from`, silently legalizing `X → X` everywhere (verify an
  already-verified payout method resolved instead of rejecting). The re-claim
  exemption now applies ONLY to MULTI-SOURCE arrays, where including `to` is
  an explicit opt-in (revenue's re-match). Scalar `from === to` asserts
  normally and throws the machine's error. Race-loss diagnosis keeps the
  `current === to` exemption (a where-guard miss on a row already AT the
  target is a retryable 409, not a `to → to` table error).

### [3.22.1] - 2026-07-18

Fix — **`applyTransition()` re-claim semantics** (aligns with `claim()`'s own
documented contract).

- A from-array member EQUAL to `to` is an idempotent RE-CLAIM ("touch with
  state assertion" — `claim()` documents `from === to` exactly so), not a
  transition: transition tables never contain `X → X`, so asserting such a
  member against the machine wrongly rejected the documented multi-source
  re-entry idiom (revenue's `matched → matched` re-match, flow's
  reverse-mark stamp). Pre-flight now skips table assertion for
  same-as-target members (the CAS filter still pins them); race-loss
  diagnosis likewise exempts `current === to` (the row is already AT the
  target, so the miss was a `where`-guard failure → retryable 409, never a
  bogus `to → to` table rejection). Strictly permissive: nothing that
  passed before behaves differently.

### [3.22.0] - 2026-07-18

Feature — **`Repository.applyTransition()` + `toPlain()`**

> Named `applyTransition` (not `transition`) deliberately: `transition` is a
> natural DOMAIN verb name and was already a public repository method in
> `@classytic/order` (and a private helper in flow) — a base-class method with
> that name breaks subclass assignability on upgrade. Platform primitives must
> not squat on likely domain-verb names.: the two domain-verb
primitives every engine package hand-rolled, promoted into the kit.

- **`repo.applyTransition(id, machine, { from, to, set, push, where, by, note,
  history, at }, options)`** — state-machine-backed CAS with status history,
  replacing the ~40-line `claimTransition` helper copied across projects /
  manufacturing / assets. Legality pre-flight via the machine (which throws
  the DOMAIN's typed error), CAS via `claim()` (multi-source `$in`, `where`
  guards, full plugin routing), `$push`ed history entry (default
  `statusHistory`, custom field or `history: false`), and — new capability,
  not just consolidation — **accurate race-loss diagnosis**: on CAS miss it
  re-reads the row and throws the machine's error built from the row's
  CURRENT state (hand-rolled versions threw with the caller's stale
  pre-read), 404 `TRANSITION_TARGET_MISSING` when the row vanished, or 409
  `TRANSITION_RACE_LOST` when the move is still legal (caller may retry).
  The `machine` param is the STRUCTURAL `TransitionMachine` interface
  (`{ name, assertTransition }`) — `defineStateMachine()` from
  `@classytic/primitives/state-machine` satisfies it as-is; mongokit takes
  no primitives dependency (same policy as the arc event-shape mirror).
- **`immutableStatesPlugin({ states, field?, internalFlag?, tenantField?,
  allowClaim?, errorFactory? })`** — LIFECYCLE immutability ("posted journal
  entries are frozen"), promoted from ledger's battle-tested
  `immutableGuardPlugin`. Distinct from `appendOnlyPlugin` (whole-collection
  facts) and deliberately not merged with it. Per-op strategies: id-shaped
  ops state-lookup via raw Model; `findOneAndUpdate` pre-reads its match;
  `updateMany`/`deleteMany` refuse when ANY frozen row is in the blast
  radius (`$and`-merged exists-probe — never a silent `$nin` filter);
  `bulkWrite` refused unless internal-flagged; `claim` analyzed zero-IO on
  the state field (CAS `from` pins the pre-state) with an `allowClaim`
  fingerprint exemption (ledger's reverse-mark), and **different-field
  claims fall back to the id lookup — closing a hole the hand-rolled
  predecessor had** (a claim on another field could mutate a frozen row).
  Boot-time `OP_REGISTRY` sweep throws on any mutating op the plugin has no
  strategy for — future write ops can never ship silently unfenced. TOCTOU
  semantics documented honestly: defense-in-depth, not the concurrency
  mechanism (legal transitions ride `claim`/`transition()`).
- **`appendOnlyPlugin({ allow? })`** — immutable-facts fence for event-ledger
  collections (flow `StockEvent`, manufacturing `ProductionEvent`, audit
  sinks). Coverage derived from `OP_REGISTRY`: inserts (`create`/`createMany`)
  land; every other mutating op — including `claim`, `claimVersion`,
  `restore`, `bulkWrite`, and ops added later — is refused at POLICY priority
  with 405 `APPEND_ONLY_VIOLATION`. Grep-proof vs hand-fenced method
  overrides. Escape hatches are deliberate and audited
  (`after:append-only-bypass`): plugin-level `allow: ['deleteMany']` for a
  domain's one legitimate mutation path (GDPR erasure), per-call
  `bypassAppendOnly: true` for maintenance. `skipPlugins` is ignored — same
  policy as tenant scope and soft delete.
- **`toPlain(value)`** (root + `/utils`) — spread-safety for hydrated
  (sub)documents. `{ ...subdoc }` spreads Mongoose internals, not schema
  fields; the rebuilt lines then persist as garbage because
  `findOneAndUpdate` skips validators. This footgun has bitten every
  package that maps over embedded arrays (projects, manufacturing). Rule:
  any `{ ...subdoc }` in a repository verb goes through `toPlain` first.

Fix — **peer tree no longer breaks consumer installs** (ERESOLVE via better-auth's svelte graph).

- **Removed `better-auth` and `mongodb-memory-server` from `peerDependencies`**
  (and the now-empty `peerDependenciesMeta`). Neither is imported at runtime
  anywhere in `src`: the `/better-auth` overlay types its `auth` param with a
  local structural `BetterAuthInstance` interface (it reads `$context.tables`,
  never better-auth's own types), and `/testkit` imports mongodb-memory-server
  as `import type` only. Even as *optional* peers, npm's resolver walks their
  speculative dependency graphs — better-auth's optional `@sveltejs/kit` peer
  demands vite 8, which hard-conflicts with any consumer on vitest 3 (vite 7)
  and fails the install with ERESOLVE unless `--legacy-peer-deps` is forced.
  Declaring peers that no code requires bought version-checking for nobody and
  broke installs for everybody.
- Consumers of the `/better-auth` subpath need better-auth installed anyway
  (they're wiring a Better Auth instance); consumers of `/testkit` have
  mongodb-memory-server by definition. Nothing changes for them except the
  install works again.

### [3.21.0] - 2026-07-13

Feature — `MongooseAdapter` defaults to `buildCrudSchemasFromModel` (correct-by-default).

- **`schemaGenerator` option now defaults to mongokit's own `buildCrudSchemasFromModel`**
  when omitted. Previously, omitting the option silently produced `null` OpenAPI bodies
  and empty MCP tool schemas — an audit of a 68-resource production host found 28 adapters
  that hit this. Correct-by-default closes the failure class.
- **Explicit opt-out**: pass `schemaGenerator: false` to restore the old `null`-returning
  behaviour for adapters that deliberately skip schema generation.
- One test updated: "returns null when no schemaGenerator" → two tests: "defaults to
  `buildCrudSchemasFromModel` when omitted" + "returns null when `false`".

### [3.20.0] - 2026-07-13

Feature — `getByIds` batch point-read + `archiveByFilter` (repo-core 0.8
data-lifecycle contract) + adapter `close()`. TypeScript 7 toolchain.

- **Added `repo.getByIds(ids, options)`** — the `$in` counterpart to
  `getById`: fetches every doc whose id is in `ids` in ONE query, routed
  through `findAll` so tenant + soft-delete scoping and hooks apply exactly
  as a single read would. Returns a `Map` keyed by the stringified id;
  inputs are de-duplicated, misses are simply absent, and **structurally
  invalid ids are dropped** (one malformed id never poisons the batch —
  mirrors `getById`'s null-on-miss). Validation is id-FIELD-aware:
  `getSchemaIdType` gained an optional `field` param so custom-`idField`
  repos with String/UUID keys aren't over-filtered by an ObjectId-only
  check; per-call `options.idField` override matches `getById`. Implements
  the optional `StandardRepo.getByIds` contract member added in repo-core
  0.9 — the conformance gate now pins the signature per-method.
- **Added `MongooseAdapter.close()`** — documented no-op (mongokit's `watch()`/`cursor()` resources release via their own `AbortSignal`/end-of-iteration), provided for uniform `adapter.close()` teardown across every kit. Per the `DataAdapter.close` ownership rule it never closes the mongoose connection; the host owns that.

- **Added `repo.archiveByFilter(filter, sink, options)`** — chunked
  cold-storage extraction via repo-core's `runChunkedArchive` +
  `createMongoArchivePort` (`actions/archive.ts`): `_id`-ordered lean reads
  (plugin-bypass — the caller's filter is the authoritative predicate),
  plugin-routed `deleteMany` removal (`bypassTenant`, `mode: 'hard'` —
  audit/cache fire), write-before-delete, at-least-once. Accepts Filter IR
  or Mongo-shaped filters (compiled once via `compileFilterToMongo`).
  Capability `archiveByFilter: true`; sinks must be duplicate-tolerant.
- Existing `cursor()` now satisfies the `StandardRepo.cursor` declaration
  added in repo-core 0.8; the new capability-gated conformance scenarios
  (archive + streaming) pass unchanged. Peers: `@classytic/repo-core >=0.8.0`
  (unchanged floor — verified: the built package typechecks against a host
  pinned to repo-core 0.8.1; only the devDep moved to ^0.9.0 for the
  conformance gate).
- **Toolchain: TypeScript 7.0.2 (Go-native) + tsdown 0.22.5.** No consumer
  impact — dist output is unchanged and was verified by typechecking a
  consumer of the packed tarball under BOTH TypeScript 6.0.3 and 7.0.2
  (StandardRepo/MinimalRepo conformance + adapter factory boundaries).
- **Release gate: `lint:package`** (`publint` + `attw --profile esm-only`)
  now runs in `prepublishOnly` — package-shape regressions fail locally at
  publish time instead of only in CI.

### [3.19.0] - 2026-07-07

Feature release — a batteries-included test harness subpath.

- **Added `@classytic/mongokit/testkit`** — an in-memory MongoDB test harness
  for testing repositories. Spins an ephemeral MongoDB (standalone, or a
  single-node replica set via `{ replset: true }` for transactions), opens an
  **isolated** `createConnection` (never the global mongoose singleton, so
  repeated/parallel boots never collide), and returns a live mongokit
  `Repository` in one call. Exports: `createTestRepository` (server +
  connection + `Repository`, forwards the full `CreateRepositoryConfig`),
  `createTestConnection`, `withMongoMemory` (scoped setup→run→teardown),
  `createMongoMemory` (raw server lifecycle), `clearCollections`, and
  `mongoMemoryBackend()` — a `TestBackend` seam that drops into
  `@classytic/arc-testkit`'s `bootModuleApp`.
  - **Bring your own DB:** pass `{ uri }` or set `MONGODB_URI` and no in-memory
    server starts — the harness connects to your real local/cloud (Atlas)
    database and `stop()`/`close()` become no-ops, so it never drops it. Point
    at a **dedicated test DB** — `clear()` empties every collection.
  - **Indexes are real:** `createTestRepository` runs `model.init()`, so
    unique (`E11000`), TTL, compound, text, and geo indexes behave for real on
    the in-memory server; use the exposed `model` for runtime
    `syncIndexes()` / `dropIndex(...)`. Atlas `$search` / `$vectorSearch`
    indexes remain Atlas-only — test those against a real cluster via `{ uri }`.
- **`mongodb-memory-server` added as an OPTIONAL peer** (`>=10.0.0`,
  `peerDependenciesMeta.optional`). It is **dynamically imported** and kept in
  tsdown's `neverBundle` list, so it is never a production dependency and never
  enters an app bundle. `dependencies` stays empty — nothing new is installed
  for consumers who don't use the testkit. The `testkit` subpath is unreachable
  from the main import graph (0 references in `dist/index.mjs`).

### [3.18.0] - 2026-07-04

Feature release — capture side of the `@classytic/repo-core` 0.7.0 sync contract.

> **Compatibility note:** requires `@classytic/repo-core` `>=0.7.0` (peer bump —
> publish repo-core 0.7.0 first).

- **Added `changeLogPlugin({ store, scope, tenantField?, versionField? })`**
  (`./plugins`): appends a `ChangeEntry` to a host-provided `ChangeLogStore`
  on every repository write — `upsert` entries (full doc) on create /
  createMany / update, **tombstones** on delete (built from the delete
  summary id). `context.session` is passed through to `store.append` so
  durable stores persist atomically with the business write. Version derives
  from `doc.version` (kernel convention) → `__v` → `updatedAt` epoch.
  Honors `skipPlugins: ['changeLog']`. The durable, storage-agnostic sibling
  of `repo.watch()` — feeds offline-first pull/push (`arc-sync`) and
  incremental replicas. **v1 capture surface (documented):** exactly
  `create` / `createMany` / `update` / `delete`. NOT captured:
  `updateMany` / `deleteMany` / `bulkWrite` (bulk ops return no per-doc
  results), `findOneAndUpdate` / `claim` / `claimVersion` (CAS verbs may
  return projected partial docs — an `upsert` entry must carry the full
  doc), `getOrCreate` / `restore`, and mongo-operations helpers
  (`increment`, `pushToArray`, ...). Surfaces meant for offline sync
  should write through the four captured verbs.

### [3.17.0] - 2026-06-28

Feature release — imperative cascade purge for deletes that happen outside a
mongokit Repository.

- **Added `cascadePurgeReferences(value, relations, options?)`** (root
  export): multi-relation "purge by reference" — given a value (typically an
  id) and a set of relations (target + referencing field), purge every
  matching row. The imperative sibling of `cascadePlugin` (which is
  Repository-delete-event driven): use it when the delete originates outside
  mongokit — e.g. a Better Auth `user.delete` hook, where BA removes its own
  `user` row and the app must clean up FK-referencing collections. Repo-routed
  relations reuse repo-core's `runChunkedPurge` + `createMongoPurgePort`
  (chunking, `hard`/`soft`/`anonymize` strategies, plugin hooks, tenant
  bypass); collection-routed relations hit a raw `Collection`/`Model` with
  direct `deleteMany`/`updateMany`. Never throws for in-strategy failures —
  each relation returns an `{ ok, error }` report line.
- **Added `idVariants(id)`** (`./utils`): returns `[hexString, ObjectId]`
  for a valid ObjectId hex string (else `[id]`), so reference matching via
  `{ $in: idVariants(userId) }` catches values stored in either
  representation. Used by `cascadePurgeReferences` id matching.

### [3.16.0] - 2026-06-11

Feature release adopting the `@classytic/repo-core` 0.6.0 contract.

> **Compatibility note:** requires `@classytic/repo-core` `>=0.6.0` (peer bump — update both packages together).

#### Added — runtime capabilities (`repo.capabilities`)

- **`MONGOKIT_CAPABILITIES`** (new public export) — mongokit's `RepoCapabilities` declaration, and **`Repository.capabilities`** now satisfies the `readonly capabilities` member that `StandardRepo<TDoc>` requires as of repo-core 0.6.0. Hosts and arc feature-detect at boot (`repo.capabilities.changeStreams`, `.aggregateOps.percentile`, ...) instead of try/catching per call.
- The cross-kit conformance harness now spreads the same constant (`ConformanceFeatures` is an alias of `RepoCapabilities`) — one source of truth; runtime claims and tested scenarios can't drift. The harness overrides only `nestedTransactions: false` (mongokit's `withTransaction` wrapper doesn't rebind nested calls to the same session yet).

#### Added — `watch()` change feed

- **`Repository.watch(filter?, options?)`** — implements `StandardRepo.watch` over Mongo change streams (`Model.watch`, `fullDocument: 'updateLookup'`; requires a replica set). Returns `AsyncIterable<ChangeEvent<TDoc>>` with portable operations (`create` / `update` / `replace` / `delete`), the affected id, the post-image doc where available, and a commit timestamp.
- **Policy-routed like every other read:** `watch` is registered in `OP_REGISTRY` (policyKey `'query'`) and routes through `_buildContext` BEFORE the pipeline is built — `multiTenantPlugin` scopes the feed (and throws under `required: true` exactly like other reads), `softDeletePlugin` injects the deletion-state predicate. A tenant-scoped repo never streams cross-tenant changes.
- Caller filters (plain record or Filter IR) compile through the standard filter compiler and apply — together with the policy predicates — against `fullDocument.*` paths. `options.signal` ends the iterator cleanly (a pre-aborted signal rejects at the op boundary); `options.resumeAfter` forwards a Mongo resume token.

#### Added — `createRepository(model, config)` config-driven factory

- New recommended construction path: features light up only when their config key is present (`tenant`, `softDelete`, `timestamps`, `batch`, `cache`, `audit`, `customId`, `schema`, `updateSchema`, `events`, extra `plugins`, `pagination`, plus every `RepositoryOptions` passthrough). The factory composes plugins in the canonical safe order (methodRegistry → multiTenant → softDelete → timestamps → customId → cache → audit → batch → extras) and defaults `pluginOrderChecks` to `'throw'` — plugin-order mistakes become impossible.
- `audit` accepts either a `Logger` (routes to `auditLogPlugin`) or `AuditTrailOptions` (routes to `auditTrailPlugin`).
- ⚠️ **Signature change:** `createRepository` previously existed as a thin positional alias of the constructor (`createRepository(Model, plugins?, paginationConfig?, options?)`). It is now the config-driven factory — positional callers migrate to `new Repository(Model, plugins, paginationConfig, options)` (unchanged) or to the config shape.

#### Added — `schema` / `updateSchema` / `events` constructor options

- `RepositoryOptions` gained the repo-core 0.6.0 `RepositoryBaseOptions` slots, forwarded to `super()`: **Standard Schema validation** of `create` / `createMany` / `update` payloads at `HOOK_PRIORITY.VALIDATION` (150) — invalid writes throw `HttpError` 400 with structured `validationErrors`, validator output (coercions/defaults) replaces the payload — and **domain-event emission** (`<resource>.created` / `.updated` / `.deleted` / ... through any arc/primitives-compatible `EventTransport`).

#### Added — `signal` + `retryPolicy` honored on all repository operations

- The repo-core 0.6.0 resilience contract now covers the whole CRUD surface (previously only `watch()` and `purgeByField` honored it): a pre-aborted `QueryOptions.signal` rejects at the op boundary BEFORE before-hooks and before any driver round-trip (guard in `_buildContext`, so plugin-contributed ops like `restore` / `lease` are covered too), and `QueryOptions.retryPolicy` retries the DRIVER call only via repo-core's `withRetry` — before-hooks (validation, tenant scope, audit, events) never re-run on retry, and aborting between attempts stops the retry loop.
- Soft-delete's hook-owned driver writes (the `before:delete` `findOneAndUpdate` and the `before:deleteMany` → `updateMany` conversion) honor the same contract — they sit BEFORE the class-level wrap (which the soft path skips), so the plugin wraps them with `withRetry` + abort guard itself.

#### Added — `lean: true` honored on reads

- `getById` / `getOne` / `getByQuery` honor `lean: true` (plain objects, no mongoose hydration); `findAll` / `getAll` / `cursor` were already lean-by-default. Locked in by tests and declared via `capabilities.lean`.

#### Changed — multi-tenant mismatch guard (fail-closed)

- ⚠️ **Behavioral change:** when a call's filter/payload carries `tenantField` with a value that does NOT match the resolved tenant scope, `multiTenantPlugin` now **throws** (new `onMismatch: 'throw'` default) instead of silently overwriting the caller's value. The resolved scope always won before (no leak either way) — the change is loud-vs-silent: a cross-tenant value on a scoped call is either a caller bug or an injection attempt, and masking it hid real bugs. Operator-shaped tenant values (`{ $in: [...] }`) are rejected too — multi-value tenant scoping stays unsupported by design. Matching values (string vs ObjectId representations included) pass and are normalized to the configured `fieldType`. Restore the legacy behavior with `onMismatch: 'overwrite'`; legitimate cross-tenant access stays on `bypassTenant: true` / `skipWhen` — both emit `after:tenant-bypass` for audit.
- New table-driven coverage test iterates `ALL_OPERATIONS` asserting tenant-scope injection per `policyKey` — and that a missing tenant under `required: true` fails closed on EVERY registered op (reads and writes, incl. updateMany / deleteMany / bulkWrite / aggregate / distinct / count / exists / findOneAndUpdate / claim / claimVersion / getOrCreate / cursor). A future op added to `OP_REGISTRY` can't silently skip tenancy.

#### Changed — better-auth overlay guidance + coverage

- Documented on `BetterAuthOverlayOptions.RepositoryClass`: do NOT apply `multiTenantPlugin` to BA overlays (BA tables are global by design; `member.organizationId` is BA's own membership semantics, not tenant-scoped data) and the `cachePlugin` caveat (BA's own writes go through BA's driver and won't invalidate mongokit's cache). The default overlay repo deliberately installs no plugins.
- New tests: a host model's `ref: 'user'` populates through `registerBetterAuthStubs` stubs; QueryParser-driven pagination + filters work end-to-end on a BA-managed collection.

#### Changed — internal (no behavior change)

- Soft-delete plugin: `buildDeletedFilter` / `buildGetDeletedFilter` unified into one parameterized `buildDeletionStateFilter(field, mode, 'live' | 'deleted')` helper — the two predicates can't drift.
- AI vector plugin: after a `$vectorSearch` failure classified as NOT_ATLAS, the actionable error is cached and subsequent `searchSimilar` calls fail fast upfront instead of paying a driver round-trip per call.

#### Changed — toolchain (dev-only)

- TypeScript `^6.0.3` (tsconfig gains explicit `"types": ["node"]` — TS 6 dropped the implicit `@types` auto-include this repo relied on), Vitest `^4.1.4` + `@vitest/coverage-v8` `^4.1.4` (config migrated off removed `poolOptions` to top-level `minWorkers` / `maxWorkers`). Node `>=22` unchanged.

### [3.13.4] - 2026-05-12

#### Added — `systemContext()` helper for tenant-bypass calls outside request scope

- **`systemContext(extra?)`** (new public export) — canonical options bag for repo calls made OUTSIDE any request scope: event handlers, cron jobs, queue workers, migration scripts. Returns `{ ...extra, bypassTenant: true }` with `bypassTenant: true` applied last so it can't be accidentally overridden.
- **Why:** `multiTenantPlugin` requires `organizationId` in the operation context. Background work has no inherited request scope; calling a tenant-aware repo from an event subscriber without a bypass throws `"[mongokit] Multi-tenant: Missing 'organizationId' in context for ..."`. When the call site is wrapped in `try/catch` (as fire-and-forget event handlers routinely are), the error is swallowed and the side effect silently doesn't happen — a shipped-bug shape.
- **Greppable by design.** A reviewer scanning the codebase can find every "running outside any tenant scope" call site by searching `systemContext(` — no chasing magic option spreads. The multi-tenant plugin still emits `after:tenant-bypass` with `reason: 'option'` so observability sees these calls distinct from request-scoped ones.
- **Not a substitute for access control.** Same caveat as raw `bypassTenant`: bypasses tenant scoping, does NOT bypass auth or RBAC. Use only at trusted boundaries.
- Composes cleanly with sessions / audit-attribution: `systemContext({ session, userId: 'cron:nightly' })`.

#### Added — `sort` option on `getByQuery` / `getOne`

- **`getByQuery(query, { sort })`** / **`getOne(query, { sort })`** — forwards a Mongoose `SortSpec` to `findOne(...).sort(...)`. Closes the gap where "find the most recent match for this query" required either a kludgy `getAll({ limit: 1, sort })[0]` or dropping to `repo.model.findOne(...)`. Travels through the standard hook pipeline (multi-tenant, cache, audit) unchanged.

### [3.13.3] - 2026-05-08

#### Fixed — `_handleError` strips transactional retry labels

- **`_handleError` now preserves `errorLabels` on `MongoServerError`.** When the driver raised a `WriteConflict` (or any error carrying `'TransientTransactionError'` / `'UnknownTransactionCommitResult'`), the previous wrap into `createError(500, message)` produced a fresh `Error` and silently stripped both `errorLabels` and the `hasErrorLabel` method. `mongoose.Connection.withTransaction()` reads those labels to decide whether to auto-retry — without them, retries never fire and concurrent transactional writes (hot-key upserts, idempotency CAS, outbox commit races) surface to userland as `HttpError(500)` instead of being handled by Mongo's standard retry mechanism. Fix detects retry-eligible errors before any wrap and returns the original instance unwrapped, leaving E11000 / validation / cast handling unchanged.
- **Affected hosts:** any package whose write paths run inside `session.withTransaction(...)` — confirmed in `@classytic/flow` (hot-SKU reservation upsert; tests in `tests/concurrency/hot-sku-reservation.test.ts`). After this fix, those repos can drop their direct-`Model.findOneAndUpdate` workarounds and route through `this.findOneAndUpdate` like every other write.
- **Scope of preservation:** detection is narrow on purpose. Only `'TransientTransactionError'` and `'UnknownTransactionCommitResult'` short-circuit the wrap — those are the two labels mongoose's transaction retry loop actually reads. Errors that merely have a `hasErrorLabel` method (every `MongoServerError`, including E11000) but report no retry labels still get wrapped per the documented contract.

#### Added — optional `limit` on `findAll` + forward-through on `getAll({ noPagination: true })`

- **`findAll(filter, { limit })`** — caps the result set at the driver level. Defaults to "no limit" (historic behavior preserved). Closes the gap that previously forced bounded-non-paginated reads to either over-fetch (`findAll` with no cap) or pay the count round-trip of `getAll({ limit, page })`.
- **`getAll({ noPagination: true, limit: N })`** — forwards `limit` to the delegated `findAll` call. Previously `noPagination: true` silently dropped any passed `limit`.
- **Use case:** removal-engine candidate fetches (FIFO/FEFO/LIFO) inside hot reservation transactions. Both options stay through the standard hook pipeline (multi-tenant scope, soft-delete, audit, cache).

### [3.13.0] - 2026-05-04

#### ⚠️ BREAKING — deprecated `UpdateInput<TDoc>` alias removed

- **`UpdateInput<TDoc>` no longer exported from `@classytic/mongokit`.** Renamed to `UpdatePatch<TDoc>` in 3.11.0 with a one-release-only alias kept for migration; that release cycle is done.
- **Migration:**
  - If you wrote `Partial<Omit<TDoc, '_id' | 'createdAt' | '__v'>>` patches: rename `UpdateInput` → `UpdatePatch`.
  - If you actually wanted the bulk/find-and-update union (`UpdateSpec | Record | Record[]`): `import type { UpdateInput } from '@classytic/repo-core/update'` (different type, same name — that's why the local alias was removed).

#### Changed — internal consolidation (zero behavioral change)

- **Aggregate normalize + keyset cursor helpers now delegate to `@classytic/repo-core/aggregate`.** `normalizeGroupBy`, `validateMeasures`, `encodeAggCursor`, `decodeAggCursor`, `isKeysetMode` were byte-identical to sqlitekit's copies; they now live in repo-core. Public mongokit imports (`from '@classytic/mongokit'`) work unchanged — kit-local files are thin shims that bind the `'mongokit'` error prefix.
- **`adminBypass` now delegates to `@classytic/repo-core/plugins`.** Same factory shape; reduces drift surface across the kit ecosystem.
- **`payloadHasTenantField` (multi-tenant plugin internal helper) now delegates to repo-core.**

#### Fixed — modern mongoose / mongodb-driver compat

- **`isTransactionUnsupported` now recognizes the new standalone-mongo error message.** Modern mongoose/mongodb-driver versions enable `retryWrites=true` by default, which standalone Mongo rejects with `"This MongoDB deployment does not support retryable writes"` BEFORE the transaction precondition fires. The `withTransaction({ allowFallback: true })` path was returning the retryable-writes error to callers instead of degrading to non-tx writes. The predicate now treats this message as equivalent to the older transaction-not-supported error — same root cause, same fallback semantics. (`src/transaction.ts`)

#### Fixed — security & robustness hardening

- **Stack-DoS hole in `_sanitizeExpressions`**: the `$addFields` / `$set` pipeline-stage sanitizer was missing the depth guard that its sibling `_sanitizeMatchConfig` already ships. A hostile `$cond` / `$switch` chain could recurse arbitrarily deep and exhaust the JS stack. Now bounded by `maxFilterDepth` like the match-side path. (`src/query/QueryParser.ts`)
- **`auditTrailPlugin` `onWriteError` callback for compliance hosts**: audit writes are still fire-and-forget by default (audit failures must not break the primary operation), but compliance-grade deployments (SOC 2 / PCI / HIPAA) can now wire `onWriteError(err, entry)` to forward failures to a dead-letter queue, page on-call, or short-circuit the request. The default `console.warn` log was invisible to compliance review. (`src/plugins/audit-trail.plugin.ts`)

#### ⚠️ BREAKING — `multiTenantPlugin` defaults to fail-closed (`allowDataInjection: false`)

The plugin's `allowDataInjection` option used to default to `true` — meaning if the
caller stamped the tenant onto `data` / `query` / `filters` themselves, the
`required` throw was bypassed. That was the wrong security posture for a production-
grade boundary: caller-supplied scope on the payload cannot be trusted as
authentication. The default now flips to **`false`** (fail-closed).

**Migration:** if you intentionally want the prior behavior — e.g. a host control-
plane has authenticated the tenant out-of-band and stamps it on every write — set
the option explicitly to make the trust model visible at the call site:

```ts
multiTenantPlugin({ tenantField: 'organizationId', allowDataInjection: true })
```

The vast majority of users pass tenant via context (`{ organizationId }` in the
options bag) and are unaffected.

#### Fixed — README contract drift

- `delete(id)` miss-shape: the README claimed `{ success: false, message: '...' }`;
  actual return is `null` (per the `MinimalRepo` contract). Documentation now matches code.
- Pagination envelope key: `docs` → `data` (rename landed in 3.10; README was stale).
- Peer-dep range: `>=0.3.0` → `>=0.4.0` (matches `package.json`).

**Field-grade primitives.** Four new shapes that turn hand-rolled `findOneAndUpdate` calls into one-liners — `claim()` (state-machine CAS), `claimVersion()` (optimistic-concurrency CAS), `cursor()` (tenant-scoped streaming reads), and `useMiddleware()` (wrap-style middleware). Plus `leasePlugin()` (distributed FIFO claim-lease), `incrementIfBelow()` (capacity-bounded counter increment), `batchTransaction()` (multi-repo session binding), `requirePlugins` (boot-time plugin assertion), and `createOptionsExtractor<TCtx>()` (typed ctx → options builder).

#### ⚠️ BREAKING — `getOrCreate()` returns `{ doc, created }` instead of bare `TDoc`

`getOrCreate()` previously returned the document directly; it now returns an object discriminating insert from match:

```ts
// Before (3.12)
const user = await repo.getOrCreate({ email }, { name });
console.log(user.email); // direct doc access

// After (3.13)
const { doc, created } = await repo.getOrCreate({ email }, { name });
console.log(doc.email);
if (created) console.log('first sign-in');
```

This aligns mongokit with `StandardRepo.getOrCreate?` from `@classytic/repo-core` 0.4.0 — every kit returns the same shape so cross-kit consumers can branch on `created` without driver-specific shims. The discriminator answers a question every caller was already asking out-of-band ("did THIS call insert, or match an existing row?") via second-trip exists-checks; doing it in the same round-trip is the whole point.

**Migration:** every `repo.getOrCreate(...)` call site needs destructuring or `.doc` access. Greppable diff:

```diff
- const user = await repo.getOrCreate({ email }, { name });
+ const { doc: user } = await repo.getOrCreate({ email }, { name });
```

If you don't care whether the row was inserted, the destructuring rename above is a one-line mechanical edit. Be-prod hit two sites (`cms.controller.ts`, `customer.repository.ts`); commission, yard, streamline don't use `getOrCreate`. Slip-of-the-keyboard prevention: TypeScript catches this at compile time — there's no silent-undefined path.

This change shipped between 3.12 and 3.13 but was not in the original 3.13 release notes; this entry corrects that. `getOrCreate` is also flagged in the conformance test (`tests/unit/standard-repo-assignment.test-d.ts`) so any future contract drift fails the prepublish gate.

#### `claim()` — three additions in response to consumer migration audits

The 3.13.0 release shipped `claim()` with a single-source `from` and hardcoded `upsert: false`. Consumer migrations (commission's 4 multi-source sites, yard's gate-event upsert-claim, media-kit's error path) surfaced three real friction points. Fixed in this update:

- **`from: T | T[]` — multi-source CAS.** `from` accepts an array; compiles to `[stateField]: { $in: [...] }`. Replaces the raw-`findOneAndUpdate` fallback every state machine with multiple non-terminal source states was reaching for. Real-world frequency: commission's `voidRecord` / `markClawedBack` / `endAgreement` / `_transition`, media-kit's `pending|processing → error` catch-block, every "from any non-terminal" pattern. Compounds with `where` predicates the same way single-value `from` does.
- **`options.upsert?: boolean` — insert-or-claim.** Default stays `false` (canonical CAS semantic — "match exactly, else null"). Setting `upsert: true` enables the upsert-claim pattern: insert when the row doesn't exist, else CAS-transition. Yard's `gate-event.append` and any idempotent first-write flow can now use claim directly. Pair with `$setOnInsert` in the operator patch for insert-only fields.
- **`from === to` is allowed — idempotent re-claim.** Yard's `reviseDeparture` writes `departed → departed` to update the row's payload while asserting the row hasn't moved on. The CAS still returns `null` on race-loss (row left the source state), so the safety property holds. Documented explicitly in the `claim()` JSDoc as a supported pattern.

#### `from === to` no-op write optimization

Once `from === to` was admitted as a supported semantic (see above), a follow-up complaint surfaced: every CAS-hit on a replay was writing `$set: { [stateField]: to }` over a value that the filter had already pinned to that exact same value. Functionally a no-op — but a **real** disk write. Under high-replay workloads (yard's `gate-event.append`, outbox dedup storms, idempotent first-write CAS), one redundant journal flush + replication-log entry per replay is non-trivial.

The optimization recognises the shape and skips the redundant write. Three observable cases:

- **Empty patch + `upsert: false`** → the call lowers to a plain `Model.findOne(filter)` round-trip. Pure assertion, zero writes. The plugin pipeline (before/after `claim` hooks) still fires correctly — only the internal driver shape changes.
- **Empty patch + `upsert: true`** → update becomes `{ $setOnInsert: { [stateField]: to } }`. On match: no-op (the `$setOnInsert` operator only fires on insert). On miss: inserts with the canonical state value via the filter literal + `$setOnInsert`. This is the yard `gate-event.append` shape — replay storms now do **zero disk writes** instead of one-per-replay.
- **Non-empty patch + `from === to`** → drops the redundant state-field key from `$set` while keeping all caller patch fields. `claim(id, { from: 'running', to: 'running' }, { workerId: 'w-1' })` writes `$set: { workerId: 'w-1' }` (no `status` key).

**Safety.** Optimization fires only when `from` is a literal AND `from === to`. Array `from` is unsafe to optimize (the matched value could be any of the `$in` members; the `to` write IS load-bearing for convergence). Non-equal `from`/`to` is the normal CAS path — the state-field write is the load-bearing transition, never dropped.

**Verification.** [tests/integration/claim.test.ts](mongokit/tests/integration/claim.test.ts) covers each case via spy-based assertions: `vi.spyOn(Model, 'findOne')` + `vi.spyOn(Model, 'findOneAndUpdate')` confirm which driver call fires on each shape, plus `before:claim` hooks inspect the constructed `context.data` to confirm the redundant key is absent. 12 new tests across two `describe` blocks (`from === to optimization` and `pure-dedup upsert (yard gate-event.append shape)`).

**Recipe.** [mongokit's CLAUDE.md](mongokit/CLAUDE.md) now carries a "Pure-dedup upsert via `claim()`" recipe block documenting the canonical yard pattern (`idField: 'externalEventId'` + `field: 'externalEventId'` + `from === to === id` + `upsert: true`) so future readers and AI maintainers don't have to reverse-engineer the idiom from the JSDoc. Includes the explicit "when to reach for `claim()` vs `getOrCreate()`" decision matrix.

#### Round-3 consumer feedback — what landed and what was deliberately rejected

After the round-3 review (flow, be-prod, commission), four real engineering improvements landed and four asks were deliberately rejected with rationale.

**Landed:**

- **`assertNoMixedPatchShape()` — named validator with louder error messages.** The mixed-patch check was an inline conditional in `claim()` and `claimVersion()`. Hoisted into a top-level helper so error stack traces point at the rule directly — debugging "why does my patch throw?" is now grep-friendly. Error message reframed from "Mongo would silently drop the flat keys" to "Mongo would silently DROP the flat keys — that's a write-loss bug we refuse to forward" so the data-loss risk is unmissable. JSDoc on both `claim` and `claimVersion` carries an explicit `@throws` line.
- **`claimVersion()` first-write CAS — version-field collision protection.** When `from === undefined`, the version is initialized via `$set` (since `$inc` can't apply to null). If the caller's update ALSO writes the version field — in `$set` OR `$inc` — the implicit init would silently fight the caller's intent. Now throws with a message that points at both fix paths ("remove `version` from your $set" OR "pass a numeric `from`") so the caller doesn't have to read the source.
- **`repoOptionsFromCtx(ctx)` — canonical request-context → options-bag extractor.** Consumers were repeatedly hand-rolling `{ organizationId: ctx.organizationId, userId: ctx.userId, session: ctx.session }` — sometimes correctly forwarding all three, sometimes only one, occasionally pre-casting `Types.ObjectId(orgId)` because the caller didn't trust `multiTenantPlugin` to handle the cast (it does). The helper extracts the canonical fields (`organizationId`, `userId`, `user`, `session`, `requestId`) and omits absent keys (no `undefined` writes that would erase parent values in spread merges). Exported from the public barrel.
- **Dotted-path `field` support — verified, locked in, documented.** `field: 'scheduling.status'` for nested state columns (lpn.state, package.condition.state) now has explicit test coverage including the `from === to` optimization on dotted paths. JSDoc on `claim()` calls it out as supported.

**Rejected (would degrade the design):**

- **Widening `from` to accept Mongo expressions (`$ne`, `$lt`, `$exists`, …).** The CAS contract is "match if the state field equals one of these specific values." Admitting arbitrary predicates would collapse `claim` into a generic filter primitive and defeat the point of a state-machine API. The `where` slot already covers compound predicates — JSDoc now documents this loudly with a worked `$ne` example pointing callers at `where`.
- **`idempotencyKey` slot on `leasePlugin`.** Idempotency-key dedup is a different shape from time-bounded leases. The `claim()` pure-dedup recipe (CLAUDE.md) is the answer for "first-writer-wins on an external event id" patterns; lease plugin stays focused on reaper-recoverable work-item leases.
- **`forEachOp(callback)` over `OP_REGISTRY`.** `Object.entries(OP_REGISTRY)` is already typed and discoverable. A `forEachOp` wrapper would just bloat the public surface without adding semantics. Custom-plugin authors iterate the registry directly.
- **`warmupCollection(model)` test utility.** Test infrastructure for `MongoMemoryReplSet` promotion isn't a runtime mongokit concern. Belongs in each consumer's test setup, not the public barrel.

**Documented (the answer is the existing primitive):**

- "State-machine + `claim()` pairing" recipe in CLAUDE.md showing how `defineStateMachine().assertTransition()` (compile-time + sync domain check) composes with `claim()` (runtime concurrency check) — the canonical CAS pattern. Explicit framing of "skip `assertTransition` → malformed transitions reach the database; skip `claim` → concurrent writers race, last-write-wins" so the two layers' value is unambiguous.
- "`useMiddleware()` for observability" recipe with the load-bearing security boundary note (middleware fires AFTER `before:*` hooks; cannot wrap policy failures; use `before:*` for security, `useMiddleware()` for ergonomics).
- "`skipPlugins` for backfills/migrations" recipe with the safety caveat (only audit + observability are skippable; never skip `multiTenantPlugin` / `softDeletePlugin` / `cachePlugin` — those are correctness, not observability).

```ts
// Multi-source: void any pending or approved record
await repo.claim(id, { from: ['pending', 'approved'], to: 'voided' });

// Upsert-claim: insert if missing, else transition
await repo.claim(id, { from: 'pending', to: 'sent' }, {
  $set: { sentAt: now },
  $setOnInsert: { createdBy, createdAt: now },
}, { upsert: true });

// Idempotent re-claim: refresh payload while asserting state hasn't moved
await repo.claim(id, { from: 'departed', to: 'departed' }, { revisedAt: now });
```

Same applies to repo-core 0.4: `ClaimTransition.from` widened to `unknown | readonly unknown[]` with full JSDoc on the multi-source semantic.

#### Round-4 consumer feedback — `batchTransaction`, `requirePlugins`, `createOptionsExtractor`, contract promotion

After round 4 (~10 packages with FSM verbs depending on `claim`, ~6 packages hand-rolling identical ctx → options forwarders, ~20 sites threading session manually across multi-repo transactions), four real engineering wins landed and four asks were deliberately rejected.

**Landed:**

- **`StandardRepo.claim` and `claimVersion` promoted from optional → required** in repo-core's contract. Both kits already ship them as concrete primitives; the optional-`?` was rollout scaffolding. Removes the `if (repo.claim) { ... }` boilerplate at every cross-kit call site and surfaces missing implementations at the conformance gate instead of at runtime. New `ClaimVersionTransition` type exported alongside `ClaimTransition`.

- **`batchTransaction(connection, repos, callback)` — multi-repo session binding.** Replaces the per-call-site `{ session }` threading that was repeated across ~20 sites. Each repo passed in becomes a session-bound proxy via `createTxBoundRepo` so callers don't have to remember to forward — every CRUD method (including `claim` / `claimVersion` / `findOneAndUpdate` and plugin-contributed methods) auto-injects. Same retry + fallback semantics as the existing `withTransaction`. 7 new integration tests cover commit, atomic rollback on throw, claim+claimVersion auto-threading, single-repo-in-bag edge case, repo-identity preservation, and `transactionOptions` forwarding.

- **`requirePlugins: string[]` constructor assertion — fail-closed at boot.** Replaces convention-by-documentation ("always wire `multiTenantPlugin`" repeated in 7+ CLAUDE.md files; "always wire `softDeletePlugin`" in 9+) with an enforcement gate. The constructor throws `TypeError` listing every missing plugin name in one shot (so the host fixes them all in one round-trip rather than bisecting through repeated boot failures), plus the names of installed plugins so a typo surfaces as a side-by-side diff. Names match each plugin's exported `name` property (kebab-case for some, camelCase for others — the JSDoc lists every bundled plugin's canonical name).

- **`createOptionsExtractor<TCtx>(fields)` — typed ctx → options builder.** Eliminates the ~150 lines of identical `repo-options.ts` boilerplate hand-rolled across 6 packages (commission, supplier-performance, pos, yard, order, plus implicit in leave / payrun / muster / people). Field list is constrained to `keyof TCtx & string` — typos become compile errors. Frozen at extractor creation so caller mutation of the input array can't silently change behaviour. Sits alongside the existing `repoOptionsFromCtx` (opinionated, hardcoded to mongokit's bundled-plugin fields) — reach for `createOptionsExtractor` when your domain has additional canonical fields (`actorRef`, `correlationId`, `idempotencyKey`, `sagaRunId`, …).

- **`createTxBoundRepo` proxy fix: `bound.Model` no longer returns `undefined`.** The proxy's "non-function values pass through" logic was bypassed for `Model` because mongoose Models ARE functions (constructors); the proxy was wrapping them in `Function.prototype.bind` which strips static properties (`modelName`, `schema`, `collection`). Special-cased `Model` to return as-is so callers can introspect schema or use the raw mongoose API inside a session-bound repo. Pre-existing limitation surfaced by `batchTransaction`'s repo-identity test.

**Rejected (would degrade the design):**

- **`Repository.aggregateScoped(pipeline)` as a new method.** `aggregatePipeline` already routes through the plugin pipeline (registered as `policyKey: 'query'` in `OP_REGISTRY`); `multiTenantPlugin` and `softDeletePlugin` already inject `$match` predicates. The bug is consumers reaching for `Model.aggregate(...)` raw and bypassing the plugin pipeline. Documented loudly in CLAUDE.md as "use `aggregatePipeline()`, NOT `Model.aggregate()`" — no new method needed.

- **`Repository.tx(callback)` as a new instance method.** `Repository.withTransaction(callback)` already exists as the single-repo bound primitive; `batchTransaction(...)` covers the multi-repo case; standalone `withTransaction(connection, fn)` covers the raw-session escape hatch. Adding `tx()` would just bloat the surface without filling a gap.

- **Soft-deprecation policy as CI-enforced rule.** A scanner that fails publish if a public export is removed without prior `@deprecated` marking is real but heavyweight — false positives block releases and need careful build-tool design. Documented as a process expectation; defer the scanner to dedicated tooling work.

- **Audit plugin consolidation (single switchable `audit` surface).** Out of scope for this round; `auditLogPlugin` and `auditTrailPlugin` solve adjacent-but-distinct problems (sink vs DB-persisted trail). Consolidation is a future API design pass, not a feedback-driven patch.

**Documented (existing primitive answers it):**

- "Scoped aggregations" recipe in CLAUDE.md — `aggregatePipeline()` IS the canonical scoped pipeline, with the plugin-routing path explained explicitly.
- "Transactions — three primitives, one for each shape" recipe in CLAUDE.md — single-repo `repo.withTransaction(fn)`, multi-repo `batchTransaction(conn, map, fn)`, raw-session escape `withTransaction(conn, fn)`. Decision matrix included.
- `leasePlugin()` discoverability section in CLAUDE.md — confirms it ships, is greppable, lease/extend/release semantics are stable. ~120 lines per package eliminated by migration.

#### Round-5 docs revision — `assertAndClaim`, decision matrix, contract framing

After primitives 0.3.1 shipped `assertAndClaim` + `validSources` + `validTargets`, three docs revisions landed:

- **State-machine recipe in CLAUDE.md now leads with `assertAndClaim`** as the canonical entry point. The manual two-step (`machine.assertTransition` + `repo.claim` separately) is documented as the edge-case form for callers who need to interleave logic between the two layers.
- **"Decision matrix — `claim` vs `claimVersion` vs `getOrCreate` vs `leasePlugin`"** added at the top of CLAUDE.md's Recipes section. Closes the "which CAS-shaped primitive do I reach for?" ergonomics gap with a concrete decision tree + a common-mistake flag (using `leasePlugin` for idempotency-key dedup is wrong — leases are time-bounded work claims, not first-writer-wins guarantees).
- **Type-alignment + stability framing now points at repo-core** instead of introducing a `RepositoryClaim<TDoc>` mongokit-specific type. The contract source-of-truth is `StandardRepo.claim` in `@classytic/repo-core/repository` (made required in repo-core 0.4.0). Mongokit's `Repository<TDoc>` conforms; primitives' `ClaimableRepo<TDoc>` is structurally compatible. **Adding a kit-specific `RepositoryClaim` was an explicit reject** — would have duplicated the contract and split the surface (`StandardRepo` for cross-kit, `RepositoryClaim` for mongokit-specific). Stability of the cross-package alignment lives in repo-core's `ClaimTransition` JSDoc (now carries the explicit "cross-package stability contract" note) + the conformance gate. Narrowing claim's options or transition shape is a contract-level break that has to land in repo-core first, not in any kit.

No new exports, no behavioural changes — pure documentation + contract-clarity revision in response to consumer feedback (round 5). Repo-core's `ClaimTransition` JSDoc updated alongside to carry the stability commitment at the source-of-truth, not in the kit.

#### Round-6 — multi-tenant host-composition primitives

Multi-tenancy + access control had a real ergonomic gap: super-admin / cross-tenant access was supported (`skipWhen` callback) but every consumer hand-rolled the same logic, the doc-claimed `bypassTenant` per-call escape didn't actually exist (drift introduced in round-4 docs), and bypassed queries couldn't be distinguished from tenant-scoped ones at the audit layer. Three additive primitives close the gap without making the plugin try to anticipate every domain shape:

- **`bypassTenant: true`** — per-call escape hatch in the options bag. Discoverable, explicit, scoped to a single call (NOT sticky on the repo). The plugin returns without injecting the tenant field; caller carries the responsibility. Ends the doc-drift from round-4 by making the documented option real.
- **`adminBypass({ roleField, adminRoles })` factory** — canonical `skipWhen` callback for role-based bypass. Replaces the hand-rolled `(ctx) => ctx.role === 'superadmin'` callback that ~6 packages each carry. Field list is frozen at factory creation (defensive against post-creation mutation). Composes with `bypassTenant: true` (per-call still wins; `adminBypass` is the always-on form). Exported alongside `multiTenantPlugin` from the barrel.
- **`after:tenant-bypass` event** — emitted whenever a bypass fires (option or callback) with `{ context, operation, reason }`. Audit / observability plugins distinguish bypassed queries from tenant-scoped ones in their logs without the host wiring it manually at every call site. Reason is `'option'` for `bypassTenant: true`, `'callback'` for `skipWhen`-driven bypass — `option` always wins on the precedence order so audit logs reflect the most-specific intent.

```ts
import { adminBypass, multiTenantPlugin } from '@classytic/mongokit';

const repo = new Repository(InvoiceModel, [
  multiTenantPlugin({
    tenantField: 'organizationId',
    required: true,
    skipWhen: adminBypass({ adminRoles: ['superadmin', 'platform_admin'] }),
  }),
]);

// Three distinct paths through the plugin's decision graph:
await repo.findAll({}, { role: 'user', organizationId: 'org-1' }); // scoped
await repo.findAll({}, { role: 'superadmin' });                    // bypassed (callback)
await repo.findAll({}, { bypassTenant: true });                    // bypassed (option)
```

#### Host-composition recipes (CLAUDE.md, no code changes)

The plugin deliberately stays narrow — it owns ONE field. Branches, teams, regional admins, owner-id scoping all compose via primitives without new plugin options. Three recipes added under the new "Multi-tenancy + access control" section in [CLAUDE.md](CLAUDE.md):

- **Branch / team / region — stacked plugin instances.** Multiple `multiTenantPlugin` instances scope different fields independently. Each instance ANDs its predicate; together they layer (org → branch → team). Required vs optional is a per-instance decision so org admins see all branches but branch managers see one. Verified by integration test: org admin sees both branches' rows, branch manager sees only their branch's, write goes to the right org+branch tag.
- **Owner / creator scoping — `before:*` hook in the domain layer.** Mongokit doesn't ship owner-rules as plugin options (every package carves them differently — some allow teammates, some don't, some have shared workspaces). The supported pattern: register a `before:findAll/getAll/getOne/getById` hook that injects `ownerId` into the filter when the caller isn't an admin. Composes with the tenant plugin's predicate (both fire before the driver call; mongo ANDs the keys). Hosts can wrap this in their own thin plugin if they want a reusable abstraction.
- **Audit composition — wire `after:tenant-bypass` to your sink.** Direct example showing how a host's audit log captures every bypass with reason + operation + actor. Load-bearing for SOC 2 / HIPAA / PCI compliance.

#### What this surface deliberately does NOT do (explicit rejects)

- **No RBAC / ABAC primitive.** Role-based + attribute-based access control is host territory — domain-specific role vocabulary, policy evaluation engine, cross-org permission matrices. Mongokit owns the integration surface (per-call bypass + role-based skipWhen + audit hook); the policy logic stays in the host.
- **No multi-value tenant scoping** (`organizationId: string[]` → `$in`). A `null` bug would silently skip scoping. For regional admins legitimately needing N-of-M tenant access, use `bypassTenant: true` + manual `{$in}` filter at the call site, OR a custom `before:*` hook with an explicit array predicate. Both keep bypass intent explicit.
- **No "owner-or-tenant" automatic scoping** — domain-specific; use the `before:*` hook recipe.

#### Tests

- New integration suite [`tests/integration/multi-tenant-primitives.test.ts`](tests/integration/multi-tenant-primitives.test.ts) — 19 tests covering: per-call bypass (with required: true, with subsequent calls, on writes, with bypassTenant: false), `adminBypass` factory (role match, custom roleField, frozen-array defense, integration with the plugin, `'admin'` ≠ `'superadmin'` precedence), `after:tenant-bypass` audit event (option reason, callback reason, no-emit on scoped calls, option-wins-over-callback precedence), and the host-composition patterns (branch sub-scoping via stacked instances, owner-id via `before:*` hook, audit-log sink wiring).
- All 2260 mongokit tests pass (was 2241 → +19 new).

#### Process note — future deprecations will use a two-step pattern

3.12's "Removed" section took out the pagination-result types, `HttpError`, and `CrudSchemas` from the mongokit barrel as part of the single-source-of-truth migration to repo-core. Real-world consumer impact: 3.11 → 3.13 jumpers (be-prod hit 3 files) saw a hard breakage with no compile-time bridge.

Migration path is unchanged — import from the canonical location in repo-core:

```ts
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
import type { HttpError } from '@classytic/repo-core/errors';
import type { CrudSchemas } from '@classytic/repo-core/schema';
```

`PaginationResult` (the union) is renamed to `AnyPaginationResult` in repo-core. Field shape and `method` discriminant are unchanged — runtime shape is identical.

**Lesson for future major cleanups:** soft-deprecate first (one minor with `@deprecated` re-exports), hard-remove second (the minor after). The 3.12 removal skipped step one; future deprecations will follow the two-step pattern by default. Not retroactively applied here — the migration target is small and well-documented.

#### `claim()` — atomic CAS state transition

Implements `StandardRepo.claim()` from repo-core 0.4.0. Race-safe `findOneAndUpdate({ _id, [field]: from }, { $set: { [field]: to, ...patch } })` in one round-trip. Multi-tenant scope, soft-delete filter, cache invalidation, and audit hooks all flow through automatically — `claim` is registered in `OP_REGISTRY` (`policyKey: 'query'`).

```ts
const claimed = await runRepo.claim(runId, { from: 'waiting', to: 'running' }, {
  workerId: 'w-12',
  lastHeartbeat: new Date(),
});
if (!claimed) return; // someone else got it (or no match)
```

**`transition.where` — compound CAS predicate.** Of streamline's 21 atomic-claim sites, only 1 fit the bare `{ [idField]: id, [field]: from }` shape; the other 20 carried compound predicates (paused guards, retry-time guards, heartbeat-staleness, `$elemMatch` sub-docs). Same pattern in commission, yard, revenue, order, invoice. `where` AND-merges arbitrary predicates alongside the canonical id + state-field match — the same shape that hand-rolled `findOneAndUpdate` calls were already encoding:

```ts
const claimed = await runRepo.claim(
  runId,
  {
    from: 'waiting',
    to: 'running',
    where: {
      paused: { $ne: true },
      'scheduling.retryAfter': { $lte: new Date() },
    },
  },
  { lastHeartbeat: new Date() },
);
```

Canonical CAS keys (`[idField]: id`, `[stateField]: from`) spread last — overlapping keys in `where` are dominated, so a wiring bug that puts the state field in `where` with the wrong value can't silently break the CAS.

**Operator patches (`$set`, `$inc`, `$unset`, …).** Of commission's 7 raw-bypass sites, every one had literal `from`/`to` values (the textbook claim shape) but only 1 fit because the rest also did `$inc: { version: 1 }`. Yard had 0 fits for the same reason. `claim`'s patch param now accepts BOTH flat (`{ field: value }`) and Mongo operator (`{ $set, $inc, $unset, $push, … }`) shapes:

```ts
await orderRepo.claim(orderId, { from: 'pending', to: 'shipped' }, {
  $set: { shippedAt: new Date() },
  $inc: { version: 1 },
});
```

The state transition merges into `$set` LAST so a caller's `$set` can't accidentally overwrite the target state. Mixing flat keys with `$`-keys throws (matches mongo's silent-drop behavior — a wiring bug we won't ship).

#### `claimVersion()` — optimistic-concurrency CAS

Sibling to `claim()` for version-stamped CAS:

```ts
const submitted = await orderRepo.claimVersion(
  orderId,
  { from: order.version },
  { $set: { status: 'submitted' } },
);
```

Builds `findOneAndUpdate({ _id, [versionField]: from }, { ...update, $inc: { [versionField]: by ?? 1 } })` in one round-trip. Caller's `$inc` on other fields coexists with the version bump.

**`transition.where` — compound CAS, same as `claim`.** Yard's `transition()` filter is `{ _id, status, version }` — state AND version both must match. Without `where`, callers were forced back to raw `findOneAndUpdate`:

```ts
const transitioned = await yardRepo.claimVersion(
  loadId,
  { from: load.version, where: { status: 'queued' } },
  { $set: { status: 'in-progress', startedAt: new Date() } },
);
```

**`from: undefined` tolerance.** Lean reads return `version: number | undefined` because field defaults are absent on fresh-from-mongo POJOs. Forcing `?? 0` at every call site was friction. Passing `from: undefined` matches docs whose version field is null OR missing — the safe first-write CAS semantics. When `from === undefined`, the version is initialized via `$set` (mongo's `$inc` can't apply to a null-valued field).

#### `cursor()` — tenant-scoped streaming reads

Replaces direct `Model.find().cursor()` (which bypasses every plugin — cross-tenant data leak waiting to happen). Goes through the standard `before:cursor` hook pipeline so multi-tenant scope, soft-delete, and access-control plugins inject before the underlying mongoose cursor is built. Async iterator with bounded memory (`batchSize`) and proper cleanup on early `break`.

```ts
for await (const doc of repo.cursor({ status: 'active' }, { organizationId: 'org-a' })) {
  await pipeline.send(doc);
}
```

Registered in `OP_REGISTRY` (`policyKey: 'query'`) — multi-tenant + soft-delete plugins iterate the registry and pick it up automatically. Emits `after:cursor` with `{count}` on completion. Consumer-thrown errors propagate via the normal throw path; `error:cursor` is reserved for stream-level driver failures.

#### `useMiddleware()` — wrap-style middleware

Composes around every op (including cache-hit branches of `getById` / `getOne` / `getAll`) so middleware sees every call, not just `_runOp`-routed ones. Composition order: registration = outermost-first.

```ts
repo.useMiddleware(async ({ operation, next }) => {
  const start = performance.now();
  try { return await next(); }
  finally { metrics.record(operation, performance.now() - start); }
});
```

**Middleware composes WITH `repo.on()`, doesn't replace it.** `_buildContext + before:<op>` runs BEFORE the middleware chain dispatches — middleware cannot wrap a `before:*` policy failure. That's by design: middleware as a security boundary would be impossible to audit, since registration order would determine whether tenant scope wins. **Middleware is for ergonomics (timing, short-circuit, input/output mutation in a single closure); use `before:*` hooks for security policy.**

#### `leasePlugin()` — distributed FIFO claim-lease

Standardises the pattern five repos hand-rolled (outbox relays, flow waves, promo pending-evaluation, fulfillment retry, cart idempotency). Three contributed methods:

```ts
const repo = new Repository(OutboxModel, [methodRegistryPlugin(), leasePlugin()]) as
  Repository<IOutbox> & LeaseMethods<IOutbox>;

const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-1' });
await repo.extend(id, { leasedBy: 'worker-1', leaseFor: 30_000 });
await repo.release(id, { leasedBy: 'worker-1', finalStatus: 'done' });
```

`lease()` claims the oldest pending row OR recovers a dead lease (`leaseExpiresAt < now`). `extend()` CAS-checks `leasedBy === ours AND leaseExpiresAt > now`, returns `null` if the lease was lost. `release()` enforces the same CAS — only the live holder may finalise the row, so a worker whose lease was recovered can't accidentally mark another worker's in-progress work as `done` / `failed`. Field names + statuses configurable.

#### `incrementIfBelow()` — capacity-bounded counter

Atomic `findOneAndUpdate({ _id, [field]: { $lt: cap } }, { $inc: { [field]: 1 } })`. Returns `null` when the capacity is full. Field-path validation rejects `$`-prefixed segments, `__proto__` / `constructor` / `prototype` / empty dotted segments — defensive against prototype-pollution-style writes.

#### `OP_REGISTRY` — single source of truth widened

`claim`, `claimVersion`, `cursor` registered in `OP_REGISTRY` (`policyKey: 'query'`, `mutates: true` for the first two, `false` for cursor). The strictQuery diagnostic now derives its filter-shaped op coverage from `operationsByPolicyKey('query')` and `operationsByPolicyKey('filters')` — adding a new query-shaped op means one map entry; the diagnostic auto-includes it. The hardcoded list was the exact redundancy the registry was meant to eliminate.

#### `warnOnStrictQueryStrip` — diagnostic

When `mongoose.set('strictQuery', true)` (mongoose 7+ default), filter keys not on the schema are silently stripped. That's a footgun for queries built from URL params. Opt-in:

```ts
const repo = new Repository(Model, plugins, paginationConfig, {
  warnOnStrictQueryStrip: { logger: console.warn },
});
```

Hooks every filter-shaped op at OBSERVABILITY priority (300 — runs AFTER policy plugins inject scope, so it checks the post-policy filter and avoids false-positives on plugin-injected keys).

#### `skipPlugins` — per-call escape hatch

`auditLogPlugin`, `auditTrailPlugin`, `observabilityPlugin` honor `context.skipPlugins?.includes(plugin-name)`. Use for backfills, migrations, internal sweeps that shouldn't fire audit / metrics:

```ts
await repo.update(id, data, { skipPlugins: ['auditLog', 'observability'] });
```

#### `MongoOperatorUpdate` — typed operator-update shape

Index-signature `[op: string]: unknown` allows typed operator updates to assign to `findOneAndUpdate`'s `Record<string, unknown>` slot without `as unknown as` casts. Streamline reported a clean migration: the historic `as unknown as Record<string, unknown>` footgun on every CAS site is gone.

```ts
const update: MongoOperatorUpdate = normalizeUpdate(input);
await repo.findOneAndUpdate(filter, update);
```

#### `Middleware`, `MiddlewareContext`, `MinimalRepoView` — middleware types

Exposed via the public barrel for typed middleware authoring. `MinimalRepoView<TDoc>` is the narrowed repo surface available inside middleware (no driver internals; the floor methods + idField).

#### Cache plugin — `after:restore` invalidation

Soft-delete restore was a silent gap: restoring a doc didn't invalidate its cached read entries, so the next `getById` returned the stale "not found" cache hit. Added `after:restore` to the cache plugin's invalidation listeners. Closes a tenant-context-leak shape that touched soft-delete-heavy repos.

#### LookupBuilder — caller pipelines + `where` always sanitized

`LookupBuilder.multiple()`'s caller-supplied stages now flow through `appendCallerStages()` which ALWAYS runs `sanitizePipeline()`. Two prior 3.12 patches forgot the rule (raw `where: { $where: 'js' }` records, raw `pipeline: [{ $out: ... }]` arrays). Kit-built stages stay trusted by construction.

#### Repository constructor — plugin-shape validation

`new Repository(Model, ['organizationId'], opts)` (passing a string array where a plugin array was meant) now throws a descriptive `TypeError` with the offending index and a hint about the common `tenantField` mistake — instead of crashing later with `TypeError: plugin.apply is not a function`. `assertValidPlugin()` lives in `@classytic/repo-core` 0.3.x.

#### `aggregate(req)` policy-scope merge respects Filter IR

`_injectPolicyScopeIntoAgg` was building `{ $and: [scope, req.filter] }` raw, leaving Filter IR nodes inside `$and` — Mongo couldn't match them, so aggregates silently returned 0 rows whenever caller passed IR + a policy plugin was installed. Each part now compiles via `compileFilterToMongo` BEFORE the merge.

#### `LookupSpec.where` honored on mongokit (cross-kit parity)

`repo-core/lookup/types.ts#LookupSpec.where` was implemented in sqlitekit but silently dropped by mongokit. `LookupOptions` now declares `where?: Filter | Record<string, unknown>` and `LookupBuilder.multiple()` compiles it into a sanitized `$match` after the join correlation.

#### `LookupSpec.select: readonly string[]` array form compiles

Repo-core allowed array-form `select`; mongokit only handled CSV strings + projection-map records, so `select: ['name']` was emitted as invalid `$project: ['name']`. Added explicit `Array.isArray()` branch handling both inclusion and exclusion forms.

#### Soft `deleteMany` reports real `deletedCount`

When the soft-delete plugin's `before:deleteMany` hook converted to `updateMany`, it discarded the result; `Repository.deleteMany` then returned `{ deletedCount: 0, soft: true }` even when rows transitioned. Plugin now stamps `context.softDeletedCount` and the envelope reads it.

#### `.gitattributes` — LF normalization

Committed `.gitattributes` with `* text=auto eol=lf` so reviewer / CI diff tools that don't honor `core.autocrlf=input` see clean diffs. Future commits stay LF-normalized regardless of contributor platform.

#### Conformance gate

`tests/unit/standard-repo-assignment.test-d.ts` widened to probe every documented public type from `docs/TYPES_GUIDE.md`. Removing any from the barrel without removing it from the doc fails the conformance gate (wired into `prepublishOnly`).

#### Migration

- **Cache adapter**: no API change.
- **`claim()` patch**: previously you'd write `findOneAndUpdate({ _id, status: 'pending' }, { $set: { status: 'shipped' }, $inc: { version: 1 } })`; now `claim(id, { from: 'pending', to: 'shipped' }, { $set: { shippedAt: now }, $inc: { version: 1 } })`. Same null-on-race semantics.
- **`claim` / `claimVersion` tenant context**: pass `{ organizationId: ctx.orgId }` in the options bag when `multiTenantPlugin` is mounted — same as every other op. The plugin throws "Missing organizationId" without it.
- **`leasePlugin.release()`**: signature is `release(id, { leasedBy, finalStatus? })`. Required `leasedBy` is the CAS holder check that prevents another worker from accidentally finalising a recovered lease. There is no shipped pre-3.13 release(), so no migration debt.

#### Heads-up for plugin authors — third-party hooks must register `before:claim` / `before:claimVersion` / `before:cursor`

Bundled plugins (`multi-tenant`, `soft-delete`, `cache`, `audit-log`, `audit-trail`, `observability`, `validation-chain`) iterate `MUTATING_OPERATIONS` / `READ_OPERATIONS` / `ALL_OPERATIONS` from `OP_REGISTRY`, so they auto-cover every new op once it's registered. Third-party plugins that hand-rolled their own per-op arrays must update those arrays — without it, the new ops aren't scoped:

- **Multi-tenant**: must add `'claim'`, `'claimVersion'`, `'cursor'` to its `before:*` hook list. Tenant scope leaks otherwise.
- **Soft-delete**: must filter on `'cursor'` (read) and `'claim'` / `'claimVersion'` (writes). Without it, soft-deleted rows surface in cursors / get claimed.
- **Cache invalidation**: must invalidate on `'claim'` / `'claimVersion'` (mutations).

Recommended migration: replace the per-op array with `import { MUTATING_OPERATIONS, READ_OPERATIONS } from '@classytic/mongokit'` (or `operationsByPolicyKey('query')` etc.) and iterate.

#### RFC follow-up — `before:write` / `before:read` category events

The pattern of "every new method = N plugin updates" is exactly what the original `before:<category>` RFC was trying to address. A category event (e.g. `before:write` firing for every mutating op, `before:read` for every read) lets a plugin subscribe ONCE and cover the entire registry — including future additions — without code changes. `OP_REGISTRY` already classifies; the hook fanout is the missing layer.

Marked as a roadmap candidate for **mongokit 4.0 / repo-core 1.0**. Not in 3.13 because:
- It's a hook-engine surface change (per-method events still fire; category events are additive); compatible but worth deliberation.
- Cross-kit story (sqlitekit, prismakit) needs a shared spec — this is a repo-core contract, not a mongokit-only addition.

If you ship a third-party plugin and want to drive your op coverage from `OP_REGISTRY` today (rather than re-syncing per-op arrays on every kit bump), import it from `@classytic/mongokit` and iterate. The shape is forward-compatible with the future category events.

### [3.12.0] - 2026-04-29

### [3.12.0] - 2026-04-29

**Schema-builder additions** (paired with arc 2.12 cutting its mongoose-to-OpenAPI fallback) — see below.

**Tenant config alignment** — `MultiTenantOptions` now extends `Pick<TenantConfig, 'tenantField' | 'contextKey' | 'required' | 'fieldType'>` from `@classytic/repo-core/tenant`. Static field vocabulary locked to repo-core's canonical contract by structural typing; mongokit-specific runtime callbacks (`skipWhen`, `resolveContext`, `skipOperations`, `allowDataInjection`) extend on top. Zero new peer deps — mongokit already peer-dep'd repo-core.

**`SchemaGenerator<Model<unknown>>` conformance** — `buildCrudSchemasFromModel` ships a compile-time conformance assertion against repo-core's canonical schema-generator contract. Drift between mongokit's signature and the org-wide interface fails mongokit's typecheck before any arc / consumer sees it.

**Error contract alignment** — local `HttpError` interface in `src/types.ts` deleted. Now imports `HttpError` from `@classytic/repo-core/errors` directly. Public re-export of `HttpError` removed from `@classytic/mongokit` index. Hosts that imported `HttpError` from `@classytic/mongokit` must switch to `@classytic/repo-core/errors`. Field shapes are unchanged — repo-core's `HttpError` was extended in 0.3 with `code?: string` and `meta?: Record<string, unknown>` (the two fields mongokit had locally that repo-core was missing).

**Breaking — mongokit no longer re-declares pagination shapes.** Repo-core 0.3.0 owns them, and shipping a duplicate set in mongokit only invited drift.

**Schema-builder additions** — paired with arc 2.12 cutting its built-in mongoose-to-OpenAPI fallback, mongokit's `buildCrudSchemasFromModel` is now the canonical generator. Three substantive additions in this release:

- **Emits `response: JsonSchema` alongside `createBody` / `updateBody` / `params` / `listQuery`.** The response shape includes server-set fields (`createdAt`, `updatedAt`, `_id`, immutable / readonly / systemManaged fields) since those ARE returned to clients. Only `fieldRules[field].hidden: true` excludes a field from responses. `additionalProperties: true` so virtuals / computed fields pass through. `Object.keys(buildCrudSchemasFromModel(M))` returns 5 keys now (was 4).
- **`Schema.Types.Mixed` → `{ additionalProperties: true }` (no `type` keyword).** Aligned with `mongoose-schema-jsonschema`'s "any value" convention. Earlier shape `{ type: 'object', additionalProperties: true }` was too narrow — Mongoose's Mixed accepts strings, numbers, booleans, arrays, and null, not just objects. The pre-3.12 shape rejected primitives at AJV validation, breaking round-trips for hosts storing mixed primitives. Same fix applied to all three Mixed code paths (top-level, `[Mixed]` array, `{ type: [Mixed] }` shorthand).
- **Nullable enum widening.** `{ type: String, enum: [...], default: null }` now appends `null` to the enum so AJV's `enum` keyword accepts null on round-trips. Previously `default: null` widened `type` but left `enum` untouched, so AJV's enum validation rejected null even when the type allowed it.

#### Security

- **`LookupBuilder.multiple()` — caller pipelines + `where` are sanitized before append.** The implicit "remember to scrub" rule was forgotten twice during the 3.12 refactors: (a) the initial `where` patch unconditionally called `builder.sanitize(false)`, letting `lookups: [{ pipeline: [{ $out: ... }] }]` push `$out` / `$merge` / `$where` / `$function` / `$accumulator` straight into the assembled pipeline; (b) the follow-up forgot that raw Mongo-shaped `where: { $where: 'js' }` records pass through `compileFilterToMongo` unchanged. Caller-supplied stages now flow through a single `appendCallerStages()` helper that ALWAYS runs `LookupBuilder.sanitizePipeline()` on its input. Kit-built stages (`$expr` join correlation, projected `$project`) stay trusted by construction. Lock-in: `tests/integration/lookup-sanitize-and-array-select.test.ts` + `tests/integration/lookup-where-sanitize.test.ts`.

#### Fixed — contract

- **`Repository` constructor: plugin-shape validation.** Passing the wrong arg position (e.g. `new Repository(Model, ['organizationId'], opts)`) now throws a descriptive `TypeError` from `RepositoryBase.use()` with the offending index and a hint about the common `tenantField` mistake, instead of crashing later with `TypeError: plugin.apply is not a function`. `assertValidPlugin()` lives in `@classytic/repo-core` 0.3.x. Lock-in: `repo-core/tests/unit/repository/base-plugin-validation.test.ts`.

- **`aggregate(req)` policy-scope merge respects Filter IR.** `_injectPolicyScopeIntoAgg` was building `{ $and: [scope, req.filter] }` raw, leaving Filter IR nodes (`eq('status', 'paid')`) sitting inside `$and` as `{ op, field, value }` literals — Mongo can't match those against real documents, so aggregates silently returned 0 rows whenever the caller passed IR + a policy plugin was installed. Each part now goes through `compileFilterToMongo` BEFORE the `$and` merge. Lock-in: `tests/integration/policy-scope-agg-ir.test.ts`.

- **`LookupSpec.where` honored on mongokit (cross-kit parity).** `repo-core/lookup/types.ts#LookupSpec.where` was implemented in sqlitekit but silently dropped by mongokit — same contract input, different rows returned. Mongokit's `LookupOptions` now declares `where?: Filter | Record<string, unknown>` and `LookupBuilder.multiple()` compiles it into a sanitized `$match` after the join correlation. Lock-in: `tests/integration/lookup-where.test.ts`.

- **`LookupSpec.select: readonly string[]` array form compiles.** Repo-core allows array-form select; mongokit only handled CSV strings and projection-map records, so `select: ['name']` was emitted as `$project: ['name']` (invalid Mongo). Added `compileSelectToProjection()` with explicit `Array.isArray()` branch handling both `['name']` inclusion and `['-status']` exclusion.

- **Soft `deleteMany` reports real `deletedCount`.** When the soft-delete plugin's `before:deleteMany` hook converted to `updateMany`, it discarded the result; `Repository.deleteMany` then returned a hardcoded `{ acknowledged: true, deletedCount: 0, soft: true }` even when rows transitioned. The plugin now stamps `context.softDeletedCount = result.modifiedCount` and the envelope reads it. Lock-in: `tests/integration/soft-delete-many-count.test.ts`.

#### Restored to public barrel (regression in earlier 3.12 work)

Some mongokit-owned types declared in `src/types.ts` were silently dropped from `src/index.ts` during the type-relocation work, even though `docs/TYPES_GUIDE.md` still advertised them. They have no canonical home outside mongokit, so they belong in the barrel. Restored:

- `BasePaginationOptions`
- `CursorPayload`
- `ValueType`
- `PrioritizedHook`

#### Conformance gate widened

`tests/unit/standard-repo-assignment.test-d.ts` now imports every mongokit-owned type listed in `docs/TYPES_GUIDE.md` and asserts each resolves. Removing any from the barrel without removing it from the doc fails `tsc -p tsconfig.tests.json` (the gate wired into `prepublishOnly`) with `TS2305 / TS2614`. Adding a new public type to the doc requires adding a probe — making docs and the public surface co-evolve instead of drifting.

#### Documentation

- `docs/TYPES_GUIDE.md` — removed four phantom entries that were never exported (`FieldRules`, `JsonSchema`, `SchemaBuilderOptions`, `ValidationResult`); split repo-core-owned types into their own section pointing at `@classytic/repo-core/{pagination,errors,schema}` with a worked migration `import` example.

#### Removed

- `OffsetPaginationResult<T>`, `KeysetPaginationResult<T>`, `AggregatePaginationResult<T>`, `PaginationResult<T>` — both as standalone declarations in `src/types.ts` and as named exports from `src/index.ts`. Internal mongokit code now imports these directly from `@classytic/repo-core/pagination`.

#### Migration

```diff
- import type { OffsetPaginationResult, KeysetPaginationResult, AggregatePaginationResult, PaginationResult } from '@classytic/mongokit';
+ import type { OffsetPaginationResult, KeysetPaginationResult, AggregatePaginationResult, AnyPaginationResult } from '@classytic/repo-core/pagination';
```

Note: the union type `PaginationResult` is renamed to `AnyPaginationResult` in repo-core to disambiguate from the singular result types. Field names and the `method` discriminant are unchanged — runtime shape is identical.

The `warning?: string` field that mongokit baked into Offset/Aggregate result is now opt-in via the `TExtra` slot:

```ts
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';

type MongokitOffset<T> = OffsetPaginationResult<T, { warning?: string }>;
```

Mongokit's own internal returns continue to surface `warning` at runtime; consumers who need it in the type should declare with the parameterised `TExtra` form above.

#### Why now

Repo-core has been the contract layer for pagination since mongokit started consuming it; the local copies were a back-compat artifact from before. With repo-core 0.3.0 also adding aggregate shapes plus HTTP wire envelopes (`OffsetPaginationResponse`, etc.) and a `toCanonicalList()` normaliser, the org gets one place for repo-shaped types — arc, sqlitekit, future kits, and SDK clients all consume the same vocabulary.

#### Peer-dep bump

`@classytic/repo-core` peer dep `>=0.2.0` → `>=0.3.0`.

### [3.11.1] - 2026-04-25

- Added structured `SEARCH_NOT_CONFIGURED` errors for index-free search setup
  issues.
- Added warnings for nested reserved query keys like
  `?filters[limit]=5`.
- Widened CRUD schema builder return typing for framework adapters without
  changing runtime behavior.
- Tightened tests and refreshed docs.

### [3.11.0] - 2026-04-22

- Promoted `updateMany` and `deleteMany` to core `Repository` methods.
- Added portable update IR support in `findOneAndUpdate` and `updateMany`.
- Renamed the single-document patch type to `UpdatePatch<TDoc>` and kept the
  old name as a deprecated alias.
- Locked repo-core / arc conformance with compile-time tests.

### [3.10.x] - 2026-04-20 to 2026-04-21

- Aligned mongokit with `@classytic/repo-core` contracts.
- Standardized miss semantics, lookup result envelopes, transaction callback
  shape, and cache adapter naming.
- Added portable lookup, filter, aggregate, and bulk-write surfaces.
- Hardened structural compatibility with arc and cross-kit conformance tests.

## Archive Policy

- `CHANGELOG.md` stays focused on the current line and recent releases.
- Older details live under [`changelog/`](./changelog/).
- Archive files are grouped by major version, which is a common pattern once a
  package changelog becomes too long to scan comfortably.

## Major History

- `v3`:
  portability, repo-core alignment, stronger pagination, search, multi-tenancy,
  vector support, and transaction hardening.
- `v2`:
  zero-dependency architecture, built-in plugins, query parser hardening, JSON
  Schema / OpenAPI support.
- `v1`:
  initial repository, hooks, and pagination foundation.

[3.11.1]: https://github.com/classytic/mongokit/compare/v3.11.0...v3.11.1
[3.11.0]: https://github.com/classytic/mongokit/compare/v3.10.3...v3.11.0
