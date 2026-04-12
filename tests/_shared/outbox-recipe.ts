/**
 * Outbox recipe — reference implementation for composing the transactional
 * outbox pattern on top of mongokit's hook system.
 *
 * This file is TEST FIXTURE, not a shipped API. Hosts are expected to copy
 * and adapt it in their own codebase (e.g. `be-prod/src/outbox/`). We keep
 * it under `tests/_shared/` so the validation suite next door exercises the
 * exact code users will copy — if the recipe drifts out of shape, the tests
 * fail.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Why no `outboxPlugin` in mongokit
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The only thing a plugin would add over this recipe is sugar. Mongokit's
 * hook system already exposes `context.session` at the exact moment of the
 * write, which is the one thing outbox needs. A plugin would force users to
 * accept opinions about:
 *
 *   - Event type naming (who owns `${resource}.created`?)
 *   - `meta` shape (correlation IDs? tenant keys? custom fields?)
 *   - Which repos get outboxed (audit_log probably shouldn't)
 *   - Transport choice (Redis? Kafka? in-memory?)
 *
 * Those opinions belong to the host, not the data-layer primitive. Hosts
 * compose; packages stay flexible.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Contract — structural compat with `@classytic/arc`
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `DomainEvent` + `OutboxStore` shapes here match arc's exactly. Arc's
 * `EventOutbox` (`arc/src/events/outbox.ts`) accepts any structurally-
 * compatible `OutboxStore`, so the `MongoOutboxStore` below plugs straight
 * into `new EventOutbox({ store, transport })` at the host layer.
 */

import type { ClientSession, Collection, Connection } from 'mongoose';
import type { RepositoryContext, RepositoryInstance } from '../../src/types.js';

// ────────────────────────────────────────────────────────────────────────────
// Contract — structurally matches @classytic/arc
// ────────────────────────────────────────────────────────────────────────────

export interface DomainEvent<T = unknown> {
  type: string;
  payload: T;
  meta: {
    id: string;
    timestamp: Date;
    resource?: string;
    resourceId?: string;
    userId?: string;
    organizationId?: string;
    correlationId?: string;
  };
}

/** Matches arc's `OutboxStore`. */
export interface OutboxStore {
  save(event: DomainEvent): Promise<void>;
  getPending(limit: number): Promise<DomainEvent[]>;
  acknowledge(eventId: string): Promise<void>;
  purge?(olderThanMs: number): Promise<number>;
}

// ────────────────────────────────────────────────────────────────────────────
// MongoDB-backed outbox row
// ────────────────────────────────────────────────────────────────────────────

/**
 * Internal row shape. Callers never see this — they only work with
 * `DomainEvent` via the store interface.
 */
interface OutboxRow {
  _id?: unknown;
  eventId: string;
  type: string;
  payload: unknown;
  meta: DomainEvent['meta'];
  status: 'pending' | 'delivered';
  createdAt: Date;
  deliveredAt?: Date;
}

/**
 * MongoDB-backed `OutboxStore`.
 *
 * Hosts can pass an existing Mongoose collection (for TTL indexes, custom
 * names, etc.) or let this class pull one from a connection by name.
 *
 * Relay ordering: `createdAt` ASC + `_id` ASC — stable FIFO. Pair with
 * a compound index `{ status: 1, createdAt: 1, _id: 1 }` in production to
 * keep the pending scan bounded. In tests the dataset is tiny so no index
 * is required.
 *
 * TTL cleanup: add a Mongo TTL index on `deliveredAt` with your desired
 * retention. This class's `purge()` is a fallback for stores that don't
 * have TTL enabled; it issues a targeted `deleteMany`.
 */
export class MongoOutboxStore implements OutboxStore {
  private readonly collection: Collection<OutboxRow>;

  constructor(source: Collection<OutboxRow> | { connection: Connection; name: string }) {
    if ('connection' in source) {
      this.collection = source.connection.collection<OutboxRow>(source.name);
    } else {
      this.collection = source;
    }
  }

  async save(event: DomainEvent): Promise<void> {
    await this.collection.insertOne({
      eventId: event.meta.id,
      type: event.type,
      payload: event.payload,
      meta: event.meta,
      status: 'pending',
      createdAt: new Date(),
    });
  }

