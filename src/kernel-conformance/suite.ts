/**
 * `describeKernelConformance` — the EXECUTABLE form of the Kernel Construction Standard
 * (commerce `STANDARDIZATION-PLAN.md` §11).
 *
 * ## Why this exists
 *
 * ~38 kernels were migrated to Describe → Bind → Verify → Serve → Close and every one of
 * their suites went green. Those suites assert the kernel's OLD behavior still works; almost
 * none assert the STANDARD's invariants. Two real defects survived that green: one kernel
 * swallowed six index-sync errors, another had no transaction gate. Both were reviewer
 * findings, and a reviewer does not scale to 38 packages.
 *
 * So the invariants become tests a consumer RUNS, on the model of arc's port contract suites
 * (`runOutboxStoreContract` et al.): passing the suite IS conformance. Structural conformance
 * (it typechecks, it has a `bind`) is not behavioral conformance.
 *
 * ## Where it lives, and what it may depend on
 *
 * `@classytic/mongokit/kernel-conformance`. Every Mongo-backed kernel already depends on
 * mongokit, and a kernel must NEVER depend on arc — so arc's `testing` subpath, the obvious
 * home, is closed. The suite therefore imports NOTHING beyond mongoose and mongokit's own
 * `ModelCollisionError`: transports, events and engines are structural types.
 *
 * ## Usage
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * import mongoose from 'mongoose';
 * import { describeKernelConformance } from '@classytic/mongokit/kernel-conformance';
 * import * as kernel from '../../src/index.js';
 *
 * describeKernelConformance({
 *   name: 'party',
 *   runner: { describe, it },
 *   blueprint: () => kernel.defineParty({ multiTenant: false, autoIndex: false }),
 *   connect: async () => mongoose.createConnection(),
 *   bind: (bp, conn, ctx) => bp.bind(conn, { eventTransport: ctx.transport }),
 *   expectedModelNames: ['Party'],
 *   moduleExports: kernel,
 *   skip: [{ check: 'bind-verifies-requirements', reason: '…' }],
 * });
 * ```
 */
import mongoose, { type Connection } from 'mongoose';
import { ModelCollisionError } from '../model-registry.js';
import { conformanceEvent, createConformanceTransport, instrumentTransport } from './transport.js';
import {
  CONDITIONAL_CHECKS,
  type ConformanceCheck,
  type ConformanceCheckStatus,
  type ConformanceConnectionHandle,
  type ConformanceEvent,
  type EventTransportLike,
  KERNEL_CONFORMANCE_CHECKS,
  type KernelBlueprintLike,
  type KernelConformanceOptions,
  type KernelConformanceReport,
} from './types.js';

// ─── Assertions (runner-agnostic: no `expect` implementation required) ───────

class ConformanceFailure extends Error {
  constructor(check: ConformanceCheck, message: string) {
    super(`[kernel-conformance:${check}] ${message}`);
    this.name = 'ConformanceFailure';
  }
}

function fail(check: ConformanceCheck, message: string): never {
  throw new ConformanceFailure(check, message);
}

function assert(check: ConformanceCheck, condition: unknown, message: string): asserts condition {
  if (!condition) fail(check, message);
}

function sortedSet(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function diffSets(
  actual: readonly string[],
  expected: readonly string[],
): { missing: string[]; extra: string[] } {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: [...e].filter((x) => !a.has(x)).sort(),
    extra: [...a].filter((x) => !e.has(x)).sort(),
  };
}

/** kebab / snake / space → PascalCase, so `supplier-performance` → `SupplierPerformance`. */
function pascal(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Yield to the macrotask queue so index I/O SCHEDULED by bind is observed, not missed. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Loose views over caller-supplied values ─────────────────────────────────

interface EngineLike {
  close?: () => unknown;
  syncIndexes?: () => unknown;
  destroy?: unknown;
  dispose?: unknown;
  events?: unknown;
  transport?: unknown;
  eventTransport?: unknown;
  bus?: unknown;
}

interface BlueprintLikeInternal extends KernelBlueprintLike {
  bind?: unknown;
}

/** Mongoose model statics the suite spies on or sabotages. Names only — no mongoose types. */
type IndexOp = 'syncIndexes' | 'createIndexes' | 'ensureIndexes' | 'dropIndexes' | 'cleanIndexes';
const INDEX_OPS: readonly IndexOp[] = [
  'syncIndexes',
  'createIndexes',
  'ensureIndexes',
  'dropIndexes',
  'cleanIndexes',
];
/** Ops that create indexes — mongoose's own `autoIndex` also drives these. */
const CREATION_OPS = new Set<IndexOp>(['createIndexes', 'ensureIndexes']);

function isTransportShaped(value: unknown): value is EventTransportLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EventTransportLike).publish === 'function'
  );
}

