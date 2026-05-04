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

import type { ClientSession } from 'mongoose';
import { createTxBoundRepo } from './tx-bound.js';
import type { WithTransactionOptions } from './types.js';

/** Minimal shape we need from a Mongoose connection. */
export interface SessionStarter {
  startSession(): Promise<ClientSession>;
}

/**
 * Run a callback inside a MongoDB transaction on the given connection.
 *
 * - Starts a session, runs `session.withTransaction(callback)` (which auto-retries
 *   on `TransientTransactionError` and `UnknownTransactionCommitResult`), and
 *   always ends the session in `finally`.
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
    return await session.withTransaction(() => callback(session), options.transactionOptions);
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
