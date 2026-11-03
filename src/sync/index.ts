/**
 * The mongo stores behind `@classytic/repo-core/sync` (replica set): the change feed
 * (`createChangeLogStore`, filled by `changeLogPlugin`) and the command streams
 * (`createCommandStreamStore`) a sync engine such as `@classytic/arc-sync` records verdicts in.
 * Proven by `runChangeLogStoreConformance` and `runCommandStreamStoreConformance`.
 *
 * ```ts
 * const changes = createChangeLogStore(createChangeLogModels(connection));
 * const streams = createCommandStreamStore(connection, createCommandStreamModels(connection), changes);
 * ```
 *
 * Feed cursors are a gap-free sequence taken from ONE counter document inside the caller's
 * transaction, so sequence order IS commit order: no reader can checkpoint past an entry that has
 * not committed yet. The single counter caps append throughput — the price of never losing an entry.
 */

import {
  type ChangeEntry,
  type ChangeLogAppendOptions,
  type ChangeLogStore,
  type ChangesPage,
  type ChangesSinceOptions,
  type CommandStreamRecord,
  type CommandStreamStore,
  type CommandStreamTx,
  type CommandVerdictRecord,
  CursorExpiredError,
} from '@classytic/repo-core/sync';
import type { ClientSession } from 'mongoose';
import { type Connection, type Model, Schema, Types } from 'mongoose';
import { withTransaction } from '../transaction.js';

export interface ChangeLogModelOptions {
  /** Entries collection. Default `sync_changes`; its counter lives in `<collection>_counter`. */
  collection?: string;
  /** Mongoose model name prefix. Default `SyncChange`. Must be unique per connection. */
  modelName?: string;
  /**
   * When an entry gets its cursor. `'in-transaction'` (default): from the counter, inside the writer's transaction —
   * every writer serialises on that one document and overlapping transactions abort and retry. `'deferred'`: the
   * writer stages the entry (`<collection>_pending`, no counter); a single leased sequencer numbers COMMITTED
   * entries before every read. A cursor is only ever given to a committed entry and is above every cursor given
   * before, so no reader can checkpoint past an entry that appears later.
   */
  sequencing?: 'in-transaction' | 'deferred';
  /**
   * Deferred sequencing: how long the sequencer lease lasts, in ms (default {@link DEFAULT_SEQUENCER_LEASE_MS}).
   * The holder renews it with every batch it commits, so this bounds one batch, not one pass, and it is the longest
   * a sequencer that dies mid-pass can delay numbering. Expiry is judged on the database clock (`$$NOW`), so
   * process clock skew does not stretch it. A holder whose lease was taken over cannot write: each batch commits
   * in one transaction gated on the lease token. Integer, at least 100.
   */
  sequencerLeaseMs?: number;
}

/** Default deferred-sequencer lease: a crashed holder delays numbering at most this long. */
export const DEFAULT_SEQUENCER_LEASE_MS = 5_000;

export interface ChangeLogModels {
  entries: Model<Record<string, unknown>>;
  counter: Model<Record<string, unknown>>;
  /**
   * `prune`'s horizons per `(tenantId, scope)` (`<collection>_horizon`, `tenantId: null` for untenanted entries):
   * the highest seq it deleted there. A filtered reader is expired only by the horizons of what it can see.
   * Always set by `createChangeLogModels`; a hand-built models object without it falls back to the feed-wide
   * horizon for every reader.
   */
  horizons?: Model<Record<string, unknown>>;
  /** Staged, not-yet-numbered entries — present only under `sequencing: 'deferred'`. */
  pending?: Model<Record<string, unknown>>;
  sequencing: 'in-transaction' | 'deferred';
  /** Deferred sequencer lease in ms; {@link DEFAULT_SEQUENCER_LEASE_MS} when absent (a hand-built models object). */
  sequencerLeaseMs?: number;
  /** The counter document's id (one feed per entries collection). */
  feed: string;
}