// ─── The suite ───────────────────────────────────────────────────────────────

export function describeKernelConformance<TBlueprint extends KernelBlueprintLike, TEngine>(
  opts: KernelConformanceOptions<TBlueprint, TEngine>,
): void {
  const { runner, name } = opts;
  const P = pascal(name);

  // ── Resolve every check's outcome UP FRONT, then report it. A skip that nobody can see
  //    is the bug class this suite exists to close, so the manifest is emitted before the
  //    first test and every non-run check still produces a visible marker test.
  const skipReasons = new Map<ConformanceCheck, string>();
  const knownChecks = new Set<string>(KERNEL_CONFORMANCE_CHECKS);
  for (const entry of opts.skip ?? []) {
    if (!knownChecks.has(entry.check)) {
      throw new Error(
        `[kernel-conformance] unknown check id '${entry.check}' in skip list for '${name}'. ` +
          `Known ids: ${KERNEL_CONFORMANCE_CHECKS.join(', ')}.`,
      );
    }
    if (skipReasons.has(entry.check)) {
      throw new Error(
        `[kernel-conformance] duplicate skip entry for '${entry.check}' in kernel '${name}'.`,
      );
    }
    if (!entry.reason || entry.reason.trim().length === 0) {
      throw new Error(
        `[kernel-conformance] skip of '${entry.check}' in kernel '${name}' has no reason. ` +
          'An unexplained skip is indistinguishable from an oversight — state why.',
      );
    }
    skipReasons.set(entry.check, entry.reason.trim());
  }

  const conditionalInputs: Partial<Record<ConformanceCheck, string>> = {
    'bind-verifies-requirements': 'bindWithUnmetRequirement',
    'outbox-requires-transactional-save': 'bindWithNonTransactionalOutbox',
    'optional-modules-register-no-models': 'minimalBlueprint',
  };
  const conditionalSupplied: Partial<Record<ConformanceCheck, boolean>> = {
    'bind-verifies-requirements': opts.bindWithUnmetRequirement !== undefined,
    'outbox-requires-transactional-save': opts.bindWithNonTransactionalOutbox !== undefined,
    'optional-modules-register-no-models': opts.minimalBlueprint !== undefined,
  };

  const statuses: ConformanceCheckStatus[] = KERNEL_CONFORMANCE_CHECKS.map((check) => {
    const reason = skipReasons.get(check);
    if (reason !== undefined) return { check, outcome: 'skipped' as const, reason };
    if ((CONDITIONAL_CHECKS as readonly string[]).includes(check) && !conditionalSupplied[check]) {
      return {
        check,
        outcome: 'not-exercised' as const,
        reason: `supply opts.${conditionalInputs[check]} to exercise this check`,
      };
    }
    return { check, outcome: 'run' as const };
  });
  const statusOf = new Map(statuses.map((s) => [s.check, s]));

  const report: KernelConformanceReport = {
    kernel: name,
    checks: statuses,
    skipped: statuses.filter((s) => s.outcome === 'skipped'),
    notExercised: statuses.filter((s) => s.outcome === 'not-exercised'),
  };
  (opts.onReport ?? defaultReport)(report);

  // ── Connection lifecycle ──────────────────────────────────────────────────
  async function withConnection<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const acquired = await opts.connect();
    const handle: ConformanceConnectionHandle =
      'connection' in acquired
        ? (acquired as ConformanceConnectionHandle)
        : { connection: acquired as Connection };
    try {
      return await fn(handle.connection);
    } finally {
      await handle.teardown?.();
    }
  }

  const bind = (blueprint: TBlueprint, connection: Connection, transport?: EventTransportLike) =>
    opts.bind(blueprint, connection, transport ? { transport } : {});

  // ── Registration ──────────────────────────────────────────────────────────
  function register(check: ConformanceCheck, title: string, fn: () => Promise<void> | void): void {
    const status = statusOf.get(check);
    if (status?.outcome === 'skipped') {
      runner.it(`[SKIPPED] ${check} — ${status.reason}`, () => {
        assert(check, (status.reason ?? '').length > 0, 'a skip must carry a reason');
      });
      return;
    }
    if (status?.outcome === 'not-exercised') {
      runner.it(`[NOT EXERCISED] ${check} — ${status.reason}`, () => undefined);
      return;
    }
    runner.it(`${check} — ${title}`, fn);
  }

  runner.describe(`kernel conformance: ${name}`, () => {
    // ─────────────────────────────────────────────────────────────────────────
    register('describe-purity', 'defineX registers no model and performs no I/O', async () => {
      const check: ConformanceCheck = 'describe-purity';
      await withConnection(async (connection) => {
        const globalBefore = sortedSet(Object.keys(mongoose.models));
        const connBefore = sortedSet(Object.keys(connection.models));

        const calls: string[] = [];
        const realGlobalModel = mongoose.model.bind(mongoose);
        const realConnModel = connection.model.bind(connection);
        const mutableMongoose = mongoose as unknown as Record<string, unknown>;
        const mutableConn = connection as unknown as Record<string, unknown>;
        mutableMongoose.model = (...args: unknown[]) => {
          calls.push(`mongoose.model('${String(args[0])}')`);
          return (realGlobalModel as (...a: unknown[]) => unknown)(...args);
        };
        mutableConn.model = (...args: unknown[]) => {
          calls.push(`connection.model('${String(args[0])}')`);
          return (realConnModel as (...a: unknown[]) => unknown)(...args);
        };

        let blueprint: TBlueprint;
        try {
          blueprint = opts.blueprint();
        } finally {
          mutableMongoose.model = realGlobalModel;
          mutableConn.model = realConnModel;
        }

        assert(
          check,
          calls.length === 0,
          `describe compiled models — it called ${calls.join(', ')}. ` +
            'defineX must only validate + freeze the model NAMES; registration belongs to bind.',
        );
        const globalAfter = sortedSet(Object.keys(mongoose.models));
        assert(
          check,
          globalAfter.join() === globalBefore.join(),
          `describe mutated the GLOBAL mongoose registry: +[${diffSets(globalAfter, globalBefore).extra.join(', ')}]`,
        );
        const connAfter = sortedSet(Object.keys(connection.models));
        assert(
          check,
          connAfter.join() === connBefore.join(),
          `describe mutated the connection registry: +[${diffSets(connAfter, connBefore).extra.join(', ')}]`,
        );

        // Describe must also be REPEATABLE and deterministic — it is called at import time
        // in every host, sometimes more than once.
        const second = opts.blueprint();
        assert(
          check,
          sortedSet(second.modelNames).join() === sortedSet(blueprint.modelNames).join(),
          'two describe calls produced different model sets — describe is not deterministic',
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    register('blueprint-model-names', 'modelNames is non-empty, frozen and exact', () => {
      const check: ConformanceCheck = 'blueprint-model-names';
      const blueprint = opts.blueprint();
      const names = blueprint.modelNames;
      assert(check, Array.isArray(names), 'blueprint.modelNames must be an array');
      assert(
        check,
        names.length > 0,
        'blueprint.modelNames is empty — a Mongo-backed kernel must DECLARE its models so a ' +
          'collision can be diagnosed before a connection exists',
      );
      assert(
        check,
        Object.isFrozen(names),
        'blueprint.modelNames is not frozen — a caller could mutate the declared model set ' +
          'after describe, and the declaration is the collision-diagnostic contract',
      );
      assert(
        check,
        new Set(names).size === names.length,
        `blueprint.modelNames contains duplicates: [${names.join(', ')}]`,
      );
      if (opts.expectedModelNames) {
        const { missing, extra } = diffSets(names, opts.expectedModelNames);
        assert(
          check,
          missing.length === 0 && extra.length === 0,
          `declared model set drifted from expectedModelNames — missing [${missing.join(', ')}], ` +
            `unexpected [${extra.join(', ')}]`,
        );
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'bind-registers-declared-models',
      'bind registers EXACTLY the declared models on the supplied connection',
      async () => {
        const check: ConformanceCheck = 'bind-registers-declared-models';
        await withConnection(async (connection) => {
          const before = new Set(Object.keys(connection.models));
          const blueprint = opts.blueprint();
          await bind(blueprint, connection);
          const registered = Object.keys(connection.models).filter((n) => !before.has(n));
          const { missing, extra } = diffSets(registered, blueprint.modelNames);
          assert(
            check,
            missing.length === 0,
            `bind DECLARED but did not register [${missing.join(', ')}] — a declared-but-absent ` +
              'model means the collision diagnostic lies about what this kernel owns',
          );
          assert(
            check,
            extra.length === 0,
            `bind registered UNDECLARED models [${extra.join(', ')}] — every model must appear ` +
              'in blueprint.modelNames or a second kernel can silently collide with it',
          );
        });
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'bind-connection-scoped',
      'bind never touches the global mongoose registry',
      async () => {
        const check: ConformanceCheck = 'bind-connection-scoped';
        await withConnection(async (connection) => {
          const before = sortedSet(Object.keys(mongoose.models));
          await bind(opts.blueprint(), connection);
          const after = sortedSet(Object.keys(mongoose.models));
          const { extra } = diffSets(after, before);
          assert(
            check,
            extra.length === 0,
            `bind registered [${extra.join(', ')}] on the GLOBAL mongoose registry. A connection ` +
              'was supplied, so registration must be connection-local (§5.2) — a global model ' +
              'leaks across every connection in the process, including other tenants/tests',
          );
        });
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    register('bind-no-index-io', 'bind synchronizes, creates or drops NO index', async () => {
      const check: ConformanceCheck = 'bind-no-index-io';
      await withConnection(async (connection) => {
        const ModelBase = mongoose.Model as unknown as Record<string, unknown>;
        const originals = new Map<string, unknown>();
        const explicit: string[] = [];
        const autoIndexDriven: string[] = [];
        let insideInit = 0;

        const originalInit = ModelBase.init;
        ModelBase.init = function patchedInit(this: unknown, ...args: unknown[]) {
          insideInit += 1;
          let settled = false;
          try {
            const result = (originalInit as (...a: unknown[]) => unknown).apply(this, args);
            if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
              settled = true;
              return Promise.resolve(result).finally(() => {
                insideInit -= 1;
              });
            }
            return result;
          } finally {
            if (!settled) insideInit -= 1;
          }
        };

        for (const op of INDEX_OPS) {
          originals.set(op, ModelBase[op]);
          ModelBase[op] = function patched(this: { modelName?: string }) {
            const label = `${this?.modelName ?? '<model>'}.${op}()`;
            // mongoose's OWN `autoIndex` build runs inside `Model.init()`. That is a schema
            // option (§8.1 deployment policy), not something bind called — separate it so
            // the failure message names the real cause instead of blaming the kernel.
            if (insideInit > 0 && CREATION_OPS.has(op)) autoIndexDriven.push(label);
            else explicit.push(label);
            return Promise.resolve([]);
          };
        }

        try {
          const blueprint = opts.blueprint();
          await bind(blueprint, connection);
          // Catch index work bind merely SCHEDULED (a floating promise still hits the DB).
          await macrotask();
          // …and DRAIN mongoose's own per-model init, which is where `autoIndex` builds
          // indexes on a live connection. Awaiting `$init` is deterministic; a fixed delay
          // would make this check pass on a fast machine and fail on a slow one, which is
          // worse than not checking at all.
          //
          // ONLY when the connection is actually open (readyState 1). Mongoose defers `$init`
          // until connect, so on the registry-only connection this suite recommends it would
          // never settle — an await that hangs forever is not a stricter check, it is a
          // 200-second timeout in every consumer.
          if (connection.readyState === 1) {
            await Promise.all(
              blueprint.modelNames
                .map((n) => (connection.models[n] as unknown as { $init?: unknown })?.$init)
                .filter((p): p is PromiseLike<unknown> => Boolean(p))
                .map((p) => Promise.resolve(p).catch(() => undefined)),
            );
          }
        } finally {
          ModelBase.init = originalInit;
          for (const [op, fn] of originals) ModelBase[op] = fn;
        }

        assert(
          check,
          explicit.length === 0,
          `bind performed index I/O: ${explicit.join(', ')}. §11.11 — binding never ` +
            'synchronizes or drops indexes; index reconciliation is an explicit operational ' +
            'action (engine.syncIndexes()), never a constructor side effect.' +
            (autoIndexDriven.length > 0
              ? ` (${autoIndexDriven.length} further call(s) came from mongoose autoIndex and were not counted.)`
              : ''),
        );
        assert(
          check,
          autoIndexDriven.length === 0,
          `mongoose autoIndex built indexes during bind: ${autoIndexDriven.join(', ')}. ` +
            'Describe the conformance blueprint with autoIndex:false (§8.1) — a production ' +
            'kernel must not create indexes as a side effect of construction. ' +
            '(See the no-autoindex-on-bind check for the connection-independent form.)',
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    register('no-autoindex-on-bind', 'every bound schema disables mongoose autoIndex', async () => {
      const check: ConformanceCheck = 'no-autoindex-on-bind';
      await withConnection(async (connection) => {
        const blueprint = opts.blueprint();
        await bind(blueprint, connection);
        // Deterministic and connection-independent: read the compiled schema rather than
        // watching for index calls, which only fire on an OPEN connection. This is also
        // the "did the flag survive the write?" check — a per-model autoIndex map that
        // misses one schema typechecks everywhere and protects nothing.
        const offenders = blueprint.modelNames.filter((n) => {
          const model = connection.models[n];
          return model !== undefined && model.schema.options.autoIndex !== false;
        });
        assert(
          check,
          offenders.length === 0,
          `these bound schemas leave autoIndex enabled: [${offenders.join(', ')}]. Mongoose ` +
            'DEFAULTS autoIndex to true, so an unset option is not neutral — every bind ' +
            'against a live connection issues createIndex for every declared index, making ' +
            'index reconciliation an accidental constructor effect (§8.1/§8.2). Set ' +
            'autoIndex:false on the schema (or describe the blueprint with it) and reconcile ' +
            'through the explicit engine.syncIndexes() path.',
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'fresh-schema-per-connection',
      'one blueprint binds to two connections with distinct models and schemas',
      async () => {
        const check: ConformanceCheck = 'fresh-schema-per-connection';
        const blueprint = opts.blueprint();
        await withConnection(async (connA) => {
          await withConnection(async (connB) => {
            await bind(blueprint, connA);
            await bind(blueprint, connB);
            for (const modelName of blueprint.modelNames) {
              const a = connA.models[modelName];
              const b = connB.models[modelName];
              assert(check, a !== undefined, `model '${modelName}' missing on connection A`);
              assert(check, b !== undefined, `model '${modelName}' missing on connection B`);
              assert(
                check,
                a !== b,
                `model '${modelName}' is the SAME object on two connections — the blueprint ` +
                  'reused a compiled model, so writes route to one connection',
              );
              assert(
                check,
                a?.schema !== b?.schema,
                `model '${modelName}' SHARES one Schema instance across connections (§11.3). ` +
                  'A schema must be a FACTORY: mongoose mutates schemas (plugins, indexes, ' +
                  'discriminators), so a shared instance leaks one engine’s config into another',
              );
            }
          });
        });
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'double-bind-collision',
      'a second bind on one connection throws mongokit ModelCollisionError',
      async () => {
        const check: ConformanceCheck = 'double-bind-collision';
        await withConnection(async (connection) => {
          const blueprint = opts.blueprint();
          await bind(blueprint, connection);
          let error: unknown;
          try {
            await bind(opts.blueprint(), connection);
          } catch (err) {
            error = err;
          }
          assert(
            check,
            error !== undefined,
            'binding twice on ONE connection did not throw. Silent reuse drops every field and ' +
              'index the second bind would have contributed (§11.2/§11.12) — it must fail loud.',
          );
          const err = error as { name?: string; modelName?: unknown };
          assert(
            check,
            error instanceof ModelCollisionError || err?.name === 'ModelCollisionError',
            `double bind threw ${(error as Error)?.name ?? typeof error} — it must be mongokit's ` +
              'typed ModelCollisionError, not a generic Error and not a kernel-specific ' +
              'collision class (§11.12: one collision error for every kernel).',
          );
          assert(
            check,
            typeof err.modelName === 'string' && err.modelName.length > 0,
            'ModelCollisionError carried no .modelName — the diagnostic must name the model ' +
              'that collided',
          );
          assert(
            check,
            blueprint.modelNames.includes(err.modelName as string),
            `ModelCollisionError named '${String(err.modelName)}', which is not in the declared ` +
              `model set [${blueprint.modelNames.join(', ')}]`,
          );
        });
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'transport-not-closed-when-supplied',
      'close() never closes a host-supplied transport',
      async () => {
        const check: ConformanceCheck = 'transport-not-closed-when-supplied';
        await withConnection(async (connection) => {
          const supplied = instrumentTransport(
            (opts.makeTransport ?? createConformanceTransport)(),
          );
          const engine = (await bind(
            opts.blueprint(),
            connection,
            supplied.transport,
          )) as unknown as EngineLike;
          assert(check, typeof engine.close === 'function', 'engine exposes no close()');
          await engine.close?.();
          assert(
            check,
            supplied.closeCalls() === 0,
            `close() closed the SUPPLIED transport (${supplied.closeCalls()} call(s)). A host ` +
              'transport is usually arc’s shared bus — closing it from one kernel silences ' +
              'events for every other module, and nothing errors (§11.7).',
          );
          // Ownership is only meaningful if the transport still WORKS afterwards.
          let delivered = 0;
          const unsubscribe = await supplied.transport.subscribe?.('*', () => {
            delivered += 1;
          });
          await supplied.transport.publish(conformanceEvent('conformance.after-close'));
          if (typeof unsubscribe === 'function') unsubscribe();
          assert(
            check,
            delivered === 1,
            'the supplied transport stopped delivering after engine.close() — it was closed or ' +
              'otherwise disabled by the kernel',
          );
        });
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    register('owned-transport-closed', 'close() closes the internally-created bus', async () => {
      const check: ConformanceCheck = 'owned-transport-closed';
      await withConnection(async (connection) => {
        const engine = await bind(opts.blueprint(), connection);
        const engineLike = engine as unknown as EngineLike;
        assert(check, typeof engineLike.close === 'function', 'engine exposes no close()');

        if (opts.internalTransportClosed) {
          await engineLike.close?.();
          const closed = await opts.internalTransportClosed(engine);
          assert(
            check,
            closed === true,
            'internalTransportClosed() reported the internally-created bus was NOT closed — a ' +
              'bus the kernel created is a resource the kernel must release (§11.7)',
          );
          return;
        }

        const resolved =
          opts.resolveInternalTransport?.(engine) ??
          [engineLike.events, engineLike.transport, engineLike.eventTransport, engineLike.bus].find(
            isTransportShaped,
          );
        assert(
          check,
          isTransportShaped(resolved),
          'could not find the engine’s internal transport. Supply opts.resolveInternalTransport ' +
            '(or opts.internalTransportClosed), or skip this check with a reason — a kernel that ' +
            'creates a bus it never closes leaks it on every module restart.',
        );
        const transport = resolved as EventTransportLike;
        assert(
          check,
          typeof transport.subscribe === 'function',
          'the engine’s transport has no subscribe(), so closure is unobservable. Supply ' +
            'opts.internalTransportClosed.',
        );

        let delivered = 0;
        const handler = (_event: ConformanceEvent) => {
          delivered += 1;
        };
        await transport.subscribe?.('*', handler);
        await transport.publish(conformanceEvent('conformance.before-close'));
        assert(
          check,
          delivered === 1,
          'the internal transport did not deliver BEFORE close — the probe cannot distinguish ' +
            'a closed bus from a broken one. Supply opts.internalTransportClosed.',
        );

        await engineLike.close?.();
        await transport.publish(conformanceEvent('conformance.after-close'));
        assert(
          check,
          delivered === 1,
          'the internally-created bus still delivers after close() — the kernel created it, so ' +
            'the kernel owns it and must close it (§11.7). Subscriptions survive every restart.',
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    register('close-idempotent', 'close() twice does not throw', async () => {
      const check: ConformanceCheck = 'close-idempotent';
      await withConnection(async (connection) => {
        const engine = (await bind(opts.blueprint(), connection)) as unknown as EngineLike;
        assert(check, typeof engine.close === 'function', 'engine exposes no close()');
        await engine.close?.();
        try {
          await engine.close?.();
        } catch (err) {
          fail(
            check,
            `the second close() threw (${(err as Error)?.message}). Arc tears modules down in ` +
              'reverse order and a host may also close explicitly, so close() is called twice ' +
              'routinely (§6.4).',
          );
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    register('no-legacy-surface', 'one construction API, one teardown name', async () => {
      const check: ConformanceCheck = 'no-legacy-surface';
      const blueprint = opts.blueprint() as BlueprintLikeInternal;
      assert(
        check,
        typeof blueprint.bind === 'function',
        'the blueprint exposes no bind() — defineX(shape).bind(connection, runtime) is the sole ' +
          'construction API (§11.12)',
      );

      await withConnection(async (connection) => {
        const engine = (await bind(opts.blueprint(), connection)) as unknown as EngineLike &
          Record<string, unknown>;
        assert(check, typeof engine.close === 'function', 'engine exposes no close()');
        for (const legacy of ['destroy', 'dispose'] as const) {
          assert(
            check,
            engine[legacy] === undefined,
            `the engine still exposes '${legacy}()'. close() is the ONE teardown name — an alias ` +
              'means two teardown paths that drift (§11.12).',
          );
        }
      });

      const exportNames: string[] | undefined = Array.isArray(opts.moduleExports)
        ? [...(opts.moduleExports as readonly string[])]
        : opts.moduleExports
          ? Object.keys(opts.moduleExports as Record<string, unknown>)
          : undefined;
      assert(
        check,
        exportNames !== undefined,
        'opts.moduleExports was not supplied, so the package surface could not be inspected. ' +
          "Pass the namespace (`import * as kernel from '../../src/index.js'`) or a name list — " +
          'or skip this check with a reason. A legacy factory nobody looks at is exactly how two ' +
          'construction APIs survive a migration.',
      );
      const exported = new Set(exportNames);
      const construction = opts.constructionExportName ?? `define${P}`;
      assert(
        check,
        exported.has(construction),
        `the package does not export '${construction}'. The sole construction API must be a ` +
          'named export (§11.12); pass opts.constructionExportName if it is named differently.',
      );
      const forbidden = [
        `create${P}`,
        `create${P}Engine`,
        `ensure${P}Engine`,
        `get${P}Engine`,
        `destroy${P}Engine`,
        `${P}ModelCollisionError`,
        ...(opts.forbiddenExportNames ?? []),
      ];
      const present = forbidden.filter((n) => exported.has(n));
      assert(
        check,
        present.length === 0,
        `the package still exports legacy construction/teardown surface [${present.join(', ')}]. ` +
          'NO LEGACY / NO COMPAT SHIMS: exactly one construction API and one collision error ' +
          '(mongokit’s ModelCollisionError) per kernel (§11.12).',
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'maintenance-fails-loud',
      'engine.syncIndexes() REJECTS when a model index sync fails',
      async () => {
        const check: ConformanceCheck = 'maintenance-fails-loud';
        await withConnection(async (connection) => {
          const blueprint = opts.blueprint();
          const engine = (await bind(blueprint, connection)) as unknown as EngineLike;
          assert(
            check,
            typeof engine.syncIndexes === 'function',
            'the engine exposes no syncIndexes(). §6.4 requires it — index reconciliation must ' +
              'be an explicit, callable operation. Skip this check with a reason if the kernel ' +
              'genuinely owns no indexes.',
          );

          const sentinel = new Error('kernel-conformance: induced index-sync failure');
          let sabotaged = 0;
          for (const modelName of blueprint.modelNames) {
            const model = connection.models[modelName] as unknown as Record<string, unknown>;
            if (!model) continue;
            sabotaged += 1;
            // Own properties SHADOW the inherited statics, so whichever verb the engine uses
            // (`syncIndexes` in most kernels, `createIndexes` in flow) is intercepted.
            for (const op of INDEX_OPS) {
              model[op] = () => Promise.reject(sentinel);
            }
          }
          assert(check, sabotaged > 0, 'no declared model was registered — nothing to sabotage');

          let rejected = false;
          try {
            await engine.syncIndexes?.();
          } catch {
            rejected = true;
          }
          assert(
            check,
            rejected,
            `engine.syncIndexes() RESOLVED while every one of ${sabotaged} model index sync(s) ` +
              'rejected. A swallowed index-sync error means an operator runs the maintenance ' +
              'command, sees success, and ships with the indexes missing — the exact defect this ' +
              'check generalizes. Never catch-and-continue here; aggregate and reject.',
          );
        });
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'bind-verifies-requirements',
      'an unmet runtime requirement fails the bind',
      async () => {
        const check: ConformanceCheck = 'bind-verifies-requirements';
        await withConnection(async (connection) => {
          let threw = false;
          try {
            await opts.bindWithUnmetRequirement?.(connection);
          } catch {
            threw = true;
          }
          assert(
            check,
            threw,
            'bind SUCCEEDED with an unmet runtime requirement (§11.5). A declared capability that ' +
              'is never verified is decoration — it will authorize a route that then 500s.',
          );
        });
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'outbox-requires-transactional-save',
      'a non-transactional outbox is REFUSED at bind, naming transactionalSave',
      async () => {
        const check: ConformanceCheck = 'outbox-requires-transactional-save';
        await withConnection(async (connection) => {
          let error: unknown;
          let threw = false;
          try {
            await opts.bindWithNonTransactionalOutbox?.(connection);
          } catch (err) {
            threw = true;
            error = err;
          }
          assert(
            check,
            threw,
            'bind ACCEPTED an OutboxStore that does not declare transactionalSave. ' +
              '`OutboxWriteOptions.session` is best-effort BY CONTRACT (see ' +
              '@classytic/primitives/events/outbox), so a store which ignores it persists the ' +
              'event row outside the caller’s transaction: a domain write that later rolls back ' +
              'still emits its event, and a downstream consumer acts on something that never ' +
              'happened — a commission paid on a sale that does not exist, a credential synced ' +
              'for access never granted. Nothing throws, on either side. Verify the flag at the ' +
              'TOP of bind (before the model blueprint binds, so a collision cannot report first ' +
              'and a refused bind leaves the registry untouched):\n' +
              '    if (runtime.outbox && runtime.outbox.transactionalSave !== true) throw …\n' +
              'If this kernel’s outbox rows genuinely need not commit with the state change, ' +
              'do not gate it — skip this check and say why.',
          );

          // The refusal must be the RIGHT refusal. A bind that throws for an unrelated reason
          // (a model collision, a missing port) would otherwise read as a pass, and a
          // capability error that asserts the wrong remedy sends the reader to the wrong
          // layer: referral's printed "the backend must support it (mongokit 3.16+)" for an
          // outbox misconfiguration, which has nothing to do with the backend or its version.
          const message = String(
            (error as { message?: unknown })?.message ?? (error as unknown) ?? '',
          );
          assert(
            check,
            message.includes('transactionalSave'),
            `bind refused the non-transactional outbox, but its error never names ` +
              `'transactionalSave': "${message.slice(0, 300)}". Either the refusal came from ` +
              'something other than the outbox gate — in which case this check is passing for ' +
              'the wrong reason — or the diagnostic points the reader at the wrong layer. Name ' +
              'the unmet capability in the message.',
          );
        });
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    register(
      'optional-modules-register-no-models',
      'a disabled optional module registers no models',
      async () => {
        const check: ConformanceCheck = 'optional-modules-register-no-models';
        const full = opts.blueprint();
        const minimal = opts.minimalBlueprint?.() as TBlueprint;
        const { extra } = diffSets(minimal.modelNames, full.modelNames);
        assert(
          check,
          extra.length === 0,
          `the minimal blueprint declares models the full one does not: [${extra.join(', ')}]`,
        );
        assert(
          check,
          minimal.modelNames.length < full.modelNames.length,
          `disabling the optional modules changed nothing (${minimal.modelNames.length} models ` +
            'either way) — a disabled module must register no models, schedules or indexes (§11.10)',
        );
        await withConnection(async (connection) => {
          const before = new Set(Object.keys(connection.models));
          await bind(minimal, connection);
          const registered = Object.keys(connection.models).filter((n) => !before.has(n));
          const drift = diffSets(registered, minimal.modelNames);
          assert(
            check,
            drift.extra.length === 0 && drift.missing.length === 0,
            `the minimal bind registered [${registered.join(', ')}] but declared ` +
              `[${minimal.modelNames.join(', ')}] — a disabled module still compiled a model`,
          );
        });
      },
    );
  });
}

function defaultReport(report: KernelConformanceReport): void {
  const lines = [
    `[kernel-conformance] ${report.kernel}: ${report.checks.length} checks ` +
      `(${report.checks.filter((c) => c.outcome === 'run').length} run, ` +
      `${report.skipped.length} skipped, ${report.notExercised.length} not exercised)`,
  ];
  for (const s of report.skipped) lines.push(`  SKIPPED       ${s.check} — ${s.reason}`);
  for (const s of report.notExercised) lines.push(`  NOT EXERCISED ${s.check} — ${s.reason}`);
  console.info(lines.join('\n'));
}
