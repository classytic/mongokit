/**
 * Public contract of `@classytic/mongokit/kernel-conformance`.
 *
 * Types only — no runtime behavior, no test-runner import. Kept separate so a consumer
 * can `import type` the option shape from production code (a build script, a registry of
 * conformant kernels) without pulling the suite itself.
 */
import type { Connection } from 'mongoose';

// ─── Check identity ──────────────────────────────────────────────────────────

/**
 * Every check the suite can run, in execution order. The ids are STABLE — `skip` is typed
 * against this tuple, so a typo is a compile error rather than a silently-ineffective skip
 * (a skip that skips nothing is the same silent-permissiveness bug class the suite exists
 * to catch).
 */
export const KERNEL_CONFORMANCE_CHECKS = [
  /** §11.1 — `defineX(shape)` registers no model and performs no I/O. */
  'describe-purity',
  /** §11.1 — `modelNames` is non-empty, frozen, and matches `expectedModelNames`. */
  'blueprint-model-names',
  /** §11.1 — after `bind`, the connection holds EXACTLY the declared models. */
  'bind-registers-declared-models',
  /** §5.2 — `bind` uses the supplied connection's registry, never the global one. */
  'bind-connection-scoped',
  /** §11.11 — `bind` never synchronizes, creates or drops indexes. */
  'bind-no-index-io',
  /** §8.1 — every bound schema disables mongoose's own `autoIndex` build. */
  'no-autoindex-on-bind',
  /** §11.3 — a schema factory produces a FRESH schema per connection. */
  'fresh-schema-per-connection',
  /** §11.2/§11.12 — a second bind on one connection throws mongokit `ModelCollisionError`. */
  'double-bind-collision',
  /** §11.7 — a host-SUPPLIED transport is never closed by the engine. */
  'transport-not-closed-when-supplied',
  /** §11.7 — the internally-created bus IS closed by `close()`. */
  'owned-transport-closed',
  /** §6.4 — `close()` is idempotent. */
  'close-idempotent',
  /** §11.12 — one construction API (`defineX`), one teardown name (`close`). */
  'no-legacy-surface',
  /** §8 — a failing index sync REJECTS; it is never swallowed. */
  'maintenance-fails-loud',
  /** §11.5 — unmet runtime capability requirements fail the bind. (conditional) */
  'bind-verifies-requirements',
  /** §11.5 — an injected outbox that does not enlist `ctx.session` is REFUSED. (conditional) */
  'outbox-requires-transactional-save',
  /** §11.10 — a blueprint with optional modules off registers no extra models. (conditional) */
  'optional-modules-register-no-models',
] as const;

export type ConformanceCheck = (typeof KERNEL_CONFORMANCE_CHECKS)[number];

/**
 * Checks that only run when the kernel supplies the input they need. When the input is
 * absent they are reported as NOT EXERCISED — a visible marker test plus a report entry,
 * never a silent pass.
 */
export const CONDITIONAL_CHECKS = [
  'bind-verifies-requirements',
  'outbox-requires-transactional-save',
  'optional-modules-register-no-models',
] as const satisfies readonly ConformanceCheck[];

// ─── Test-runner seam ────────────────────────────────────────────────────────

/**
 * The two runner functions the suite needs, INJECTED by the consumer.
 *
 * mongokit deliberately does not import `vitest` (not even as an optional peer): the suite
 * would then only work under one runner and would put a test framework in the dependency
 * graph of a package every kernel installs in production. Injection costs the consumer one
 * line — `runner: { describe, it }` — and in exchange the suite runs unmodified under
 * vitest, jest, mocha or `node:test`. Assertions are internal (precise `Error` messages),
 * so no `expect` implementation is required either.
 */
export interface ConformanceRunner {
  describe(name: string, fn: () => void): unknown;
  it(name: string, fn: () => void | Promise<void>): unknown;
}

// ─── Structural shapes (no kernel imports) ───────────────────────────────────

/** The minimum a `defineX(shape)` result must expose to be conformance-testable. */
export interface KernelBlueprintLike {
  readonly id?: string;
  readonly modelNames: readonly string[];
}

