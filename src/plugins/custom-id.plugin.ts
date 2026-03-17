/**
 * Custom ID Plugin
 *
 * Generates custom document IDs using pluggable generators.
 * Supports atomic counters for sequential IDs (e.g., INV-2026-0001),
 * date-partitioned sequences, and fully custom generators.
 *
 * Uses MongoDB's atomic `findOneAndUpdate` with `$inc` on a dedicated
 * counters collection — guaranteeing no duplicate IDs under concurrency.
 *
 * @example Basic sequential counter
 * ```typescript
 * const invoiceRepo = new Repository(InvoiceModel, [
 *   customIdPlugin({
 *     field: 'invoiceNumber',
 *     generator: sequentialId({
 *       prefix: 'INV',
 *       model: InvoiceModel,
 *     }),
 *   }),
 * ]);
 *
 * const inv = await invoiceRepo.create({ amount: 100 });
 * // inv.invoiceNumber → "INV-0001"
 * ```
 *
 * @example Date-partitioned counter (resets monthly)
 * ```typescript
 * const billRepo = new Repository(BillModel, [
 *   customIdPlugin({
 *     field: 'billNumber',
 *     generator: dateSequentialId({
 *       prefix: 'BILL',
 *       model: BillModel,
 *       partition: 'monthly',
 *       separator: '-',
 *       padding: 4,
 *     }),
 *   }),
 * ]);
 *
 * const bill = await billRepo.create({ total: 250 });
 * // bill.billNumber → "BILL-2026-02-0001"
 * ```
 *
 * @example Custom generator function
 * ```typescript
 * const orderRepo = new Repository(OrderModel, [
 *   customIdPlugin({
 *     field: 'orderRef',
 *     generator: async (context) => {
 *       const region = context.data?.region || 'US';
 *       const seq = await getNextSequence('orders');
 *       return `ORD-${region}-${seq}`;
 *     },
 *   }),
 * ]);
 * ```
 */

import mongoose from 'mongoose';
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types.js';

// ============================================================
// Types
// ============================================================

/**
 * Generator function that produces a unique ID.
 * Receives the full repository context for conditional logic.
 */
export type IdGenerator = (context: RepositoryContext) => string | Promise<string>;

export interface CustomIdOptions {
  /** Field to store the custom ID (default: 'customId') */
  field?: string;
  /** Function to generate the ID. Can be async. */
  generator: IdGenerator;
  /** Only generate if the field is missing/empty (default: true) */
  generateOnlyIfEmpty?: boolean;
}

// ============================================================
// Atomic Counter Infrastructure
// ============================================================

/** Schema for the internal counters collection */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  {
    // Use a dedicated collection so it doesn't collide with user models
    collection: '_mongokit_counters',
    // Disable versioning — we rely on atomic $inc
    versionKey: false,
  }
);

/**
 * Get or create the Counter model on the given connection.
 * Falls back to the default mongoose connection if none is provided.
 * Lazy-init to avoid model registration errors if mongoose isn't connected yet.
 */
function getCounterModel(
  connection?: mongoose.Connection,
): mongoose.Model<{ _id: string; seq: number }> {
  const conn = connection ?? mongoose.connection;
  if (conn.models._MongoKitCounter) {
    return conn.models._MongoKitCounter as mongoose.Model<{ _id: string; seq: number }>;
  }
  return conn.model('_MongoKitCounter', counterSchema) as unknown as mongoose.Model<{ _id: string; seq: number }>;
}

/**
 * Atomically increment and return the next sequence value for a given key.
 * Uses `findOneAndUpdate` with `upsert` + `$inc` — fully atomic even under
 * heavy concurrency.
 *
 * @param counterKey - Unique key identifying this counter (e.g., "Invoice" or "Invoice:2026-02")
 * @param increment - Value to increment by (default: 1)
 * @returns The next sequence number (after increment)
 *
 * @example
 * const seq = await getNextSequence('invoices');
 * // First call → 1, second → 2, ...
 *
 * @example Batch increment for createMany
 * const startSeq = await getNextSequence('invoices', 5);
 * // If current was 10, returns 15 (you use 11, 12, 13, 14, 15)
 */
