/**
 * Pagination types — config, per-mode options, cursor wire format, and the
 * minimal parsed-query shape Repository.getAll consumes.
 *
 * Pagination RESULT shapes are owned by `@classytic/repo-core/pagination`
 * (see CHANGELOG 3.12.0) — mongokit declares no envelope of its own, only the
 * `TExtra` payload repo-core reserves for a kit ({@link MongokitPageExtras}).
 */

import type { PipelineStage } from 'mongoose';
import type { CursorSecret } from '../pagination/utils/cursor-signing.js';
import type { ReadConcernLevel, ResolvedQueryOptions } from '../repository/query-defaults.js';
import type {
  AnyDocument,
  FilterQuery,
  ObjectId,
  PopulateSpec,
  ReadPreferenceType,
  SelectSpec,
  SortSpec,
} from './core.js';

export type { CursorSecret };

/**
 * How an offset page learns how many rows sit behind it.
 *
 * | | cost | `total` reports |
 * |---|---|---|
 * | `exact` | O(matching index keys) — the whole range, every page | the truth |
 * | `estimated` | O(1) collection metadata, but IGNORES filters, so it falls back to `exact` whenever any filter is present | the truth, or the collection size |
 * | `capped` | O(countLimit) — the scan stops at the ceiling | the truth below the ceiling, else the ceiling, with `totalIsLowerBound: true` |
 * | `none` | free — `limit + 1` is fetched instead | `0` |
 *
 * `exact` is the default and is right until a filter matches enough rows for
 * the count to outgrow the find it runs beside. Past that it is the dominant
 * cost of a page the user reads fifteen rows of, and it is paid again on every
 * page.
 *
 * `capped` is what a product ships instead: the row count a list header shows
 * is only actionable while it is small, so bound the work and say `10,000+`
 * above the bound. Elasticsearch (`track_total_hits`), Odoo (`search_count`'s
 * limit) and GitHub's `1000+` are all this strategy.
 *
 * Declared ONCE and referenced everywhere — this union was hand-copied to eight
 * declarations, which is how the aggregate variant silently lost a member.
 */
/**
 * `cached`: the capped count memoised per (collection, filter, collation, hint) for
 * `countCacheTtlMs`; never inside a transaction (it would publish uncommitted rows).
 */
export type CountStrategy = 'exact' | 'estimated' | 'capped' | 'none' | 'cached';

/**
 * What mongokit adds to repo-core's offset envelope, via its reserved `TExtra`
 * slot: `OffsetPaginationResult<TDoc, MongokitPageExtras>`.
 *
 * Both members are optional and absent on an ordinary page, so every existing
 * consumer of `OffsetPaginationResult<TDoc>` stays assignable.
 *
 * A `type` and not an `interface`: repo-core constrains `TExtra` to
 * `Record<string, unknown>`, and an interface has no implicit index signature.
 */
export type MongokitPageExtras = {
  /** Deep-page or clamped-limit advice. Human-readable; never branch on it. */
  warning?: string;
  /**
   * `total` is not an exact count of the rows matching right now: a capped count at its
   * ceiling (a floor — render `10,000+`), an estimate, a memoised (`cached`) count, or no count
   * (`none`). Never derive a last-page number or a percentage from a total carrying it.
   */
  totalIsEstimate: boolean;
  /** When `total` was counted; `null` when nothing was counted (`none`). */
  countedAt: Date | null;
};

