/**
 * Mongokit's runtime capability descriptor — the `RepoCapabilities`
 * declaration required by `StandardRepo<TDoc>` (repo-core 0.6.0+).
 *
 * One source of truth, three consumers:
 *   - Runtime: `repo.capabilities.changeStreams` lets kit-portable hosts
 *     and arc feature-detect at boot instead of try/catching per call.
 *   - Conformance: the cross-kit harness (`ConformanceFeatures` is an
 *     alias of `RepoCapabilities`) spreads {@link MONGOKIT_CAPABILITIES}
 *     so the flags the kit declares are exactly the scenarios it runs.
 *   - **Kernel boot gates**: `assertWalletCapabilities`, `assertPartyCapabilities`,
 *     `ensureInvoiceReady`, … read `repo.capabilities.transactions` at `bind()`
 *     to refuse a deployment that cannot commit money atomically.
 *
 * ## Why this file is not just a constant (2026-08-05)
 *
 * It used to be. `MONGOKIT_CAPABILITIES.transactions` was hard-coded `true`,
 * and `Repository.capabilities` was a class field pointing straight at it — so
 * every one of those boot gates resolved to a literal `true` and **could never
 * fire**, including against a standalone `mongod`, which is the exact
 * deployment they exist to catch (a standalone rejects
 * `session.startTransaction()`; observed error: *"This MongoDB deployment does
 * not support retryable writes"*). That is AGENTS.md FAIL-LOUD rule 4 —
 * a declared capability that is never enforced is decoration — and two
 * independent findings hit it: the kernel-conformance suite could not falsify
 * `bind-verifies-requirements` for party or wallet, and the invoice gate work
 * flagged the same static-descriptor limitation.
 *
 * The fix: **the answer is now OBSERVED from the live deployment**, per
 * connection, via {@link resolveMongoCapabilities}. `MONGOKIT_CAPABILITIES`
 * survives as the DECLARED baseline — what MongoDB-the-product supports
 * through mongokit's surface, which is still the right input for the
 * cross-kit conformance harness and for kits that legitimately declare
 * statically (sqlitekit, prismakit). Only the mongoose-backed path probes.
 *
 * ## `unknown` is not a yes (AGENTS.md FAIL-LOUD rule 3)
 *
 * If the topology cannot be read — connection not open yet, a driver that
 * exposes no `topology`, a probe that times out or is refused — the answer is
 * `'unknown'`, and `unknown` is reported as `transactions: false` with
 * `transactionsResolution: 'unknown'`. An unobserved outcome is never a
 * positive one: for a money kernel, "we could not confirm atomic commit" and
 * "there is no atomic commit" have the same correct response — refuse, unless
 * the host explicitly accepts the degradation (`allowNonTransactional: true`).
 * Reporting `true` here is what made the old gate useless; reporting `false`
 * makes it fail closed. {@link transactionResolutionOf} lets a gate tell the
 * two apart so its error message can be actionable.
 *
 * Note the deliberate asymmetry with {@link supportsTransactions} in
 * `transaction.ts`: that helper answers "should I bother ATTEMPTING a
 * transaction?", where an unknown may safely be optimistic because a genuine
 * failure is still caught reactively. This module answers "may this deployment
 * be TRUSTED with money?", where an unknown may not.
 */

import type { RepoCapabilities } from '@classytic/repo-core/repository';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Three-valued transaction answer. `'unknown'` is NOT `'no'` and NOT `'yes'`. */
export type TransactionSupport = 'yes' | 'no' | 'unknown';

/**
 * How a capability descriptor's `transactions` flag was arrived at.
 *
 * - `'declared'` — a static kit descriptor (sqlitekit, prismakit, or
 *   {@link MONGOKIT_CAPABILITIES} itself). Absent field ⇒ `'declared'`, so
 *   every existing kit stays valid without change.
 * - `'observed'` — read off THIS connection's live deployment topology.
 * - `'unknown'`  — could not be determined; `transactions` is reported
 *   `false` (fail closed), which is a different fact from an observed `false`.
 */
export type CapabilityResolution = 'declared' | 'observed' | 'unknown';

/**
 * Mongokit's capability descriptor: `RepoCapabilities` plus the provenance of
 * the `transactions` flag.
 *
 * Structural extension rather than a repo-core change on purpose — the extra
 * key is optional to every other consumer, and {@link transactionResolutionOf}
 * reads it defensively so a kernel can accept ANY `RepoCapabilities` (including
 * a non-mongo kit's) without a cast.
 */
