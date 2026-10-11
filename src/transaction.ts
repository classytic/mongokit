/**
 * Cross-repo transaction helper.
 *
 * `Repository#withTransaction` is convenient when every write in a transaction
 * lives on the same repository, but real workflows usually span several:
 *
 *   await withTransaction(connection, async (session) => {
 *     const txn = await revenue.transaction.create(data, { session });
 *     await ledger.entry.create(journal, { session });
 *     await revenue.transaction.verify(txn._id, {}, { session });
 *   });
 *
 * This module-level helper accepts a Mongoose connection (or anything with a
 * compatible `startSession()`), so hosts don't need to arbitrarily pick one
 * repository to hang the transaction off.
 *
 * The Repository instance method delegates to this function — one source of
 * truth for retry semantics, standalone fallback, and session lifecycle.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import { resolveTransactionSupport } from './capabilities.js';
import { setTransactionDeadline } from './repository/query-defaults.js';
import { createTxBoundRepo } from './tx-bound.js';
import type { ConvenientTransactionOptions, WithTransactionOptions } from './types/operations.js';

/** Minimal shape we need from a Mongoose connection. */
export interface SessionStarter {
  startSession(): Promise<ClientSession>;
}

/**
 * Run a callback inside a MongoDB transaction on the given connection.
 *
 * - Starts a session and runs the callback in a transaction with the driver's retry rules
 *   (`TransientTransactionError` → retry the attempt, `UnknownTransactionCommitResult` → retry
 *   the commit), ending the session in `finally`. See {@link runTransaction}.
 * - When `allowFallback` is true and the deployment doesn't support transactions
 *   (e.g. standalone MongoDB in dev), the callback runs once without a
 *   transaction on the same session. `onFallback` is invoked with the original
 *   error so hosts can log the degradation.
 *
 * @example
 * ```ts
 * import mongoose from 'mongoose';
 * import { withTransaction } from '@classytic/mongokit';
 *
 * await withTransaction(mongoose.connection, async (session) => {
 *   const order  = await orderRepo.create(data, { session });
 *   await inventoryRepo.decrement(order.items, { session });
 *   return order;
 * });
 * ```
 */