/** Pagination configuration */
export interface PaginationConfig {
  /** Default number of documents per page (default: 10) */
  defaultLimit?: number;
  /** Maximum allowed limit (default: 100) */
  maxLimit?: number;
  /** Maximum allowed page number (default: 10000) */
  maxPage?: number;
  /**
   * Deepest `skip` an offset page may ask for (default 100,000). Past it the call is refused
   * with `mongokit.pagination.offset_too_deep` (400): walk with keyset (`after`) instead.
   */
  maxOffset?: number;
  /** Freshness window of `countStrategy: 'cached'` (default 30,000 ms). */
  countCacheTtlMs?: number;
  /** Page number that triggers performance warning (default: 100) */
  deepPageThreshold?: number;
  /** Cursor version for forward compatibility (default: 1) */
  cursorVersion?: number;
  /**
   * Minimum cursor version accepted. Bump alongside `cursorVersion` when a
   * breaking format change ships so stale client cursors are rejected with a
   * clear error instead of silently paginating from the wrong position.
   * Default: 1 (accept any cursor <= cursorVersion).
   */
  minCursorVersion?: number;
  /**
   * Allowlist of primary sort fields for keyset pagination. When set, any
   * `getAll({ sort })` whose primary (non-_id) field is not in this list
   * throws at validation time.
   *
   * Use this to lock down keyset pagination to fields that are structurally
   * guaranteed non-null in your schema — keyset sort across null/non-null
   * boundaries is lossy (MongoDB's `$lt/$gt` semantics leave a gap at the
   * type boundary, so not every doc is reachable).
   *
   * `_id` is always allowed regardless of this list.
   * Undefined (default) = no allowlist, any sort field accepted.
   */
  strictKeysetSortFields?: string[];
  /** Use estimatedDocumentCount for faster counts on large collections */
  useEstimatedCount?: boolean;
  /**
   * Repo-wide `countStrategy` for `getAll` / `lookupPopulate` /
   * `aggregatePaginate` calls that don't set their own (default: 'exact' —
   * a `countDocuments` round-trip per page). `'none'` suits list endpoints
   * that only need `hasNext`: one query per page, `total` / `pages` report
   * 0. A per-call `countStrategy` always wins.
   */
  defaultCountStrategy?: CountStrategy;
  /**
   * Ceiling for `countStrategy: 'capped'` when a call names none. Default 10000.
   * See {@link OffsetPaginationOptions.countLimit}.
   */
  defaultCountLimit?: number;
  /**
   * HMAC key for cursor tokens. Absent (default) = cursors are unsigned, as
   * before. A list rotates keys: the FIRST signs, all of them verify.
   *
   * Signing stops a caller EDITING a cursor to move the position — re-submit a
   * tampered sort value and the response says whether any row sorts past it,
   * which is a binary search over a column the caller may never read. It does
   * NOT hide the token's contents: the payload stays readable base64url JSON.
   * Integrity, not confidentiality.
   *
   * **Switching it on is a cutover.** Cursors already in flight carry no
   * signature and will be refused — the client restarts from page one. That is
   * deliberate: a "tolerate unsigned during rollout" flag is a permanent
   * downgrade switch, and stripping the signature is the first thing an
   * attacker tries.
   *
   * A key under 16 characters throws rather than being accepted, because an
   * unset environment variable reads as `''` and would otherwise mean "signing
   * on, key guessable" with nothing to say so.
   */
  cursorSecret?: CursorSecret;
  /**
   * Repo-wide pagination mode for a `getAll` call that carries no explicit
   * `mode`, no `page` and no cursor (`after`) — the plain
   * `getAll({ filters })` case, which otherwise picks offset (or keyset
   * only when a non-default sort is given). `'keyset'` makes those calls
   * cursor-paginated: no `skip`, O(1) deep pages. Explicit per-call
   * signals still win — `page` → offset, `after` → keyset, `mode` → as
   * given. Default: undefined (the sort-based auto-detection above).
   */
  defaultMode?: 'offset' | 'keyset';
}

/** MongoDB collation options for locale-aware string comparison */
export interface CollationOptions {
  locale: string;
  caseLevel?: boolean;
  caseFirst?: 'upper' | 'lower' | 'off';
  strength?: 1 | 2 | 3 | 4 | 5;
  numericOrdering?: boolean;
  alternate?: 'non-ignorable' | 'shifted';
  maxVariable?: 'punct' | 'space';
  backwards?: boolean;
}

/** Base pagination options */
export interface BasePaginationOptions {
  /** Pagination mode (explicit override) */
  mode?: 'offset' | 'keyset';
  /** MongoDB query filters */
  filters?: FilterQuery<AnyDocument>;
  /** Sort specification */
  sort?: SortSpec;
  /** Number of documents per page */
  limit?: number;
  /** Fields to select */
  select?: SelectSpec;
  /** Fields to populate */
  populate?: PopulateSpec;
  /** Return plain JavaScript objects */
  lean?: boolean;
  /** MongoDB session for transactions */
  session?: unknown;
  /** Query hint (index name or document) */
  hint?: string | Record<string, 1 | -1>;
  /** Maximum execution time in milliseconds */
  maxTimeMS?: number;
  /** Read preference for replica sets (e.g. 'secondaryPreferred') */
  readPreference?: ReadPreferenceType;
  readConcern?: ReadConcernLevel;
  comment?: string;
  /**
   * Already-resolved time bound and concerns (the Repository passes these, defaults folded in).
   * When absent the engine resolves the per-call fields above against the deployment defaults.
   */
  queryOptions?: ResolvedQueryOptions;
  /** Collation for locale-aware string comparison and case-insensitive sorting */
  collation?: CollationOptions;
}