export interface MongoRepoCapabilities extends RepoCapabilities {
  readonly transactionsResolution: CapabilityResolution;
  /**
   * `LookupOptions.coerce` — join a STRING reference against an `ObjectId` key.
   *
   * Declared HERE and not on repo-core's portable `RepoCapabilities` on
   * purpose: `coerce` is a mongokit-only `LookupOptions` field with no
   * counterpart on repo-core's `LookupSpec`, so a cross-kit caller cannot
   * express it. A portable capability flag for a non-portable option would be
   * decoration — and it would force a repo-core release plus a peer-floor bump
   * on every kit for a field only one of them can honour.
   *
   * It is worth declaring at all because the unsupported case is INVISIBLE: a
   * `$lookup` comparing `string` to `ObjectId` matches nothing and raises no
   * error, so a host cannot tell "not supported here" from "no matches".
   */
  readonly lookupCoerce: boolean;
}

/**
 * Read the provenance of a capability descriptor's `transactions` flag.
 * A descriptor without the field is a static declaration (`'declared'`) —
 * which is exactly right for sqlitekit / prismakit / any kit whose answer
 * genuinely does not depend on a live deployment.
 */
export function transactionResolutionOf(caps: RepoCapabilities): CapabilityResolution {
  const value = (caps as Partial<MongoRepoCapabilities>).transactionsResolution;
  return value === 'observed' || value === 'unknown' ? value : 'declared';
}

// ─── The declared baseline ───────────────────────────────────────────────────

/**
 * What MongoDB supports through mongokit's surface, DECLARED (not observed).
 *
 * Deployment-dependent flags (`transactions`, `changeStreams` — both need a
 * replica set or mongos) are `true` here because they describe the product,
 * not the server you happen to be pointed at. `nestedTransactions` is NOT one
 * of them: it is `false` unconditionally, because the refusal comes from
 * mongokit's own tx-bound proxy rather than from the deployment. **Do not read this constant to decide whether a live connection can run
 * a transaction** — that is {@link resolveMongoCapabilities}, which is what
 * `Repository#capabilities` returns. This one is for the cross-kit conformance
 * harness (which overrides environment-specific limits where it is
 * constructed) and as the base every observed descriptor is derived from.
 */
export const MONGOKIT_CAPABILITIES: MongoRepoCapabilities = Object.freeze({
  transactionsResolution: 'declared',
  // Multi-document transactions via sessions (requires replica set / mongos).
  transactions: true,
  // FALSE, and not a driver limitation: mongokit's tx-bound repository
  // (`createTxBoundRepo`) throws on nested `withTransaction` by design —
  // reuse the outer txRepo. The descriptor must describe what a caller
  // holding THIS repository may do, not what a raw session would allow.
  // repo-core conformance asserts the two agree.
  nestedTransactions: false,
  // The driver's convenient transaction API (`session.withTransaction`)
  // re-runs the callback on TransientTransactionError /
  // UnknownTransactionCommitResult for up to 120s. Callers invoke it EXACTLY
  // once; an outer retry envelope on top would stack two policies and make
  // the callback's execution count unbounded.
  transactionRetry: 'managed',
  upsert: true,
  // `isDuplicateKeyError` classifies Mongo error code 11000.
  duplicateKeyError: true,
  // `ifVersion` CAS on update(): stale version throws VersionConflictError,
  // success $inc's the version field (default '__v'). Phase 1b.
  optimisticConcurrency: true,
  distinct: true,
  aggregate: true,
  aggregateOps: Object.freeze({
    // Mongo 7+ `$percentile` (approximate t-digest accumulator).
    percentile: true,
    // Native `$stdDevSamp` / `$stdDevPop` (numerically stable Welford).
    stddev: true,
    // `$setWindowFields` (Mongo 5+) gives in-engine top-N per partition.
    topN: true,
    // `$dateTrunc` / `$dateToString` both accept an IANA `timezone`, so
    // business-day and business-month buckets are drawn correctly, DST
    // included. Kits without a tz database must leave this unset AND throw
    // when a timezone is requested — never silently bucket in UTC.
    dateBucketTimezone: true,
    // `$dateTrunc` (Mongo 5+) handles `{ every, unit }` custom bins.
    customDateBuckets: true,
    // `$dateToString` `%H:%M` formats cover minute/hour named buckets.
    dateBucketSubMinute: true,
    // Per-request `cache?` slot routes through repo-core's SWR engine
    // when `aggregateCache` is wired on the Repository constructor.
    cache: true,
  }),
  getOrCreate: true,
  countAndExists: true,
  // `purgeByField` chunks via `_id`-keyed batches through deleteMany /
  // updateMany so audit + cache plugins compose automatically.
  purgeByField: true,
  // `purgeByFilter(filter, strategy)` — range/filter-scoped purge/anonymize
  // (a `civilDate` window, a retention cutoff) via `runChunkedPurge` + the
  // filter-bound mongo purge port. Same chunk + narrowed-write re-assertion.
  purgeByFilter: true,
  // `archiveByFilter(filter, sink)` — chunked cold-storage extraction
  // (write-before-delete) via `runChunkedArchive` + the mongo archive port.
  archiveByFilter: true,
  // Native `$push` / `$pull` / `$addToSet` / `$pop` / `$pullAll`.
  arrayOperators: true,
  // Filter IR `regex` op compiles to native `$regex`.
  regexFilter: true,
  // `watch()` via Mongo change streams (requires a replica set at runtime).
  changeStreams: true,
  // Read ops honor `lean: true` (plain objects instead of hydrated docs).
  lean: true,
  // Portable `lookupPopulate` join IR compiles to `$lookup` stages.
  lookupPopulate: true,
  // `LookupOptions.coerce` — join a STRING reference against an `ObjectId`
  // `_id`. Declared so a host can DETECT the support: without the coercion a
  // `$lookup` across those two types matches nothing and raises no error, so a
  // caller cannot tell "unsupported" from "genuinely no matches".
  lookupCoerce: true,
  // `cursor(filter, options)` streaming reads over mongoose cursors.
  streaming: true,
});

