/**
 * The mongo-backed OUTBOX table — schema, indexes and repository.
 *
 * ## Why this is here
 *
 * Two ERP hosts independently hand-rolled this: 465 lines in one, 301 in the other, both
 * implementing the same `OutboxStore` contract over the same database. The second host's source
 * even carries the comment *"be-prod learned that the hard way"* about a partial-index pitfall —
 * the LESSON transferred and the code was rewritten anyway. That is the failure mode worth
 * naming: duplication here does not fail loudly, it drifts, and this is the table that guarantees
 * a collected payment is eventually recorded.
 *
 * ## What this module is, and is not
 *
 * It is the MONGO half only: a schema, the four indexes that make claim/dedupe/retention correct,
 * and a repository over them. It does NOT implement `OutboxStore` — `@classytic/arc`'s
 * `repositoryAsOutboxStore` already does that, generically, over any repository. Keeping the two
 * apart is what avoids a dependency cycle (mongokit does not depend on arc) and what lets a
 * non-mongo kit reuse the contract half.
 *
 * A host composes three lines:
 *
 * ```ts
 * const model = createOutboxModel(connection, { visibleAtField: 'nextVisibleAt' });
 * const repository = new Repository(model);
 * const store = repositoryAsOutboxStore(repository, { visibleAtField: 'nextVisibleAt' });
 * ```
 */

import { Schema, type Connection, type Model } from "mongoose";
import { Repository } from "../Repository.js";
import { batchOperationsPlugin } from "../plugins/batch-operations.plugin.js";
import { methodRegistryPlugin } from "../plugins/method-registry.plugin.js";

/** Delivery states. `dead_letter` is terminal and operator-visible. */
export const OUTBOX_STATUSES = ["pending", "delivered", "dead_letter"] as const;

