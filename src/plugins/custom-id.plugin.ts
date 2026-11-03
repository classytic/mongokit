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
import type { Plugin, RepositoryContext, RepositoryInstance } from '../types/repository.js';
import { warn } from '../utils/logger.js';

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
  },
);

/**
 * Get or create the Counter model on the given connection.
 * Falls back to the default mongoose connection if none is provided.
 * Lazy-init to avoid model registration errors if mongoose isn't connected yet.
 */
function getCounterModel(
  connection?: mongoose.Connection,
  collection?: string,
): mongoose.Model<{ _id: string; seq: number }> {
  const conn = connection ?? mongoose.connection;
  // The default collection keeps its historical model name; a custom
  // collection gets its own model so both can live on one connection.
  const modelName =
    collection === undefined || collection === '_mongokit_counters'
      ? '_MongoKitCounter'
      : `_MongoKitCounter:${collection}`;
  if (conn.models[modelName]) {
    return conn.models[modelName] as mongoose.Model<{ _id: string; seq: number }>;
  }
  return conn.model(
    modelName,
    counterSchema,
    collection ?? '_mongokit_counters',
  ) as unknown as mongoose.Model<{
    _id: string;
    seq: number;
  }>;
}

/** Options for {@link createSequenceCounter}. */
export interface SequenceCounterOptions {
  /** Mongoose connection. @default the default `mongoose.connection` */
  connection?: mongoose.Connection;
  /**
   * Collection holding the counters, for hosts with a collection-naming
   * rule (e.g. an app prefix). @default `'_mongokit_counters'`
   */
  collection?: string;
}

/**
 * The atomic counter API bound to one connection + collection. Same
 * semantics as {@link getNextSequence} / {@link readSequence} /
 * {@link ensureSequenceAtLeast}, with an optional session on every call.
 */
export interface SequenceCounter {
  /** Atomic `$inc` + upsert; returns the value after the increment. */
  next(counterKey: string, increment?: number, session?: mongoose.ClientSession): Promise<number>;
  /** Current value, or `null` when the counter was never created. */
  read(counterKey: string, session?: mongoose.ClientSession): Promise<number | null>;
  /** Raise to at least `floor` (`$max` + upsert); never lowers. Returns the value after. */
  ensureAtLeast(
    counterKey: string,
    floor: number,
    session?: mongoose.ClientSession,
  ): Promise<number>;
  /**
   * Next value of the counter `'<baseKey><sep><civil period>'`, which resets
   * every civil year / month / day in `timeZone`. See {@link getNextPeriodSequence}.
   */
  nextInPeriod(baseKey: string, options: PeriodSequenceOptions): Promise<PeriodSequenceResult>;
}

/**
 * Bind the atomic counter API to a connection and, optionally, a
 * collection other than `_mongokit_counters`.
 *
 * @example
 * const counters = createSequenceCounter({ connection, collection: 'app_counters' });
 * await withTransaction(connection, async (session) => {
 *   const seq = await counters.next('alert.stream', 1, session);
 * });
 */
export function createSequenceCounter(options: SequenceCounterOptions = {}): SequenceCounter {
  const { connection, collection } = options;
  assertCounterCollection('createSequenceCounter', collection);
  const model = () => getCounterModel(connection, collection);
  return {
    next: (counterKey, increment = 1, session) =>
      incrementCounter(model(), counterKey, increment, session),
    read: (counterKey, session) => readCounter(model(), counterKey, session),
    ensureAtLeast: (counterKey, floor, session) =>
      raiseCounter(model(), counterKey, floor, session),
    nextInPeriod: (baseKey, periodOptions) => nextInPeriod(model(), baseKey, periodOptions),
  };
}

function assertCounterCollection(fn: string, collection: unknown): void {
  if (collection !== undefined && (typeof collection !== 'string' || collection.length === 0)) {
    throw new Error(`${fn}: collection must be a non-empty string`);
  }
}

async function incrementCounter(
  Counter: mongoose.Model<{ _id: string; seq: number }>,
  counterKey: string,
  increment: number,
  session?: mongoose.ClientSession,
): Promise<number> {
  const result = await Counter.findOneAndUpdate(
    { _id: counterKey },
    { $inc: { seq: increment } },
    { upsert: true, returnDocument: 'after', session },
  );
  if (!result) {
    throw new Error(`Failed to increment counter '${counterKey}'`);
  }
  return result.seq;
}