export function createChangeLogModels(
  connection: Connection,
  options: ChangeLogModelOptions = {},
): ChangeLogModels {
  const {
    collection = 'sync_changes',
    modelName = 'SyncChange',
    sequencing = 'in-transaction',
    sequencerLeaseMs = DEFAULT_SEQUENCER_LEASE_MS,
  } = options;
  assertLeaseMs(sequencerLeaseMs);
  const entriesName = modelName;
  const counterName = `${modelName}Counter`;
  const entries =
    (connection.models[entriesName] as Model<Record<string, unknown>> | undefined) ??
    (connection.model(
      entriesName,
      (() => {
        const schema = new Schema(
          {
            seq: { type: Number, required: true },
            scope: { type: String, required: true },
            docId: { type: String, required: true },
            op: { type: String, enum: ['upsert', 'delete'], required: true },
            version: { type: Number, required: true },
            doc: { type: Schema.Types.Mixed },
            tenantId: { type: String },
            at: { type: Date, required: true },
            /** The staged row this entry was numbered from (deferred sequencing) — the sequencer's idempotency key. */
            pendingId: { type: String },
          },
          { collection, versionKey: false, minimize: false },
        );
        schema.index({ seq: 1 }, { unique: true, name: 'feed_order' });
        schema.index(
          { pendingId: 1 },
          // `$gte: ''`, not `$type`: an equality lookup by pendingId is implied only by `$gte`, so only it serves the lookup.
          {
            unique: true,
            name: 'sequenced_from',
            partialFilterExpression: { pendingId: { $gte: '' } },
          },
        );
        // A branch pulling the resources it syncs, in feed order.
        schema.index({ tenantId: 1, scope: 1, seq: 1 }, { name: 'tenant_scope_feed' });
        // Every entry of one document, oldest first — what compaction deletes by.
        schema.index({ scope: 1, docId: 1, seq: 1 }, { name: 'doc_versions' });
        // Entries older than a cutoff — what `prune(before)` starts from.
        schema.index({ at: 1 }, { name: 'feed_age' });
        return schema;
      })(),
    ) as unknown as Model<Record<string, unknown>>);
  const counter =
    (connection.models[counterName] as Model<Record<string, unknown>> | undefined) ??
    (connection.model(
      counterName,
      new Schema(
        {
          _id: { type: String, required: true },
          seq: { type: Number, required: true },
          /** The deferred sequencer's lease. */
          lockUntil: { type: Date },
          lockBy: { type: String },
          /** `prune`'s feed-wide horizon: the highest seq it deleted. An unfiltered cursor below it is expired. */
          horizon: { type: Number },
        },
        { collection: `${collection}_counter`, versionKey: false },
      ),
    ) as unknown as Model<Record<string, unknown>>);
  const horizonName = `${modelName}Horizon`;
  const horizons =
    (connection.models[horizonName] as Model<Record<string, unknown>> | undefined) ??
    (connection.model(
      horizonName,
      (() => {
        const schema = new Schema(
          {
            tenantId: { type: String, default: null },
            scope: { type: String, required: true },
            horizon: { type: Number, required: true },
          },
          { collection: `${collection}_horizon`, versionKey: false },
        );
        // One row per (tenant, scope): bounded by tenants x scopes, never by prune runs.
        schema.index({ tenantId: 1, scope: 1 }, { unique: true, name: 'tenant_scope_horizon' });
        // A tenant reader's shared scopes: rows of every tenant in those scopes.
        schema.index({ scope: 1 }, { name: 'scope_horizon' });
        return schema;
      })(),
    ) as unknown as Model<Record<string, unknown>>);
  const pendingName = `${modelName}Pending`;
  const pending =
    sequencing === 'deferred'
      ? ((connection.models[pendingName] as Model<Record<string, unknown>> | undefined) ??
        (connection.model(
          pendingName,
          new Schema(
            {
              scope: { type: String, required: true },
              docId: { type: String, required: true },
              op: { type: String, enum: ['upsert', 'delete'], required: true },
              version: { type: Number, required: true },
              doc: { type: Schema.Types.Mixed },
              tenantId: { type: String },
              at: { type: Date, required: true },
            },
            { collection: `${collection}_pending`, versionKey: false, minimize: false },
          ),
        ) as unknown as Model<Record<string, unknown>>))
      : undefined;
  return {
    entries,
    counter,
    horizons,
    ...(pending ? { pending } : {}),
    sequencing,
    sequencerLeaseMs,
    feed: collection,
  };
}

function assertLeaseMs(ms: unknown): asserts ms is number {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 100) {
    throw new Error('[mongokit:sync] sequencerLeaseMs must be an integer of at least 100');
  }
}

/** A change as staged under deferred sequencing — the feed row without its `seq`. */
function stagedRow(
  entry: Parameters<ChangeLogStore['append']>[0],
  at: Date,
): Record<string, unknown> {
  return {
    scope: entry.scope,
    docId: entry.docId,
    op: entry.op,
    version: entry.version,
    ...(entry.op === 'upsert' && entry.doc !== undefined ? { doc: entry.doc } : {}),
    ...(entry.tenantId !== undefined ? { tenantId: entry.tenantId } : {}),
    at,
  };
}

/** Fixed-width, so the opaque cursor also sorts as text. */
const toCursor = (seq: number) => String(seq).padStart(16, '0');
const fromCursor = (cursor: string): number => {
  if (cursor === '') return 0;
  const seq = Number(cursor);
  if (!Number.isSafeInteger(seq) || seq < 0)
    throw new Error(`[mongokit:sync] "${cursor}" is not a cursor from this feed`);
  return seq;
};

const DEFAULT_LIMIT = 500;

