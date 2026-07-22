/**
 * Audit Trail Plugin
 *
 * Persists operation audit entries to a MongoDB collection.
 *
 * Two delivery modes (`mode` option):
 *
 * - `'best-effort'` (default): fire-and-forget — writes happen async and
 *   never block or fail the main operation. Suitable for observability,
 *   debugging, and eventually-consistent activity feeds. NOT suitable as a
 *   compliance ledger: an entry can be written for a transaction that later
 *   aborts, and the process can die after the business write but before the
 *   audit write lands.
 *
 * - `'transactional'`: the audit insert is awaited inside the operation and
 *   joins the operation's `session` when one is present. Inside a
 *   `withTransaction` block this makes business write + audit entry atomic —
 *   both commit or both roll back. A failed audit write fails the operation
 *   (after routing through `onWriteError`). This is the mode to use for
 *   compliance-grade trails (SOC 2 / PCI / HIPAA) — but note it is atomic
 *   ONLY inside an actual transaction; without one, an audit failure rejects
 *   the call after the business write has already committed. Call
 *   `ensureAuditTrailReady()` at boot so collection/index creation doesn't
 *   happen inside the first transaction. For durable *asynchronous* auditing,
 *   write an outbox entry in the same transaction instead and relay it
 *   separately (see `@classytic/primitives/outbox`).
 *
 * Features:
 * - Tracks create, update, delete operations
 * - Field-level change tracking (before/after diff on updates)
 * - Connection-aware: models register on the connection you pass (multi-DB safe)
 * - TTL auto-cleanup via MongoDB TTL index — retention conflicts throw
 * - Custom metadata per entry (IP, user-agent, etc.)
 * - Shared `audit_trails` collection across all models
 *
 * @example
 * ```typescript
 * const repo = new Repository(Job, [
 *   auditTrailPlugin({
 *     mode: 'transactional',
 *     operations: ['create', 'update', 'delete'],
 *     trackChanges: true,
 *     ttlDays: 90,
 *     connection: jobsConnection, // omit to use mongoose.connection
 *     metadata: (context) => ({
 *       ip: context.req?.ip,
 *     }),
 *   }),
 * ]);
 * ```
 */

import mongoose, { type ClientSession, type Connection } from 'mongoose';
import type { ObjectId } from '../types/core.js';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';
import { warn } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Audit write delivery mode.
 *
 * - `'best-effort'`: async fire-and-forget; never blocks or fails the
 *   operation. Observability-grade.
 * - `'transactional'`: awaited insert sharing the operation's session; a
 *   failed audit write fails the operation.
 *
 * PRECISION: `'transactional'` is **atomic only when the operation actually
 * runs inside a MongoDB transaction** (`withTransaction` / an explicit
 * `session`). Without one, the mode still guarantees "the call does not
 * return success unless the audit entry landed" — but the business write has
 * already committed by the time the audit insert runs, so an audit failure
 * rejects the call while leaving the business write in place. For
 * compliance-grade "both or neither", wrap the operation in a transaction.
 * Call {@link ensureAuditTrailReady} at boot so the collection and indexes
 * are not created lazily inside the first transaction.
 */
export type AuditTrailMode = 'best-effort' | 'transactional';

export interface AuditTrailOptions {
  /**
   * Delivery guarantee for audit writes (default: 'best-effort').
   * See {@link AuditTrailMode}. `'transactional'` requires the repository's
   * default `hooks: 'async'` mode — plugin registration throws on a
   * `hooks: 'sync'` repository because awaited delivery cannot be honored.
   */
  mode?: AuditTrailMode;

  /**
   * Mongoose connection to register the audit model on. Defaults to the
   * audited model's OWN connection (`repo.Model.db`), so
   * `mongoose.createConnection()` apps get audit entries in the same database
   * as their data automatically. Pass this explicitly only to centralize
   * audit storage on a different connection than the model lives on. Mirrors
   * the `connection` option on the lock and usage stores.
   *
   * Note: `AuditTrailQuery` / `ensureAuditTrailReady` have no repository to
   * infer from and default to the global `mongoose.connection` — pass the
   * same `connection` there for multi-DB apps.
   */
  connection?: Connection;

