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
 * `acquiredAt` is when the current holder took the lock (fresh acquire
 * or takeover of an expired lease, on `nowFn`'s clock). Renewals by
 * the same holder keep it, so `inspect().acquiredAt` answers "holder
 * since when".
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
 * When the caller records a change of holder (leader election, a
 * "master" role), `acquire` answers who held it before from the same
 * atomic write, so there is no `inspect` before `tryAcquire`:
 *
 *     const got = await lock.acquire('sound-master:room-1', me, 30_000);
 *     if (got.acquired && got.previousHolder !== me) {
 *       // took it; `got.previousHolder` lapsed (or absent: it was free)
 *     } else if (!got.acquired) {
 *       // `got.holder` holds it until `got.expiresAt`
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
  /**
   * Clock for `tryAcquire` (expiry comparison + new expiry) and
   * `inspect`. Inject one to drive lease expiry from tests or a host
   * `Clock` port. Default `() => new Date()`.
   *
   * The collection's TTL index on `expiresAt` deletes by the server's
   * real time, so in production `nowFn` must track wall-clock time: a
   * clock running behind real time writes expiries the TTL monitor may
   * already treat as past, and the lock can be swept (and taken by
   * another holder) while still held. Skewed / frozen clocks are for
   * tests only (use a far-future base there).
   */
  nowFn?: () => Date;
}

/**
 * The outcome of {@link MongoLockAdapter.acquire}, read from the same atomic write that took (or
 * did not take) the lock. Structurally the same as repo-core's optional `LockAdapter.acquire`
 * result (`LockAcquisition`), declared here so mongokit keeps its repo-core peer floor.
 */
export interface MongoLockAcquisition {
  /** `true` when `holderId` holds the lock after this call (fresh, takeover or renewal). */
  acquired: boolean;
  /** The holder after this call: the caller when acquired, else the live holder that kept it. */
  holder: string;
  /**
   * The holder recorded on the row BEFORE this write, when there was one: the caller itself on a
   * renewal, another holder on a takeover of its lapsed lease. Absent when the lock was free
   * (never taken, released, or swept by the TTL index). Only set when `acquired`.
   */
  previousHolder?: string;
  /** Since when `holder` holds the lock (kept across its renewals). */
  acquiredAt: Date;
  /** When `holder`'s lease ends. */
  expiresAt: Date;
}

/** The Mongo lock adapter: the repo-core contract, with `inspect` and `acquire` always present. */
export interface MongoLockAdapter extends LockAdapter {
  /**
   * Like `tryAcquire` (take a free or lapsed lock, or renew one's own), but answers WHO held it
   * before and who holds it now, from the one atomic write: no `inspect` before or after, so no
   * race window between reading the previous holder and taking the lock. A refused acquire writes
   * nothing and reports the live holder.
   */
  acquire(name: string, holderId: string, leaseMs: number): Promise<MongoLockAcquisition>;
  inspect(name: string): Promise<LockState | null>;
}

/**
 * Build a Mongo-backed lock adapter. Idempotent — the underlying
 * model is registered once per `(connection, modelName)` pair, so
 * calling this multiple times with the same options shares the same
 * collection (no duplicate-model errors).
 */
export function createMongoLockAdapter(options: MongoLockAdapterOptions = {}): MongoLockAdapter {
  const {
    connection,
    collectionName = 'mongo_locks',
    modelName = 'MongoLock',
    defaultLeaseMs = 30_000,
    nowFn = () => new Date(),
  } = options;

  const conn: Connection | typeof mongoose = connection ?? mongoose;
  const model = getOrCreateModel(conn, modelName, collectionName);

  return {
    async tryAcquire(name: string, holderId: string, leaseMs: number): Promise<boolean> {
      const ms = leaseMs > 0 ? leaseMs : defaultLeaseMs;
      const now = nowFn();
      const expiresAt = new Date(now.getTime() + ms);

      try {
        // Atomic acquire: succeed when the doc is absent, expired, or
        // already ours. Upsert handles the absent case; `$or` on the
        // filter handles expired + same-holder.
        //
        // `acquiredAt` is when the CURRENT holder took the lock: a
        // renewal by the same holder keeps it, while a fresh insert or
        // a takeover of an expired lease by another holder stamps
        // `now`. An update pipeline decides this in the same atomic
        // write: within one `$set` stage `$holder` / `$acquiredAt`
        // read the pre-update values. `$literal` keeps a holder id
        // that starts with `$` from being read as a field path.
        const holder = { $literal: holderId };
        const result = await model
          .findOneAndUpdate(
            {
              _id: name,
              $or: [{ expiresAt: { $lt: now } }, { holder: holderId }],
            },
            [
              {
                $set: {
                  acquiredAt: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$holder', holder] },
                          { $ne: [{ $type: '$acquiredAt' }, 'missing'] },
                        ],
                      },
                      '$acquiredAt',
                      { $literal: now },
                    ],
                  },
                  holder,
                  expiresAt: { $literal: expiresAt },
                },
              },
            ],
            { upsert: true, returnDocument: 'after', updatePipeline: true },
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

    async acquire(name: string, holderId: string, leaseMs: number): Promise<MongoLockAcquisition> {
      const ms = leaseMs > 0 ? leaseMs : defaultLeaseMs;
      const now = nowFn();
      const expiresAt = new Date(now.getTime() + ms);
      const holder = { $literal: holderId };
      // Same rule as `tryAcquire` (free, lapsed or ours), but the filter matches the row whoever
      // holds it and the pipeline decides: a row held live by another holder is rewritten with its
      // own values (a no-op), so `returnDocument: 'before'` hands back the row this write saw in
      // every case. A missing `expiresAt` (fresh upsert) sorts below any date.
      const won = '$__lockWon';
      const pipeline = [
        {
          $set: {
            __lockWon: {
              $or: [{ $lt: ['$expiresAt', { $literal: now }] }, { $eq: ['$holder', holder] }],
            },
          },
        },
        {
          $set: {
            acquiredAt: {
              $cond: [
                won,
                {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$holder', holder] },
                        { $ne: [{ $type: '$acquiredAt' }, 'missing'] },
                      ],
                    },
                    '$acquiredAt',
                    { $literal: now },
                  ],
                },
                '$acquiredAt',
              ],
            },
            holder: { $cond: [won, holder, '$holder'] },
            expiresAt: { $cond: [won, { $literal: expiresAt }, '$expiresAt'] },
          },
        },
        { $unset: '__lockWon' },
      ];
      // A racing first insert of the same name loses with E11000; the row then exists, so the
      // retry reads its holder from the same kind of write.
      for (let attempt = 0; ; attempt++) {
        try {
          const before = await model
            .findOneAndUpdate({ _id: name }, pipeline, {
              upsert: true,
              returnDocument: 'before',
              updatePipeline: true,
            })
            .lean();
          if (!before) return { acquired: true, holder: holderId, acquiredAt: now, expiresAt };
          const mine = before.holder === holderId;
          if (mine || before.expiresAt.getTime() < now.getTime()) {
            return {
              acquired: true,
              holder: holderId,
              previousHolder: before.holder,
              acquiredAt: mine && before.acquiredAt ? before.acquiredAt : now,
              expiresAt,
            };
          }
          return {
            acquired: false,
            holder: before.holder,
            acquiredAt: before.acquiredAt,
            expiresAt: before.expiresAt,
          };
        } catch (err) {
          const code = (err as { code?: number } | null)?.code;
          if (code === 11000 && attempt < 3) continue;
          throw err;
        }
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
      if (doc.expiresAt.getTime() <= nowFn().getTime()) return null;
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

export type {
  MongoDailyClaim,
  MongoDailyClaimInfo,
  MongoDailyLedger,
  MongoDailyLedgerOptions,
  MongoDailyLedgerRow,
} from './daily-ledger.js';
export { createMongoDailyLedger } from './daily-ledger.js';
