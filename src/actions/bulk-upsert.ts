/**
 * `bulkUpsert` execution: keyed `updateOne` + `upsert` sub-ops in ONE `client.bulkWrite` with
 * `verboseResults`, the only form that reports matched / modified / upserted PER OP (server 8.0,
 * driver ClientBulkWrite). Mongoose's unordered `Connection.bulkWrite` returns without rethrowing a
 * driver error (lib/connection.js, the `[res, error]` branch), so it is not used. Each row is cast
 * with `Model.castObject` (a bad value fails that row as `validation`) and schema timestamps are
 * stamped here, since the driver path runs no mongoose middleware.
 */

import {
  BULK_UPSERT_ERROR_CODES,
  BULK_UPSERT_FAILURE_CODES,
  type BulkUpsertFailureCode,
  type BulkUpsertRowResult,
} from '@classytic/repo-core/repository';
import type {
  AnyClientBulkWriteModel,
  ClientBulkWriteResult,
  ClientSession,
  Document,
} from 'mongodb';
import mongoose, { type Model } from 'mongoose';
import type { WriteConcernSpec } from '../repository/query-defaults.js';
import { createError } from '../utils/error.js';

export interface PlannedUpsert {
  /** Input position. */
  index: number;
  key: Record<string, unknown>;
  filter: Record<string, unknown>;
  update: Record<string, Record<string, unknown>>;
}

/** Split rows into sendable sub-ops and rows refused before sending (`invalid_row`). */
export function planUpserts(
  rows: readonly Record<string, unknown>[],
  key: readonly string[],
  routing: { set?: readonly string[]; inc: readonly string[]; setOnInsert: readonly string[] },
): { planned: PlannedUpsert[]; refused: BulkUpsertRowResult[] } {
  const planned: PlannedUpsert[] = [];
  const refused: BulkUpsertRowResult[] = [];
  rows.forEach((row, index) => {
    const keyVals = Object.fromEntries(key.map((k) => [k, row[k]]));
    const missingKey = key.some((k) => row[k] === undefined || row[k] === null);
    const badInc = routing.inc.some((f) => row[f] !== undefined && typeof row[f] !== 'number');
    if (missingKey || badInc) {
      refused.push({
        index,
        key: keyVals,
        outcome: 'failed',
        code: BULK_UPSERT_FAILURE_CODES.INVALID_ROW,
      });
      return;
    }
    const $set: Record<string, unknown> = {};
    const $inc: Record<string, unknown> = {};
    const $setOnInsert: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(row)) {
      if (key.includes(field) || value === undefined) continue;
      if (routing.inc.includes(field)) $inc[field] = value;
      else if (routing.setOnInsert.includes(field)) $setOnInsert[field] = value;
      else if (!routing.set || routing.set.includes(field)) $set[field] = value;
    }
    const update: Record<string, Record<string, unknown>> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($inc).length > 0) update.$inc = $inc;
    if (Object.keys($setOnInsert).length > 0) update.$setOnInsert = $setOnInsert;
    // Mongo 5+ accepts an empty operand: a key-only row inserts its key, or matches unchanged.
    if (Object.keys(update).length === 0) update.$set = {};
    planned.push({ index, key: keyVals, filter: { ...keyVals }, update });
  });
  return { planned, refused };
}

/** Field sets a unique index covers; `_id` always. */
function uniqueIndexes<TDoc>(model: Model<TDoc>): string[][] {
  const out: string[][] = [['_id']];
  for (const [fields, options] of model.schema.indexes()) {
    if (options.unique === true) out.push(Object.keys(fields));
  }
  return out;
}

/** Is some unique index entirely pinned by the filter's equality fields (so it matches <= 1 row)? */
export function keyIsUnique<TDoc>(model: Model<TDoc>, filterFields: readonly string[]): boolean {
  return uniqueIndexes(model).some((fields) => fields.every((f) => filterFields.includes(f)));
}

