/**
 * Create Actions
 * Pure functions for document creation
 */

import type { ClientSession, Model, SchemaType } from 'mongoose';
import type { AnyDocument } from '../types/core.js';
import type { CreateOptions } from '../types/operations.js';

/**
 * Create single document
 */
export async function create<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  data: Record<string, unknown>,
  options: CreateOptions = {},
): Promise<TDoc> {
  const document = new Model(data);
  await document.save({ session: options.session as ClientSession | undefined });
  return document as TDoc;
}

/**
 * One rejected input, keyed by its position in the array that was passed in.
 *
 * The index is the load-bearing part: it is the only way to tie a failure back
 * to the caller's own record — the driver reports failures positionally, and a
 * rejected document never comes back with an `_id` to match on.
 */
export interface CreateManyFailure {
  /** Position in the ORIGINAL `dataArray`. */
  index: number;
  /** The input that was rejected, as supplied. */
  doc: Record<string, unknown>;
  /** MongoDB error code, e.g. 11000 for a duplicate key. */
  code?: number;
  message: string;
}

/**
 * What a partially-successful `createMany` actually did.
 *
 * Attached to the thrown error as `partial`. `createMany` still REJECTS — that
 * is unchanged and deliberate — but the rejection now says which documents
 * landed and which did not, instead of leaving the caller to dig through a
 * driver error to find out.
 */
export interface CreateManyPartial<TDoc = AnyDocument> {
  /** Documents the server accepted. */
  inserted: TDoc[];
  /** Every rejected input, in input order. */
  failed: CreateManyFailure[];
}

/** The error `createMany` throws when some documents landed and some did not. */
export type CreateManyPartialError<TDoc = AnyDocument> = Error & {
  partial?: CreateManyPartial<TDoc>;
};

/** Narrow a caught error to one carrying a partial-write report. */
export function isCreateManyPartialError<TDoc = AnyDocument>(
  err: unknown,
): err is CreateManyPartialError<TDoc> & { partial: CreateManyPartial<TDoc> } {
  return (
    err instanceof Error &&
    typeof (err as CreateManyPartialError<TDoc>).partial === 'object' &&
    (err as CreateManyPartialError<TDoc>).partial !== null
  );
}

/** Pull the positional failures out of a driver bulk-write error. */
function readFailures(err: unknown, dataArray: Record<string, unknown>[]): CreateManyFailure[] {
  const raw = (err as { writeErrors?: unknown }).writeErrors;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return entries.map((entry) => {
    // The driver nests the useful fields one level down on some paths
    // (`err.err.index`) and flat on others. Read both rather than assume.
    const e = entry as Record<string, unknown>;
    const inner = (e.err ?? e) as Record<string, unknown>;
    const index = Number(inner.index ?? e.index ?? -1);
    return {
      index,
      doc: dataArray[index] ?? {},
      ...(typeof inner.code === 'number' ? { code: inner.code } : {}),
      message: String(inner.errmsg ?? inner.message ?? e.message ?? 'write failed'),
    };
  });
}

/**
 * Create multiple documents.
 *
 * **A rejection does NOT mean nothing was written.** Neither ordering does:
 * `ordered: true` stops at the first failure and keeps everything before it,
 * `ordered: false` keeps everything valid. Measured on a six-document batch
 * with a conflict in the middle — ordered wrote 3, unordered wrote 5. Only a
 * transaction gives all-or-nothing.
 *
 * So the rejection carries a `partial` report naming what landed and what did
 * not, because the alternative is a caller retrying the whole batch and
 * double-writing everything that had already succeeded. Use it to retry only
 * `failed`, or to reconcile — and prefer a unique index or an idempotency key
 * for anything that will be retried automatically.
 */
export async function createMany<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  dataArray: Record<string, unknown>[],
  options: CreateOptions = {},
): Promise<TDoc[]> {
  try {
    return (await Model.insertMany(dataArray, {
      session: options.session as ClientSession | undefined,
      ordered: options.ordered === true,
    })) as TDoc[];
  } catch (err) {
    // Only decorate; never swallow. The call still rejects with the driver's
    // own error, so existing `catch` blocks behave exactly as before.
    const inserted = (err as { insertedDocs?: unknown }).insertedDocs;
    const failed = readFailures(err, dataArray);
    if (Array.isArray(inserted) || failed.length > 0) {
      (err as CreateManyPartialError<TDoc>).partial = {
        inserted: (Array.isArray(inserted) ? inserted : []) as TDoc[],
        failed,
      };
    }
    throw err;
  }
}

/**
 * Create with defaults (useful for initialization)
 */
export async function createDefault<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  overrides: Record<string, unknown> = {},
  options: CreateOptions = {},
): Promise<TDoc> {
  const defaults: Record<string, unknown> = {};

  // Extract defaults from schema
  Model.schema.eachPath((path: string, schemaType: SchemaType) => {
    const schemaOptions = schemaType.options as { default?: unknown };
    if (schemaOptions.default !== undefined && path !== '_id') {
      defaults[path] =
        typeof schemaOptions.default === 'function'
          ? schemaOptions.default()
          : schemaOptions.default;
    }
  });

  return create(Model, { ...defaults, ...overrides }, options);
}

/**
 * Upsert (create or update)
 */
export async function upsert<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  data: Record<string, unknown>,
  options: { session?: unknown; updatePipeline?: boolean } = {},
): Promise<TDoc | null> {
  return Model.findOneAndUpdate(
    query,
    { $setOnInsert: data },
    {
      upsert: true,
      returnDocument: 'after',
      runValidators: true,
      session: options.session as ClientSession | undefined,
      ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
    },
  );
}