/** Offset pagination options */
export interface OffsetPaginationOptions extends BasePaginationOptions {
  /** Page number (1-indexed) */
  page?: number;
  /** Count strategy for filtered queries (default: 'exact'). See {@link CountStrategy}. */
  countStrategy?: CountStrategy;
  /**
   * Ceiling for `countStrategy: 'capped'` (default: the repository's
   * `defaultCountLimit`, else 10000). Ignored by every other strategy.
   *
   * A `total` that comes back EQUAL to this is a lower bound, not a count —
   * `totalIsLowerBound` on the result says so, because `total === countLimit`
   * is also what an exactly-full collection legitimately returns and the two
   * are otherwise indistinguishable.
   */
  countLimit?: number;
  /**
   * Optional alternate filter used for the count query only. The primary
   * `filters` is still used for `.find()`. Lets callers (Repository) run a
   * sort-only query like `$near` for results while counting with a
   * count-compatible rewrite (e.g. `$geoWithin: $centerSphere`) that
   * returns the same document set but works with `countDocuments`.
   */
  countFilters?: FilterQuery<AnyDocument>;
}

/** Keyset (cursor) pagination options */
export interface KeysetPaginationOptions extends BasePaginationOptions {
  /** Cursor token for next page */
  after?: string;
  /**
   * Cursor token for the PREVIOUS page — the page ending just before this
   * position. Mutually exclusive with `after`; passing both throws.
   *
   * Feed back the `prev` from a result. Rows come back in the sort order you
   * asked for, not reversed: the query runs inverted internally and the page
   * is turned back around before it is returned.
   */
  before?: string;
  /** Sort is required for keyset pagination */
  sort: SortSpec;
}

/** Aggregate pagination options */
export interface AggregatePaginationOptions {
  /** Aggregation pipeline stages */
  pipeline?: PipelineStage[];
  /** Page number (1-indexed) */
  page?: number;
  /** Number of documents per page */
  limit?: number;
  /** MongoDB session for transactions */
  session?: unknown;
  /** Query hint (index name or document) for aggregation */
  hint?: string | Record<string, 1 | -1>;
  /** Maximum execution time in milliseconds */
  maxTimeMS?: number;
  /** Count strategy (default: 'exact' via $facet).
   * 'estimated' is accepted but treated as 'exact' in aggregation context
   * since estimatedDocumentCount is not available inside pipelines.
   * 'capped' bounds the count facet with a `$limit` — see {@link CountStrategy}. */
  countStrategy?: CountStrategy;
  /** Ceiling for `countStrategy: 'capped'`. See {@link OffsetPaginationOptions.countLimit}. */
  countLimit?: number;
  /**
   * Let `$sort` / `$group` spill to disk past the server's 100MB per-stage
   * memory limit. Off by default — spilling hides a missing index behind a
   * slow success, and on MongoDB >= 6.0 the server's own
   * `allowDiskUseByDefault` already decides this when a caller says nothing.
   */
  allowDiskUse?: boolean;
  /** Pagination mode (reserved for API consistency) */
  mode?: 'offset';
  /** Read preference for replica sets (e.g. 'secondaryPreferred') */
  readPreference?: ReadPreferenceType;
  readConcern?: ReadConcernLevel;
  comment?: string;
  /** Collections the caller asserts are company-wide (see `join-scope.ts`). */
  unscopedJoins?: readonly string[];
  /**
   * The caller states the pipeline's last `$sort` is a TOTAL order (unique per output row), so the
   * not-provably-total warning is silenced. Only for a sort total by domain knowledge.
   */
  sortIsTotal?: boolean;
  /** Already-resolved options; see {@link BasePaginationOptions.queryOptions}. */
  queryOptions?: ResolvedQueryOptions;
}

/** Value type identifier for cursor serialization */
export type ValueType =
  | 'date'
  | 'objectid'
  | 'decimal'
  | 'boolean'
  | 'number'
  | 'string'
  | 'null'
  | 'unknown';

/** Cursor payload */
export interface CursorPayload {
  /** Primary sort field value (legacy single-field) */
  v: string | number | boolean | null;
  /** Value type identifier (legacy single-field) */
  t: ValueType;
  /** Document ID */
  id: string;
  /** ID type identifier */
  idType: ValueType;
  /** Sort specification */
  sort: SortSpec;
  /** Cursor version */
  ver: number;
  /** Compound sort field values (multi-field keyset) */
  vals?: Record<string, string | number | boolean | null>;
  /** Compound sort value types */
  types?: Record<string, ValueType>;
  /** Scope fingerprint: collection + post-policy filter + collation (see `utils/guards.ts`). */
  fp: string;
}

/** Decoded cursor */
export interface DecodedCursor {
  /** Primary sort field value (rehydrated) — legacy compat */
  value: unknown;
  /** Document ID (rehydrated) */
  id: ObjectId | string;
  /** Sort specification */
  sort: SortSpec;
  /** Cursor version */
  version: number;
  /** All sort field values (rehydrated) — for compound sort */
  values?: Record<string, unknown>;
  /** Scope fingerprint the cursor was minted under. */
  scope: string;
}