  /** Operations to track (default: ['create', 'update', 'delete']) */
  operations?: AuditOperation[];

  /** Store field-level before/after diff on updates (default: true) */
  trackChanges?: boolean;

  /** Store full document snapshot on create (default: false — can be heavy) */
  trackDocument?: boolean;

  /**
   * Auto-purge after N days via MongoDB TTL index (default: undefined — keep
   * forever). Retention is collection-level configuration: every plugin (and
   * `AuditTrailQuery`) touching the same collection on the same connection
   * must agree on `ttlDays`. A conflicting value throws at registration time
   * instead of silently keeping whichever caller ran first.
   */
  ttlDays?: number;

  /** MongoDB collection name (default: 'audit_trails') */
  collectionName?: string;

  /**
   * Extract custom metadata from the repository context.
   * Returned object is stored on the audit entry as `metadata`.
   */
  metadata?: (context: RepositoryContext) => Record<string, unknown>;

  /**
   * Fields to exclude from change tracking (e.g., passwords, tokens).
   * These fields are redacted in the `changes` diff.
   */
  excludeFields?: string[];

  /**
   * Callback fired when an audit write fails. Receives the error and the
   * entry that failed to land.
   *
   * - In `'best-effort'` mode this is the ONLY failure signal — the
   *   operation has already succeeded. Forward to a dead-letter queue or
   *   error reporter; the default is a `console.warn`-level log. Note that
   *   a callback cannot make fire-and-forget writes atomic — if you need
   *   "no business write without an audit entry", use `mode:
   *   'transactional'` inside a transaction.
   * - In `'transactional'` mode the callback observes the failure before
   *   the operation itself rejects (and, inside a transaction, before the
   *   transaction aborts). Throwing from the callback is safe — the
   *   original write error still propagates.
   */
  onWriteError?: (error: Error, entry: Omit<AuditEntry, 'timestamp'>) => void;
}

export type AuditOperation = 'create' | 'update' | 'delete' | 'findOneAndUpdate';