// ─── Topology reading (synchronous, live, free) ──────────────────────────────

/**
 * Driver `ServerType`s that positively imply a session-capable, transaction-
 * capable deployment. Verified against mongodb driver 7.x: a single-node
 * replica set reports `RSPrimary` (topology `ReplicaSetWithPrimary`, or
 * `Single` when reached with `directConnection`), a standalone `mongod`
 * reports `Standalone`, and a mongos reports `Mongos`.
 *
 * **This is why the check reads SERVER type, not just topology type.** The
 * pre-existing heuristic (`topology.description.type !== 'Single'`) has a
 * false NEGATIVE: a directly-connected single-node replica set is `Single`
 * yet runs transactions fine.
 */
const TRANSACTION_CAPABLE_SERVER_TYPES: ReadonlySet<string> = new Set([
  'RSPrimary',
  'RSSecondary',
  'RSArbiter',
  'RSOther',
  'RSGhost',
  'Mongos',
  'LoadBalancer',
]);

/** Topology types that positively imply transactions regardless of server detail. */
const TRANSACTION_CAPABLE_TOPOLOGY_TYPES: ReadonlySet<string> = new Set([
  'ReplicaSetWithPrimary',
  'ReplicaSetNoPrimary',
  'Sharded',
  'LoadBalanced',
]);

interface ServerDescriptionLike {
  readonly type?: string | undefined;
}

interface TopologyDescriptionLike {
  readonly type?: string | undefined;
  readonly servers?:
    | ReadonlyMap<string, ServerDescriptionLike>
    | Record<string, ServerDescriptionLike>
    | undefined;
}

interface ClientLike {
  readonly topology?: { readonly description?: TopologyDescriptionLike | undefined } | undefined;
}

/**
 * The slice of a Mongoose `Connection` this module touches. Structural on
 * purpose — mongokit's topology helpers stay usable with a raw `MongoClient`,
 * a `Connection`, or a test double, and never import mongoose types.
 */
export interface CapabilityConnectionLike {
  readyState?: number | undefined;
  getClient?: (() => ClientLike | undefined) | undefined;
  client?: ClientLike | undefined;
  asPromise?: (() => Promise<unknown>) | undefined;
  db?:
    | {
        admin?:
          | (() => { command: (cmd: Record<string, unknown>) => Promise<Record<string, unknown>> })
          | undefined;
      }
    | undefined;
}

function clientOf(connection: unknown): ClientLike | undefined {
  const probe = connection as (CapabilityConnectionLike & ClientLike) | null | undefined;
  if (!probe || typeof probe !== 'object') return undefined;
  try {
    // A Mongoose Connection (`getClient()` / `client`), or a raw MongoClient /
    // topology holder passed straight in.
    return (
      probe.getClient?.() ?? probe.client ?? (probe.topology !== undefined ? probe : undefined)
    );
  } catch {
    // A mongoose Connection that was never opened throws from getClient() on
    // some versions. Not knowing IS the answer here — never guess "yes".
    return undefined;
  }
}

function serverTypes(description: TopologyDescriptionLike): string[] {
  const servers = description.servers;
  if (!servers) return [];
  const values: ServerDescriptionLike[] =
    typeof (servers as ReadonlyMap<string, ServerDescriptionLike>).values === 'function'
      ? [...(servers as ReadonlyMap<string, ServerDescriptionLike>).values()]
      : Object.values(servers as Record<string, ServerDescriptionLike>);
  return values.map((s) => s?.type).filter((t): t is string => typeof t === 'string');
}

