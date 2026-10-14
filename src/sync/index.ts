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

import type {
  ChangeEntry,
  ChangeLogAppendOptions,
  ChangeLogStore,
  ChangesPage,
  ChangesSinceOptions,
  CommandStreamRecord,
  CommandStreamStore,
  CommandStreamTx,
  CommandVerdictRecord,
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
}

export interface ChangeLogModels {
  entries: Model<Record<string, unknown>>;
  counter: Model<Record<string, unknown>>;
  /** Staged, not-yet-numbered entries — present only under `sequencing: 'deferred'`. */
  pending?: Model<Record<string, unknown>>;
  sequencing: 'in-transaction' | 'deferred';
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
  } = options;
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
        },
        { collection: `${collection}_counter`, versionKey: false },
      ),
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
  return { entries, counter, ...(pending ? { pending } : {}), sequencing, feed: collection };
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
   * Delete every entry a later COMMITTED entry of the same `(scope, docId)` replaced. Safe for any client
   * cursor: entries carry whole documents, so a reader only ever needs the latest one; tombstones and
   * each document's latest entry stay. Idempotent; run it on a schedule.
   */
  compactSuperseded(options?: { batchSize?: number }): Promise<{ removed: number }>;
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
}

/** How long one sequencer holds the lease — far above one batch, so a live holder never loses it mid-batch. */
const SEQUENCER_LEASE_MS = 30_000;
const SEQUENCER_BATCH = 500;

export function createChangeLogStore(models: ChangeLogModels): MongoChangeLogStore {
  const { entries, counter, feed, pending } = models;
  const deferred = models.sequencing === 'deferred' && pending !== undefined;

  /**
   * One pass under the lease: committed staged rows → the feed, in staging order, numbered above everything.
   * Nothing staged costs ONE read. A crash mid-pass is converged by the next one: an entry already in the feed is
   * recognised by its unique `pendingId`, and a stale counter is caught by the unique `seq` index.
   */
  const sequencePending = async (): Promise<number | null> => {
    if (!deferred || !pending) return 0;
    if (!(await pending.exists({}).exec())) return 0;
    const token = new Types.ObjectId().toString();
    const unlocked = {
      _id: feed,
      $or: [
        { lockUntil: { $exists: false } },
        { lockUntil: null },
        { lockUntil: { $lt: new Date() } },
      ],
    };
    const takeLease = () =>
      counter
        .findOneAndUpdate(
          unlocked,
          { $set: { lockUntil: new Date(Date.now() + SEQUENCER_LEASE_MS), lockBy: token } },
          { returnDocument: 'after', lean: true },
        )
        .exec() as Promise<{ seq?: number } | null>;
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
    try {
      for (;;) {
        const rows = (await pending
          .find({})
          .sort({ _id: 1 })
          .limit(SEQUENCER_BATCH)
          .lean()
          .exec()) as Array<Record<string, unknown>>;
        if (rows.length === 0) break;
        const build = (from: number, list: Array<Record<string, unknown>>) =>
          list.map((r, i) => {
            const { _id, ...rest } = r;
            return { ...rest, seq: from + i + 1, pendingId: String(_id) };
          });
        try {
          await entries.insertMany(build(seq, rows), { ordered: true });
          seq += rows.length;
          numbered += rows.length;
        } catch (err) {
          if ((err as { code?: number }).code !== 11000) throw err;
          // A crashed pass: drop rows already in the feed, renumber above the feed's real top.
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
          if (fresh.length > 0) {
            await entries.insertMany(build(seq, fresh), { ordered: true });
            seq += fresh.length;
            numbered += fresh.length;
          }
        }
        await counter.updateOne({ _id: feed, lockBy: token }, { $max: { seq } }).exec();
        await pending.deleteMany({ _id: { $in: rows.map((r) => r._id) } }).exec();
        if (rows.length < SEQUENCER_BATCH) break;
      }
    } finally {
      await counter
        .updateOne({ _id: feed, lockBy: token }, { $set: { lockUntil: null, lockBy: null } })
        .exec();
    }
    return numbered;
  };
  const sessionOf = (options?: ChangeLogAppendOptions) =>
    options?.session ? { session: options.session as ClientSession } : {};

  const filterOf = (
    after: number,
    options: Pick<ChangesSinceOptions, 'tenantId' | 'scopes' | 'sharedScopes'> = {},
  ) => {
    const { tenantId, scopes, sharedScopes } = options;
    const tenant =
      tenantId === undefined
        ? {}
        : sharedScopes?.length
          ? { $or: [{ tenantId }, { scope: { $in: [...sharedScopes] } }] }
          : { tenantId };
    return { seq: { $gt: after }, ...tenant, ...(scopes ? { scope: { $in: [...scopes] } } : {}) };
  };

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
      await pending.create([stagedRow(entry, new Date())], sessionOf(options));
    },

    async append(entry, options) {
      const session = sessionOf(options);
      if (deferred && pending) {
        const at = new Date();
        const [staged] = (await pending.create(
          [stagedRow(entry, at)],
          session,
        )) as unknown as Array<{ _id: unknown }>;
        // Inside a transaction the entry is not committed yet: it is numbered after the commit (the memory
        // reference answers '' here too). Standalone it IS committed: number it now and return its cursor.
        if (options?.session) return { ...entry, at, cursor: '' };
        const stagedId = String(staged?._id);
        for (let attempt = 0; attempt < 50; attempt++) {
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
      const at = new Date();
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
      const rows = (await entries
        .find(filterOf(fromCursor(cursor), options))
        .sort({ seq: 1 })
        .limit(limit + 1)
        .lean()
        .exec()) as Record<string, unknown>[];
      const page = rows.slice(0, limit).map(toEntry);
      const last = page[page.length - 1];
      return { changes: page, cursor: last ? last.cursor : cursor, hasMore: rows.length > limit };
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
      return row?.seq ? toCursor(row.seq) : '';
    },

    async compactSuperseded(options = {}) {
      const batchSize = options.batchSize ?? 1000;
      const groups = entries
        .aggregate<{ _id: { scope: string; docId: string }; latest: number }>([
          {
            $group: {
              _id: { scope: '$scope', docId: '$docId' },
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
            filter: { scope: g._id.scope, docId: g._id.docId, seq: { $lt: g.latest } },
          },
        });
        if (ops.length >= batchSize) await flush();
      }
      await flush();
      return { removed };
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