/** The mongo change feed: the `ChangeLogStore` contract plus superseded-entry compaction. */
export interface MongoChangeLogStore extends ChangeLogStore {
  /**
   * Delete every entry a later COMMITTED entry of the same `(tenantId, scope, docId)` replaced. Safe for any client
   * cursor: entries carry whole documents, so a reader only ever needs the latest one; tombstones and
   * each document's latest entry stay. Idempotent; run it on a schedule.
   */
  compactSuperseded(options?: { batchSize?: number }): Promise<{ removed: number }>;
  /**
   * Retention with a horizon (the `ChangeLogStore.prune` contract). Deletes every entry older than
   * `before` (`at < before`) that a later entry of the same `(tenantId, scope, docId)` replaced:
   * each document's latest entry stays, tombstone or not, so a full reload still sees every
   * document. Records a HORIZON (the highest deleted cursor, never lowered) per `(tenantId, scope)`
   * and feed-wide, BEFORE deleting, and returns the feed-wide one, `''` while nothing was ever
   * pruned. `since(cursor, options)` with a cursor below the horizon of what that reader can see
   * (its tenant, shared scopes and `scopes`; the feed-wide horizon when unfiltered; `''` included)
   * throws repo-core's `CursorExpiredError(cursor, horizon)`: that reader missed deleted
   * intermediate entries and must resync from `latestCursor(options)`, which never answers below
   * that horizon. Pruning one tenant never expires another tenant's cursor. Unlike
   * `compactSuperseded`, which is safe for any cursor but silently drops intermediate entries a
   * resuming reader has not seen, a reader never gets a silent gap here. Idempotent; schedule it
   * (e.g. hourly with `before = now - 24h`).
   */
  prune(before: Date, options?: { batchSize?: number }): Promise<string>;
  /**
   * The compaction horizon cursor a reader with these options is held to (`''` while nothing it
   * can see was pruned); feed-wide without options.
   */
  horizon(
    options?: Pick<ChangesSinceOptions, 'tenantId' | 'scopes' | 'sharedScopes'>,
  ): Promise<string>;
  /**
   * Number every staged entry (deferred sequencing; a no-op otherwise). Reads call it first; a scheduler may too.
   * Returns how many it numbered, or `null` when another sequencer holds the lease.
   */
  sequencePending(): Promise<number | null>;
  /**
   * Record a change WITHOUT waiting for its cursor (deferred sequencing): the next read numbers it. For writers that
   * never use the cursor (`changeLogPlugin`). Under in-transaction sequencing it is `append`.
   */
  stage(
    entry: Parameters<ChangeLogStore['append']>[0],
    options?: ChangeLogAppendOptions,
  ): Promise<void>;
  /**
   * Point read of ONE document's latest recorded change: its last staged entry when one waits for a cursor
   * (deferred sequencing; `cursor: ''`, as `append` answers inside a transaction), else its highest numbered
   * entry; `null` when the feed holds none. Reads only (it never runs the sequencer), so it is cheap on a hot
   * path, e.g. a writer that needs the last recorded state of a record before it appends the next change.
   * A document is `(tenantId, scope, docId)`: `tenantId` omitted or `null` reads the untenanted document.
   * Pass `session` to see what the caller staged or appended in its own transaction. A pruned or compacted
   * document still has its latest entry (both keep it).
   */
  latestOf(
    scope: string,
    docId: string,
    options?: { tenantId?: string | null; session?: unknown },
  ): Promise<ChangeEntry | null>;
}

const SEQUENCER_BATCH = 500;

/** Thrown inside a batch transaction whose lease was taken over: the transaction aborts, nothing it wrote lands. */
class SequencerLeaseLost extends Error {}

/** What {@link ChangeLogStoreOptions.onSequenced} is told: new entries now have cursors up to `cursor`. */
export interface ChangeLogSequencedEvent {
  /** The highest numbered cursor of the feed after the pass (readers reading past their cursor see the new entries). */
  cursor: string;
  /** How many entries were numbered since this store last looked (by this store, or by another holder). */
  numbered: number;
  /** `'self'`: this store's pass numbered them. `'other'`: another holder did, while a read of this store waited. */
  by: 'self' | 'other';
}

/** Runtime options of {@link createChangeLogStore} (the models carry the storage options). */
export interface ChangeLogStoreOptions {
  /**
   * Clock for every entry's `at` (staged and in-transaction appends). Default `() => new Date()`. Inject the host's
   * clock so `at` and `prune(before)` cutoffs agree with a driven test clock. The deferred sequencer's LEASE stays on
   * the database clock (`$$NOW`): it is shared by every process, so it must not depend on any one process's clock.
   */
  now?: () => Date;
  /**
   * Deferred sequencing: called after new entries got cursors, so a host's replay hub can `notify()` its tails at
   * once. Fires when this store's pass numbered entries (`by: 'self'`), and when a read of this store found the
   * sequencer lease held by another holder: the store then retries in the background (short backoff, unref'd
   * timers, for at most three leases) until that holder is done, and reports what it numbered meanwhile
   * (`by: 'other'`), or takes over a lease left by a holder that died and numbers the entries itself
   * (`by: 'self'`). Without this hook nothing is retried in the background. A throwing hook is ignored. Never
   * called under in-transaction sequencing (every append already has its cursor).
   */
  onSequenced?: (event: ChangeLogSequencedEvent) => void;
}