async function raiseCounter(
  Counter: mongoose.Model<{ _id: string; seq: number }>,
  counterKey: string,
  floor: number,
  session?: mongoose.ClientSession,
): Promise<number> {
  if (!Number.isSafeInteger(floor) || floor < 0) {
    throw new Error(`ensureSequenceAtLeast: floor must be a non-negative integer, got ${floor}`);
  }
  const result = await Counter.findOneAndUpdate(
    { _id: counterKey },
    { $max: { seq: floor } },
    { upsert: true, returnDocument: 'after', session },
  );
  if (!result) throw new Error(`Failed to seed counter '${counterKey}'`);
  return result.seq;
}

/**
 * Atomically increment and return the next sequence value for a given key.
 * Uses `findOneAndUpdate` with `upsert` + `$inc` — fully atomic even under
 * heavy concurrency.
 *
 * @param counterKey - Unique key identifying this counter (e.g., "Invoice" or "Invoice:2026-02")
 * @param increment - Value to increment by (default: 1)
 * @param connection - Mongoose connection to use (defaults to the default connection)
 * @param session - Optional client session. When provided, the counter bump
 *   participates in the caller's transaction — if the surrounding transaction
 *   aborts, the counter does NOT advance. Without a session, the bump commits
 *   immediately and is not rolled back if a sibling write fails.
 * @returns The next sequence number (after increment)
 *
 * @example
 * const seq = await getNextSequence('invoices');
 * // First call → 1, second → 2, ...
 *
 * @example Batch increment for createMany
 * const startSeq = await getNextSequence('invoices', 5);
 * // If current was 10, returns 15 (you use 11, 12, 13, 14, 15)
 *
 * @example Transactional counter bump
 * await withTransaction(conn, async (session) => {
 *   const seq = await getNextSequence('invoices', 1, conn, session);
 *   await invoiceRepo.create({ invoiceNumber: `INV-${seq}` }, { session });
 *   // if this throws, the counter is rolled back with the insert
 * });
 */
export async function getNextSequence(
  counterKey: string,
  increment: number = 1,
  connection?: mongoose.Connection,
  session?: mongoose.ClientSession,
): Promise<number> {
  return incrementCounter(getCounterModel(connection), counterKey, increment, session);
}

/**
 * Current value of a counter, or `null` when it has never been created.
 * `null` and `0` differ: only a missing counter needs seeding.
 */
export async function readSequence(
  counterKey: string,
  connection?: mongoose.Connection,
  session?: mongoose.ClientSession,
): Promise<number | null> {
  return readCounter(getCounterModel(connection), counterKey, session);
}

async function readCounter(
  Counter: mongoose.Model<{ _id: string; seq: number }>,
  counterKey: string,
  session?: mongoose.ClientSession,
): Promise<number | null> {
  const doc = await Counter.findById(counterKey, null, session ? { session } : {}).lean();
  return doc ? doc.seq : null;
}

/**
 * Raise a counter to at least `floor` — never lowers it. Atomic (`$max` +
 * upsert), so concurrent seeders converge on the highest floor.
 *
 * Use before a counter's first increment when ids were already issued under
 * another key (e.g. moving from a global to a per-tenant sequence); otherwise
 * the new counter restarts at 1 and re-issues taken ids.
 *
 * @returns The counter's value after the raise.
 */
export async function ensureSequenceAtLeast(
  counterKey: string,
  floor: number,
  connection?: mongoose.Connection,
  session?: mongoose.ClientSession,
): Promise<number> {
  return raiseCounter(getCounterModel(connection), counterKey, floor, session);
}

// ============================================================
// Period-scoped sequences (civil year / month / day in a time zone)
// ============================================================

/** The civil period a period-scoped counter resets on. */
export type SequencePeriod = 'year' | 'month' | 'day';

const SEQUENCE_PERIODS: ReadonlySet<string> = new Set(['year', 'month', 'day']);

/** One cached formatter per zone; construction is the expensive part of Intl. */
const civilFormatters = new Map<string, Intl.DateTimeFormat>();

function civilFormatter(fn: string, timeZone: unknown): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new Error(`${fn}: timeZone must be a non-empty IANA time zone (e.g. 'Asia/Riyadh')`);
  }
  let formatter = civilFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      throw new Error(`${fn}: unknown time zone '${timeZone}'`);
    }
    civilFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The civil date of an instant in a zone. Read from the zone's own rules
 * (Intl), never by adding a fixed offset, so DST shifts and zone-rule changes
 * (a skipped or repeated local day) land on the date a wall clock there shows.
 */
function civilParts(
  fn: string,
  at: Date,
  timeZone: string,
): { year: string; month: string; day: string } {
  const formatter = civilFormatter(fn, timeZone);
  let year = '';
  let month = '';
  let day = '';
  for (const part of formatter.formatToParts(at)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return { year: year.padStart(4, '0'), month, day };
}

function assertInstant(fn: string, at: unknown): asserts at is Date {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new Error(`${fn}: at must be a valid Date`);
  }
}

