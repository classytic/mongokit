/**
 * Option shapes for bundled plugins that declare their options in the shared
 * type layer (soft-delete, cascade, validation-chain, field-filter) plus the
 * minimal `Logger` port they log through. Plugins with self-contained options
 * (audit-trail, multi-tenant, cache, …) declare them in their own module.
 */

import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
import type { ObjectId, PopulateSpec, SelectSpec, SortSpec } from './core.js';
import type { RepositoryContext, RepositoryInstance } from './repository.js';

/** Field preset configuration (field-filter plugin) */
export interface FieldPreset {
  /** Fields visible to everyone */
  public: string[];
  /** Additional fields for authenticated users */
  authenticated?: string[];
  /** Additional fields for admins */
  admin?: string[];
}

/** Validator definition (validation-chain plugin) */
export interface ValidatorDefinition {
  /** Validator name */
  name: string;
  /** Operations to apply validator to */
  operations?: Array<'create' | 'createMany' | 'update' | 'findOneAndUpdate' | 'delete'>;
  /** Validation function */
  validate: (context: RepositoryContext, repo?: RepositoryInstance) => void | Promise<void>;
}

/** Validation chain options */
export interface ValidationChainOptions {
  /** Stop on first validation error (default: true) */
  stopOnFirstError?: boolean;
}

/** Logger interface for audit plugin */
export interface Logger {
  info?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

/** Filter mode for soft delete queries */
export type SoftDeleteFilterMode = 'null' | 'exists';

/** Soft delete plugin options */
export interface SoftDeleteOptions {
  /** Field name for deletion timestamp (default: 'deletedAt') */
  deletedField?: string;
  /** Field name for deleting user (default: 'deletedBy') */
  deletedByField?: string;
  /** Enable soft delete (default: true) */
  soft?: boolean;
  /**
   * Filter mode for excluding deleted documents (default: 'null')
   * - 'null': Filters where deletedField is null (works with `default: null` in schema)
   * - 'exists': Filters where deletedField does not exist (legacy behavior)
   */
  filterMode?: SoftDeleteFilterMode;
  /** Add restore method to repository (default: true) */
  addRestoreMethod?: boolean;
  /** Add getDeleted method to repository (default: true) */
  addGetDeletedMethod?: boolean;
  /**
   * TTL in days for auto-cleanup of deleted documents.
   * When set, creates a TTL index on the deletedField.
   * Documents will be automatically removed after the specified days.
   */
  ttlDays?: number;
}

/** Repository with soft delete methods */
export interface SoftDeleteRepository<TDoc = unknown> {
  /**
   * Restore a soft-deleted document by setting deletedAt to null
   * @param id - Document ID to restore
   * @param options - Optional session for transactions
   * @returns The restored document
   */
  restore(
    id: string | ObjectId,
    options?: {
      session?: unknown;
      organizationId?: unknown;
      bypassTenant?: boolean;
      [key: string]: unknown;
    },
  ): Promise<TDoc>;

  /**
   * Get all soft-deleted documents
   * @param params - Query parameters (filters, pagination, etc.)
   * @param options - Query options (select, populate, etc.)
   * @returns Paginated result of deleted documents
   */
  getDeleted(
    params?: {
      filters?: Record<string, unknown>;
      sort?: SortSpec | string;
      page?: number;
      limit?: number;
    },
    options?: {
      select?: SelectSpec;
      populate?: PopulateSpec;
      lean?: boolean;
      session?: unknown;
    },
  ): Promise<OffsetPaginationResult<TDoc>>;
}

/** Cascade relation definition */
export interface CascadeRelation {
  /**
   * Preferred: a Repository instance for the target collection. When present,
   * cascade routes deletes through `repo.delete` / `repo.deleteMany`, so the
   * target's `before:delete` / `before:deleteMany` hooks fire — meaning
   * multi-tenant scoping, audit logging, cache invalidation, and the target's
   * own soft-delete plugin (with its configured `deletedField`) all run
   * correctly. Strongly recommended for any target that has policy plugins.
   */
  repo?: RepositoryInstance;
  /**
   * Legacy: a Mongoose model name. When set without `repo`, cascade writes
   * directly via `RelatedModel.updateMany` / `RelatedModel.deleteMany`. This
   * path bypasses the target's hooks — it will NOT enforce tenant scoping,
   * fire audit events, or honor a custom `deletedField`. Only safe for
   * trivial targets with no policy plugins. Prefer `repo` for new code.
   */
  model?: string;
  /** Foreign key field in the related model that references the deleted document */
  foreignKey: string;
  /**
   * WHICH parent field `foreignKey` stores. Default: the parent repository's
   * `idField` (`_id` unless the repository declares another).
   *
   * Set it when the two differ. An order repository addressed by `orderNumber`
   * whose children store the order's `_id` declares `parentKey: '_id'`;
   * without it, `delete('ORD-2026-0001')` cascaded with the order NUMBER and
   * every child delete failed on the ObjectId cast. The cascade reads the
   * parent's value for this field before the delete, under the same session.
   */
  parentKey?: string;
  /** Whether to use soft delete if available (default: follows parent behavior) */
  softDelete?: boolean;
  /**
   * What happens to the referencing documents when the parent is deleted.
   *
   * MongoDB has no foreign keys, so this is the application-level equivalent of an
   * RDBMS `ON DELETE` clause. Odoo — which hard-deletes almost everything — relies on
   * Postgres `ondelete='restrict'` in 31 places in its accounting module alone; that
   * enforcement is what lets it skip soft delete entirely. Without an equivalent here, a
   * hard delete leaves dangling references that surface later as reports with missing
   * names, and the usual workaround is to soft-delete the parent forever — which hides
   * the row rather than refusing the operation.
   *
   * - `cascade` (DEFAULT, and the pre-existing behaviour) — delete the children too.
   * - `restrict` — REFUSE the parent delete while any reference remains. Runs
   *   `before:delete`, because refusing after the parent is gone is not a refusal.
   * - `detach` — clear the reference (`$unset`) and keep the child. The RDBMS
   *   `SET NULL`; only valid where the field is optional.
   *
   * `restrict` and `detach` issue a query per relation on delete, so `foreignKey`
   * SHOULD be indexed — Mongo gives no index for free the way a FK constraint does.
   */
  onDelete?: 'cascade' | 'restrict' | 'detach';
}

/** Cascade delete plugin options */
export interface CascadeOptions {
  /** Relations to cascade delete */
  relations: CascadeRelation[];
  /** Run cascade deletes in parallel (default: true) */
  parallel?: boolean;
  /**
   * Upper bound on every `$in` the bulk (`deleteMany`) path issues — restrict counts,
   * detach `$unset`s and cascade deletes are all sliced to at most this many parent ids
   * per query. Bounds the query-document size (Mongo rejects documents past 16 MB, which
   * an unsliced `$in` reaches around a million ObjectIds) and the per-call working set.
   * Default 10_000 (`DEFAULT_ID_CHUNK`); see `utils/id-chunks.ts` for why this is larger
   * than `runChunkedPurge`'s 1000.
   */
  batchSize?: number;
  /** Logger for cascade operations */
  logger?: Logger;
}
