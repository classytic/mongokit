/**
 * Mongo-backed `UsageStore` — the mongokit adapter for
 * `@classytic/repo-core/usage`'s canonical usage-counter contract
 * (period-bucketed counters per actor: quotas, plan enforcement,
 * usage-based billing; consumed by `@classytic/arc/usage`'s
 * `usagePlugin` structurally).
 *
 * ## Document shape — one doc per (actor, period, kind)
 *
 * Deliberately row-per-cell, NOT a kinds-map on one doc:
 * - Counter kinds are dot-namespaced (`api.requests`,
 *   `storage.egress.bytes`) — as map keys they'd explode into nested
 *   paths under `$inc` and corrupt round-trips.
 * - `$inc` on a unique `(actor, period, kind)` cell is atomic under
 *   concurrency with zero read-modify-write.
 * - SQL kits implement the same contract as row-per-cell, so behavior
 *   stays provably identical (`runUsageStoreContract`).
 *
 * ## Usage
 *
 *     import mongoose from 'mongoose';
 *     import { createMongoUsageStore } from '@classytic/mongokit/usage';
 *
 *     const store = createMongoUsageStore({ connection: mongoose.connection });
 *     await app.register(usagePlugin, { store });
 *
 * ## Retention
 *
 * Counters are billing data — no TTL by default. Hosts pruning old
 * periods do so explicitly (`db.usage_counters.deleteMany({ period: { $lt: '2025-01' } })`).
 */

import type { UsageBucket, UsageStore } from '@classytic/repo-core/usage';
import type { Connection, Model } from 'mongoose';
import mongoose, { Schema } from 'mongoose';
import { isDuplicateKeyError } from '../utils/error.js';

interface MongoUsageDoc {
  actor: string;
  period: string;
  kind: string;
  count: number;
}

/** Adapter-construction options. */
export interface MongoUsageStoreOptions {
  /**
   * Mongoose connection. Defaults to `mongoose.connection` (the
   * default global connection). Apps using a named connection pass
   * it explicitly.
   */
  connection?: Connection;
  /** Collection name. Default `usage_counters`. */
  collectionName?: string;
  /** Override the Mongoose model name. Default `MongoUsageCounter`. */
  modelName?: string;
}

/**
 * Build a Mongo-backed usage store. Idempotent — the underlying model
 * is registered once per `(connection, modelName)` pair.
 */
export function createMongoUsageStore(options: MongoUsageStoreOptions = {}): UsageStore {
  const {
    connection,
    collectionName = 'usage_counters',
    modelName = 'MongoUsageCounter',
  } = options;

  const conn: Connection | typeof mongoose = connection ?? mongoose;
  const model = getOrCreateModel(conn, modelName, collectionName);

  return {
    name: 'mongo',

    async increment(bucket: UsageBucket, amount: number): Promise<void> {
      const filter = { actor: bucket.actor, period: bucket.period, kind: bucket.kind };
      try {
        await model.updateOne(filter, { $inc: { count: amount } }, { upsert: true });
      } catch (err) {
        // Two concurrent upserts for a brand-new cell can race: both
        // miss the filter, both insert, one loses on the unique index.
        // The loser retries once — the cell now exists, so the retry
        // is a plain atomic $inc. Standard upsert-race handling.
        if (!isDuplicateKeyError(err)) throw err;
        await model.updateOne(filter, { $inc: { count: amount } }, { upsert: true });
      }
    },

    async summary(actor: string, period: string): Promise<Record<string, number>> {
      const rows = await model.find({ actor, period }).select('kind count').lean();
      const out: Record<string, number> = {};
      for (const row of rows) out[row.kind] = row.count;
      return out;
    },
  };
}

function getOrCreateModel(
  conn: Connection | typeof mongoose,
  modelName: string,
  collectionName: string,
): Model<MongoUsageDoc> {
  const existing =
    'models' in conn ? (conn.models[modelName] as Model<MongoUsageDoc> | undefined) : undefined;
  if (existing) return existing;

  const schema = new Schema<MongoUsageDoc>(
    {
      actor: { type: String, required: true },
      period: { type: String, required: true },
      kind: { type: String, required: true },
      count: { type: Number, required: true, default: 0 },
    },
    { versionKey: false },
  );
  // The contract's atomicity rides this unique cell index; it also
  // covers `summary`'s (actor, period) prefix scan.
  schema.index({ actor: 1, period: 1, kind: 1 }, { unique: true });

  return (conn as Connection).model<MongoUsageDoc>(modelName, schema, collectionName);
}