/**
 * Read whether a connection's LIVE deployment supports multi-document
 * transactions, synchronously, from the driver's SDAM topology description.
 *
 * Free (a few property reads against an object the driver keeps current), so
 * it is deliberately NOT memoized — a connection that opens after the repo was
 * constructed upgrades its own answer with no invalidation step. What IS
 * memoized is the async {@link probeMongoCapabilities} result, which this
 * function consults first so an exotic deployment that answered `hello` but
 * exposes no topology still reports definitively.
 *
 * @returns `'yes'` / `'no'` when the topology is conclusive, `'unknown'`
 *   otherwise — never optimistic. See the module docblock on rule 3.
 */
export function resolveTransactionSupport(connection: unknown): TransactionSupport {
  const cached = readProbeCache(connection);
  if (cached) return cached;

  const description = clientOf(connection)?.topology?.description;
  if (!description) return 'unknown';

  const types = serverTypes(description);
  if (types.some((t) => TRANSACTION_CAPABLE_SERVER_TYPES.has(t))) return 'yes';
  // A standalone mongod is the one deployment that positively CANNOT.
  if (types.length > 0 && types.every((t) => t === 'Standalone')) return 'no';

  const topologyType = description.type;
  if (topologyType && TRANSACTION_CAPABLE_TOPOLOGY_TYPES.has(topologyType)) return 'yes';
  // 'Single' with no readable server description, 'Unknown', still connecting:
  // we genuinely do not know. Do not guess.
  return 'unknown';
}

// ─── Derived descriptors ─────────────────────────────────────────────────────

function deriveCapabilities(support: TransactionSupport): MongoRepoCapabilities {
  const available = support === 'yes';
  return Object.freeze({
    ...MONGOKIT_CAPABILITIES,
    transactionsResolution: support === 'unknown' ? 'unknown' : 'observed',
    // `unknown` reports FALSE — fail closed. A gate written as
    // `caps.transactions !== true` therefore refuses an unconfirmed
    // deployment without needing to know this field exists.
    transactions: available,
    // Never derived from `available` — nesting is refused by the tx-bound
    // proxy whether or not the deployment supports transactions at all.
    nestedTransactions: false,
    // Change streams need the same oplog a transaction needs.
    changeStreams: available,
  });
}

/** Three possible answers ⇒ three frozen singletons; the getter allocates nothing. */
const DERIVED: Readonly<Record<TransactionSupport, MongoRepoCapabilities>> = Object.freeze({
  yes: deriveCapabilities('yes'),
  no: deriveCapabilities('no'),
  unknown: deriveCapabilities('unknown'),
});

/**
 * The capability descriptor for a LIVE connection — what
 * `Repository#capabilities` returns.
 *
 * Every deployment-dependent flag reflects the observed topology; everything
 * else comes from {@link MONGOKIT_CAPABILITIES}. Cheap enough to call per
 * access (topology read + one frozen-object lookup).
 */
export function resolveMongoCapabilities(connection: unknown): MongoRepoCapabilities {
  return DERIVED[resolveTransactionSupport(connection)];
}

/** The three derived descriptors, for tests and for gates that want to compare identity. */
export function capabilitiesForSupport(support: TransactionSupport): MongoRepoCapabilities {
  return DERIVED[support];
}

// ─── Async probe (bounded, memoized) ─────────────────────────────────────────

/** Definitive results only. Keyed on the connection object; never holds `'unknown'`. */
const PROBE_RESULTS = new WeakMap<object, TransactionSupport>();
/** In-flight de-duplication so N repos on one connection issue ONE `hello`. */
const PROBE_INFLIGHT = new WeakMap<object, Promise<TransactionSupport>>();

function readProbeCache(connection: unknown): TransactionSupport | undefined {
  if (!connection || typeof connection !== 'object') return undefined;
  return PROBE_RESULTS.get(connection as object);
}

/** Test seam — drop memoized probe answers (a reused connection object across suites). */
export function resetCapabilityProbeCache(connection?: unknown): void {
  if (connection && typeof connection === 'object') {
    PROBE_RESULTS.delete(connection as object);
    PROBE_INFLIGHT.delete(connection as object);
  }
  // WeakMaps cannot be cleared wholesale; per-connection eviction is the seam.
}