export async function withTransaction<T>(
  connection: SessionStarter,
  callback: (session: ClientSession) => Promise<T>,
  options: WithTransactionOptions = {},
): Promise<T> {
  const session = await connection.startSession();
  try {
    return await runTransaction(session, callback, options.transactionOptions);
  } catch (error) {
    const err = error as Error;
    if (options.allowFallback && isTransactionUnsupported(err)) {
      options.onFallback?.(err);
      return await callback(session);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

const MAX_TRANSACTION_TIMEOUT_MS = 120_000;
const BACKOFF_INITIAL_MS = 5;
const BACKOFF_MAX_MS = 500;
const MAX_TIME_MS_EXPIRED = 50;

function hasLabel(err: unknown, label: string): boolean {
  const e = err as { hasErrorLabel?: (l: string) => boolean; errorLabels?: unknown } | null;
  if (typeof e?.hasErrorLabel === 'function') return e.hasErrorLabel(label);
  return Array.isArray(e?.errorLabels) && e.errorLabels.includes(label);
}

function isMaxTimeMSExpired(err: unknown): boolean {
  const e = err as { code?: unknown; writeConcernError?: { code?: unknown } } | null;
  return e?.code === MAX_TIME_MS_EXPIRED || e?.writeConcernError?.code === MAX_TIME_MS_EXPIRED;
}

function timeoutError(cause: unknown, csot: boolean): unknown {
  if (!csot || cause instanceof mongoose.mongo.MongoOperationTimeoutError) return cause;
  const error = new mongoose.mongo.MongoOperationTimeoutError('Timed out during withTransaction', {
    cause: cause instanceof Error ? cause : undefined,
  });
  if (cause instanceof mongoose.mongo.MongoError)
    for (const label of cause.errorLabels) error.addErrorLabel(label);
  return error;
}

/**
 * The driver's convenient-transaction algorithm (start → callback → commit, label-based retry,
 * jittered backoff, a deadline), run here so the driver never attaches a session `timeoutContext`:
 * with one, every legacy bulk write (`insertMany`, `bulkWrite`) in the transaction is refused once
 * the client carries `timeoutMS` (driver <= 7.7: the bulk path re-resolves the inherited client
 * `timeoutMS` as a per-op one). Each operation keeps its own per-op CSOT budget instead.
 * Deadline: `transactionOptions.timeoutMS`, else the client's `timeoutMS`, else 120 s (as the driver).
 * Pinned by `tests/integration/csot-transaction-matrix.test.ts`.
 */
async function runTransaction<T>(
  session: ClientSession,
  callback: (session: ClientSession) => Promise<T>,
  transactionOptions: ConvenientTransactionOptions = {},
): Promise<T> {
  const { timeoutMS: explicitTimeout, ...startOptions } = transactionOptions;
  const clientTimeout = (session as { timeoutMS?: number }).timeoutMS;
  const timeoutMS = explicitTimeout ?? clientTimeout;
  const csot = timeoutMS != null;
  const deadline = performance.now() + (timeoutMS ?? MAX_TRANSACTION_TIMEOUT_MS);
  let lastError: unknown;
  // One budget for the whole transaction: every mongokit op is capped at what remains of it.
  if (csot) setTransactionDeadline(session, deadline);
  try {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        const backoff =
          Math.random() * Math.min(BACKOFF_INITIAL_MS * 1.5 ** (attempt - 1), BACKOFF_MAX_MS);
        if (performance.now() + backoff >= deadline) throw timeoutError(lastError, csot);
        await sleep(backoff);
      }
      session.startTransaction(startOptions);
      let result: T;
      try {
        result = await callback(session);
        // The callback committed or aborted by itself: respect it.
        if (!session.inTransaction()) return result;
      } catch (err) {
        lastError = err;
        await abortKeepingError(session, err);
        if (
          err instanceof mongoose.mongo.MongoError &&
          hasLabel(err, 'TransientTransactionError')
        ) {
          if (performance.now() >= deadline) throw timeoutError(err, csot);
          continue;
        }
        throw err;
      }
      for (;;) {
        const left = deadline - performance.now();
        if (csot && left <= 0) {
          // Budget spent before the commit: abort, so the outcome is KNOWN (not committed).
          const late = new mongoose.mongo.MongoOperationTimeoutError(
            'Transaction budget exhausted before commit; the transaction was aborted, nothing was committed',
          );
          await abortKeepingError(session, late);
          throw late;
        }
        try {
          await session.commitTransaction(
            csot ? { timeoutMS: Math.max(1, Math.floor(left)) } : undefined,
          );
          return result;
        } catch (err) {
          lastError = err;
          if (hasLabel(err, 'UnknownTransactionCommitResult') && !isMaxTimeMSExpired(err)) {
            if (performance.now() >= deadline) throw timeoutError(err, csot);
            continue;
          }
          if (hasLabel(err, 'TransientTransactionError')) break;
          throw err;
        }
      }
    }
  } finally {
    if (csot) setTransactionDeadline(session, undefined);
  }
}

/** Abort if still in progress; an abort failure rides along as `abortError`, never replacing `original`. */
async function abortKeepingError(session: ClientSession, original: unknown): Promise<void> {
  if (!session.inTransaction()) return;
  try {
    await session.abortTransaction();
  } catch (abortError) {
    if (original && typeof original === 'object') Object.assign(original, { abortError });
  }
}

/**
 * Multi-repo transactional batch — every repo in `repos` becomes a
 * session-bound proxy inside the callback. Eliminates the per-call
 * `{ session }` threading that was repeated across ~20 call sites
 * (be-prod outbox writes, order placement, transfer source/dest pairs,
 * payrun saga steps).
 *
 * Same retry + fallback semantics as `withTransaction`: the
 * `transactionOptions` / `allowFallback` / `onFallback` knobs apply.
 *
 * Each property of the input `repos` map is rebound via the
 * `createTxBoundRepo` proxy — every CRUD method on the bound repo
 * auto-injects `session` into its options bag, including
 * `claim` / `claimVersion` / `findOneAndUpdate` and plugin-contributed
 * methods. Non-CRUD properties (Model, modelName, hook engine,
 * idField) pass through to the underlying repo. Nested
 * `boundRepo.withTransaction(...)` throws — reuse the outer bound
 * repos.
 *
 * @example Order placement across three repos in one transaction
 * ```ts
 * import { batchTransaction } from '@classytic/mongokit';
 *
 * const order = await batchTransaction(
 *   mongoose.connection,
 *   { orders: orderRepo, events: eventRepo, inventory: inventoryRepo },
 *   async ({ orders, events, inventory }) => {
 *     const created = await orders.create(orderData);          // session auto-injected
 *     await events.create({ type: 'order.placed', orderId: created._id });
 *     await inventory.claim(skuId, { from: 'available', to: 'reserved' });
 *     return created;
 *   },
 * );
 * ```
 *
 * @example With fallback for standalone-mongo dev environments
 * ```ts
 * await batchTransaction(
 *   mongoose.connection,
 *   { orders, events },
 *   async ({ orders, events }) => { ... },
 *   { allowFallback: true, onFallback: (err) => log.warn(err) },
 * );
 * ```
 *
 * @param connection - Mongoose connection (or anything with
 *   `startSession()`). Single source of session truth — every bound
 *   repo shares this session.
 * @param repos - Map of repo instances to rebind. Keys become the
 *   property names on the callback's argument.
 * @param callback - Receives the bound repo map. Return value flows
 *   through to the outer `Promise`.
 */
export async function batchTransaction<TRepos extends Record<string, object>, TResult>(
  connection: SessionStarter,
  repos: TRepos,
  callback: (bound: TRepos) => Promise<TResult>,
  options: WithTransactionOptions = {},
): Promise<TResult> {
  return withTransaction(
    connection,
    async (session) => {
      const bound = {} as TRepos;
      for (const key of Object.keys(repos) as Array<keyof TRepos>) {
        const repo = repos[key];
        bound[key] = createTxBoundRepo(repo, session) as TRepos[typeof key];
      }
      return callback(bound);
    },
    options,
  );
}

/**
 * Detect whether an error indicates the MongoDB deployment does not support
 * multi-document transactions (standalone server, older topology, etc.).
 *
 * Checks MongoDB error codes first — 263 (standalone) and 20 (unsupported
 * topology) — with a message-matching fallback for edge cases surfaced by
 * driver versions that throw before the proper code lands.
 *
 * **Driver-version drift:** modern mongoose / mongodb-driver versions hit
 * the standalone case via the retryable-writes precondition rather than
 * the transaction precondition (`retryWrites=true` is on by default,
 * standalone Mongo rejects it before the transaction is even attempted).
 * So we accept that message as equivalent — the underlying topology
 * problem is the same, and the fallback semantics are correct either way.
 */
export function isTransactionUnsupported(error: Error): boolean {
  const code = (error as Error & { code?: number }).code;
  if (code === 263 || code === 20) return true;

  const message = (error.message || '').toLowerCase();
  return (
    message.includes('transaction numbers are only allowed on a replica set member') ||
    message.includes('transaction is not supported') ||
    // Modern driver: standalone-mongo rejects retryable writes (which the
    // driver enables by default) before the transaction layer can throw
    // its own precondition error. Same root cause, different surface.
    message.includes('does not support retryable writes')
  );
}

/**
 * PROACTIVELY report whether a connection's deployment supports multi-document
 * transactions — the read-side companion to {@link isTransactionUnsupported}
 * (which classifies a FAILED attempt). Lets a caller skip a doomed transaction
 * attempt on standalone dev Mongo rather than starting one just to catch the
 * error.
 *
 * Delegates to {@link resolveTransactionSupport} so mongokit has exactly ONE
 * topology reader. That also fixes a false NEGATIVE this function used to
 * have: it tested `description.type !== 'Single'`, but a single-node replica
 * set reached with `directConnection` is `Single` with a server type of
 * `RSPrimary` and runs transactions fine. The shared reader looks at the
 * SERVER descriptions first.
 *
 * **`unknown` is optimistic HERE and pessimistic in `capabilities.ts` — the
 * difference is deliberate.** This answers "should I bother ATTEMPTING a
 * transaction?", where guessing yes costs one caught error (`allowFallback`
 * still recovers). The capability descriptor answers "may this deployment be
 * trusted with money?", where guessing yes is the bug class this repo keeps
 * hitting (AGENTS.md FAIL LOUD rule 3). Do not "unify" them.
 *
 * Accepts a Mongoose `Connection` (or anything exposing `getClient()`/`client`
 * with a driver `topology`), so it stays decoupled from mongoose types.
 */
export function supportsTransactions(connection: unknown): boolean {
  return resolveTransactionSupport(connection) !== 'no';
}
