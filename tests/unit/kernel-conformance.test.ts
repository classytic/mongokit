/**
 * FALSIFICATION suite for `@classytic/mongokit/kernel-conformance`.
 *
 * A conformance suite that cannot fail is worse than no suite: it converts "nobody checked"
 * into "we verified it". So every check is exercised twice — once against a conformant fake
 * kernel (must pass) and once against a fake broken in exactly that one way (must fail, with
 * a message that names the defect).
 *
 * The broken variants are modelled on real findings: index sync inside `bind`, a supplied
 * transport closed by the engine, an owned bus never closed, and `syncIndexes()` swallowing
 * per-model rejections (the ledger defect).
 */
import mongoose, { type Connection, type Model } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConformanceCheck,
  type ConformanceRunner,
  createConformanceTransport,
  describeKernelConformance,
  type EventTransportLike,
  KERNEL_CONFORMANCE_CHECKS,
  type KernelBlueprintLike,
} from '../../src/kernel-conformance/index.js';
import { defineModels } from '../../src/model-blueprint.js';

// ─── A fake kernel with individually switchable defects ──────────────────────

interface FakeFlags {
  eagerDescribe?: boolean;
  syncIndexesOnBind?: boolean;
  reuseOnCollision?: boolean;
  closeSuppliedTransport?: boolean;
  neverCloseOwnBus?: boolean;
  throwOnSecondClose?: boolean;
  swallowIndexErrors?: boolean;
  omitSyncIndexes?: boolean;
  registerUndeclaredModel?: boolean;
  registerOnGlobal?: boolean;
  sharedSchema?: boolean;
  exposeDestroy?: boolean;
  autoIndexOn?: boolean;
  /** Threads an injected outbox through the runtime without verifying `transactionalSave`. */
  acceptNonTransactionalOutbox?: boolean;
  /** Refuses the outbox, but with a diagnostic that never names the unmet capability. */
  outboxErrorNamesWrongLayer?: boolean;
}

/** Structural stand-in for `@classytic/primitives`' `OutboxStore`. */
interface FakeOutbox {
  readonly transactionalSave?: boolean;
  save(): Promise<void>;
}

interface FakeEngine {
  models: { M: Model<unknown> };
  events: EventTransportLike;
  syncIndexes?: () => Promise<void>;
  close: () => Promise<void>;
  destroy?: () => void;
}

interface FakeBlueprint extends KernelBlueprintLike {
  readonly id: 'fake';
  bind(connection: Connection, transport?: EventTransportLike, outbox?: FakeOutbox): FakeEngine;
}

let seq = 0;
let globalLeak = 0;
const GLOBAL_PREFIX = 'ConfFake';

function buildSchema(autoIndexOn = false): mongoose.Schema {
  const schema = new mongoose.Schema({ v: String }, autoIndexOn ? {} : { autoIndex: false });
  schema.index({ v: 1 });
  return schema;
}