export function createChangeLogStore(
  models: ChangeLogModels,
  storeOptions: ChangeLogStoreOptions = {},
): MongoChangeLogStore {
  const { entries, counter, feed, pending, horizons } = models;
  const deferred = models.sequencing === 'deferred' && pending !== undefined;
  const leaseMs = models.sequencerLeaseMs ?? DEFAULT_SEQUENCER_LEASE_MS;
  assertLeaseMs(leaseMs);
  const now = storeOptions.now ?? (() => new Date());
  const onSequenced = storeOptions.onSequenced;
  const counterId = feed as unknown as never;

  const report = (event: ChangeLogSequencedEvent) => {
    try {
      onSequenced?.(event);
    } catch {
      // A host hook never fails the read that numbered the entries.
    }
  };

  /** The feed's numbered top (the counter row's `seq`; 0 before the first entry). */
  const counterTop = async (): Promise<number> => {
    const row = (await counter.collection.findOne(
      { _id: counterId },
      { projection: { seq: 1 } },
    )) as { seq?: unknown } | null;
    return typeof row?.seq === 'number' ? row.seq : 0;
  };

  /**
   * After a pass found the lease busy (and a hook is set): retry in the background until the holder is done, then
   * report what got numbered meanwhile. One follow-up per store at a time; bounded by three leases.
   */
  let followUp = false;
  const followBusyLease = async () => {
    if (!onSequenced || followUp) return;
    followUp = true;
    try {
      const seen = await counterTop();
      const deadline = Date.now() + leaseMs * 3;
      let delay = Math.max(10, Math.min(50, Math.floor(leaseMs / 10)));
      for (;;) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, delay);
          (t as { unref?: () => void }).unref?.();
        });
        const result = await runPass();
        if (result !== null) {
          // `result > 0`: this store numbered (and already reported). Otherwise the other holder finished.
          if (result === 0) {
            const top = await counterTop();
            if (top > seen) report({ cursor: toCursor(top), numbered: top - seen, by: 'other' });
          }
          return;
        }
        if (Date.now() > deadline) return;
        delay = Math.min(delay * 2, Math.max(50, Math.floor(leaseMs / 2)));
      }
    } catch {
      // Background best effort: the next read or wake runs the sequencer again.
    } finally {
      followUp = false;
    }
  };

  /**
   * One pass under the lease: committed staged rows → the feed, in staging order, numbered above everything.
   * Nothing staged costs ONE read. The lease lives on the counter row and is judged on the database clock; each
   * batch commits in ONE transaction (insert, counter + lease renewal gated on this pass's token, staged-row delete),
   * so a holder that lost the lease to a takeover writes nothing, and a crash leaves no half batch. Without
   * transactions (standalone) the batch runs unfenced, as before. A pre-existing half batch is still converged:
   * an entry already in the feed is recognised by its unique `pendingId`, a stale counter by the unique `seq` index.
   */
  const runPass = async (): Promise<number | null> => {
    if (!deferred || !pending) return 0;
    if (!(await pending.exists({}).exec())) return 0;
    const token = new Types.ObjectId().toString();
    const takeLease = async () =>
      (await counter.collection.findOneAndUpdate(
        // Free, released (null) or lapsed: a missing or null lockUntil sorts below any date.
        { _id: counterId, $expr: { $lt: ['$lockUntil', '$$NOW'] } },
        [{ $set: { lockUntil: { $add: ['$$NOW', leaseMs] }, lockBy: { $literal: token } } }],
        { returnDocument: 'after' },
      )) as { seq?: number } | null;
    let lease = await takeLease();
    if (!lease) {
      // Held by another sequencer, or the feed has no counter yet.
      if (await counter.exists({ _id: feed }).exec()) return null;
      await counter.create([{ _id: feed, seq: 0 }]).catch((err: unknown) => {
        if ((err as { code?: number }).code !== 11000) throw err;
      });
      lease = await takeLease();
      if (!lease) return null;
    }
    let seq = lease.seq ?? 0;
    let numbered = 0;
    const build = (from: number, list: Array<Record<string, unknown>>) =>
      list.map((r, i) => {
        const { _id, ...rest } = r;
        return { ...rest, seq: from + i + 1, pendingId: String(_id) };
      });
    /** Commit one batch atomically under the lease; `fresh` are the rows not yet in the feed. */
    const commit = (rows: Array<Record<string, unknown>>, fresh: Array<Record<string, unknown>>) =>
      withTransaction(
        entries.db,
        async (session) => {
          if (fresh.length > 0)
            await entries.insertMany(build(seq, fresh), { ordered: true, session });
          // The fence: renew the lease and raise the counter only while this pass still holds it.
          const held = await counter.collection.updateOne(
            { _id: counterId, lockBy: token },
            [
              {
                $set: {
                  seq: { $max: ['$seq', seq + fresh.length] },
                  lockUntil: { $add: ['$$NOW', leaseMs] },
                },
              },
            ],
            { session },
          );
          if (held.matchedCount === 0) throw new SequencerLeaseLost();
          await pending.deleteMany({ _id: { $in: rows.map((r) => r._id) } }, { session }).exec();
        },
        { allowFallback: true },
      );
    try {
      for (;;) {
        const rows = (await pending
          .find({})
          .sort({ _id: 1 })
          .limit(SEQUENCER_BATCH)
          .lean()
          .exec()) as Array<Record<string, unknown>>;
        if (rows.length === 0) break;
        try {
          await commit(rows, rows);
          seq += rows.length;
          numbered += rows.length;
        } catch (err) {
          if (err instanceof SequencerLeaseLost) break;
          if ((err as { code?: number }).code !== 11000) throw err;
          // A half batch from before (or a racing holder): drop rows already in the feed, renumber above its top.
          const placed = new Set(
            (
              (await entries
                .find({ pendingId: { $in: rows.map((r) => String(r._id)) } })
                .select({ pendingId: 1 })
                .lean()
                .exec()) as Array<{ pendingId?: string }>
            ).map((e) => e.pendingId),
          );
          const fresh = rows.filter((r) => !placed.has(String(r._id)));
          const top = (await entries
            .findOne({})
            .sort({ seq: -1 })
            .select({ seq: 1 })
            .lean()
            .exec()) as { seq?: number } | null;
          seq = Math.max(seq, top?.seq ?? 0);
          try {
            await commit(rows, fresh);
          } catch (again) {
            if (again instanceof SequencerLeaseLost) break;
            throw again;
          }
          seq += fresh.length;
          numbered += fresh.length;
        }
        if (rows.length < SEQUENCER_BATCH) break;
      }
    } finally {
      await counter
        .updateOne({ _id: feed, lockBy: token }, { $set: { lockUntil: null, lockBy: null } })
        .exec();
    }
    if (numbered > 0) report({ cursor: toCursor(seq), numbered, by: 'self' });
    return numbered;
  };
  /** One pass; a busy lease starts the background follow-up (only with `onSequenced`). */
  const sequencePending = async (): Promise<number | null> => {
    const result = await runPass();
    if (result === null) void followBusyLease();
    return result;
  };
  const sessionOf = (options?: ChangeLogAppendOptions) =>
    options?.session ? { session: options.session as ClientSession } : {};

  type View = Pick<ChangesSinceOptions, 'tenantId' | 'scopes' | 'sharedScopes'>;
  /** What a reader sees: its tenant (plus shared scopes), narrowed by `scopes`. Matches entries and horizon rows. */
  const viewOf = (options: View = {}) => {
    const { tenantId, scopes, sharedScopes } = options;
    const tenant =
      tenantId === undefined
        ? {}
        : sharedScopes?.length
          ? { $or: [{ tenantId }, { scope: { $in: [...sharedScopes] } }] }
          : { tenantId };
    return { ...tenant, ...(scopes ? { scope: { $in: [...scopes] } } : {}) };
  };
  const filterOf = (after: number, options: View = {}) => ({
    seq: { $gt: after },
    ...viewOf(options),
  });

  /** The recorded feed-wide compaction horizon (0: never pruned). Raw driver: the counter row is schemaless here. */
  const horizonSeq = async (): Promise<number> => {
    const row = (await counter.collection.findOne(
      { _id: feed as unknown as never },
      { projection: { horizon: 1 } },
    )) as { horizon?: unknown } | null;
    return typeof row?.horizon === 'number' ? row.horizon : 0;
  };

  /** The horizon a reader is held to: the highest one among the `(tenantId, scope)` rows it can see. */
  const horizonFor = async (options: View = {}): Promise<number> => {
    if (!horizons || (options.tenantId === undefined && !options.scopes)) return horizonSeq();
    const row = (await horizons.collection.findOne(viewOf(options), {
      sort: { horizon: -1 },
      projection: { horizon: 1 },
    })) as { horizon?: unknown } | null;
    return typeof row?.horizon === 'number' ? row.horizon : 0;
  };

  /**
   * One document's identity: tenants sharing a docId in one scope are different documents. A missing
   * tenantId groups (and, as `null`, matches) as untenanted.
   */
  const docKey = {
    tenantId: { $ifNull: ['$tenantId', null] },
    scope: '$scope',
    docId: '$docId',
  };
  type DocKey = { tenantId: string | null; scope: string; docId: string };
  const docOf = (id: DocKey) => ({
    tenantId: id.tenantId ?? null,
    scope: id.scope,
    docId: id.docId,
  });

  const toEntry = (row: Record<string, unknown>): ChangeEntry => ({
    scope: row.scope as string,
    docId: row.docId as string,
    op: row.op as 'upsert' | 'delete',
    version: row.version as number,
    ...(row.doc !== undefined && row.doc !== null ? { doc: row.doc } : {}),
    ...(typeof row.tenantId === 'string' ? { tenantId: row.tenantId } : {}),
    at: row.at as Date,
    cursor: toCursor(row.seq as number),
  });

  return {
    sequencePending,

    async stage(entry, options) {
      if (!deferred || !pending) {
        await this.append(entry, options);
        return;
      }
      await pending.create([stagedRow(entry, now())], sessionOf(options));
    },

    async append(entry, options) {
      const session = sessionOf(options);
      if (deferred && pending) {
        const at = now();
        const [staged] = (await pending.create(
          [stagedRow(entry, at)],
          session,
        )) as unknown as Array<{ _id: unknown }>;
        // Inside a transaction the entry is not committed yet: it is numbered after the commit (the memory
        // reference answers '' here too). Standalone it IS committed: number it now and return its cursor.
        if (options?.session) return { ...entry, at, cursor: '' };
        const stagedId = String(staged?._id);
        // Long enough to outlast a lease left by a crashed holder (at least the old 50 x 20 ms).
        const deadline = Date.now() + Math.max(1_000, leaseMs + 1_000);
        for (let attempt = 0; attempt < 50 || Date.now() < deadline; attempt++) {
          await sequencePending();
          const at2 = (await entries
            .findOne({ pendingId: stagedId })
            .select({ seq: 1 })
            .lean()
            .exec()) as {
            seq?: number;
          } | null;
          if (typeof at2?.seq === 'number') return { ...entry, at, cursor: toCursor(at2.seq) };
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(
          `[mongokit:sync] staged entry ${stagedId} was not sequenced — a sequencer lease is stuck`,
        );
      }
      const next = await counter
        .findOneAndUpdate(
          { _id: feed },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: 'after', lean: true, ...session },
        )
        .exec();
      const seq = (next as unknown as { seq: number }).seq;
      const at = now();
      await entries.create(
        [
          {
            seq,
            scope: entry.scope,
            docId: entry.docId,
            op: entry.op,
            version: entry.version,
            ...(entry.op === 'upsert' && entry.doc !== undefined ? { doc: entry.doc } : {}),
            ...(entry.tenantId !== undefined ? { tenantId: entry.tenantId } : {}),
            at,
          },
        ],
        session,
      );
      return { ...entry, at, cursor: toCursor(seq) };
    },

    async since(cursor, options = {}): Promise<ChangesPage> {
      // A busy lease (null) is fine: read what is numbered; anything staged gets a cursor above it.
      if (deferred) await sequencePending();
      const limit = options.limit ?? DEFAULT_LIMIT;
      const after = fromCursor(cursor);
      const rows = (await entries
        .find(filterOf(after, options))
        .sort({ seq: 1 })
        .limit(limit + 1)
        .lean()
        .exec()) as Record<string, unknown>[];
      // Read AFTER the rows: `prune` raises the horizon before it deletes, so a page that could be
      // missing a pruned entry always sees the raised horizon here. Only what this reader can see
      // counts: pruning another tenant or scope never expires its cursor.
      const horizon = await horizonFor(options);
      if (horizon > 0 && after < horizon) throw new CursorExpiredError(cursor, toCursor(horizon));
      const page = rows.slice(0, limit).map(toEntry);
      const last = page[page.length - 1];
      return { changes: page, cursor: last ? last.cursor : cursor, hasMore: rows.length > limit };
    },

    async latestOf(scope, docId, options = {}) {
      // `null` also matches a missing tenantId: the untenanted document (the `docKey` identity).
      const filter = { scope, docId, tenantId: options.tenantId ?? null };
      const session = options.session ? { session: options.session as ClientSession } : {};
      // Staged rows are committed after every numbered one (the sequencer numbers above the top), so a staged
      // entry is newer; among them, staging order (`_id`) is the order the sequencer will number them in.
      if (deferred && pending) {
        const staged = (await pending
          .findOne(filter, null, session)
          .sort({ _id: -1 })
          .lean()
          .exec()) as Record<string, unknown> | null;
        if (staged) return { ...toEntry({ ...staged, seq: 0 }), cursor: '' };
      }
      const row = (await entries
        .findOne(filter, null, session)
        .sort({ seq: -1 })
        .lean()
        .exec()) as Record<string, unknown> | null;
      return row ? toEntry(row) : null;
    },

    async latestCursor(options = {}) {
      if (deferred) await sequencePending();
      const row = (await entries
        .findOne(filterOf(0, options))
        .sort({ seq: -1 })
        .select({ seq: 1 })
        .lean()
        .exec()) as {
        seq?: number;
      } | null;
      // Never below the reader's horizon, so a reader that resyncs here can always resume.
      const seq = Math.max(row?.seq ?? 0, await horizonFor(options));
      return seq > 0 ? toCursor(seq) : '';
    },

    async compactSuperseded(options = {}) {
      const batchSize = options.batchSize ?? 1000;
      const groups = entries
        .aggregate<{ _id: DocKey; latest: number }>([
          {
            $group: {
              _id: docKey,
              latest: { $max: '$seq' },
              n: { $sum: 1 },
            },
          },
          { $match: { n: { $gt: 1 } } },
          { $project: { latest: 1 } },
        ])
        .allowDiskUse(true)
        .cursor({ batchSize });
      let removed = 0;
      let ops: Array<{ deleteMany: { filter: Record<string, unknown> } }> = [];
      const flush = async () => {
        if (ops.length === 0) return;
        removed += (await entries.bulkWrite(ops, { ordered: false })).deletedCount;
        ops = [];
      };
      for await (const g of groups) {
        ops.push({
          deleteMany: {
            filter: { ...docOf(g._id), seq: { $lt: g.latest } },
          },
        });
        if (ops.length >= batchSize) await flush();
      }
      await flush();
      return { removed };
    },

    async horizon(options) {
      const seq = await horizonFor(options);
      return seq > 0 ? toCursor(seq) : '';
    },

    async prune(before, options = {}) {
      if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
        throw new Error('[mongokit:sync] prune(before) needs a valid Date');
      }
      const batchSize = options.batchSize ?? 1000;
      if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new Error('[mongokit:sync] prune batchSize must be a positive integer');
      }
      // Staged entries become numbered first, so "latest per document" is judged on the whole feed.
      if (deferred) await sequencePending();
      const old = { $lt: before };
      const groups = entries
        .aggregate<{ _id: DocKey; oldMax: number; n: number }>([
          { $match: { at: old } },
          {
            $group: {
              _id: docKey,
              oldMax: { $max: '$seq' },
              n: { $sum: 1 },
            },
          },
        ])
        .allowDiskUse(true)
        .cursor({ batchSize });
      const topSeq = async (filter: Record<string, unknown>): Promise<number> => {
        const row = (await entries
          .findOne(filter)
          .sort({ seq: -1 })
          .select({ seq: 1 })
          .lean()
          .exec()) as { seq?: number } | null;
        return row?.seq ?? 0;
      };
      let ops: Array<{ deleteMany: { filter: Record<string, unknown> } }> = [];
      let batchMax = 0;
      /** Highest seq this batch deletes per `(tenantId, scope)` — the rows a filtered reader is held to. */
      let viewMax = new Map<string, { tenantId: string | null; scope: string; seq: number }>();
      const flush = async () => {
        if (ops.length === 0) return;
        // Horizons first, deletes second: a reader that could miss a deleted entry sees its horizon.
        if (horizons) {
          await horizons.collection.bulkWrite(
            [...viewMax.values()].map(({ tenantId, scope, seq }) => ({
              updateOne: {
                filter: { tenantId, scope },
                update: { $max: { horizon: seq } },
                upsert: true,
              },
            })),
            { ordered: false },
          );
        }
        await counter.collection.updateOne(
          { _id: feed as unknown as never },
          { $max: { horizon: batchMax } },
          { upsert: true },
        );
        await entries.bulkWrite(ops, { ordered: false });
        ops = [];
        batchMax = 0;
        viewMax = new Map();
      };
      for await (const g of groups) {
        const doc = docOf(g._id);
        const latest = await topSeq(doc);
        // Highest entry this group deletes: every old one when a later entry exists, else all old
        // ones but the latest (and then only if there is more than one).
        let deletedMax: number;
        if (latest > g.oldMax) deletedMax = g.oldMax;
        else if (g.n > 1) deletedMax = await topSeq({ ...doc, at: old, seq: { $lt: latest } });
        else continue;
        if (deletedMax <= 0) continue;
        // Delete exactly the range the recorded horizon covers (`seq <= deletedMax`), never up to
        // `latest`: `oldMax` is from the earlier snapshot, so an old entry appended (or numbered)
        // since then sits between it and `latest`. It stays for the next run; deleting it here would
        // put a gap above the advertised horizon that `since()` could not detect.
        ops.push({ deleteMany: { filter: { ...doc, at: old, seq: { $lte: deletedMax } } } });
        batchMax = Math.max(batchMax, deletedMax);
        const key = JSON.stringify([doc.tenantId, doc.scope]);
        const seen = viewMax.get(key);
        if (!seen || seen.seq < deletedMax) {
          viewMax.set(key, { tenantId: doc.tenantId, scope: doc.scope, seq: deletedMax });
        }
        if (ops.length >= batchSize) await flush();
      }
      await flush();
      const horizon = await horizonSeq();
      return horizon > 0 ? toCursor(horizon) : '';
    },
  };
}