/** A domain-event-shaped envelope. Structural — the suite never imports primitives. */
export interface ConformanceEvent {
  readonly type: string;
  readonly payload?: unknown;
  readonly meta?: Record<string, unknown>;
}

/**
 * Structurally compatible with `@classytic/primitives`' `EventTransport` and arc's
 * `MemoryEventTransport`. Declared here so mongokit stays dependency-free.
 */
export interface EventTransportLike {
  readonly name?: string;
  publish(event: ConformanceEvent): Promise<void> | void;
  publishMany?(events: readonly ConformanceEvent[]): Promise<unknown>;
  subscribe?(
    pattern: string,
    handler: (event: ConformanceEvent) => unknown,
  ): Promise<() => void> | (() => void);
  close?(): Promise<void> | void;
}

/** Collaborators the suite hands to `bind`. The kernel maps them onto its own runtime. */
export interface KernelBindContext {
  /**
   * Present ONLY for the supplied-transport ownership check. When absent the kernel must
   * create (and therefore own) its internal bus.
   */
  readonly transport?: EventTransportLike;
}

/** A connection plus its teardown. Return this from `connect` when cleanup is needed. */
export interface ConformanceConnectionHandle {
  readonly connection: Connection;
  teardown?(): Promise<void> | void;
}

export type ConformanceConnect = () => Promise<Connection | ConformanceConnectionHandle>;

// ─── Skips and reporting ─────────────────────────────────────────────────────

/**
 * An explicit, REASONED opt-out. The reason is required: an unexplained skip is
 * indistinguishable from an oversight, and this suite exists because oversights were
 * invisible.
 */
export interface ConformanceSkip {
  readonly check: ConformanceCheck;
  readonly reason: string;
}

export type ConformanceCheckOutcome = 'run' | 'skipped' | 'not-exercised';

export interface ConformanceCheckStatus {
  readonly check: ConformanceCheck;
  readonly outcome: ConformanceCheckOutcome;
  /** Why it was skipped, or which option would exercise a conditional check. */
  readonly reason?: string;
}

