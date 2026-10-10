/**
 * Query defaults — the time bound and read/write concerns every repository command carries.
 *
 * Resolution, per option: per call → repository (`RepositoryOptions.queryDefaults` /
 * `aggregateDefaults`) → deployment (`configureQueryDefaults` / `configureAggregateDefaults`).
 * An explicit value always wins (FL1). For an aggregation the aggregate chain is consulted before
 * the generic query chain, because it is the more specific instruction.
 *
 * `maxTimeMS` and `comment` go to the commands Mongoose itself bounds with its global `maxTimeMS`
 * (find, findOne, countDocuments, distinct, findOneAndUpdate, aggregate:
 * lib/query.js:2465,2812,2905,3074,3610; lib/aggregate.js:1106). Writes get `writeConcern`. The
 * connection's CSOT `timeoutMS` bounds everything else; {@link assertQueryDefaultsConfigured}
 * checks both at boot. Inside a transaction a DEFAULT read/write concern or read preference is
 * dropped (the transaction owns them); a per-call one is passed and the driver judges it.
 */

import type { Aggregate, Connection, Query } from 'mongoose';
import type { ReadPreferenceType } from '../types/core.js';
import { createError } from '../utils/error.js';

export type ReadConcernLevel = 'local' | 'available' | 'majority' | 'linearizable' | 'snapshot';

export interface WriteConcernSpec {
  w?: number | 'majority';
  j?: boolean;
  wtimeoutMS?: number;
}

/** Defaults for every repository command. */
export interface QueryDefaults {
  maxTimeMS?: number;
  readPreference?: ReadPreferenceType;
  readConcern?: ReadConcernLevel;
  writeConcern?: WriteConcernSpec;
  /** Profiler / log tag. */
  comment?: string;
}

/** Defaults for aggregations only; consulted before {@link QueryDefaults}. */
export interface AggregateDefaults {
  maxTimeMs?: number;
  allowDiskUse?: boolean;
}

/** What one call may pass. Every field beats every default. */
export interface PerCallQueryOptions {
  maxTimeMS?: number;
  readPreference?: ReadPreferenceType;
  readConcern?: ReadConcernLevel;
  writeConcern?: WriteConcernSpec;
  comment?: string;
  hint?: string | Record<string, 1 | -1>;
  allowDiskUse?: boolean;
  session?: unknown;
}

/** The options a command is executed with, after resolution. */
export interface ResolvedQueryOptions {
  maxTimeMS?: number;
  readPreference?: ReadPreferenceType;
  readConcern?: ReadConcernLevel;
  writeConcern?: WriteConcernSpec;
  comment?: string;
  hint?: string | Record<string, 1 | -1>;
  allowDiskUse?: boolean;
}

export type CommandKind = 'read' | 'aggregate' | 'write' | 'findAndModify';

interface Policy {
  query: QueryDefaults;
  aggregate: AggregateDefaults;
}

/** On `globalThis`, for the reason `pagination/defaults.ts` gives: a duplicated install must share it. */
const POLICY_SLOT = Symbol.for('classytic.mongokit.queryDefaults');

function policy(): Policy {
  const holder = globalThis as { [POLICY_SLOT]?: Policy };
  holder[POLICY_SLOT] ??= { query: {}, aggregate: {} };
  return holder[POLICY_SLOT];
}

function defined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function assertPositive(name: string, value: number | undefined): void {
  if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
    throw new TypeError(`[mongokit] ${name} must be a positive number of milliseconds, got ${value}`);
  }
}

/** Set the deployment's query defaults. Merges; an explicit `undefined` changes nothing. */
export function configureQueryDefaults(defaults: QueryDefaults): void {
  assertPositive('queryDefaults.maxTimeMS', defaults.maxTimeMS);
  Object.assign(policy().query, defined(defaults));
}

/** Set the deployment's aggregation defaults. Merges; an explicit `undefined` changes nothing. */
export function configureAggregateDefaults(defaults: AggregateDefaults): void {
  assertPositive('aggregateDefaults.maxTimeMs', defaults.maxTimeMs);
  Object.assign(policy().aggregate, defined(defaults));
}

/** A copy of the deployment defaults. */
export function getQueryDefaults(): { query: QueryDefaults; aggregate: AggregateDefaults } {
  const p = policy();
  return { query: { ...p.query }, aggregate: { ...p.aggregate } };
}

/** Back to no deployment defaults. For tests. */
export function resetQueryDefaults(): void {
  const holder = globalThis as { [POLICY_SLOT]?: Policy };
  holder[POLICY_SLOT] = { query: {}, aggregate: {} };
}

/**
 * Boot check (M7): throws unless the deployment sets a query `maxTimeMS`, and — when a connection
 * is passed — unless its client carries a CSOT `timeoutMS`. Returns what it verified.
 */