export interface AuditEntry {
  model: string;
  operation: AuditOperation;
  documentId: unknown;
  userId?: unknown;
  orgId?: unknown;
  changes?: Record<string, { from: unknown; to: unknown }>;
  document?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

// ─── Internal Model Registry (connection-aware, TTL-deterministic) ─────────

interface AuditModelCacheEntry {
  model: mongoose.Model<AuditEntry>;
  /** TTL the model was created with — `null` means "no TTL index". */
  ttlSeconds: number | null;
}

/**
 * Per-connection model cache. WeakMap keyed by the Connection object so a
 * closed/discarded connection's models can be garbage collected, and so two
 * connections never share a model even when they use the same collection
 * name (each connection may point at a different database).
 */
const modelCaches = new WeakMap<Connection, Map<string, AuditModelCacheEntry>>();

function ttlDaysToSeconds(ttlDays: number | undefined): number | null {
  return ttlDays !== undefined && ttlDays > 0 ? ttlDays * 24 * 60 * 60 : null;
}

/**
 * Introspect an already-compiled model (hot reload, duplicate registration
 * outside our cache) for the TTL its schema installed on `timestamp`.
 */
function resolveExistingTtlSeconds(model: mongoose.Model<AuditEntry>): number | null {
  for (const [fields, opts] of model.schema.indexes()) {
    const expireAfterSeconds = (opts as { expireAfterSeconds?: unknown } | undefined)
      ?.expireAfterSeconds;
    if (
      (fields as Record<string, unknown>).timestamp !== undefined &&
      typeof expireAfterSeconds === 'number'
    ) {
      return expireAfterSeconds;
    }
  }
  return null;
}

function ttlConflictError(
  collectionName: string,
  existing: number | null,
  requested: number | null,
): Error {
  const fmt = (s: number | null) => (s === null ? 'no TTL' : `${s / 86400} day(s)`);
  return new Error(
    `[auditTrailPlugin] TTL conflict for audit collection '${collectionName}': ` +
      `already registered with ${fmt(existing)}, now requested with ${fmt(requested)}. ` +
      `Retention is collection-level configuration — every auditTrailPlugin()/AuditTrailQuery ` +
      `touching the same collection on the same connection must pass the same ttlDays. ` +
      `Changing retention on an existing collection requires an index migration outside the plugin.`,
  );
}

/**
 * How `ttlDays` interacts with an already-registered model:
 *
 * - `'declare'` (the writing plugin): the caller states the collection's
 *   retention. Omitting `ttlDays` MEANS "no TTL" — a mismatch with an
 *   existing registration throws. Retention must be explicit and agreed.
 * - `'reuse-existing'` (readers: `AuditTrailQuery`, `ensureAuditTrailReady`):
 *   omitting `ttlDays` means "whatever is configured" — the existing model is
 *   reused as-is. An *explicit* `ttlDays` is still conflict-checked, so a
 *   reader that does state retention can't silently disagree with the writer.
 */
type TtlPolicy = 'declare' | 'reuse-existing';

function getAuditModel(
  connection: Connection | undefined,
  collectionName: string,
  ttlDays: number | undefined,
  ttlPolicy: TtlPolicy = 'declare',
): mongoose.Model<AuditEntry> {
  const conn = connection ?? mongoose.connection;
  const requestedTtl = ttlDaysToSeconds(ttlDays);
  const reuseExisting = ttlPolicy === 'reuse-existing' && ttlDays === undefined;

  let cache = modelCaches.get(conn);
  if (!cache) {
    cache = new Map();
    modelCaches.set(conn, cache);
  }

  const cached = cache.get(collectionName);
  if (cached) {
    if (!reuseExisting && cached.ttlSeconds !== requestedTtl) {
      throw ttlConflictError(collectionName, cached.ttlSeconds, requestedTtl);
    }
    return cached.model;
  }

  const modelName = `AuditTrail_${collectionName}`;

  // Reuse an existing compiled model (hot reload safety). Check the
  // connection's own registry first; for the default connection also check
  // the global registry, where pre-3.25 versions of this plugin registered.
  const existing =
    (conn.models[modelName] as mongoose.Model<AuditEntry> | undefined) ??
    (conn === mongoose.connection
      ? (mongoose.models[modelName] as mongoose.Model<AuditEntry> | undefined)
      : undefined);
  if (existing) {
    const existingTtl = resolveExistingTtlSeconds(existing);
    if (!reuseExisting && existingTtl !== requestedTtl) {
      throw ttlConflictError(collectionName, existingTtl, requestedTtl);
    }
    cache.set(collectionName, { model: existing, ttlSeconds: existingTtl });
    return existing;
  }

  const schema = new mongoose.Schema(
    {
      model: { type: String, required: true, index: true },
      operation: {
        type: String,
        required: true,
        enum: ['create', 'update', 'findOneAndUpdate', 'delete'],
      },
      documentId: { type: mongoose.Schema.Types.Mixed, required: true, index: true },
      userId: { type: mongoose.Schema.Types.Mixed, index: true },
      orgId: { type: mongoose.Schema.Types.Mixed, index: true },
      changes: { type: mongoose.Schema.Types.Mixed },
      document: { type: mongoose.Schema.Types.Mixed },
      metadata: { type: mongoose.Schema.Types.Mixed },
      // No field-level `index: true` — the timestamp index is declared once
      // below (as the TTL index when retention is configured, plain otherwise)
      // to avoid mongoose's duplicate-index warning.
      timestamp: { type: Date, default: Date.now },
    },
    {
      collection: collectionName,
      versionKey: false,
      // No timestamps — we use our own `timestamp` field for TTL
    },
  );

  // Compound index for common queries: "show audit for this document"
  schema.index({ model: 1, documentId: 1, timestamp: -1 });

  // Compound index for "show audit by user in this org"
  schema.index({ orgId: 1, userId: 1, timestamp: -1 });

  // TTL index — MongoDB auto-deletes documents after expiry. Without TTL,
  // a plain ascending index keeps date-range queries fast.
  if (requestedTtl !== null) {
    schema.index({ timestamp: 1 }, { expireAfterSeconds: requestedTtl });
  } else {
    schema.index({ timestamp: 1 });
  }

  const model = conn.model<AuditEntry>(modelName, schema);
  cache.set(collectionName, { model, ttlSeconds: requestedTtl });
  return model;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Compute field-level diff between previous and updated document */
function computeChanges(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  excludeFields: string[],
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const exclude = new Set(excludeFields);

  // Check all keys in the update data against previous values
  for (const key of Object.keys(next)) {
    if (exclude.has(key)) continue;
    // Skip internal mongoose fields
    if (key === '_id' || key === '__v' || key === 'updatedAt') continue;

    const prevVal = prev[key];
    const nextVal = next[key];

    // Simple comparison — stringify for deep equality on objects/arrays
    if (!deepEqual(prevVal, nextVal)) {
      changes[key] = { from: prevVal, to: nextVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}

/** Simple deep equality check for audit diffing */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  // Handle ObjectId comparison
  if (typeof a === 'object' && typeof b === 'object') {
    const aStr = a.toString?.();
    const bStr = b.toString?.();
    if (aStr && bStr && aStr === bStr) return true;
  }

  // Handle Date comparison
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // Deep compare via JSON (handles nested objects/arrays)
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Extract user ID from context */
function getUserId(context: RepositoryContext): unknown {
  return context.user?._id || context.user?.id;
}

/** Resolve the effective id field for an operation: per-call override > repo config > '_id'. */
function getEffectiveIdField(repo: RepositoryInstance, context: RepositoryContext): string {
  return (
    (context.idField as string | undefined) ??
    ((repo as Record<string, unknown>).idField as string | undefined) ??
    '_id'
  );
}

function invokeWriteErrorCallback(
  onWriteError: ((error: Error, entry: Omit<AuditEntry, 'timestamp'>) => void) | undefined,
  err: Error,
  entry: Omit<AuditEntry, 'timestamp'>,
): void {
  if (!onWriteError) {
    warn(`[auditTrailPlugin] Failed to write audit entry: ${err.message}`);
    return;
  }
  try {
    onWriteError(err, entry);
  } catch (cbErr) {
    // Callback itself threw — at least log so the original error isn't
    // completely swallowed.
    warn(`[auditTrailPlugin] onWriteError callback itself threw: ${(cbErr as Error).message}`);
  }
}

/**
 * Best-effort audit write. Never throws into the caller's promise chain
 * (audit failures must not break the primary operation), but routes errors
 * to `onWriteError` for hosts that need surface visibility.
 *
 * Deliberately does NOT join the operation's session: by the time the
 * microtask runs, a transaction may already be committed or aborted —
 * joining it late would either throw or attach the entry to a doomed
 * transaction. Session-consistent delivery is exactly what
 * `mode: 'transactional'` is for.
 */
function writeAuditBestEffort(
  AuditModel: mongoose.Model<AuditEntry>,
  entry: Omit<AuditEntry, 'timestamp'>,
  onWriteError?: (error: Error, entry: Omit<AuditEntry, 'timestamp'>) => void,
): void {
  // Use a microtask to avoid blocking the event loop on the hot path.
  Promise.resolve().then(() => {
    AuditModel.create({ ...entry, timestamp: new Date() }).catch((err: Error) => {
      invokeWriteErrorCallback(onWriteError, err, entry);
    });
  });
}

/**
 * Transactional audit write. Awaited by the operation's after-hook and
 * attached to the operation's session when present — inside a transaction
 * the entry commits/aborts atomically with the business write. A failed
 * insert rethrows (after `onWriteError`) so the operation fails rather than
 * silently succeeding without its audit entry.
 */
async function writeAuditTransactional(
  AuditModel: mongoose.Model<AuditEntry>,
  entry: Omit<AuditEntry, 'timestamp'>,
  session: ClientSession | undefined,
  onWriteError?: (error: Error, entry: Omit<AuditEntry, 'timestamp'>) => void,
): Promise<void> {
  try {
    await AuditModel.create([{ ...entry, timestamp: new Date() }], session ? { session } : {});
  } catch (err) {
    invokeWriteErrorCallback(onWriteError, err as Error, entry);
    throw err;
  }
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

// WeakMap to store pre-update snapshots (keyed by context to avoid leaks)
const snapshots = new WeakMap<RepositoryContext, Record<string, unknown>>();

export function auditTrailPlugin(options: AuditTrailOptions = {}): Plugin {
  const {
    mode = 'best-effort',
    connection,
    operations = ['create', 'update', 'delete'],
    trackChanges = true,
    trackDocument = false,
    ttlDays,
    collectionName = 'audit_trails',
    metadata,
    excludeFields = [],
    onWriteError,
  } = options;

  const opsSet = new Set(operations);

  // Hot-path opt-out — `skipPlugins: ['auditTrail']` in operation options
  // bypasses every listener this plugin registers.
  const isSkipped = (context: RepositoryContext): boolean => {
    const list = context.skipPlugins as readonly string[] | undefined;
    return Array.isArray(list) && list.includes('auditTrail');
  };

  return {
    name: 'auditTrail',

    apply(repo: RepositoryInstance): void {
      // Default to the audited model's OWN connection, not the global one, so
      // `mongoose.createConnection()` apps get their audit entries in the same
      // database as their data without wiring `connection` manually. Explicit
      // `connection` still wins (intentionally centralized audit storage). For
      // an app on the global `mongoose.connect()` handle, `repo.Model.db` IS
      // `mongoose.connection`, so this is a no-op for the common case.
      const effectiveConnection = connection ?? repo.Model.db;
      const AuditModel = getAuditModel(effectiveConnection, collectionName, ttlDays);

      if (mode === 'transactional') {
        // after:* hooks are only awaited when the repo's hook engine runs in
        // 'async' mode (the default). On a `hooks: 'sync'` repository the
        // awaited insert would silently degrade to fire-and-forget — refuse
        // loudly instead of shipping a false guarantee.
        if (repo.hooks.mode === 'sync') {
          throw new Error(
            `[auditTrailPlugin] mode: 'transactional' requires the repository's ` +
              `hooks: 'async' mode (the default) — this repository uses hooks: 'sync', ` +
              `whose after-hooks are fire-and-forget and cannot await the audit write.`,
          );
        }
      }

      /** Route one entry through the configured delivery mode. */
      const deliver = (
        entry: Omit<AuditEntry, 'timestamp'>,
        context: RepositoryContext,
      ): Promise<void> | undefined => {
        if (mode === 'transactional') {
          return writeAuditTransactional(
            AuditModel,
            entry,
            context.session as ClientSession | undefined,
            onWriteError,
          );
        }
        writeAuditBestEffort(AuditModel, entry, onWriteError);
        return undefined;
      };

      // ─── Create ─────────────────────────────────────────────
      if (opsSet.has('create')) {
        repo.on(
          'after:create',
          ({ context, result }: { context: RepositoryContext; result: unknown }) => {
            if (isSkipped(context)) return;
            const doc = toPlainObject(result);

            const idKey = getEffectiveIdField(repo, context);
            return deliver(
              {
                model: context.model || repo.model,
                operation: 'create',
                documentId: doc?.[idKey],
                userId: getUserId(context),
                orgId: context.organizationId,
                document: trackDocument ? sanitizeDoc(doc, excludeFields) : undefined,
                metadata: metadata?.(context),
              },
              context,
            );
          },
        );
      }

      // ─── Update ─────────────────────────────────────────────
      if (opsSet.has('update')) {
        // Capture previous state BEFORE update. Mirrors the update path's
        // own lookup semantics: the repository's configured idField (with
        // per-call override), the operation's policy filters accumulated in
        // `context.query` (soft-delete, tenant scope), and the operation's
        // transaction session — so the snapshot is the exact document the
        // update will touch, even for `idField: 'slug'` repos and inside
        // transactions.
        if (trackChanges) {
          repo.on('before:update', async (context: RepositoryContext) => {
            if (isSkipped(context)) return;
            if (context.id === undefined || context.id === null) return;

            try {
              const idKey = getEffectiveIdField(repo, context);
              const filter = {
                [idKey]: context.id,
                ...((context.query as Record<string, unknown> | undefined) ?? {}),
              };
              const query = repo.Model.findOne(filter);
              if (context.session) {
                query.session(context.session as ClientSession);
              }
              const prev = await query.lean();
              if (prev) {
                snapshots.set(context, prev as Record<string, unknown>);
              }
            } catch (err) {
              warn(
                `[auditTrailPlugin] Failed to snapshot before update: ${(err as Error).message}`,
              );
            }
          });
        }

        repo.on(
          'after:update',
          ({ context, result }: { context: RepositoryContext; result: unknown }) => {
            if (isSkipped(context)) return;
            const doc = result as Record<string, unknown>;
            let changes: Record<string, { from: unknown; to: unknown }> | undefined;

            if (trackChanges) {
              const prev = snapshots.get(context);
              if (prev && context.data) {
                changes = computeChanges(prev, context.data, excludeFields);
              }
              snapshots.delete(context);
            }

            return deliver(
              {
                model: context.model || repo.model,
                operation: 'update',
                documentId: context.id || doc?.[getEffectiveIdField(repo, context)],
                userId: getUserId(context),
                orgId: context.organizationId,
                changes,
                metadata: metadata?.(context),
              },
              context,
            );
          },
        );
      }

      // ─── findOneAndUpdate (atomic CAS) ──────────────────────
      // Note: change-tracking is not supported here. The operation is
      // filter-based (no context.id), and snapshotting the matched doc
      // would require an extra findOne round-trip per call — too heavy
      // for the high-frequency outbox/lock workloads this primitive
      // exists for. Callers who need diffs should use update().
      if (opsSet.has('findOneAndUpdate')) {
        repo.on(
          'after:findOneAndUpdate',
          ({ context, result }: { context: RepositoryContext; result: unknown }) => {
            if (isSkipped(context)) return;
            if (!result) return; // null match — nothing to audit
            const doc = result as Record<string, unknown>;
            const idKey = getEffectiveIdField(repo, context);
            return deliver(
              {
                model: context.model || repo.model,
                operation: 'findOneAndUpdate',
                documentId: doc?.[idKey],
                userId: getUserId(context),
                orgId: context.organizationId,
                metadata: metadata?.(context),
              },
              context,
            );
          },
        );
      }

      // ─── Delete ─────────────────────────────────────────────
      if (opsSet.has('delete')) {
        repo.on('after:delete', ({ context }: { context: RepositoryContext }) => {
          if (isSkipped(context)) return;
          return deliver(
            {
              model: context.model || repo.model,
              operation: 'delete',
              documentId: context.id,
              userId: getUserId(context),
              orgId: context.organizationId,
              metadata: metadata?.(context),
            },
            context,
          );
        });
      }

      // ─── Query Methods ────────────────────────────────────────
      // Register query helpers if methodRegistryPlugin is available
      if (typeof repo.registerMethod === 'function') {
        /**
         * Get audit trail for a specific document
         */
        repo.registerMethod(
          'getAuditTrail',
          async function (
            this: RepositoryInstance,
            documentId: string | ObjectId,
            queryOptions: {
              page?: number;
              limit?: number;
              operation?: AuditOperation;
            } = {},
          ) {
            const { page = 1, limit = 20, operation } = queryOptions;
            const skip = (page - 1) * limit;

            const filter: Record<string, unknown> = {
              model: this.model,
              documentId,
            };
            if (operation) filter.operation = operation;

            const [data, total] = await Promise.all([
              AuditModel.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
              AuditModel.countDocuments(filter),
            ]);

            return {
              data,
              page,
              limit,
              total,
              pages: Math.ceil(total / limit),
              hasNext: page < Math.ceil(total / limit),
              hasPrev: page > 1,
            };
          },
        );
      }
    },
  };
}

/** Convert Mongoose document to plain object */
function toPlainObject(doc: unknown): Record<string, unknown> {
  if (!doc) return {};
  if (typeof (doc as { toObject?: () => Record<string, unknown> }).toObject === 'function') {
    return (doc as { toObject: () => Record<string, unknown> }).toObject();
  }
  return doc as Record<string, unknown>;
}

/** Remove excluded fields from a document snapshot */
function sanitizeDoc(
  doc: Record<string, unknown>,
  excludeFields: string[],
): Record<string, unknown> {
  if (excludeFields.length === 0) return doc;
  const result = { ...doc };
  for (const field of excludeFields) {
    delete result[field];
  }
  return result;
}

// ─── Boot Readiness ─────────────────────────────────────────────────────────

/** Options for {@link ensureAuditTrailReady}. */
export interface EnsureAuditTrailReadyOptions {
  /** Connection the audit model lives on (default: `mongoose.connection`). */
  connection?: Connection;
  /** MongoDB collection name (default: 'audit_trails'). */
  collectionName?: string;
  /**
   * TTL in days. Omit to reuse whatever the plugin already registered;
   * pass explicitly (before the plugin, e.g. in a migration script) to
   * declare retention up front — conflicts with an existing registration
   * throw.
   */
  ttlDays?: number;
}

/**
 * Create the audit collection and build its indexes BEFORE traffic begins.
 *
 * Call once at boot (after the plugin is registered, before serving
 * requests) — especially with `mode: 'transactional'`: creating the
 * collection or building indexes lazily inside the first transaction
 * forces MongoDB catalog locks and transient `TransientTransactionError`
 * retries. Idempotent; safe to call on every boot.
 *
 * @example
 * ```typescript
 * const repo = new Repository(Model, [
 *   auditTrailPlugin({ mode: 'transactional', ttlDays: 90 }),
 * ]);
 * await ensureAuditTrailReady(); // collection + indexes exist before traffic
 * ```
 */
export async function ensureAuditTrailReady(
  options: EnsureAuditTrailReadyOptions = {},
): Promise<void> {
  const model = getAuditModel(
    options.connection,
    options.collectionName ?? 'audit_trails',
    options.ttlDays,
    'reuse-existing',
  );
  try {
    await model.createCollection();
  } catch (err) {
    // Already exists — fine; anything else is a real boot problem.
    if ((err as { codeName?: string }).codeName !== 'NamespaceExists') throw err;
  }
  await model.init();
}

// ─── Standalone Query Class ──────────────────────────────────────────────────

export interface AuditQueryOptions {
  model?: string;
  documentId?: string | ObjectId;
  userId?: string | ObjectId;
  orgId?: string | ObjectId;
  operation?: AuditOperation;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface AuditQueryResult {
  data: AuditEntry[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Constructor options for {@link AuditTrailQuery}. */
export interface AuditTrailQueryOptions {
  /** MongoDB collection name (default: 'audit_trails') */
  collectionName?: string;
  /**
   * TTL in days. Omit (recommended) to reuse whatever retention the writing
   * plugin configured — readers don't need to know it. When passed
   * explicitly it is conflict-checked against the existing registration and
   * a mismatch throws.
   */
  ttlDays?: number;
  /**
   * Mongoose connection the audit model lives on. Defaults to the global
   * `mongoose.connection`. Pass the same connection you gave
   * `auditTrailPlugin` for multi-DB apps.
   */
  connection?: Connection;
}

/**
 * Standalone audit trail query utility.
 * Use this to query audits across all models — e.g., admin dashboards, audit APIs.
 *
 * @example
 * ```typescript
 * import { AuditTrailQuery } from '@classytic/mongokit';
 *
 * const auditQuery = new AuditTrailQuery(); // defaults to 'audit_trails' on mongoose.connection
 *
 * // Named connection (multi-DB apps)
 * const tenantAudits = new AuditTrailQuery({ connection: tenantConnection });
 *
 * // All audits for an org
 * const orgAudits = await auditQuery.query({ orgId: '...' });
 *
 * // All updates by a user
 * const userUpdates = await auditQuery.query({
 *   userId: '...',
 *   operation: 'update',
 * });
 *
 * // All audits for a specific document
 * const docHistory = await auditQuery.query({
 *   model: 'Job',
 *   documentId: '...',
 * });
 *
 * // Date range
 * const recent = await auditQuery.query({
 *   from: new Date('2025-01-01'),
 *   to: new Date(),
 *   page: 1,
 *   limit: 50,
 * });
 *
 * // Direct model access for custom queries
 * const model = auditQuery.getModel();
 * const count = await model.countDocuments({ operation: 'delete' });
 * ```
 */
export class AuditTrailQuery {
  private model: mongoose.Model<AuditEntry>;

  constructor(options: AuditTrailQueryOptions = {}) {
    this.model = getAuditModel(
      options.connection,
      options.collectionName ?? 'audit_trails',
      options.ttlDays,
      // Readers reuse whatever retention the writing plugin configured when
      // ttlDays is omitted — querying history must not require knowing it.
      'reuse-existing',
    );
  }

  /**
   * Get the underlying Mongoose model for custom queries
   */
  getModel(): mongoose.Model<AuditEntry> {
    return this.model;
  }

  /**
   * Query audit entries with filters and pagination
   */
  async query(options: AuditQueryOptions = {}): Promise<AuditQueryResult> {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};

    if (options.model) filter.model = options.model;
    if (options.documentId) filter.documentId = options.documentId;
    if (options.userId) filter.userId = options.userId;
    if (options.orgId) filter.orgId = options.orgId;
    if (options.operation) filter.operation = options.operation;

    // Date range
    if (options.from || options.to) {
      const dateFilter: Record<string, Date> = {};
      if (options.from) dateFilter.$gte = options.from;
      if (options.to) dateFilter.$lte = options.to;
      filter.timestamp = dateFilter;
    }

    const [data, total] = await Promise.all([
      this.model.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);

    const pages = Math.ceil(total / limit);

    return {
      data: data as AuditEntry[],
      page,
      limit,
      total,
      pages,
      hasNext: page < pages,
      hasPrev: page > 1,
    };
  }

  /**
   * Get audit trail for a specific document
   */
  async getDocumentTrail(
    model: string,
    documentId: string | ObjectId,
    options: { page?: number; limit?: number; operation?: AuditOperation } = {},
  ): Promise<AuditQueryResult> {
    return this.query({ model, documentId, ...options });
  }

  /**
   * Get all audits for a user
   */
  async getUserTrail(
    userId: string | ObjectId,
    options: {
      page?: number;
      limit?: number;
      operation?: AuditOperation;
      orgId?: string | ObjectId;
    } = {},
  ): Promise<AuditQueryResult> {
    return this.query({ userId, ...options });
  }

  /**
   * Get all audits for an organization
   */
  async getOrgTrail(
    orgId: string | ObjectId,
    options: { page?: number; limit?: number; operation?: AuditOperation; model?: string } = {},
  ): Promise<AuditQueryResult> {
    return this.query({ orgId, ...options });
  }
}

// ─── TypeScript Interface ───────────────────────────────────────────────────

export interface AuditTrailMethods {
  /**
   * Get paginated audit trail for a document
   */
  getAuditTrail(
    documentId: string | ObjectId,
    options?: {
      page?: number;
      limit?: number;
      operation?: AuditOperation;
    },
  ): Promise<AuditQueryResult>;
}