function makeFakeKernel(flags: FakeFlags = {}) {
  seq += 1;
  const modelName = `${GLOBAL_PREFIX}${seq}`;
  const shared = flags.sharedSchema ? buildSchema(flags.autoIndexOn) : undefined;

  const defineFake = (): FakeBlueprint => {
    if (flags.eagerDescribe && !mongoose.models[modelName]) {
      mongoose.model(modelName, buildSchema());
    }
    const blueprint = defineModels<{ M: Model<unknown> }>({
      models: [
        {
          name: modelName,
          schema: () => shared ?? buildSchema(flags.autoIndexOn),
          existing: flags.reuseOnCollision ? { mode: 'reuse' } : { mode: 'throw' },
        },
      ],
      assemble: (m) => ({ M: m.get(modelName) as Model<unknown> }),
    });

    return {
      id: 'fake',
      modelNames: blueprint.modelNames,
      bind(
        connection: Connection,
        supplied?: EventTransportLike,
        outbox?: FakeOutbox,
      ): FakeEngine {
        // The conformant boot gate: FIRST statement, before the model blueprint binds, so a
        // refused bind never mutated the registry and the cheaper error reports first.
        if (outbox && outbox.transactionalSave !== true && !flags.acceptNonTransactionalOutbox) {
          throw new Error(
            flags.outboxErrorNamesWrongLayer
              ? '[fake] missing required capabilities — the backend must support them (mongokit 3.16+)'
              : '[fake] missing required capabilities: outbox.transactionalSave (the configured ' +
                'OutboxStore does not declare that save() enlists ctx.session)',
          );
        }
        const models = blueprint.bind(connection);
        if (flags.registerUndeclaredModel) connection.model(`${modelName}Extra`, buildSchema());
        if (flags.registerOnGlobal) {
          // A fresh name per bind: the check compares the global registry immediately
          // before and after ITS bind, so a name registered by an earlier check would
          // already be in the baseline.
          globalLeak += 1;
          mongoose.model(`${modelName}Global${globalLeak}`, buildSchema());
        }
        if (flags.syncIndexesOnBind) void models.M.syncIndexes();

        const ownsTransport = supplied === undefined;
        const transport = supplied ?? createConformanceTransport(`fake-${modelName}`);
        let closed = false;

        const engine: FakeEngine = {
          models,
          events: transport,
          async close() {
            if (flags.throwOnSecondClose && closed) throw new Error('already closed');
            closed = true;
            if (flags.closeSuppliedTransport) await transport.close?.();
            else if (ownsTransport && !flags.neverCloseOwnBus) await transport.close?.();
          },
        };
        if (!flags.omitSyncIndexes) {
          engine.syncIndexes = async () => {
            const results = await Promise.allSettled([models.M.syncIndexes()]);
            if (flags.swallowIndexErrors) return;
            for (const r of results) if (r.status === 'rejected') throw r.reason;
          };
        }
        if (flags.exposeDestroy) engine.destroy = () => undefined;
        return engine;
      },
    };
  };

  return { defineFake, modelName };
}

// ─── A capturing runner: run the suite, collect per-check outcomes ───────────

interface CapturedTest {
  name: string;
  fn: () => void | Promise<void>;
}

function captureRunner(): { runner: ConformanceRunner; tests: CapturedTest[] } {
  const tests: CapturedTest[] = [];
  return {
    tests,
    runner: {
      describe: (_name, fn) => fn(),
      it: (name, fn) => {
        tests.push({ name, fn });
      },
    },
  };
}

interface SuiteOutcome {
  failures: Map<ConformanceCheck, string>;
  passed: Set<string>;
  names: string[];
}

async function runSuite(
  configure: (runner: ConformanceRunner, report: unknown[]) => void,
): Promise<SuiteOutcome> {
  const { runner, tests } = captureRunner();
  const reports: unknown[] = [];
  configure(runner, reports);
  const failures = new Map<ConformanceCheck, string>();
  const passed = new Set<string>();
  for (const t of tests) {
    try {
      await t.fn();
      passed.add(t.name);
    } catch (err) {
      const check = KERNEL_CONFORMANCE_CHECKS.find((c) => t.name.startsWith(`${c} —`));
      failures.set((check ?? t.name) as ConformanceCheck, (err as Error).message);
    }
  }
  return { failures, passed, names: tests.map((t) => t.name) };
}

function conformanceFor(
  kernel: ReturnType<typeof makeFakeKernel>,
  runner: ConformanceRunner,
  overrides: Record<string, unknown> = {},
): void {
  describeKernelConformance<FakeBlueprint, FakeEngine>({
    name: 'fake',
    runner,
    blueprint: kernel.defineFake,
    connect: async () => mongoose.createConnection(),
    bind: (bp, connection, ctx) => bp.bind(connection, ctx.transport),
    expectedModelNames: [kernel.modelName],
    moduleExports: { defineFake: kernel.defineFake },
    onReport: () => undefined,
    ...overrides,
  } as never);
}

afterEach(() => {
  for (const name of Object.keys(mongoose.models)) {
    if (name.startsWith(GLOBAL_PREFIX)) mongoose.deleteModel(name);
  }
});

// ─── Baseline: a conformant kernel passes every runnable check ───────────────

