/**
 * FAIL LOUD — a Mongoose process warning fails the test that produced it.
 *
 * ## Why this exists
 *
 * Mongoose 9 does not use `util.deprecate` and does not emit a
 * `DeprecationWarning`. It emits a *plain* `Warning` through
 * `process.emitWarning(message, { code: 'MONGOOSE' })`
 * (`mongoose/lib/utils.js` → `exports.warn`). Two consequences:
 *
 *   1. `node --trace-deprecation` shows NOTHING. Only `--trace-warnings`
 *      (or a hook like this one) sees them.
 *   2. Node prints each distinct warning once, to stderr, and the process
 *      still exits 0 — so a green test run proves nothing about deprecations.
 *
 * That is how `Document.prototype.validateSync()` — deprecated in mongoose
 * 9.7.0 — went unnoticed across 2779 mongokit tests while downstream kernels
 * (order, pos, ledger) were emitting it in production logs.
 *
 * ## What it does
 *
 * Wraps `process.emitWarning` in every test worker, records anything carrying
 * `code: 'MONGOOSE'`, and throws in `afterEach` / `afterAll`. The original
 * emitter is always called, so `--trace-warnings` output is unchanged.
 *
 * ## Opting out
 *
 * There is no env var and no silent skip. The ONLY escape hatch is
 * `ALLOWED_MONGOOSE_WARNINGS` below: a named entry with a regex, a written
 * reason, and the date it was added. An empty list is the intended steady
 * state — if you are adding to it, you are recording a known debt, not
 * disabling the guard.
 */

import { afterAll, afterEach, beforeAll } from 'vitest';

/** One deliberate, documented exception to the guard. */
export interface AllowedMongooseWarning {
  /** Matched against the warning MESSAGE. Anchor it — a loose regex silently widens the hole. */
  readonly match: RegExp;
  /** Why this warning is tolerated, and what has to change to remove the entry. */
  readonly reason: string;
  /** ISO date the entry was added, so a stale allowance is visible. */
  readonly since: string;
}

/**
 * Deliberately EMPTY. mongokit's own source emits no mongoose warnings at
 * mongoose 9.9.1, and that is the property this guard locks in.
 */
export const ALLOWED_MONGOOSE_WARNINGS: readonly AllowedMongooseWarning[] = [];

/** The `code` mongoose stamps on every warning it emits (`utils.warn`). */
const MONGOOSE_WARNING_CODE = 'MONGOOSE';

type EmitWarning = typeof process.emitWarning;

interface CapturedWarning {
  readonly message: string;
  readonly stack: string | undefined;
}

const captured: CapturedWarning[] = [];
let originalEmitWarning: EmitWarning | undefined;

/**
 * `process.emitWarning` is overloaded four ways. Only one thing matters here:
 * does this call carry `code === 'MONGOOSE'`? Read the code from every place
 * it can appear rather than assuming the shape mongoose happens to use today —
 * a signal we fail to recognise is a warning that slips through silently,
 * which is the exact failure this guard exists to prevent.
 */
function extractMongooseCode(args: readonly unknown[]): boolean {
  const [warning, second, third] = args;

  // `emitWarning(new Error(...))` where the error carries `.code`.
  if (warning instanceof Error && (warning as { code?: unknown }).code === MONGOOSE_WARNING_CODE) {
    return true;
  }
  // `emitWarning(msg, { type, code, detail })` — mongoose's own shape.
  if (typeof second === 'object' && second !== null) {
    if ((second as { code?: unknown }).code === MONGOOSE_WARNING_CODE) return true;
  }
  // `emitWarning(msg, type, code)` — positional form.
  if (second === MONGOOSE_WARNING_CODE || third === MONGOOSE_WARNING_CODE) return true;

  return false;
}

function messageOf(warning: unknown): string {
  if (warning instanceof Error) return warning.message;
  return String(warning);
}

function isAllowed(message: string): boolean {
  return ALLOWED_MONGOOSE_WARNINGS.some((entry) => entry.match.test(message));
}

function drainAndThrow(phase: string): void {
  if (captured.length === 0) return;
  const seen = captured.splice(0, captured.length);
  const lines = seen.map((w, i) => {
    const trace = w.stack ? `\n${w.stack}` : '\n      (no stack — re-run with NODE_OPTIONS=--trace-warnings)';
    return `  ${i + 1}. ${w.message}${trace}`;
  });
  throw new Error(
    `[MONGOOSE] ${seen.length} mongoose warning(s) emitted during ${phase}.\n` +
      `${lines.join('\n')}\n\n` +
      'Mongoose warnings are deprecations and misconfiguration notices. Fix the call site.\n' +
      'If the warning is genuinely unavoidable, add a named entry with a reason to\n' +
      'ALLOWED_MONGOOSE_WARNINGS in tests/_shared/no-mongoose-warnings.ts — there is no\n' +
      'env var and no silent skip.',
  );
}

beforeAll(() => {
  if (originalEmitWarning) return;
  originalEmitWarning = process.emitWarning.bind(process) as EmitWarning;
  const passthrough = originalEmitWarning;

  process.emitWarning = ((...args: Parameters<EmitWarning>) => {
    if (extractMongooseCode(args)) {
      const message = messageOf(args[0]);
      if (!isAllowed(message)) {
        captured.push({
          message,
          // Capture the call site here — Node's own warning stack points at
          // the emitter, not at the mongokit code that triggered it.
          stack: new Error('mongoose warning call site').stack?.split('\n').slice(2).join('\n'),
        });
      }
    }
    // Always forward: `--trace-warnings` and any host warning listener must
    // still see the warning. A guard that swallows its input is worse than none.
    return passthrough(...(args as Parameters<EmitWarning>));
  }) as EmitWarning;
});

afterEach(() => {
  drainAndThrow('this test');
});

afterAll(() => {
  if (originalEmitWarning) {
    process.emitWarning = originalEmitWarning;
    originalEmitWarning = undefined;
  }
  // Warnings emitted at module load or during teardown never reach an
  // `afterEach`. Report them here rather than dropping them.
  drainAndThrow('this test file (module load or teardown)');
});
