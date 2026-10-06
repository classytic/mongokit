/**
 * The mongo {@link IdempotencyClaimStore} — use this with `runIdempotent` from
 * `@classytic/repo-core/idempotency`; never keep a per-module claims table.
 *
 * ```ts
 * const store = createIdempotencyStore(createIdempotencyModel(connection));
 * const run = await runIdempotent({ store, identity, requestFingerprint, execute });
 * ```
 *
 * One document per identity, `_id` = `identityKey(identity)`, so "insert iff absent" is
 * the `_id` index and every compare-and-set is a single-document filter. Proven by
 * `runIdempotencyStoreConformance` (`@classytic/repo-core/testing`) in this package's tests.
 */

import {
  type IdempotencyClaim,
  type IdempotencyClaimStore,
  type IdempotencyIdentity,
  type IdempotencyStoreCallOptions,
  identityKey,
} from '@classytic/repo-core/idempotency';
import { type Connection, type Model, Schema } from 'mongoose';

export interface IdempotencyModelOptions {
  /** Collection name. Default `idempotency_claims`. */
  collection?: string;
  /** Mongoose model name. Default `IdempotencyClaim`. Must be unique per connection. */
  modelName?: string;
}

export interface IdempotencyStoreOptions {
  /**
   * How long a claim is kept after its last write before the TTL monitor removes it.
   * Default 7 days. Size it to the longest a caller may retry — a retry after the claim
   * is gone executes again. An offline till that syncs days later needs more.
   */
  retentionSeconds?: number;
}

const DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** Build (or return) the claims model on `connection`. Idempotent per connection. */
export function createIdempotencyModel(
  connection: Connection,
  options: IdempotencyModelOptions = {},
): Model<Record<string, unknown>> {
  const { collection = 'idempotency_claims', modelName = 'IdempotencyClaim' } = options;
  const existing = connection.models[modelName];
  if (existing) return existing as Model<Record<string, unknown>>;

  const schema = new Schema(
    {
      _id: { type: String, required: true },
      identity: { type: Schema.Types.Mixed, required: true },
      requestFingerprint: { type: String, required: true },
      state: { type: String, enum: ['in_flight', 'succeeded', 'failed'], required: true },
      leaseToken: { type: String, required: true },
      leaseExpiresAt: { type: Date, required: true },
      createdAt: { type: Date, required: true },
      completedAt: { type: Date },
      result: { type: Schema.Types.Mixed },
      attempts: { type: Number, required: true },
      progress: { type: Schema.Types.Mixed },
      context: { type: Schema.Types.Mixed },
      lastError: { type: String },
      purgeAt: { type: Date, required: true },
    },
    { collection, versionKey: false, minimize: false },
  );
  schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0, name: 'retention' });
  // `listLapsed` — a recovery sweep's "stuck claims of this operation, oldest first".
  schema.index({ 'identity.operation': 1, state: 1, leaseExpiresAt: 1 }, { name: 'lapsed_sweep' });
  return connection.model(modelName, schema) as unknown as Model<Record<string, unknown>>;
}

interface ClaimDoc extends Omit<IdempotencyClaim<unknown>, 'identity'> {
  _id: string;
  identity: IdempotencyIdentity;
  purgeAt: Date;
}

/** The store over a model from {@link createIdempotencyModel}. */
export function createIdempotencyStore(
  model: Model<Record<string, unknown>>,
  options: IdempotencyStoreOptions = {},
): IdempotencyClaimStore {
  const retentionMs = (options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS) * 1000;
  // The driver collection, not the model: this table has no hooks or plugins to run,
  // and casting must not reshape a stored result that retries replay byte-for-byte.
  const claims = () => model.collection as unknown as import('mongodb').Collection<ClaimDoc>;

  const toDoc = (claim: IdempotencyClaim<unknown>): ClaimDoc => ({
    ...claim,
    _id: identityKey(claim.identity),
    purgeAt: new Date(Date.now() + retentionMs),
  });
  /** The caller's transaction, so a claim commits or rolls back with the writes it describes. */
  const withSession = (options?: IdempotencyStoreCallOptions) =>
    options?.session ? { session: options.session as import('mongodb').ClientSession } : {};
  const ownedInFlight = (identity: IdempotencyIdentity, leaseToken: string) => ({
    _id: identityKey(identity),
    state: 'in_flight' as const,
    leaseToken,
  });

  return {
    async get<TValue>(identity: IdempotencyIdentity, options?: IdempotencyStoreCallOptions) {
      const doc = await claims().findOne({ _id: identityKey(identity) }, withSession(options));
      if (!doc) return null;
      const { _id, purgeAt, ...claim } = doc;
      return claim as IdempotencyClaim<TValue>;
    },
    async insert(claim, options) {
      try {
        await claims().insertOne(toDoc(claim as IdempotencyClaim<unknown>), withSession(options));
        return true;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) return false;
        throw error;
      }
    },
    async swap(identity, expectedLeaseToken, next, options) {
      const result = await claims().replaceOne(
        ownedInFlight(identity, expectedLeaseToken),
        toDoc(next as IdempotencyClaim<unknown>),
        withSession(options),
      );
      return result.matchedCount === 1;
    },
    async release(identity, expectedLeaseToken, options) {
      const result = await claims().deleteOne(ownedInFlight(identity, expectedLeaseToken), withSession(options));
      return result.deletedCount === 1;
    },
    async listLapsed(operation, now, limit) {
      const docs = await claims()
        .find({ 'identity.operation': operation, state: 'in_flight', leaseExpiresAt: { $lte: now } })
        .sort({ leaseExpiresAt: 1 })
        .limit(limit)
        .toArray();
      return docs.map(({ _id, purgeAt, ...claim }) => claim as IdempotencyClaim<unknown>);
    },
  };
}