  /**
   * Variant of `save` that enrolls the insert in a specific
   * `ClientSession`, so the outbox row lives inside the same transaction as
   * the business write. `wireOutbox` below always calls this variant from
   * repository hooks — that's the whole reason the recipe exists.
   */
  async saveInSession(event: DomainEvent, session: ClientSession | null | undefined): Promise<void> {
    await this.collection.insertOne(
      {
        eventId: event.meta.id,
        type: event.type,
        payload: event.payload,
        meta: event.meta,
        status: 'pending',
        createdAt: new Date(),
      },
      { session: session ?? undefined },
    );
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    const rows = await this.collection
      .find({ status: 'pending' })
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .toArray();

    return rows.map((row) => ({
      type: row.type,
      payload: row.payload,
      meta: row.meta,
    }));
  }

  async acknowledge(eventId: string): Promise<void> {
    await this.collection.updateOne(
      { eventId },
      { $set: { status: 'delivered', deliveredAt: new Date() } },
    );
  }

  async purge(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.collection.deleteMany({
      status: 'delivered',
      deliveredAt: { $lt: cutoff },
    });
    return result.deletedCount ?? 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// wireOutbox — the hook-based wiring
// ────────────────────────────────────────────────────────────────────────────

export interface WireOutboxOptions {
  /**
   * Map of resource name → repository. The resource name is used as the
   * event type prefix: `${resource}.created`, `${resource}.updated`, etc.
   * Pattern-match style — consumers subscribe to `'catalog:product.*'` etc.
   */
  repos: Record<string, RepositoryInstance>;
  /** Mongo-backed outbox store. */
  store: MongoOutboxStore;
  /**
   * Optional filter: return `false` to skip enqueueing for a given
   * operation + context. Default: enqueue everything.
   *
   * Example — skip an audit-log repo whose writes are already the audit:
   *     shouldEnqueue: ({ resource }) => resource !== 'audit:log'
   */
  shouldEnqueue?: (info: {
    resource: string;
    operation: 'create' | 'update' | 'delete';
    context: RepositoryContext;
  }) => boolean;
  /**
   * Optional meta enricher — tack on tenant/correlation/user fields from
   * request-scoped context (AsyncLocalStorage, CLS, etc.).
   */
  enrichMeta?: (context: RepositoryContext) => Partial<DomainEvent['meta']>;
}

/**
 * Wire transactional outbox onto the given repositories.
 *
 * Registers `before:create` / `before:update` / `before:delete` hooks on each
 * repo. The hook writes an outbox row in the same `ClientSession` as the
 * business write, so the row commits or rolls back atomically with the
 * document.
 *
 * Idempotency: the hook uses `crypto.randomUUID()` for the event ID. If the
 * business transaction retries (TransientTransactionError), the outbox row
 * from the failed attempt is rolled back with it — no duplicates.
 */
export function wireOutbox(options: WireOutboxOptions): void {
  const { repos, store, shouldEnqueue, enrichMeta } = options;

  for (const [resource, repo] of Object.entries(repos)) {
    const enqueue = (operation: 'create' | 'update' | 'delete') => {
      return async (context: RepositoryContext) => {
        if (shouldEnqueue && !shouldEnqueue({ resource, operation, context })) {
          return;
        }

        const payload = buildPayload(operation, context);
        const event: DomainEvent = {
          type: `${resource}.${operation === 'delete' ? 'deleted' : `${operation}d`}`,
          payload,
          meta: {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            resource,
            resourceId: context.id ? String(context.id) : undefined,
            userId: context.user?._id ? String(context.user._id) : undefined,
            organizationId: context.organizationId
              ? String(context.organizationId)
              : undefined,
            ...(enrichMeta ? enrichMeta(context) : {}),
          },
        };

        // Session-aware write — this is the crux. If we wrote to the outbox
        // without `context.session`, the row would commit in a separate
        // transaction and a crash between writes would leak or lose events.
        await store.saveInSession(event, context.session);
      };
    };

    repo.on('before:create', enqueue('create'));
    repo.on('before:update', enqueue('update'));
    repo.on('before:delete', enqueue('delete'));
  }
}

function buildPayload(
  operation: 'create' | 'update' | 'delete',
  context: RepositoryContext,
): unknown {
  if (operation === 'create') return context.data ?? null;
  if (operation === 'update') return { id: context.id, changes: context.data ?? {} };
  return { id: context.id };
}