export interface OutboxModelOptions {
	/** Collection name. Default `event_outbox`. */
	collection?: string;
	/** Mongoose model name. Default `EventOutbox`. Must be unique per connection. */
	modelName?: string;
	/**
	 * How long a DELIVERED row is retained before the TTL monitor removes it.
	 * Default 7 days. Pending and dead-lettered rows are never auto-removed —
	 * expiring an undelivered event would destroy the guarantee the table exists for.
	 */
	ttlSeconds?: number;
	/**
	 * Column holding the "not claimable before" timestamp. Default `visibleAt`.
	 *
	 * Configurable because an existing table cannot be renamed without rebuilding the claim
	 * index — the one index whose absence turns a busy outbox into a collection scan. One live
	 * host uses `nextVisibleAt`; it passes that here and keeps its data and indexes untouched.
	 * The same value must be given to `repositoryAsOutboxStore`, or the writer and the claimer
	 * disagree about which column means "visible" and the queue silently stops draining.
	 */
	visibleAtField?: string;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Build (or return) the outbox model on `connection`.
 *
 * Idempotent per connection: calling twice returns the same model rather than throwing
 * `OverwriteModelError`, so a host may build it lazily from several call sites.
 */
export function createOutboxModel(
	connection: Connection,
	options: OutboxModelOptions = {},
): Model<Record<string, unknown>> {
	const {
		collection = "event_outbox",
		modelName = "EventOutbox",
		ttlSeconds = DEFAULT_TTL_SECONDS,
		visibleAtField = "visibleAt",
	} = options;

	const existing = connection.models[modelName];
	if (existing) return existing as Model<Record<string, unknown>>;

	/**
	 * The document shape is `repositoryAsOutboxStore`'s, not an invention of this module.
	 *
	 * Two things about it surprise people coming from a hand-rolled table, and both are
	 * deliberate:
	 *
	 * 1. **`_id` IS the event id** (a string), not an ObjectId with a separate `eventId`
	 *    column. That is what makes `save` idempotent for free — a redelivered event is a
	 *    duplicate-key error the adapter swallows, with no read-then-write race to lose.
	 * 2. **The whole `event` is nested**, rather than split into `payload` + `meta`. The relay
	 *    republishes the event verbatim; splitting it means reassembling it on the way out, and
	 *    a reassembly that drifts from the original is a corrupted replay nobody can detect.
	 *
	 * A host with an EXISTING outbox in a different shape cannot simply point this at its
	 * collection — the ids are of a different type. That is a data migration, not a config
	 * change, and it must be planned rather than discovered.
	 */
	const schema = new Schema<Record<string, unknown>>(
		{
			/** The event id itself. String, because the adapter writes `event.meta.id` here. */
			_id: { type: String, required: true },
			/** The event, verbatim, as the relay will republish it. */
			event: { type: Schema.Types.Mixed, required: true },
			type: { type: String, required: true },
			status: { type: String, enum: [...OUTBOX_STATUSES], default: "pending" },
			attempts: { type: Number, default: 0 },
			/**
			 * Caller-supplied dedupe key. `null` when absent — see the partial index below for
			 * why null must not participate in the unique constraint.
			 */
			dedupeKey: { type: String, default: null },
			partitionKey: { type: String, default: null },
			headers: { type: Schema.Types.Mixed, default: null },
			leaseOwner: { type: String, default: null },
			leaseExpiresAt: { type: Date, default: null },
			[visibleAtField]: { type: Date, default: Date.now },
			deliveredAt: { type: Date, default: null },
			firstFailedAt: { type: Date, default: null },
			lastFailedAt: { type: Date, default: null },
			lastError: { type: Schema.Types.Mixed, default: null },
			createdAt: { type: Date, default: Date.now },
		},
		{
			/**
			 * `strict: false` so a host may stamp extra columns without a schema change, and
			 * `timestamps: false` because `createdAt` is set by the adapter — letting mongoose
			 * manage it would add an `updatedAt` the claim index does not cover.
			 *
			 * `_id: false` disables mongoose's ObjectId auto-generation; the adapter always
			 * supplies the id.
			 */
			strict: false,
			timestamps: false,
			collection,
			versionKey: false,
			_id: false,
		},
	);

	/**
	 * THE CLAIM INDEX. The relay's hot query is
	 * `status = 'pending' AND <visibleAt> <= now`, ordered by `createdAt`.
	 * Without this the relay table-scans on every tick.
	 */
	schema.index({ status: 1, [visibleAtField]: 1, createdAt: 1 });

	/**
	 * Retention. Scoped to `deliveredAt`, which is only ever set on success — so a pending or
	 * dead-lettered row has `null` and is never expired. A TTL on `createdAt` would silently
	 * delete undelivered events, which is the one thing this table must never do.
	 */
	schema.index({ deliveredAt: 1 }, { expireAfterSeconds: ttlSeconds });

	/**
	 * Dedupe. `unique` + `partialFilterExpression` on the TYPE, not on `$ne: null`.
	 *
	 * Mongo rejects `unique` combined with a `sparse: true` + partial filter ("cannot mix"), and
	 * the failure is that the index silently never builds — so duplicate events insert happily
	 * and the outbox's idempotency guarantee is gone with nothing in the logs. Filtering on
	 * `$type: 'string'` indexes only rows that actually carry a key.
	 */
	schema.index(
		{ dedupeKey: 1 },
		{ unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
	);

	/**
	 * The DEAD-LETTER read. `getDeadLettered` is part of the `OutboxStore` contract and is what
	 * an operator alert polls — hourly, forever, on a table that grows. Partial, because the
	 * rows an operator reads are a vanishing fraction of the rows written, and a full index on
	 * `status` would be almost entirely `delivered` entries nobody queries by status alone.
	 *
	 * A host that dropped this still worked: the alert just collection-scanned every hour, which
	 * is invisible until the table is large and then is a periodic production stall.
	 */
	schema.index(
		{ status: 1, lastFailedAt: 1 },
		{ partialFilterExpression: { status: "dead_letter" } },
	);

	/**
	 * There is deliberately NO `claimToken` index.
	 *
	 * One host's fork claims with a generated token; `repositoryAsOutboxStore` claims with a
	 * LEASE (`leaseOwner` + `leaseExpiresAt`), already covered above. An index copied across
	 * from that fork would be permanently empty here — free to write, but it advertises a
	 * column this shape never sets, which is how the next reader concludes the two tables are
	 * interchangeable.
	 */

	return connection.model<Record<string, unknown>>(modelName, schema, collection);
}

/**
 * The repository `repositoryAsOutboxStore` needs, with the plugin set it actually calls.
 *
 * The adapter drives `create` / `getOne` / `getAll` / `findOneAndUpdate` (base `Repository`)
 * plus `deleteMany`, which is contributed by `batchOperationsPlugin` THROUGH the method
 * registry. Both plugins are therefore required, and in that pairing — a host that passes only
 * `batchOperationsPlugin()` gets a repository whose `deleteMany` is never registered.
 *
 * This existed as three hand-written lines in a host, which is two lines too many to get wrong
 * silently: the wrong plugin list does not fail at boot, it fails the first time a delivered row
 * is swept, on a code path nobody watches. `Repository` validates the registered set at
 * construction and throws naming what is missing, so composing it HERE moves that check to
 * every consumer instead of the one host that remembered.
 *
 * ```ts
 * const store = repositoryAsOutboxStore(
 *   createOutboxRepository(connection),        // this
 *   { visibleAtField: 'nextVisibleAt' },       // iff you passed the same to createOutboxModel
 * );
 * ```
 *
 * `plugins` appends to the required set rather than replacing it — for an observability or
 * cache plugin a deployment wants on this table too.
 */
export function createOutboxRepository(
	connection: Connection,
	options: OutboxModelOptions & { plugins?: readonly unknown[] } = {},
): Repository<Record<string, unknown>> {
	const { plugins = [], ...modelOptions } = options;
	return new Repository(createOutboxModel(connection, modelOptions), [
		methodRegistryPlugin(),
		batchOperationsPlugin(),
		...plugins,
	] as never);
}