describe('kernel-conformance — a conformant kernel passes', () => {
  it('reports zero failures and one test per check', async () => {
    const kernel = makeFakeKernel();
    const outcome = await runSuite((runner) => conformanceFor(kernel, runner));
    expect([...outcome.failures.entries()]).toEqual([]);
    // Exactly one test per check — skipped and not-exercised checks still emit a marker,
    // so the test count never silently shrinks when a check stops running.
    expect(outcome.names).toHaveLength(KERNEL_CONFORMANCE_CHECKS.length);
  });

  it('emits a visible marker for the conditional checks nobody wired', async () => {
    const kernel = makeFakeKernel();
    const outcome = await runSuite((runner) => conformanceFor(kernel, runner));
    expect(
      outcome.names.filter((n) => n.startsWith('[NOT EXERCISED] bind-verifies-requirements')),
    ).toHaveLength(1);
    expect(
      outcome.names.filter((n) =>
        n.startsWith('[NOT EXERCISED] optional-modules-register-no-models'),
      ),
    ).toHaveLength(1);
    // A kernel that never wires the outbox opt must be VISIBLY unexercised, never a silent
    // pass — 29 kernels thread an outbox and verify nothing, and a green tick would say the
    // opposite.
    expect(
      outcome.names.filter((n) =>
        n.startsWith(
          '[NOT EXERCISED] outbox-requires-transactional-save — supply ' +
            'opts.bindWithNonTransactionalOutbox',
        ),
      ),
    ).toHaveLength(1);
  });
});

// ─── Falsification: each defect fails exactly its own check ──────────────────

/**
 * Wire the conditional outbox check: bind the fake with a structurally valid `OutboxStore`
 * that simply does not promise session enlistment — `transactionalSave` absent, exactly the
 * shape of a hand-rolled host store.
 */
const withNonTransactionalOutbox = (kernel: ReturnType<typeof makeFakeKernel>) => ({
  bindWithNonTransactionalOutbox: (connection: Connection) =>
    kernel.defineFake().bind(connection, undefined, { save: async () => undefined }),
});

const FALSIFICATIONS: ReadonlyArray<{
  label: string;
  flags: FakeFlags;
  check: ConformanceCheck;
  messageIncludes: string;
  /** Extra conformance options this defect needs to be OBSERVABLE (conditional checks). */
  overrides?: (kernel: ReturnType<typeof makeFakeKernel>) => Record<string, unknown>;
}> = [
  {
    label: 'describe registers a model (eager construction)',
    flags: { eagerDescribe: true },
    check: 'describe-purity',
    messageIncludes: 'describe compiled models',
  },
  {
    label: 'bind synchronizes indexes',
    flags: { syncIndexesOnBind: true },
    check: 'bind-no-index-io',
    messageIncludes: 'bind performed index I/O',
  },
  {
    label: 'a second bind silently reuses the model',
    flags: { reuseOnCollision: true },
    check: 'double-bind-collision',
    messageIncludes: 'did not throw',
  },
  {
    label: 'close() closes a host-supplied transport',
    flags: { closeSuppliedTransport: true },
    check: 'transport-not-closed-when-supplied',
    messageIncludes: 'closed the SUPPLIED transport',
  },
  {
    label: 'close() leaks the bus it created',
    flags: { neverCloseOwnBus: true },
    check: 'owned-transport-closed',
    messageIncludes: 'still delivers after close()',
  },
  {
    label: 'close() is not idempotent',
    flags: { throwOnSecondClose: true },
    check: 'close-idempotent',
    messageIncludes: 'second close() threw',
  },
  {
    label: 'syncIndexes() swallows per-model failures',
    flags: { swallowIndexErrors: true },
    check: 'maintenance-fails-loud',
    messageIncludes: 'RESOLVED while every one of',
  },
  {
    label: 'the engine has no syncIndexes()',
    flags: { omitSyncIndexes: true },
    check: 'maintenance-fails-loud',
    messageIncludes: 'exposes no syncIndexes()',
  },
  {
    label: 'bind registers an undeclared model',
    flags: { registerUndeclaredModel: true },
    check: 'bind-registers-declared-models',
    messageIncludes: 'registered UNDECLARED models',
  },
  {
    label: 'bind registers on the global mongoose registry',
    flags: { registerOnGlobal: true },
    check: 'bind-connection-scoped',
    messageIncludes: 'on the GLOBAL mongoose registry',
  },
  {
    label: 'one Schema instance is shared across connections',
    flags: { sharedSchema: true },
    check: 'fresh-schema-per-connection',
    messageIncludes: 'SHARES one Schema instance',
  },
  {
    label: 'a bound schema leaves mongoose autoIndex enabled',
    flags: { autoIndexOn: true },
    check: 'no-autoindex-on-bind',
    messageIncludes: 'leave autoIndex enabled',
  },
  {
    label: 'the engine still exposes destroy()',
    flags: { exposeDestroy: true },
    check: 'no-legacy-surface',
    messageIncludes: "still exposes 'destroy()'",
  },
  {
    // The 29-kernel defect: `outbox` threaded through the runtime with zero references to
    // `transactionalSave` — no boot gate, no per-call refusal. Non-atomic event persistence
    // that nothing anywhere reports.
    label: 'bind accepts an outbox that never promises session enlistment',
    flags: { acceptNonTransactionalOutbox: true },
    check: 'outbox-requires-transactional-save',
    messageIncludes: 'ACCEPTED an OutboxStore that does not declare transactionalSave',
    overrides: withNonTransactionalOutbox,
  },
  {
    // Refusing for the right reason but PRINTING the wrong one is still a defect: referral's
    // capability error asserted a backend/mongokit-version remedy for an outbox
    // misconfiguration, sending the reader to a layer that was never involved.
    label: 'bind refuses the outbox but blames the wrong layer',
    flags: { outboxErrorNamesWrongLayer: true },
    check: 'outbox-requires-transactional-save',
    messageIncludes: "never names 'transactionalSave'",
    overrides: withNonTransactionalOutbox,
  },
];