/** Options for {@link probeMongoCapabilities}. */
export interface CapabilityProbeOptions {
  /**
   * Hard ceiling on the whole probe (waiting for the connection to open PLUS
   * the `hello` round-trip). Exceeding it yields `'unknown'` — a bounded
   * wrong-but-loud answer, never a hang at boot. Default 2000ms.
   */
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    // `unref` keeps a probe timer from holding the process open in a CLI/test.
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

/**
 * Classify a `hello` (or legacy `isMaster`) reply.
 *
 * - `msg: 'isdbgrid'` ⇒ mongos ⇒ transactions (Mongo 4.2+ sharded).
 * - `setName` ⇒ a replica-set member ⇒ transactions.
 * - a reply that IS a hello (`isWritablePrimary` / `ismaster` present) with
 *   neither marker ⇒ standalone ⇒ **no**. Verified: a memory-server standalone
 *   returns `{ isWritablePrimary: true }` and nothing else.
 * - anything unrecognised ⇒ `'unknown'`. A reply we cannot parse is not a yes.
 */
export function classifyHelloReply(reply: Record<string, unknown> | undefined): TransactionSupport {
  if (!reply || typeof reply !== 'object') return 'unknown';
  const { msg, setName } = reply as { msg?: unknown; setName?: unknown };
  if (msg === 'isdbgrid') return 'yes';
  if (typeof setName === 'string' && setName.length > 0) return 'yes';
  const looksLikeHello = 'isWritablePrimary' in reply || 'ismaster' in reply;
  return looksLikeHello ? 'no' : 'unknown';
}

async function runProbe(
  connection: CapabilityConnectionLike,
  timeoutMs: number,
): Promise<TransactionSupport> {
  // 1. If it is mid-connect, give it (a bounded slice of) the budget to finish.
  //    readyState 0 = never connected / disconnected: we cannot open it for the
  //    host, and waiting would hang. That is `unknown`, immediately.
  if (connection.readyState === 2 && typeof connection.asPromise === 'function') {
    await withTimeout(
      connection.asPromise().then(
        () => undefined,
        () => undefined,
      ),
      timeoutMs,
      undefined,
    );
  }

  // 2. The topology may now be conclusive without any I/O at all.
  const fromTopology = resolveTransactionSupport(connection);
  if (fromTopology !== 'unknown') return fromTopology;

  // 3. Last resort: ask the server. Bounded; any failure (auth, timeout,
  //    an exotic backend, no admin rights) is `unknown`, never a yes.
  const admin = connection.db?.admin?.();
  if (!admin) return 'unknown';
  const hello = await withTimeout(
    admin.command({ hello: 1 }).catch(async () =>
      // `hello` landed in 4.4.2; older servers answer the legacy command.
      admin.command({ isMaster: 1 }).catch(() => undefined),
    ),
    timeoutMs,
    undefined,
  );
  return classifyHelloReply(hello);
}

/**
 * Resolve a connection's real capabilities, waiting for (and if necessary
 * asking) the deployment. Memoized per connection: N repositories and N
 * kernels on one connection issue at most ONE `hello`.
 *
 * Hosts do not have to call this — `Repository#capabilities` reads the live
 * topology synchronously, which is already conclusive once
 * `await mongoose.connect()` has returned (the Kernel Construction Standard's
 * Describe → **Bind** ordering guarantees that). It exists for the cases the
 * sync read cannot cover: binding while a connection is still opening, or a
 * deployment whose driver surfaces no topology description. Calling it makes
 * the SUBSEQUENT synchronous reads definitive, so nothing else needs rewiring:
 *
 * ```ts
 * await probeMongoCapabilities(connection);   // once, before bind
 * const engine = defineWallet().bind(connection);  // gate now sees the truth
 * ```
 *
 * Only definitive answers are cached — an `'unknown'` may be re-probed later
 * (the deployment may simply not have been up yet).
 */
export async function probeMongoCapabilities(
  connection: unknown,
  options: CapabilityProbeOptions = {},
): Promise<MongoRepoCapabilities> {
  if (!connection || typeof connection !== 'object') return DERIVED.unknown;
  const key = connection as object;

  const cached = PROBE_RESULTS.get(key);
  if (cached) return DERIVED[cached];

  const inflight = PROBE_INFLIGHT.get(key);
  if (inflight) return DERIVED[await inflight];

  const timeoutMs = options.timeoutMs ?? 2000;
  const run = runProbe(connection as CapabilityConnectionLike, timeoutMs)
    .catch((): TransactionSupport => 'unknown')
    .then((support) => {
      if (support !== 'unknown') PROBE_RESULTS.set(key, support);
      PROBE_INFLIGHT.delete(key);
      return support;
    });
  PROBE_INFLIGHT.set(key, run);
  return DERIVED[await run];
}
