/**
 * Mongo-backed daily ledger — one claim row per `(key, civilDate)`.
 *
 * Structurally implements arc's `DailyLedger` (`@classytic/arc` →
 * `createDailyGate` / `ScheduleDefinition.daily`) without importing arc:
 * pass the returned object as `ledger`. Exactly one replica wins
 * `claimDay` for a given key and civil date (unique `_id` + upsert; the
 * loser's upsert hits E11000 and returns `false`). An uncompleted claim
 * older than `info.staleAfterMs` may be re-granted (crash mid-run); a
 * completed day never is.
 *
 *     {
 *       _id: 'cron.digest|2026-10-30',
 *       key: 'cron.digest',
 *       civilDate: '2026-10-30',
 *       claimedAt: 2026-10-30T06:00:01.000Z,   // the gate's clock (info.now)
 *       completed: true,
 *       completedAt: 2026-10-30T06:00:04.000Z,
 *       result: { sent: 12 },
 *     }
 *
 * `civilDate` must be `YYYY-MM-DD` (what arc passes), so the composite
 * `_id` stays unambiguous whatever the key contains.
 *
 * Fencing is per INVOCATION, not per ledger instance: every won claim
 * gets a unique `claimToken` (stored on the row), and completing or
 * releasing only touches the row while it still carries that token. A
 * run that outlived `staleAfterMs` and was re-granted (by another
 * replica, or by this same instance on a later tick) can therefore
 * neither delete nor complete the newer claim, and a retry of its
 * completion stays fenced.
 *
 * - `claim()` returns a handle carrying the token; its `complete()` /
 *   `release()` are fenced by it. Prefer it in host code.
 * - `claimDay` / `completeDay` / `releaseDay` (arc's token-less
 *   `DailyLedger` shape) bind the token to the calling async context:
 *   `completeDay` / `releaseDay` act on the claim that THIS invocation
 *   (the async flow that awaited `claimDay`) won. Called from a flow
 *   that won nothing, they fall back to the instance's claim on the row
 *   only when it holds exactly one, and are otherwise a no-op.
 * - `adminCompleteDay` is the separate, explicit, unfenced manual
 *   completion. Nothing ever falls through to it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Connection, Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

/** What a claim carries (mirrors arc's `DailyClaimInfo`). */
export interface MongoDailyClaimInfo {
  /** The gate's clock reading when the claim was attempted. */
  readonly now: Date;
  /** Uncompleted claims older than this may be re-granted. Omit to never re-grant. */
  readonly staleAfterMs?: number;
}

/** The ledger contract (structurally arc's `DailyLedger`, plus `inspect`). */
export interface MongoDailyLedger {
  claimDay(key: string, civilDate: string, info: MongoDailyClaimInfo): Promise<boolean>;
  /**
   * Mark the day done (stale recovery never applies again) and store `result`, fenced to the
   * claim this invocation won. A no-op when that claim was re-granted, already completed or
   * released, or when the caller holds no claim on the day (see `adminCompleteDay`).
   */
  completeDay(key: string, civilDate: string, result?: Record<string, unknown>): Promise<void>;
  /** Drop this invocation's UNCOMPLETED claim so the next tick retries. A completed day is kept. */
  releaseDay(key: string, civilDate: string): Promise<void>;
  /**
   * Claim the day and return a per-invocation handle (or `null` when not won). The handle's
   * `complete` / `release` are fenced by its own token, whatever else claims the day later.
   */
  claim(key: string, civilDate: string, info: MongoDailyClaimInfo): Promise<MongoDailyClaim | null>;
  /**
   * Manual / admin completion: complete the day's UNCOMPLETED claim whoever holds it, unfenced.
   * Explicit only; never a fallback of `completeDay`. Resolves `true` when it completed a row.
   */
  adminCompleteDay(
    key: string,
    civilDate: string,
    result?: Record<string, unknown>,
  ): Promise<boolean>;
  /** Read one day's row, or `null`. For assertions and admin views. */
  inspect(key: string, civilDate: string): Promise<MongoDailyLedgerRow | null>;
}

/** One won claim (see `MongoDailyLedger.claim`). */
export interface MongoDailyClaim {
  readonly key: string;
  readonly civilDate: string;
  /** Unique per claim; the row carries it as `claimToken` while this claim holds the day. */
  readonly token: string;
  readonly claimedAt: Date;
  /** Complete the day while this claim still holds it. `true` when it did. */
  complete(result?: Record<string, unknown>): Promise<boolean>;
  /** Drop the claim while it still holds the day uncompleted. `true` when it did. */
  release(): Promise<boolean>;
}

export interface MongoDailyLedgerRow {
  key: string;
  civilDate: string;
  claimedAt: Date;
  /** The winning claim's token (rows written by earlier versions have none). */
  claimToken?: string;
  completed: boolean;
  completedAt?: Date;
  result?: Record<string, unknown>;
}