export async function getNextSequence(
  counterKey: string,
  increment: number = 1,
  connection?: mongoose.Connection,
): Promise<number> {
  const Counter = getCounterModel(connection);

  const result = await Counter.findOneAndUpdate(
    { _id: counterKey },
    { $inc: { seq: increment } },
    { upsert: true, returnDocument: 'after' }
  );

  if (!result) {
    throw new Error(`Failed to increment counter '${counterKey}'`);
  }
  return result.seq;
}

// ============================================================
// Built-in Generators
// ============================================================

export interface SequentialIdOptions {
  /** Prefix string (e.g., 'INV', 'ORD') */
  prefix: string;
  /** Mongoose model — used to derive the counter key from model name */
  model: mongoose.Model<any>;
  /** Number of digits to pad to (default: 4 → "0001") */
  padding?: number;
  /** Separator between prefix and number (default: '-') */
  separator?: string;
  /** Custom counter key override (default: model.modelName) */
  counterKey?: string;
}

/**
 * Generator: Simple sequential counter.
 * Produces IDs like `INV-0001`, `INV-0002`, etc.
 *
 * Uses atomic MongoDB counters — safe under concurrency.
 *
 * @example
 * ```typescript
 * customIdPlugin({
 *   field: 'invoiceNumber',
 *   generator: sequentialId({ prefix: 'INV', model: InvoiceModel }),
 * })
 * ```
 */
export function sequentialId(options: SequentialIdOptions): IdGenerator {
  const {
    prefix,
    model,
    padding = 4,
    separator = '-',
    counterKey,
  } = options;

  const key = counterKey || model.modelName;

  return async (context: RepositoryContext): Promise<string> => {
    const seq = await getNextSequence(key, 1, context._counterConnection as mongoose.Connection | undefined);
    return `${prefix}${separator}${String(seq).padStart(padding, '0')}`;
  };
}

export interface DateSequentialIdOptions {
  /** Prefix string (e.g., 'BILL', 'INV') */
  prefix: string;
  /** Mongoose model — used to derive the counter key */
  model: mongoose.Model<any>;
  /**
   * Partition granularity — counter resets each period.
   * - 'yearly'  → BILL-2026-0001, resets every January
   * - 'monthly' → BILL-2026-02-0001, resets every month
   * - 'daily'   → BILL-2026-02-20-0001, resets every day
   */
  partition?: 'yearly' | 'monthly' | 'daily';
  /** Number of digits to pad to (default: 4) */
  padding?: number;
  /** Separator (default: '-') */
  separator?: string;
}

/**
 * Generator: Date-partitioned sequential counter.
 * Counter resets per period — great for invoice/bill numbering.
 *
 * Produces IDs like:
 * - yearly:  `BILL-2026-0001`
 * - monthly: `BILL-2026-02-0001`
 * - daily:   `BILL-2026-02-20-0001`
 *
 * @example
 * ```typescript
 * customIdPlugin({
 *   field: 'billNumber',
 *   generator: dateSequentialId({
 *     prefix: 'BILL',
 *     model: BillModel,
 *     partition: 'monthly',
 *   }),
 * })
 * ```
 */
export function dateSequentialId(options: DateSequentialIdOptions): IdGenerator {
  const {
    prefix,
    model,
    partition = 'monthly',
    padding = 4,
    separator = '-',
  } = options;

  return async (context: RepositoryContext): Promise<string> => {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    let datePart: string;
    let counterKey: string;

    switch (partition) {
      case 'yearly':
        datePart = year;
        counterKey = `${model.modelName}:${year}`;
        break;
      case 'daily':
        datePart = `${year}${separator}${month}${separator}${day}`;
        counterKey = `${model.modelName}:${year}-${month}-${day}`;
        break;
      case 'monthly':
      default:
        datePart = `${year}${separator}${month}`;
        counterKey = `${model.modelName}:${year}-${month}`;
        break;
    }

    const seq = await getNextSequence(counterKey, 1, context._counterConnection as mongoose.Connection | undefined);
    return `${prefix}${separator}${datePart}${separator}${String(seq).padStart(padding, '0')}`;
  };
}

