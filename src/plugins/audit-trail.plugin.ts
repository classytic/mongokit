/**
 * Audit Trail Plugin
 *
 * Persists operation audit entries to a MongoDB collection.
 * Fire-and-forget: writes happen async and never block or fail the main operation.
 *
 * Features:
 * - Tracks create, update, delete operations
 * - Field-level change tracking (before/after diff on updates)
 * - TTL auto-cleanup via MongoDB TTL index
 * - Custom metadata per entry (IP, user-agent, etc.)
 * - Shared `audit_trails` collection across all models
 *
 * @example
 * ```typescript
 * const repo = new Repository(Job, [
 *   auditTrailPlugin({
 *     operations: ['create', 'update', 'delete'],
 *     trackChanges: true,
 *     ttlDays: 90,
 *     metadata: (context) => ({
 *       ip: context.req?.ip,
 *     }),
 *   }),
 * ]);
 * ```
 */

import mongoose from 'mongoose';
import type { ObjectId, Plugin, RepositoryContext, RepositoryInstance } from '../types.js';
import { warn } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AuditTrailOptions {
  /** Operations to track (default: ['create', 'update', 'delete']) */
  operations?: AuditOperation[];

  /** Store field-level before/after diff on updates (default: true) */
  trackChanges?: boolean;

  /** Store full document snapshot on create (default: false — can be heavy) */
  trackDocument?: boolean;

  /** Auto-purge after N days via MongoDB TTL index (default: undefined — keep forever) */
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
   * Custom callback fired when an audit write fails. Receives the error
   * and the entry that failed to land. Default: `console.warn` only.
   *
   * **Use this for compliance-grade audit trails (SOC 2 / PCI / HIPAA)
   * where missing entries must be surfaced upstream** — e.g. forward to
   * a dead-letter queue, page on-call, or short-circuit the request.
   * The default `warn` log is appropriate for development and
   * eventually-consistent observability use cases but is invisible to
   * compliance review.
   *
   * The callback runs on the same fire-and-forget microtask that wrote
   * the entry, so throwing from here will surface as an unhandled
   * rejection — handle (or rethrow into your error reporter) inside.
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

// ─── Internal Model (lazy-initialized, shared) ─────────────────────────────

const modelCache = new Map<string, mongoose.Model<AuditEntry>>();

function getAuditModel(collectionName: string, ttlDays?: number): mongoose.Model<AuditEntry> {
  const existing = modelCache.get(collectionName);
  if (existing) return existing;

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
      timestamp: { type: Date, default: Date.now, index: true },
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

  // TTL index — MongoDB auto-deletes documents after expiry
  if (ttlDays !== undefined && ttlDays > 0) {
    const ttlSeconds = ttlDays * 24 * 60 * 60;
    schema.index({ timestamp: 1 }, { expireAfterSeconds: ttlSeconds });
  }

  const modelName = `AuditTrail_${collectionName}`;

  // Reuse existing mongoose model if already registered (hot reload safety)
  const model = mongoose.models[modelName] || mongoose.model<AuditEntry>(modelName, schema);

  modelCache.set(collectionName, model as mongoose.Model<AuditEntry>);
  return model as mongoose.Model<AuditEntry>;
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

/**
 * Fire-and-forget audit write. Never throws into the caller's promise
 * chain (audit failures must not break the primary operation), but
 * routes errors to `onWriteError` for compliance hosts that need
 * surface visibility. Default behavior: `console.warn`-only.
 */
function writeAudit(
  AuditModel: mongoose.Model<AuditEntry>,
  entry: Omit<AuditEntry, 'timestamp'>,
  onWriteError?: (error: Error, entry: Omit<AuditEntry, 'timestamp'>) => void,
): void {
  // Use a microtask to avoid blocking the event loop on the hot path.
  Promise.resolve().then(() => {
    AuditModel.create({ ...entry, timestamp: new Date() }).catch((err: Error) => {
      if (onWriteError) {
        try {
          onWriteError(err, entry);
        } catch (cbErr) {
          // Callback itself threw — at least log so the original error
          // isn't completely swallowed. Don't rethrow; we're already
          // in fire-and-forget territory.
          warn(
            `[auditTrailPlugin] onWriteError callback itself threw: ${(cbErr as Error).message}`,
          );
        }
      } else {
        warn(`[auditTrailPlugin] Failed to write audit entry: ${err.message}`);
      }
    });
  });
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

// WeakMap to store pre-update snapshots (keyed by context to avoid leaks)
const snapshots = new WeakMap<RepositoryContext, Record<string, unknown>>();

export function auditTrailPlugin(options: AuditTrailOptions = {}): Plugin {
  const {
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
      const AuditModel = getAuditModel(collectionName, ttlDays);

      // ─── Create ─────────────────────────────────────────────
      if (opsSet.has('create')) {
        repo.on(
          'after:create',
          ({ context, result }: { context: RepositoryContext; result: unknown }) => {
            if (isSkipped(context)) return;
            const doc = toPlainObject(result);

            const idKey = ((repo as Record<string, unknown>).idField as string) || '_id';
            writeAudit(
              AuditModel,
              {
                model: context.model || repo.model,
                operation: 'create',
                documentId: doc?.[idKey],
                userId: getUserId(context),
                orgId: context.organizationId,
                document: trackDocument ? sanitizeDoc(doc, excludeFields) : undefined,
                metadata: metadata?.(context),
              },
              onWriteError,
            );
          },
        );
      }

      // ─── Update ─────────────────────────────────────────────
      if (opsSet.has('update')) {
        // Capture previous state BEFORE update
        if (trackChanges) {
          repo.on('before:update', async (context: RepositoryContext) => {
            if (isSkipped(context)) return;
            if (!context.id) return;

            try {
              const prev = await repo.Model.findById(context.id).lean();
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

            writeAudit(
              AuditModel,
              {
                model: context.model || repo.model,
                operation: 'update',
                documentId:
                  context.id ||
                  doc?.[((repo as Record<string, unknown>).idField as string) || '_id'],
                userId: getUserId(context),
                orgId: context.organizationId,
                changes,
                metadata: metadata?.(context),
              },
              onWriteError,
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
            const idKey = ((repo as Record<string, unknown>).idField as string) || '_id';
            writeAudit(
              AuditModel,
              {
                model: context.model || repo.model,
                operation: 'findOneAndUpdate',
                documentId: doc?.[idKey],
                userId: getUserId(context),
                orgId: context.organizationId,
                metadata: metadata?.(context),
              },
              onWriteError,
            );
          },
        );
      }

      // ─── Delete ─────────────────────────────────────────────
      if (opsSet.has('delete')) {
        repo.on('after:delete', ({ context }: { context: RepositoryContext }) => {
          if (isSkipped(context)) return;
          writeAudit(
            AuditModel,
            {
              model: context.model || repo.model,
              operation: 'delete',
              documentId: context.id,
              userId: getUserId(context),
              orgId: context.organizationId,
              metadata: metadata?.(context),
            },
            onWriteError,
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

/**
 * Standalone audit trail query utility.
 * Use this to query audits across all models — e.g., admin dashboards, audit APIs.
 *
 * @example
 * ```typescript
 * import { AuditTrailQuery } from '@classytic/mongokit';
 *
 * const auditQuery = new AuditTrailQuery(); // defaults to 'audit_trails' collection
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

  constructor(collectionName = 'audit_trails', ttlDays?: number) {
    this.model = getAuditModel(collectionName, ttlDays);
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