export interface MongoDailyLedgerOptions {
  /** Mongoose connection. Default `mongoose.connection`. */
  connection?: Connection;
  /** Collection name. Default `mongo_daily_ledger`. */
  collectionName?: string;
  /** Mongoose model name. Default `MongoDailyLedger`. */
  modelName?: string;
  /** Clock for `completedAt`. Default `() => new Date()`. Claims use `info.now`. */
  nowFn?: () => Date;
  /**
   * Optional session getter for `completeDay`, `releaseDay` and
   * `inspect`, e.g. to complete a day inside the job's transaction.
   * `claimDay` never uses it: a losing claim raises E11000, which would
   * abort a surrounding transaction.
   */
  session?: () => ClientSession | undefined;
}

interface DailyLedgerDoc extends MongoDailyLedgerRow {
  _id: string;
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function rowId(key: string, civilDate: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('MongoDailyLedger: key must be a non-empty string');
  }
  if (typeof civilDate !== 'string' || !CIVIL_DATE.test(civilDate)) {
    throw new Error(`MongoDailyLedger: civilDate must be YYYY-MM-DD, got "${String(civilDate)}"`);
  }
  return `${key}|${civilDate}`;
}

/**
 * Build a Mongo-backed daily ledger. Idempotent per `(connection,
 * modelName)` like `createMongoLockAdapter`.
 *
 * @example
 * import { createDailyGate } from '@classytic/arc/plugins';
 * import { createMongoDailyLedger } from '@classytic/mongokit/lock';
 *
 * const gate = createDailyGate({
 *   key: 'digest', zone: 'Asia/Dubai', hour: 6, staleAfterMs: 15 * 60_000,
 *   ledger: createMongoDailyLedger({ connection, collectionName: 'app_daily_ledger' }),
 * });
 */