export interface CommandStreamModelOptions {
  /** Collection prefix: `<prefix>_streams`, `<prefix>_verdicts`, `<prefix>_aliases`. Default `sync`. */
  prefix?: string;
  /** Mongoose model name prefix. Default `SyncStream`. Must be unique per connection. */
  modelName?: string;
}

export interface CommandStreamModels {
  streams: Model<Record<string, unknown>>;
  verdicts: Model<Record<string, unknown>>;
  aliases: Model<Record<string, unknown>>;
}

export function createCommandStreamModels(
  connection: Connection,
  options: CommandStreamModelOptions = {},
): CommandStreamModels {
  const { prefix = 'sync', modelName = 'SyncStream' } = options;
  const model = (name: string, schema: () => Schema) =>
    (connection.models[name] as Model<Record<string, unknown>> | undefined) ??
    (connection.model(name, schema()) as unknown as Model<Record<string, unknown>>);
  const streams = model(
    modelName,
    () =>
      new Schema(
        {
          _id: { type: String, required: true },
          tenantId: { type: String, required: true },
          processed: { type: Number, required: true },
        },
        { collection: `${prefix}_streams`, versionKey: false },
      ),
  );
  const verdicts = model(`${modelName}Verdict`, () => {
    const schema = new Schema(
      {
        _id: { type: String, required: true },
        stream: { type: String, required: true },
        seq: { type: Number, required: true },
        outcome: {
          type: String,
          enum: ['applied', 'rejected', 'blocked', 'resolved'],
          required: true,
        },
        code: { type: String },
        fingerprint: { type: String, required: true },
        body: { type: String },
        dependsOn: { type: [String], default: undefined },
        resolution: {
          type: { action: String, by: String, at: String, _id: false },
          default: undefined,
        },
      },
      { collection: `${prefix}_verdicts`, versionKey: false },
    );
    // One verdict per seq — a fence beneath the watermark's compare-and-set.
    schema.index({ stream: 1, seq: 1 }, { unique: true, name: 'stream_seq' });
    // What a resolution re-evaluates: the blocked commands waiting on its target.
    schema.index(
      { dependsOn: 1, outcome: 1 },
      { name: 'blocked_on', partialFilterExpression: { outcome: 'blocked' } },
    );
    return schema;
  });
  const aliases = model(`${modelName}Alias`, () => {
    const schema = new Schema(
      {
        tenantId: { type: String, required: true },
        localId: { type: String, required: true },
        serverId: { type: String, required: true },
      },
      { collection: `${prefix}_aliases`, versionKey: false },
    );
    schema.index({ tenantId: 1, localId: 1 }, { unique: true, name: 'tenant_local' });
    return schema;
  });
  return { streams, verdicts, aliases };
}