describe('kernel-conformance — falsification (a broken kernel FAILS)', () => {
  for (const scenario of FALSIFICATIONS) {
    it(`${scenario.check}: ${scenario.label}`, async () => {
      const kernel = makeFakeKernel(scenario.flags);
      const outcome = await runSuite((runner) =>
        conformanceFor(kernel, runner, scenario.overrides?.(kernel) ?? {}),
      );
      const message = outcome.failures.get(scenario.check);
      expect(message, `expected '${scenario.check}' to fail but it passed`).toBeDefined();
      expect(message).toContain(scenario.messageIncludes);
    });
  }
});

// ─── Inputs the suite itself must refuse ─────────────────────────────────────

describe('kernel-conformance — expectations and legacy surface', () => {
  it('fails when expectedModelNames does not match exactly', async () => {
    const kernel = makeFakeKernel();
    const outcome = await runSuite((runner) =>
      conformanceFor(kernel, runner, { expectedModelNames: ['NotThisOne'] }),
    );
    expect(outcome.failures.get('blueprint-model-names')).toContain('drifted');
  });

  it('fails when the package still exports a createX factory', async () => {
    const kernel = makeFakeKernel();
    const outcome = await runSuite((runner) =>
      conformanceFor(kernel, runner, {
        moduleExports: { defineFake: kernel.defineFake, createFake: () => undefined },
      }),
    );
    expect(outcome.failures.get('no-legacy-surface')).toContain('createFake');
  });

  it('fails when moduleExports is omitted rather than silently passing', async () => {
    const kernel = makeFakeKernel();
    const outcome = await runSuite((runner) =>
      conformanceFor(kernel, runner, { moduleExports: undefined }),
    );
    expect(outcome.failures.get('no-legacy-surface')).toContain('was not supplied');
  });

  it('fails when the sole construction export is missing', async () => {
    const kernel = makeFakeKernel();
    const outcome = await runSuite((runner) =>
      conformanceFor(kernel, runner, { moduleExports: { somethingElse: 1 } }),
    );
    expect(outcome.failures.get('no-legacy-surface')).toContain("does not export 'defineFake'");
  });
});

// ─── Skips are explicit, reasoned and LOUD ───────────────────────────────────