export function createMongoDailyLedger(options: MongoDailyLedgerOptions = {}): MongoDailyLedger {
  const {
    connection,
    collectionName = 'mongo_daily_ledger',
    modelName = 'MongoDailyLedger',
    nowFn = () => new Date(),
  } = options;
  const conn: Connection | typeof mongoose = connection ?? mongoose;
  const model = getOrCreateLedgerModel(conn, modelName, collectionName);
  const sessionOpt = () => {
    const s = options.session?.();
    return s ? { session: s } : {};
  };
  /**
   * Token-less (arc-shaped) claims this instance won and has not finished: rowId → tokens. The
   * fallback for a `completeDay` / `releaseDay` called outside the invocation that claimed.
   */
  const live = new Map<string, Set<string>>();
  /**
   * Per-invocation binding for the token-less API: `claimDay` enters, synchronously and before
   * its first await, a context map rowId → slot, so the CALLER's continuation (the invocation
   * that awaits the claim, then completes or releases it) sees the slot, and a concurrent or
   * later invocation sees its own. A lost claim leaves its slot empty and resolves to the
   * previous one (`prev`).
   */
  interface Slot {
    token?: string;
    prev?: Slot;
  }
  const invocation = new AsyncLocalStorage<Map<string, Slot>>();
  const slotToken = (slot: Slot | undefined): string | undefined => {
    for (let s = slot; s; s = s.prev) if (s.token !== undefined) return s.token;
    return undefined;
  };
  const isLive = (id: string, token: string) => live.get(id)?.has(token) === true;
  const forget = (id: string, token: string) => {
    const set = live.get(id);
    set?.delete(token);
    if (set?.size === 0) live.delete(id);
  };
  /** The token-less caller's claim on the row: its invocation's, else the instance's only one. */
  const tokenFor = (id: string): string | undefined => {
    const own = slotToken(invocation.getStore()?.get(id));
    if (own !== undefined) return own;
    const set = live.get(id);
    return set?.size === 1 ? [...set][0] : undefined;
  };

  const validate = (key: string, civilDate: string, info: MongoDailyClaimInfo) => {
    const _id = rowId(key, civilDate);
    const now = info?.now;
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error('MongoDailyLedger.claimDay: info.now must be a valid Date');
    }
    const staleAfterMs = info.staleAfterMs;
    if (
      staleAfterMs !== undefined &&
      (typeof staleAfterMs !== 'number' || !Number.isFinite(staleAfterMs) || staleAfterMs < 0)
    ) {
      throw new Error('MongoDailyLedger.claimDay: info.staleAfterMs must be a finite number >= 0');
    }
    return { _id, now, staleAfterMs };
  };

  /** Try to win the row; the new claim's token, or `undefined` when not won. */
  const claimRow = async (
    key: string,
    civilDate: string,
    v: { _id: string; now: Date; staleAfterMs: number | undefined },
  ): Promise<string | undefined> => {
    const { _id, now, staleAfterMs } = v;
    const claimToken = randomUUID();
    try {
      if (staleAfterMs === undefined) {
        await model.create([{ _id, key, civilDate, claimedAt: now, claimToken, completed: false }]);
        return claimToken;
      }
      // Absent → the upsert inserts. Present + stale + uncompleted → the
      // filter matches and the claim is re-granted. Anything else → the
      // upsert collides on `_id` (E11000) → not ours.
      const res = await model.updateOne(
        {
          _id,
          completed: false,
          claimedAt: { $lt: new Date(now.getTime() - staleAfterMs) },
        },
        {
          $set: { key, civilDate, claimedAt: now, claimToken, completed: false },
          $unset: { result: '', completedAt: '' },
        },
        { upsert: true },
      );
      return res.upsertedCount + res.modifiedCount > 0 ? claimToken : undefined;
    } catch (err) {
      if ((err as { code?: number } | null)?.code === 11000) return undefined;
      throw err;
    }
  };

  /** Complete the row while `token` still holds it uncompleted. */
  const completeRow = async (
    _id: string,
    token: string,
    result: Record<string, unknown> | undefined,
  ): Promise<boolean> => {
    const res = await model.updateOne(
      { _id, claimToken: token, completed: false },
      {
        $set: {
          completed: true,
          completedAt: nowFn(),
          ...(result !== undefined ? { result } : {}),
        },
      },
      sessionOpt(),
    );
    return res.modifiedCount > 0;
  };

  /** Delete the row while `token` still holds it uncompleted. */
  const releaseRow = async (_id: string, token: string): Promise<boolean> => {
    const res = await model.deleteOne({ _id, claimToken: token, completed: false }, sessionOpt());
    return res.deletedCount > 0;
  };

  return {
    async claimDay(key, civilDate, info) {
      const v = validate(key, civilDate, info);
      // Bind before the first await: the caller's continuation inherits this context.
      const outer = invocation.getStore();
      const scope = new Map<string, Slot>();
      if (outer) {
        for (const [id, slot] of outer) {
          const t = slotToken(slot);
          if (t === undefined || isLive(id, t)) scope.set(id, slot);
        }
      }
      const slot: Slot = { prev: outer?.get(v._id) };
      scope.set(v._id, slot);
      invocation.enterWith(scope);
      const token = await claimRow(key, civilDate, v);
      if (token === undefined) return false;
      slot.token = token;
      const set = live.get(v._id) ?? new Set<string>();
      set.add(token);
      live.set(v._id, set);
      return true;
    },

    async completeDay(key, civilDate, result) {
      const _id = rowId(key, civilDate);
      const token = tokenFor(_id);
      if (token === undefined) return;
      await completeRow(_id, token, result);
      forget(_id, token);
    },

    async releaseDay(key, civilDate) {
      const _id = rowId(key, civilDate);
      const token = tokenFor(_id);
      if (token === undefined) return;
      forget(_id, token);
      await releaseRow(_id, token);
    },

    async claim(key, civilDate, info) {
      const v = validate(key, civilDate, info);
      const token = await claimRow(key, civilDate, v);
      if (token === undefined) return null;
      return {
        key,
        civilDate,
        token,
        claimedAt: v.now,
        complete: (result) => completeRow(v._id, token, result),
        release: () => releaseRow(v._id, token),
      };
    },

    async adminCompleteDay(key, civilDate, result) {
      const _id = rowId(key, civilDate);
      const res = await model.updateOne(
        { _id, completed: false },
        {
          $set: {
            completed: true,
            completedAt: nowFn(),
            ...(result !== undefined ? { result } : {}),
          },
        },
        sessionOpt(),
      );
      return res.modifiedCount > 0;
    },

    async inspect(key, civilDate) {
      const doc = await model.findById(rowId(key, civilDate), null, sessionOpt()).lean();
      if (!doc) return null;
      const { _id: _ignored, ...row } = doc;
      return row;
    },
  };
}

function getOrCreateLedgerModel(
  conn: Connection | typeof mongoose,
  modelName: string,
  collectionName: string,
): Model<DailyLedgerDoc> {
  const existing =
    'models' in conn ? (conn.models[modelName] as Model<DailyLedgerDoc> | undefined) : undefined;
  if (existing) return existing;

  const schema = new Schema<DailyLedgerDoc>(
    {
      _id: { type: String, required: true },
      key: { type: String, required: true },
      civilDate: { type: String, required: true },
      claimedAt: { type: Date, required: true },
      claimToken: { type: String },
      completed: { type: Boolean, required: true, default: false },
      completedAt: { type: Date },
      result: { type: Schema.Types.Mixed },
    },
    { versionKey: false, timestamps: false, _id: false, minimize: false },
  );
  schema.index({ key: 1, civilDate: -1 });

  return (conn as Connection).model<DailyLedgerDoc>(modelName, schema, collectionName);
}