export interface MongoCommandStreamTx extends CommandStreamTx {
  readonly session: ClientSession;
}

/**
 * The mongo {@link CommandStreamStore} (replica set). Proven by `runCommandStreamStoreConformance`.
 * Concurrent transactions on one stream write-conflict on its document and `withTransaction`
 * retries the loser, which then reads the winner's watermark.
 */
export function createCommandStreamStore(
  connection: Pick<Connection, 'startSession'>,
  models: CommandStreamModels,
  changes: ChangeLogStore,
): CommandStreamStore<MongoCommandStreamTx> {
  const { streams, verdicts, aliases } = models;
  type VerdictRow = Omit<CommandVerdictRecord, 'commandId'> & { _id: string; code?: string | null };
  const toVerdict = ({ _id, code, ...rest }: VerdictRow): CommandVerdictRecord => ({
    commandId: _id,
    ...rest,
    ...(code == null ? {} : { code }),
  });
  return {
    changes,
    transaction: (work) => withTransaction(connection, (session) => work({ session })),

    async stream({ session }, id) {
      const row = (await streams
        .findById(id)
        .session(session)
        .lean()
        .exec()) as CommandStreamRecord | null;
      return row ? { tenantId: row.tenantId, processed: row.processed } : null;
    },

    async advance({ session }, id, tenantId, from, to) {
      if (from === 0) {
        // A concurrent creator write-conflicts on the insert and is retried into the `exists` branch.
        if (await streams.exists({ _id: id }).session(session)) return false;
        await streams.create([{ _id: id, tenantId, processed: to }], { session });
        return true;
      }
      const result = await streams
        .updateOne({ _id: id, processed: from }, { $set: { processed: to } }, { session })
        .exec();
      return result.modifiedCount === 1;
    },

    async verdict({ session }, commandId) {
      const row = (await verdicts
        .findById(commandId)
        .session(session)
        .lean()
        .exec()) as VerdictRow | null;
      return row ? toVerdict(row) : null;
    },

    async record({ session }, { commandId, ...rest }) {
      await verdicts.replaceOne({ _id: commandId }, rest, { upsert: true, session }).exec();
    },

    async blockedOn({ session }, commandId) {
      const rows = (await verdicts
        .find({ outcome: 'blocked', dependsOn: commandId })
        .sort({ seq: 1 })
        .session(session)
        .lean()
        .exec()) as unknown as VerdictRow[];
      return rows.map(toVerdict);
    },

    async alias({ session }, { tenantId, localId, serverId }) {
      const existing = (await aliases
        .findOne({ tenantId, localId })
        .session(session)
        .lean()
        .exec()) as {
        serverId: string;
      } | null;
      if (existing) {
        if (existing.serverId !== serverId)
          throw new Error(`[mongokit:sync] "${localId}" already names "${existing.serverId}"`);
        return;
      }
      await aliases.create([{ tenantId, localId, serverId }], { session });
    },

    async aliasOf({ session }, tenantId, localId) {
      const row = (await aliases.findOne({ tenantId, localId }).session(session).lean().exec()) as {
        serverId: string;
      } | null;
      return row?.serverId ?? null;
    },
  };
}