/** Emitted once per suite, before any test runs. */
export interface KernelConformanceReport {
  readonly kernel: string;
  readonly checks: readonly ConformanceCheckStatus[];
  readonly skipped: readonly ConformanceCheckStatus[];
  readonly notExercised: readonly ConformanceCheckStatus[];
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface KernelConformanceOptions<TBlueprint extends KernelBlueprintLike, TEngine> {
  /** Kernel name, e.g. `'party'`. Used in test titles and to derive legacy export names. */
  readonly name: string;

  /** `describe`/`it` from the consumer's own test runner. See {@link ConformanceRunner}. */
  readonly runner: ConformanceRunner;

  /**
   * A FACTORY, not a value — `() => defineParty({ ... })`.
   *
   * Purity (§11.1) is only observable if the suite can call `defineX` itself while watching
   * the model registries; a pre-built blueprint has already done whatever it was going to do.
   * The factory also gives every check a pristine blueprint, so one check's bind can never
   * poison another's.
   *
   * Describe the conformance blueprint WITHOUT `forceRecreate` (the collision check needs a
   * real collision) and, when the kernel offers it, with `autoIndex: false`.
   */
  readonly blueprint: () => TBlueprint;

  /**
   * A live or registry-only connection. `async () => mongoose.createConnection()` (never
   * connected) is enough for every check and needs no server — model registration and the
   * index-call spies are registry-level. Return a {@link ConformanceConnectionHandle} when
   * teardown is needed. Called once per check that binds.
   */
  readonly connect: ConformanceConnect;

  /** Bind the blueprint the suite handed you. Map `ctx.transport` onto the kernel runtime. */
  readonly bind: (
    blueprint: TBlueprint,
    connection: Connection,
    ctx: KernelBindContext,
  ) => TEngine | Promise<TEngine>;

  /**
   * Build the transport used by `transport-not-closed-when-supplied`. Defaults to the
   * suite's own in-process transport, which satisfies the `EventTransport` contract.
   */
  readonly makeTransport?: () => EventTransportLike;

  /**
   * The exact model set the blueprint must declare. Supplied ⇒ an exact match is REQUIRED;
   * a drift in either direction fails.
   */
  readonly expectedModelNames?: readonly string[];

  /**
   * The kernel's public module namespace (`import * as kernel from '../../src/index.js'`)
   * or a list of its exported names. Required by `no-legacy-surface`.
   */
  readonly moduleExports?: Readonly<Record<string, unknown>> | readonly string[];

  /** Extra export names that must NOT exist (legacy factories this kernel used to ship). */
  readonly forbiddenExportNames?: readonly string[];

  /** The sole construction export. Defaults to `define<Pascal(name)>`, e.g. `defineParty`. */
  readonly constructionExportName?: string;

  /**
   * Find the engine's INTERNAL transport for the owned-transport check. Defaults to the
   * first transport-shaped value among `events`, `transport`, `eventTransport`, `bus`.
   */
  readonly resolveInternalTransport?: (engine: TEngine) => EventTransportLike | undefined;

  /**
   * Direct probe for "was the internally-created bus closed?". Overrides the default
   * subscribe-publish-close-publish observation when a kernel's bus is not reachable.
   */
  readonly internalTransportClosed?: (engine: TEngine) => boolean | Promise<boolean>;

  /**
   * Bind with a deliberately UNMET runtime requirement. Must reject/throw (§11.5).
   * Enables `bind-verifies-requirements`.
   */
  readonly bindWithUnmetRequirement?: (connection: Connection) => unknown | Promise<unknown>;

  /**
   * Bind with an injected `OutboxStore` whose `transactionalSave` is ABSENT or `false` — the
   * exact shape of a hand-rolled host store. The bind must reject/throw, and the error must
   * NAME `transactionalSave`. Enables `outbox-requires-transactional-save`.
   *
   * ```ts
   * bindWithNonTransactionalOutbox: (connection) =>
   *   defineX({ … }).bind(connection, { outbox: { save: async () => undefined } as never }),
   * ```
   *
   * ## When to supply it — and when a reasoned `skip` is the RIGHT answer
   *
   * The rule is **"this kernel persists outbox rows that must commit atomically with the state
   * change they describe"**, NOT "this kernel's runtime happens to accept an `outbox`". Of the
   * 32 kernels that thread an outbox through their runtime, only three verified the flag; but
   * the remedy for the other 29 is a JUDGEMENT per kernel, not a sweep.
   *
   * Supply it when a rolled-back write could still emit its event and a downstream consumer
   * would ACT on the ghost — a sale that never committed paying a commission, an access grant
   * that never committed syncing a credential. That is the case `@classytic/access` and
   * `@classytic/referral` gate at boot.
   *
   * SKIP it, with the reason stating so, when the kernel's outbox use is genuinely best-effort:
   * the events are notifications/telemetry that a later reconciliation would correct, or nothing
   * downstream takes an irreversible action on them. Inventing a requirement no code path needs
   * is decoration of the opposite kind — a recorded remedy for `referral` demanded `transactions`
   * on the belief that `convert()` wrote a row AND bumped a counter, when `attributeSale` is one
   * read plus one atomic `getOrCreate`. Read the write paths before deciding.
   *
   * A kernel whose runtime accepts no outbox at all skips with that as the reason.
   */
  readonly bindWithNonTransactionalOutbox?: (connection: Connection) => unknown | Promise<unknown>;

  /**
   * A blueprint describing the kernel with its OPTIONAL modules disabled. Enables
   * `optional-modules-register-no-models` (§11.10).
   */
  readonly minimalBlueprint?: () => TBlueprint;

  /**
   * Explicit, reasoned opt-outs. Unknown or duplicate ids throw at call time. Every skip is
   * printed and registered as a visible marker test.
   */
  readonly skip?: readonly ConformanceSkip[];

  /** Receives the manifest before any test runs. Defaults to a `console` summary. */
  readonly onReport?: (report: KernelConformanceReport) => void;
}