describe('kernel-conformance — skips cannot be silent', () => {
  it('throws on an unknown check id', () => {
    const kernel = makeFakeKernel();
    expect(() =>
      conformanceFor(kernel, captureRunner().runner, {
        skip: [{ check: 'transport-ownership', reason: 'typo' }],
      }),
    ).toThrow(/unknown check id 'transport-ownership'/);
  });

  it('throws on a skip with no reason', () => {
    const kernel = makeFakeKernel();
    expect(() =>
      conformanceFor(kernel, captureRunner().runner, {
        skip: [{ check: 'owned-transport-closed', reason: '   ' }],
      }),
    ).toThrow(/has no reason/);
  });

  it('throws on a duplicate skip entry', () => {
    const kernel = makeFakeKernel();
    expect(() =>
      conformanceFor(kernel, captureRunner().runner, {
        skip: [
          { check: 'owned-transport-closed', reason: 'a' },
          { check: 'owned-transport-closed', reason: 'b' },
        ],
      }),
    ).toThrow(/duplicate skip entry/);
  });

  it('turns a skipped check into a VISIBLE marker test and reports it', async () => {
    const kernel = makeFakeKernel({ neverCloseOwnBus: true });
    const reports: unknown[] = [];
    const outcome = await runSuite((runner) =>
      conformanceFor(kernel, runner, {
        skip: [{ check: 'owned-transport-closed', reason: 'publish-only transport' }],
        onReport: (r: unknown) => reports.push(r),
      }),
    );
    // The defect is real, but the skip is declared — so it does not fail…
    expect(outcome.failures.get('owned-transport-closed')).toBeUndefined();
    // …and it is impossible to miss: a named test plus a report entry.
    expect(
      outcome.names.some((n) =>
        n.startsWith('[SKIPPED] owned-transport-closed — publish-only transport'),
      ),
    ).toBe(true);
    const report = reports[0] as { skipped: Array<{ check: string; reason: string }> };
    expect(report.skipped).toEqual([
      { check: 'owned-transport-closed', outcome: 'skipped', reason: 'publish-only transport' },
    ]);
  });
});

// ─── Conditional checks run when their input is supplied ─────────────────────

describe('kernel-conformance — conditional checks', () => {
  it('runs bind-verifies-requirements when a failing bind is supplied', async () => {
    const kernel = makeFakeKernel();
    const good = await runSuite((runner) =>
      conformanceFor(kernel, runner, {
        bindWithUnmetRequirement: () => {
          throw new Error('missing catalog port');
        },
      }),
    );
    expect(good.failures.get('bind-verifies-requirements')).toBeUndefined();
    expect(good.names.some((n) => n.startsWith('bind-verifies-requirements —'))).toBe(true);

    const bad = await runSuite((runner) =>
      conformanceFor(makeFakeKernel(), runner, {
        bindWithUnmetRequirement: async () => 'bound anyway',
      }),
    );
    expect(bad.failures.get('bind-verifies-requirements')).toContain('unmet runtime requirement');
  });

  it('runs outbox-requires-transactional-save when the non-transactional bind is supplied', async () => {
    const kernel = makeFakeKernel();
    const outcome = await runSuite((runner) =>
      conformanceFor(kernel, runner, withNonTransactionalOutbox(kernel)),
    );
    expect(outcome.failures.get('outbox-requires-transactional-save')).toBeUndefined();
    // …and it RAN — not a marker test wearing the check's name.
    expect(outcome.names.some((n) => n.startsWith('outbox-requires-transactional-save —'))).toBe(
      true,
    );
  });

  it('accepts a store that DOES declare transactionalSave — the gate is the flag, not the outbox', async () => {
    // Guards against the opposite over-correction: a kernel that refuses every outbox would
    // break every host, and "requires an outbox to be transactional" must not become
    // "refuses an outbox".
    const kernel = makeFakeKernel();
    const connection = mongoose.createConnection();
    expect(() =>
      kernel
        .defineFake()
        .bind(connection, undefined, { transactionalSave: true, save: async () => undefined }),
    ).not.toThrow();
  });
});