export function assertQueryDefaultsConfigured(connection?: Connection): {
  maxTimeMS: number;
  timeoutMS?: number;
} {
  const maxTimeMS = policy().query.maxTimeMS;
  if (maxTimeMS === undefined) {
    throw createError(
      500,
      '[mongokit] no deployment query time bound: call configureQueryDefaults({ maxTimeMS }) at boot',
      { code: QUERY_DEFAULTS_ERROR_CODES.NOT_CONFIGURED, meta: { missing: 'maxTimeMS' } },
    );
  }
  if (!connection) return { maxTimeMS };
  const timeoutMS = (connection.getClient().options as { timeoutMS?: number }).timeoutMS;
  if (!(typeof timeoutMS === 'number' && timeoutMS > 0)) {
    throw createError(
      500,
      '[mongokit] the connection has no CSOT timeoutMS: pass { timeoutMS } to mongoose.connect()',
      { code: QUERY_DEFAULTS_ERROR_CODES.NOT_CONFIGURED, meta: { missing: 'timeoutMS' } },
    );
  }
  return { maxTimeMS, timeoutMS };
}

export const QUERY_DEFAULTS_ERROR_CODES = {
  NOT_CONFIGURED: 'mongokit.query_defaults.not_configured',
} as const;

function inTransaction(session: unknown): boolean {
  const s = session as { inTransaction?: () => boolean } | null | undefined;
  return typeof s?.inTransaction === 'function' && s.inTransaction();
}

/** Resolve the options one command runs with. `repo` is the repository's own defaults. */
export function resolveQueryOptions(
  kind: CommandKind,
  perCall: PerCallQueryOptions,
  repo: { query?: QueryDefaults; aggregate?: AggregateDefaults } = {},
): ResolvedQueryOptions {
  const deployment = policy();
  const q = { ...deployment.query, ...defined(repo.query ?? {}) };
  const agg = { ...deployment.aggregate, ...defined(repo.aggregate ?? {}) };
  const tx = inTransaction(perCall.session);
  const out: ResolvedQueryOptions = {};

  if (kind !== 'write') {
    const bound =
      perCall.maxTimeMS ??
      (kind === 'aggregate' ? (repo.aggregate?.maxTimeMs ?? deployment.aggregate.maxTimeMs) : undefined) ??
      q.maxTimeMS;
    if (bound !== undefined) out.maxTimeMS = bound;
    const comment = perCall.comment ?? q.comment;
    if (comment !== undefined) out.comment = comment;
    if (perCall.hint !== undefined) out.hint = perCall.hint;
  }
  if (kind === 'read' || kind === 'aggregate') {
    const pref = perCall.readPreference ?? (tx ? undefined : q.readPreference);
    if (pref !== undefined) out.readPreference = pref;
    const concern = perCall.readConcern ?? (tx ? undefined : q.readConcern);
    if (concern !== undefined) out.readConcern = concern;
  }
  if (kind === 'aggregate') {
    const disk = perCall.allowDiskUse ?? agg.allowDiskUse;
    if (disk !== undefined) out.allowDiskUse = disk;
  }
  if (kind === 'write' || kind === 'findAndModify') {
    const wc = perCall.writeConcern ?? (tx ? undefined : q.writeConcern);
    if (wc !== undefined) out.writeConcern = wc;
  }
  return out;
}

const READ_PREFERENCE_MODES = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
] as const;
type ReadPreferenceMode = (typeof READ_PREFERENCE_MODES)[number];

function isReadPreferenceMode(value: string): value is ReadPreferenceMode {
  return (READ_PREFERENCE_MODES as readonly string[]).includes(value);
}

/** A read preference outside the driver's modes is refused, never passed through (FL2). */
function readPreferenceMode(value: ReadPreferenceType): ReadPreferenceMode {
  if (isReadPreferenceMode(value)) return value;
  throw new TypeError(`[mongokit] unknown readPreference '${value}'; expected one of ${READ_PREFERENCE_MODES.join(', ')}`);
}

/** Apply resolved options to a mongoose Query. */
// biome-ignore lint/suspicious/noExplicitAny: any query result / doc type.
export function applyToQuery(query: Query<any, any>, o: ResolvedQueryOptions): void {
  if (o.maxTimeMS !== undefined) query.maxTimeMS(o.maxTimeMS);
  if (o.comment !== undefined) query.setOptions({ comment: o.comment });
  if (o.readPreference !== undefined) query.read(readPreferenceMode(o.readPreference));
  if (o.readConcern !== undefined) query.readConcern(o.readConcern);
  if (o.writeConcern !== undefined) query.setOptions({ writeConcern: o.writeConcern });
  if (o.hint !== undefined) query.hint(o.hint);
}

/** Apply resolved options to a mongoose Aggregate. */
// biome-ignore lint/suspicious/noExplicitAny: any aggregate row type.
export function applyToAggregate(aggregation: Aggregate<any>, o: ResolvedQueryOptions): void {
  if (o.maxTimeMS !== undefined) aggregation.option({ maxTimeMS: o.maxTimeMS });
  if (o.comment !== undefined) aggregation.option({ comment: o.comment });
  if (o.readPreference !== undefined) aggregation.read(readPreferenceMode(o.readPreference));
  if (o.readConcern !== undefined) aggregation.readConcern(o.readConcern);
  if (o.allowDiskUse !== undefined) aggregation.allowDiskUse(o.allowDiskUse);
  if (o.hint !== undefined) aggregation.hint(o.hint);
}
