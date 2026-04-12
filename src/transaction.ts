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
 * Detect whether an error indicates the MongoDB deployment does not support
 * multi-document transactions (standalone server, older topology, etc.).
 *
 * Checks MongoDB error codes first — 263 (standalone) and 20 (unsupported
 * topology) — with a message-matching fallback for edge cases surfaced by
 * older driver versions.
 */
export function isTransactionUnsupported(error: Error): boolean {
  const code = (error as Error & { code?: number }).code;
  if (code === 263 || code === 20) return true;

  const message = (error.message || '').toLowerCase();
  return (
    message.includes('transaction numbers are only allowed on a replica set member') ||
    message.includes('transaction is not supported')
  );
}