function timestampFields<TDoc>(model: Model<TDoc>): { createdAt?: string; updatedAt?: string } {
  const ts = model.schema.get('timestamps') as
    | boolean
    | { createdAt?: string | boolean; updatedAt?: string | boolean }
    | undefined;
  if (!ts) return {};
  if (ts === true) return { createdAt: 'createdAt', updatedAt: 'updatedAt' };
  const name = (v: string | boolean | undefined, d: string) =>
    v === false ? undefined : typeof v === 'string' ? v : d;
  return { createdAt: name(ts.createdAt, 'createdAt'), updatedAt: name(ts.updatedAt, 'updatedAt') };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `Model.castObject`, narrowed to the plain object it returns for a plain object input. */
function castRecord<TDoc>(
  model: Model<TDoc>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const casted: unknown = model.castObject(fields);
  if (!isRecord(casted)) throw new TypeError('[mongokit] castObject returned a non-object');
  return casted;
}

/** A server before 8.0 has no `bulkWrite` command (CommandNotFound, 59): a closed refusal. */
export function throwIfUnsupported(err: unknown): void {
  if (err instanceof mongoose.mongo.MongoServerError && err.code === 59) {
    throw createError(
      501,
      '[mongokit] bulkUpsert needs MongoDB 8.0 (client bulkWrite with per-op results)',
      {
        code: BULK_UPSERT_ERROR_CODES.UNSUPPORTED,
      },
    );
  }
}

function failureCode(code: unknown): BulkUpsertFailureCode {
  if (code === 11000 || code === 11001) return BULK_UPSERT_FAILURE_CODES.DUPLICATE;
  if (code === 121) return BULK_UPSERT_FAILURE_CODES.VALIDATION;
  return BULK_UPSERT_FAILURE_CODES.WRITE_ERROR;
}

/** Cast, stamp, send in one command, and map every sub-op to its exact outcome. */
export async function executeUpserts<TDoc>(
  model: Model<TDoc>,
  ops: readonly PlannedUpsert[],
  options: {
    ordered: boolean;
    session?: unknown;
    writeConcern?: WriteConcernSpec;
    timeoutMS?: number;
  },
): Promise<BulkUpsertRowResult[]> {
  const results: BulkUpsertRowResult[] = [];
  const sendable: PlannedUpsert[] = [];
  const namespace = `${model.db.name}.${model.collection.collectionName}`;
  const ts = timestampFields(model);
  const now = new Date();
  for (const op of ops) {
    try {
      const update: Record<string, Record<string, unknown>> = {};
      for (const [operator, fields] of Object.entries(op.update)) {
        update[operator] = Object.keys(fields).length > 0 ? castRecord(model, fields) : {};
      }
      if (ts.updatedAt) update.$set = { ...update.$set, [ts.updatedAt]: now };
      if (ts.createdAt) update.$setOnInsert = { ...update.$setOnInsert, [ts.createdAt]: now };
      sendable.push({ ...op, filter: castRecord(model, op.filter), update });
    } catch (err) {
      if (
        !(err instanceof mongoose.Error.ValidationError) &&
        !(err instanceof mongoose.Error.CastError)
      )
        throw err;
      results.push({
        index: op.index,
        key: op.key,
        outcome: 'failed',
        code: BULK_UPSERT_FAILURE_CODES.VALIDATION,
      });
    }
  }
  if (sendable.length === 0) return results;

  const models: AnyClientBulkWriteModel<Document>[] = sendable.map((op) => ({
    name: 'updateOne',
    namespace,
    filter: op.filter,
    update: op.update,
    upsert: true,
  }));
  let res: ClientBulkWriteResult | undefined;
  let writeErrors: Map<number, { code?: unknown }> = new Map();
  try {
    res = await model.db.getClient().bulkWrite(models, {
      ordered: options.ordered,
      verboseResults: true,
      ...(options.session ? { session: options.session as ClientSession } : {}),
      ...(options.writeConcern ? { writeConcern: options.writeConcern } : {}),
      ...(options.timeoutMS !== undefined ? { timeoutMS: options.timeoutMS } : {}),
    });
  } catch (err) {
    throwIfUnsupported(err);
    // Per-op write errors are outcomes; anything else (network, write concern) is not ours to guess.
    if (
      !(err instanceof mongoose.mongo.MongoClientBulkWriteError) ||
      err.writeConcernErrors.length > 0
    )
      throw err;
    res = err.partialResult;
    writeErrors = err.writeErrors;
  }
  const updates = res?.updateResults ?? new Map();
  sendable.forEach((op, i) => {
    const failed = writeErrors.get(i);
    if (failed) {
      results.push({
        index: op.index,
        key: op.key,
        outcome: 'failed',
        code: failureCode(failed.code),
      });
      return;
    }
    const r = updates.get(i);
    if (!r) {
      // Absent from both maps. Ordered: the batch stopped before it. Unordered: the server said
      // nothing about it, and an unknown outcome is never reported as a known one (FL3).
      if (!options.ordered) {
        throw new Error(
          `[mongokit] bulkUpsert: the server reported no outcome for row ${op.index}`,
        );
      }
      results.push({
        index: op.index,
        key: op.key,
        outcome: 'failed',
        code: BULK_UPSERT_FAILURE_CODES.NOT_ATTEMPTED,
      });
      return;
    }
    const outcome =
      r.upsertedId !== undefined && r.upsertedId !== null
        ? 'inserted'
        : r.modifiedCount > 0
          ? 'updated'
          : 'unchanged';
    results.push({ index: op.index, key: op.key, outcome });
  });
  return results;
}