/**
 * The civil period of an instant in an IANA time zone: `'2026'` (year),
 * `'2026-03'` (month) or `'2026-03-14'` (day). The period suffix every
 * period-scoped counter key ends with.
 *
 * @example
 * civilPeriodKey(new Date('2026-12-31T21:00:00Z'), 'year', 'Asia/Riyadh'); // '2027'
 * civilPeriodKey(new Date('2026-12-31T21:00:00Z'), 'year', 'UTC');         // '2026'
 */
export function civilPeriodKey(at: Date, period: SequencePeriod, timeZone: string): string {
  assertInstant('civilPeriodKey', at);
  if (!SEQUENCE_PERIODS.has(period)) {
    throw new Error(`civilPeriodKey: period must be 'year', 'month' or 'day', got '${period}'`);
  }
  const { year, month, day } = civilParts('civilPeriodKey', at, timeZone);
  if (period === 'year') return year;
  if (period === 'month') return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

/** Options for {@link periodCounterKey}, {@link getNextPeriodSequence} and `SequenceCounter.nextInPeriod`. */
export interface PeriodSequenceKeyOptions {
  /** Civil period the counter resets on. */
  period: SequencePeriod;
  /** IANA time zone whose civil calendar decides the period (e.g. `'Asia/Riyadh'`, `'UTC'`). */
  timeZone: string;
  /**
   * The instant whose civil date picks the period (e.g. the record's
   * `reportedAt`, so a backdated record numbers in its own year).
   * @default now
   */
  at?: Date;
  /**
   * Joins the base key and the period: `'<base><sep><period>'`.
   * Pass `'.'` to keep counters an app already created as `occ.occurrence.2026`.
   * @default ':'
   */
  keySeparator?: string;
}

/** Options for {@link getNextPeriodSequence} / `SequenceCounter.nextInPeriod`. */
export interface PeriodSequenceOptions extends PeriodSequenceKeyOptions {
  /** @default 1 */
  increment?: number;
  /** Client session: the bump joins the caller's transaction. */
  session?: mongoose.ClientSession;
}

/** A period-scoped counter value plus the period it was issued in. */
export interface PeriodSequenceResult {
  /** Value after the increment; `1` for the first value of a new period. */
  seq: number;
  /** The civil period (`'2026'`, `'2026-03'`, `'2026-03-14'`), for formatting the id. */
  period: string;
  /** The counter document's key (`'<base><sep><period>'`), for `read` / `ensureAtLeast`. */
  counterKey: string;
}

/**
 * The counter key and civil period for a base key at an instant. Use it to
 * `read` / `ensureAtLeast` the same counter `getNextPeriodSequence` bumps.
 */
export function periodCounterKey(
  baseKey: string,
  options: PeriodSequenceKeyOptions,
): { counterKey: string; period: string } {
  if (typeof baseKey !== 'string' || baseKey.length === 0) {
    throw new Error('periodCounterKey: baseKey must be a non-empty string');
  }
  const at = options.at ?? new Date();
  const period = civilPeriodKey(at, options.period, options.timeZone);
  const separator = options.keySeparator ?? ':';
  return { counterKey: `${baseKey}${separator}${period}`, period };
}

/**
 * Atomically issue the next value of a counter that resets every civil
 * year / month / day in an IANA time zone. The period is derived from `at`
 * (default now) in `timeZone`, so every replica agrees on it whatever its
 * `TZ`, and DST never moves a boundary.
 *
 * @example Yearly reference `OC-2026-000123` in Riyadh
 * const { seq, period } = await getNextPeriodSequence('occ.occurrence', {
 *   period: 'year', timeZone: 'Asia/Riyadh', at: reportedAt, connection, session,
 * });
 * const ref = `OC-${period}-${String(seq).padStart(6, '0')}`;
 */
export async function getNextPeriodSequence(
  baseKey: string,
  options: PeriodSequenceOptions & { connection?: mongoose.Connection },
): Promise<PeriodSequenceResult> {
  return nextInPeriod(getCounterModel(options.connection), baseKey, options);
}

async function nextInPeriod(
  Counter: mongoose.Model<{ _id: string; seq: number }>,
  baseKey: string,
  options: PeriodSequenceOptions,
): Promise<PeriodSequenceResult> {
  const { counterKey, period } = periodCounterKey(baseKey, options);
  const seq = await incrementCounter(Counter, counterKey, options.increment ?? 1, options.session);
  return { seq, period, counterKey };
}

// ============================================================
// Built-in Generators
// ============================================================

export interface SequentialIdOptions {
  /** Prefix string (e.g., 'INV', 'ORD') */
  prefix: string;
  /** Mongoose model — used to derive the counter key from model name */
  model: mongoose.Model<any>;
  /**
   * MINIMUM number of digits (default: 4 → "0001"). Never truncates —
   * sequence 10000 under `padding: 4` renders as `INV-10000`.
   */
  padding?: number;
  /** Separator between prefix and number (default: '-') */
  separator?: string;
  /** Custom counter key override (default: model.modelName) */
  counterKey?: string;
  /**
   * Counter collection, same as `createSequenceCounter({ collection })`
   * (for hosts with a collection-naming rule). @default `'_mongokit_counters'`
   */
  counterCollection?: string;
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
  const { prefix, model, padding = 4, separator = '-', counterKey, counterCollection } = options;

  const key = counterKey || model.modelName;
  assertCounterCollection('sequentialId', counterCollection);

  return async (context: RepositoryContext): Promise<string> => {
    const seq = await incrementCounter(
      getCounterModel(
        context._counterConnection as mongoose.Connection | undefined,
        counterCollection,
      ),
      key,
      1,
      context.session as mongoose.ClientSession | undefined,
    );
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
  /**
   * MINIMUM number of digits for the sequence (default: 4). `padStart` never
   * truncates, so the 10,000th id of a period under `padding: 4` is
   * `BILL-2026-10000` — it grows a digit rather than wrapping to `0000`.
   * Lexical sort order therefore only holds while a period stays below
   * 10^padding; size the padding for your peak period.
   */
  padding?: number;
  /** Separator (default: '-') */
  separator?: string;
  /**
   * Counter scope.
   * - `'global'` (default) — one counter per model + period, shared by
   *   every tenant in the database. Ids are unique across the deployment.
   * - `'tenant'` — one counter per tenant + model + period, keyed by
   *   `context[tenantKey]`. Every tenant's numbering starts at 1 (Shopify-
   *   style per-shop order numbers) and the write hot spot on the single
   *   shared counter document splits per tenant. Ids are unique WITHIN a
   *   tenant only — index the field compound with the tenant field.
   *   Fails closed: a create with no tenant in context throws rather than
   *   falling back to the global key, which would silently merge two
   *   tenants' sequences.
   */
  scope?: 'global' | 'tenant';
  /**
   * Context key carrying the tenant id under `scope: 'tenant'` (default:
   * `'organizationId'` — the same default as `multiTenantPlugin`'s
   * `contextKey`, so `repo.create(data, { organizationId })` feeds both).
   */
  tenantKey?: string;
  /**
   * Which clock decides the period boundary.
   *
   * - `'local'` (default) — the server's `TZ`. Kept as the default because it
   *   is what every existing deployment already generated: flipping it would
   *   retroactively change which period an id near a month boundary belongs
   *   to, and those ids are invoice and order numbers.
   * - `'utc'` — **the correct choice for more than one replica.** Two replicas
   *   with different `TZ` settings derive different counter keys for the same
   *   logical month and each increments its own, so the same number is issued
   *   twice inside one tenant-period. UTC is the one boundary every replica
   *   agrees on. It also matches the ecosystem's other period key,
   *   `usagePeriod()` in `@classytic/repo-core/usage`.
   *
   * Containers usually run UTC anyway, which is exactly why the difference
   * stays invisible until one host is configured otherwise.
   */
  timezone?: 'local' | 'utc';
  /**
   * IANA time zone whose civil calendar decides the period (e.g.
   * `'Asia/Riyadh'`). Wins over `timezone`. Read through Intl, so every
   * replica agrees on the boundary whatever its `TZ`, and DST never moves it.
   * Invalid zones throw when the generator is built.
   */
  timeZone?: string;
  /**
   * The instant whose civil date picks the period, e.g.
   * `(ctx) => ctx.data?.reportedAt` so a backdated record numbers in its own
   * period. `undefined` / `null` falls back to now; any other non-Date throws.
   * @default now
   */
  at?: (context: RepositoryContext) => Date | undefined | null;
  /**
   * Base counter key (the tenant id, under `scope: 'tenant'`, and the period
   * are appended). @default `model.modelName`
   */
  counterKey?: string;
  /**
   * Counter collection, same as `createSequenceCounter({ collection })`
   * (for hosts with a collection-naming rule). @default `'_mongokit_counters'`
   */
  counterCollection?: string;
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
 *
 * @example Per-tenant numbering in a shared database
 * ```typescript
 * customIdPlugin({
 *   field: 'orderNumber',
 *   generator: dateSequentialId({ prefix: 'ORD', model: OrderModel, scope: 'tenant' }),
 * })
 * // org-a: ORD-2026-02-0001, ORD-2026-02-0002 …   org-b: ORD-2026-02-0001 …
 * ```
 */
export function dateSequentialId(options: DateSequentialIdOptions): IdGenerator {
  const {
    prefix,
    model,
    partition = 'monthly',
    padding = 4,
    separator = '-',
    scope = 'global',
    tenantKey = 'organizationId',
    timezone = 'local',
    timeZone,
    at,
    counterKey: baseCounterKey,
    counterCollection,
  } = options;
  assertCounterCollection('dateSequentialId', counterCollection);
  // Fail at construction on a bad zone, not on the first create.
  if (timeZone !== undefined) civilFormatter('dateSequentialId', timeZone);
  if (
    baseCounterKey !== undefined &&
    (typeof baseCounterKey !== 'string' || baseCounterKey.length === 0)
  ) {
    throw new Error('dateSequentialId: counterKey must be a non-empty string');
  }

  /** Per-generator, not module-level — two generators warn independently. */
  const overflowWarned = new Set<string>();
  const paddingCeiling = 10 ** padding;

  return async (context: RepositoryContext): Promise<string> => {
    const picked = at?.(context);
    const now = picked ?? new Date();
    assertInstant('dateSequentialId', now);
    // The period boundary. `'local'` reads the SERVER's clock, so replicas
    // configured with different `TZ` values derive different counter keys for
    // the same logical month and each increments its own — two sequences, and
    // therefore repeated numbers, inside one tenant-period. `'utc'` and an
    // IANA `timeZone` are answers every replica agrees on regardless of host
    // configuration.
    let year: string;
    let month: string;
    let day: string;
    if (timeZone !== undefined) {
      ({ year, month, day } = civilParts('dateSequentialId', now, timeZone));
    } else {
      const utc = timezone === 'utc';
      year = String(utc ? now.getUTCFullYear() : now.getFullYear());
      month = String((utc ? now.getUTCMonth() : now.getMonth()) + 1).padStart(2, '0');
      day = String(utc ? now.getUTCDate() : now.getDate()).padStart(2, '0');
    }

    // Under `scope: 'tenant'` the tenant id becomes part of the counter key
    // so each tenant increments its own document. Fail closed on a missing
    // tenant — the global key is never a fallback (it would merge sequences).
    let keyBase = baseCounterKey ?? model.modelName;
    if (scope === 'tenant') {
      const tenantId = context[tenantKey];
      if (tenantId === undefined || tenantId === null || tenantId === '') {
        throw new Error(
          `[mongokit] dateSequentialId: scope 'tenant' requires '${tenantKey}' in context for '${model.modelName}' create, ` +
            `but none was provided. Pass it per call (repo.create(data, { ${tenantKey}: '<id>' })) or resolve it ambiently; ` +
            `the generator never falls back to the global counter.`,
        );
      }
      keyBase = `${keyBase}:${String(tenantId)}`;
    }

    let datePart: string;
    let counterKey: string;

    switch (partition) {
      case 'yearly':
        datePart = year;
        counterKey = `${keyBase}:${year}`;
        break;
      case 'daily':
        datePart = `${year}${separator}${month}${separator}${day}`;
        counterKey = `${keyBase}:${year}-${month}-${day}`;
        break;
      default:
        datePart = `${year}${separator}${month}`;
        counterKey = `${keyBase}:${year}-${month}`;
        break;
    }

    const seq = await incrementCounter(
      getCounterModel(
        context._counterConnection as mongoose.Connection | undefined,
        counterCollection,
      ),
      counterKey,
      1,
      context.session as mongoose.ClientSession | undefined,
    );
    // `padStart` never truncates, so crossing 10^padding grows a digit rather
    // than wrapping — ids stay unique, but they stop sorting lexically, and a
    // report ordering by this field silently starts interleaving. Say so once
    // per period rather than never (the deployment that outgrew its padding is
    // the one that will not notice).
    if (seq >= paddingCeiling && !overflowWarned.has(counterKey)) {
      overflowWarned.add(counterKey);
      warn(
        `[mongokit] dateSequentialId: '${model.modelName}' sequence ${seq} exceeds padding ${padding} ` +
          `(max ${paddingCeiling - 1}) for period '${counterKey}'. Ids remain unique but no longer sort ` +
          `lexically — raise \`padding\` for new periods, or use a finer \`partition\`.`,
      );
    }
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
