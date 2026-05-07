/**
 * Mongo-backed `LockAdapter` — distributed lock primitive for the
 * @classytic ecosystem.
 *
 * Implements the contract from `@classytic/repo-core/lock` against a
 * Mongoose collection. One document per lock name; atomic
 * `findOneAndUpdate` with `$or: [expired, ours]` filter + upsert is
 * the acquire primitive. Two replicas racing for the same lock with
 * no existing doc trigger an E11000 on the loser — the catch returns
 * `false`, matching the contract.
 *
 * ## Schema
 *
 * The lock document is named after itself (`_id` = lock name) so each
 * lock is exactly one row, no scan needed:
 *
 *     {
 *       _id: 'cron.outbox',
 *       holder: 'host-7.123.ab12cd34',
 *       expiresAt: 2026-01-01T00:00:05.000Z,
 *       acquiredAt: 2026-01-01T00:00:00.000Z,
 *     }
 *
 * A TTL index on `expiresAt` prunes abandoned leases automatically.
 * The TTL is a safety net — the next acquire reclaims an expired
 * lease via the `$or` clause without waiting for the TTL sweep
 * (Mongo's TTL monitor runs every 60s).
 *
 * ## Usage
 *
 *     import mongoose from 'mongoose';
 *     import { createMongoLockAdapter } from '@classytic/mongokit/lock';
 *     import { getInstanceId } from '@classytic/repo-core/lock';
 *
 *     const lock = createMongoLockAdapter({ connection: mongoose.connection });
 *     const me = getInstanceId();
 *
 *     if (await lock.tryAcquire('cron.outbox', me, 5_000)) {
 *       try { await runOutboxSweep(); }
 *       finally { await lock.release('cron.outbox', me); }
 *     }
 *
 * ## Multi-tenant note
 *
 * Lock names are *global* — they live in one shared collection across
 * all tenants. Hosts that need per-tenant locks (e.g. "lock outbox
 * sweep per organization") encode tenant in the name itself
 * (`outbox:org-123`) — same as Redis `SETNX` key conventions.
 *
 * ## Clock-skew assumption
 *
 * Both `expiresAt` and the `$lt` predicate use **client-side**
 * `new Date()`. A replica with a clock drifted forward by N
 * milliseconds will consider an unexpired lease "expired" N ms
 * early and may steal it. Hosts MUST keep replica clocks
 * synchronised within `leaseMs` (NTP / chrony / systemd-timesyncd).
 * This is the standard distributed-lock caveat — Redlock, Etcd
 * leases, and ZooKeeper sessions all carry the same constraint.
 * The trade-off is exercised by `lock-adapter.test.ts`'s clock-
 * skew test so a future move to server-side `$$NOW` surfaces
 * as a behaviour change.
 */

import type { BaseLockAdapterOptions, LockAdapter, LockState } from '@classytic/repo-core/lock';
import type { Connection, Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

interface MongoLockDoc {
  _id: string;
  holder: string;
  expiresAt: Date;
  acquiredAt: Date;
}

/** Adapter-construction options. */
export interface MongoLockAdapterOptions extends BaseLockAdapterOptions {
  /**
   * Mongoose connection. Defaults to `mongoose.connection` (the
   * default global connection) — most apps connect once via
   * `mongoose.connect()` and want every primitive to share that
   * handle. Apps using a named connection
   * (`mongoose.createConnection(...)`) pass it explicitly.
   */
  connection?: Connection;
  /** Collection name. Default `mongo_locks`. */
  collectionName?: string;
  /** Override the Mongoose model name. Default `MongoLock`. */
  modelName?: string;
}

/**
 * Build a Mongo-backed lock adapter. Idempotent — the underlying
 * model is registered once per `(connection, modelName)` pair, so
 * calling this multiple times with the same options shares the same
 * collection (no duplicate-model errors).
 */
export function createMongoLockAdapter(options: MongoLockAdapterOptions = {}): LockAdapter {
  const {
    connection,
    collectionName = 'mongo_locks',
    modelName = 'MongoLock',
    defaultLeaseMs = 30_000,
  } = options;

  const conn: Connection | typeof mongoose = connection ?? mongoose;
  const model = getOrCreateModel(conn, modelName, collectionName);

  return {
    async tryAcquire(name: string, holderId: string, leaseMs: number): Promise<boolean> {
      const ms = leaseMs > 0 ? leaseMs : defaultLeaseMs;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ms);

      try {
        // Atomic acquire: succeed when the doc is absent, expired, or
        // already ours. Upsert handles the absent case; `$or` on the
        // filter handles expired + same-holder. `setOnInsert` would
        // be redundant here — `$set` writes every field anyway.
        const result = await model
          .findOneAndUpdate(
            {
              _id: name,
              $or: [{ expiresAt: { $lt: now } }, { holder: holderId }],
            },
            {
              $set: { holder: holderId, expiresAt },
              // Preserve `acquiredAt` across extensions: only set on insert.
              $setOnInsert: { acquiredAt: now },
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
          )
          .lean();

        return !!result && result.holder === holderId;
      } catch (err) {
        // E11000: another replica's upsert won the race against ours.
        // The other holder owns the lock; we don't.
        const code = (err as { code?: number } | null)?.code;
        if (code === 11000) return false;
        // Anything else: propagate — connection lost, schema mismatch,
        // permission error. The caller decides whether to retry.
        throw err;
      }
    },

    async release(name: string, holderId: string): Promise<boolean> {
      // CAS delete: only remove the doc when we still hold it. A doc
      // owned by a different holder (after a steal) won't match and
      // returns null.
      const result = await model
        .findOneAndDelete({
          _id: name,
          holder: holderId,
        })
        .lean();
      return !!result;
    },

    async inspect(name: string): Promise<LockState | null> {
      const doc = await model.findById(name).lean();
      if (!doc) return null;
      // Treat expired docs as absent at the contract level — TTL hasn't
      // swept yet but the lease is conceptually free.
      if (doc.expiresAt.getTime() <= Date.now()) return null;
      return {
        name,
        holder: doc.holder,
        expiresAt: doc.expiresAt,
        acquiredAt: doc.acquiredAt,
      };
    },
  };
}

// ─── Internals ───────────────────────────────────────────────────────────

/**
 * Idempotent model registration. Mongoose throws OverwriteModelError
 * if `model('Name', schema)` is called twice with the same name on
 * the same connection — this guard makes the adapter safe to
 * construct multiple times in tests / hot-reload setups.
 */
function getOrCreateModel(
  conn: Connection | typeof mongoose,
  modelName: string,
  collectionName: string,
): Model<MongoLockDoc> {
  const existing =
    'models' in conn ? (conn.models[modelName] as Model<MongoLockDoc> | undefined) : undefined;
  if (existing) return existing;

  const schema = new Schema<MongoLockDoc>(
    {
      _id: { type: String, required: true },
      holder: { type: String, required: true },
      expiresAt: { type: Date, required: true },
      acquiredAt: { type: Date, required: true },
    },
    {
      versionKey: false,
      timestamps: false,
      _id: false, // we supply _id explicitly (the lock name)
    },
  );

  // TTL: prune leases shortly after `expiresAt`. The next acquire
  // reclaims via the `$or` filter regardless — TTL is just bounded
  // collection growth for permanently-removed lock names.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  return (conn as Connection).model<MongoLockDoc>(modelName, schema, collectionName);
}
