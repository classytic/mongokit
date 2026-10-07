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
import type { ClientSession } from 'mongodb';
import { type Connection, type Model, Schema } from 'mongoose';
import { withTransaction } from '../transaction.js';

export interface ChangeLogModelOptions {
  /** Entries collection. Default `sync_changes`; its counter lives in `<collection>_counter`. */
  collection?: string;
  /** Mongoose model name prefix. Default `SyncChange`. Must be unique per connection. */
  modelName?: string;
}

export interface ChangeLogModels {
  entries: Model<Record<string, unknown>>;
  counter: Model<Record<string, unknown>>;
  /** The counter document's id (one feed per entries collection). */
  feed: string;
}

export function createChangeLogModels(
  connection: Connection,
  options: ChangeLogModelOptions = {},
): ChangeLogModels {
  const { collection = 'sync_changes', modelName = 'SyncChange' } = options;
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
          },
          { collection, versionKey: false, minimize: false },
        );
        schema.index({ seq: 1 }, { unique: true, name: 'feed_order' });
        // A branch pulling the resources it syncs, in feed order.
        schema.index({ tenantId: 1, scope: 1, seq: 1 }, { name: 'tenant_scope_feed' });
        return schema;
      })(),
    ) as unknown as Model<Record<string, unknown>>);
  const counter =
    (connection.models[counterName] as Model<Record<string, unknown>> | undefined) ??
    (connection.model(
      counterName,
      new Schema(
        { _id: { type: String, required: true }, seq: { type: Number, required: true } },
        { collection: `${collection}_counter`, versionKey: false },
      ),
    ) as unknown as Model<Record<string, unknown>>);
  return { entries, counter, feed: collection };
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

export function createChangeLogStore(models: ChangeLogModels): ChangeLogStore {
  const { entries, counter, feed } = models;
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
    async append(entry, options) {
      const session = sessionOf(options);
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
        resolution: { type: { action: String, by: String, at: String, _id: false }, default: undefined },
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