export interface PrefixedIdOptions {
  /** Prefix string (e.g., 'USR', 'TXN') */
  prefix: string;
  /** Separator (default: '_') */
  separator?: string;
  /** Length of the random suffix (default: 12) */
  length?: number;
}

/**
 * Generator: Prefix + random alphanumeric suffix.
 * Does NOT require a database round-trip — purely in-memory.
 *
 * Produces IDs like: `USR_a7b3xk9m2p1q`
 *
 * Good for: user-facing IDs where ordering doesn't matter.
 * Not suitable for sequential numbering.
 *
 * @example
 * ```typescript
 * customIdPlugin({
 *   field: 'publicId',
 *   generator: prefixedId({ prefix: 'USR', length: 10 }),
 * })
 * ```
 */
export function prefixedId(options: PrefixedIdOptions): IdGenerator {
  const { prefix, separator = '_', length = 12 } = options;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';

  return (_context: RepositoryContext): string => {
    let result = '';
    const bytes = new Uint8Array(length);
    // Use crypto.getRandomValues if available, otherwise Math.random
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(bytes);
      for (let i = 0; i < length; i++) {
        result += chars[bytes[i] % chars.length];
      }
    } else {
      for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    return `${prefix}${separator}${result}`;
  };
}

// ============================================================
// Plugin
// ============================================================

/**
 * Custom ID plugin — injects generated IDs into documents before creation.
 *
 * @param options - Configuration for ID generation
 * @returns Plugin instance
 *
 * @example
 * ```typescript
 * import { Repository, customIdPlugin, sequentialId } from '@classytic/mongokit';
 *
 * const invoiceRepo = new Repository(InvoiceModel, [
 *   customIdPlugin({
 *     field: 'invoiceNumber',
 *     generator: sequentialId({ prefix: 'INV', model: InvoiceModel }),
 *   }),
 * ]);
 *
 * const inv = await invoiceRepo.create({ amount: 100 });
 * console.log(inv.invoiceNumber); // "INV-0001"
 * ```
 */
export function customIdPlugin(options: CustomIdOptions): Plugin {
  const fieldName = options.field || 'customId';
  const generateOnlyIfEmpty = options.generateOnlyIfEmpty !== false;

  return {
    name: 'custom-id',

    apply(repo: RepositoryInstance): void {
      // Capture the repository's connection so counters use the same DB
      const repoConnection = repo.Model.db;

      // Hook into single creation
      repo.on('before:create', async (context: RepositoryContext) => {
        if (!context.data) return;

        if (generateOnlyIfEmpty && context.data[fieldName]) {
          return; // Already has an ID
        }

        // Attach connection to context so built-in generators can use it
        context._counterConnection = repoConnection;
        context.data[fieldName] = await options.generator(context);
      });

      // Hook into bulk creation — batch-increment for efficiency
      repo.on('before:createMany', async (context: RepositoryContext) => {
        if (!context.dataArray) return;

        // Attach connection to context so built-in generators can use it
        context._counterConnection = repoConnection;

        // Count how many docs need IDs
        const docsNeedingIds: Record<string, unknown>[] = [];
        for (const doc of context.dataArray) {
          if (generateOnlyIfEmpty && doc[fieldName]) {
            continue;
          }
          docsNeedingIds.push(doc);
        }

        if (docsNeedingIds.length === 0) return;

        // Generate IDs — sequential for each doc
        // (We call generator per-doc so date-partitioned generators work correctly)
        for (const doc of docsNeedingIds) {
          const id = await options.generator({ ...context, data: doc });
          doc[fieldName] = id;
        }
      });
    },
  };
}

export default customIdPlugin;
