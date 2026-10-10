/**
 * Pagination Engine
 *
 * Production-grade pagination for MongoDB with support for:
 * - Offset pagination (page-based) - Best for small datasets, random page access
 * - Keyset pagination (cursor-based) - Best for large datasets, infinite scroll
 * - Aggregate pagination - Best for complex queries requiring aggregation
 *
 * @example
 * ```typescript
 * const engine = new PaginationEngine(UserModel, {
 *   defaultLimit: 20,
 *   maxLimit: 100,
 *   useEstimatedCount: true
 * });
 *
 * // Offset pagination
 * const page1 = await engine.paginate({ page: 1, limit: 20 });
 *
 * // Keyset pagination (better for large datasets)
 * const stream1 = await engine.stream({ sort: { createdAt: -1 }, limit: 20 });
 * const stream2 = await engine.stream({ sort: { createdAt: -1 }, after: stream1.next });
 * ```
 */

import type {
  AggregatePaginationResult,
  KeysetPaginationResult,
  OffsetPaginationResult,
} from '@classytic/repo-core/pagination';
import { createTtlMemo, type TtlMemo } from '@classytic/repo-core/cache';
import type { ClientSession, Model } from 'mongoose';
import type { AnyDocument, SortSpec } from '../types/core.js';
import type {
  AggregatePaginationOptions,
  CountStrategy,
  CursorSecret,
  KeysetPaginationOptions,
  MongokitPageExtras,
  OffsetPaginationOptions,
  PaginationConfig,
} from '../types/pagination.js';
import { applyToAggregate, applyToQuery, resolveQueryOptions } from '../repository/query-defaults.js';
import { createError } from '../utils/error.js';
import { assertOffsetWithinCap, cursorScope, withIdTiebreak } from './utils/guards.js';
import { warn } from '../utils/logger.js';
import { bindPaginationDefaults } from './defaults.js';
import { encodeCursor, resolveCursorFilter } from './utils/cursor.js';
import {
  classifyFilterFields,
  hasCompatibleKeysetIndex,
  readSchemaIndexes,
  recommendKeysetIndex,
  type SchemaIndexTuple,
} from './utils/index-hint.js';
import {
  calculateSkip,
  calculateTotalPages,
  shouldWarnDeepPagination,
  validateLimit,
  validatePage,
} from './utils/limits.js';
import { getPrimaryField, invertSort, validateKeysetSort } from './utils/sort.js';

/**
 * The sort fields a reader cares about, for MESSAGES only — never for deciding
 * whether an index is adequate.
 *
 * `_id` is appended to every keyset sort as the tiebreaker, and naming it in
 * the "sort [...]" half of a warning is noise, since the caller never wrote it.
 * Naming it in the RECOMMENDED INDEX is mandatory, which is why that half uses
 * the full sort.
 *
 * This used to strip `_id` before the compatibility CHECK too, on the stated
 * grounds that "an index covering the primary sort is still efficient — the
 * planner uses the index for ordering and only pays an in-memory tiebreak on
 * duplicate primary values". That is false, and measurably so: against 20k rows
 * with heavy ties on the sort field, an index without `_id` produced a BLOCKING
 * `SORT` stage examining all 20,000 documents to return 20, where the same
 * index with `_id` examined exactly 20. Not a tiebreak — a full sort of the
 * matching range, on every page. `tests/integration/keyset-index-explain.test.ts`
 * pins it with a real `explain('executionStats')`.
 */
function sortFieldsForMessage(sort: Record<string, 1 | -1>): string[] {
  return Object.keys(sort).filter((k) => k !== '_id');
}

function ensureKeysetSelectIncludesCursorFields(
  select: string | readonly string[] | Record<string, 0 | 1> | undefined,
  sort: Record<string, 1 | -1>,
): string | readonly string[] | Record<string, 0 | 1> | undefined {
  if (!select) return select;

  const requiredFields = new Set<string>([...Object.keys(sort), '_id']);

  if (typeof select === 'string') {
    const fields = select
      .split(/[,\s]+/)
      .map((field) => field.trim())
      .filter(Boolean);
    const isExclusion = fields.length > 0 && fields.every((field) => field.startsWith('-'));
    if (isExclusion) return select;

    const merged = new Set(fields);
    for (const field of requiredFields) {
      merged.add(field);
    }
    return Array.from(merged).join(' ');
  }

  if (Array.isArray(select)) {
    const fields = select.map((field) => field.trim()).filter(Boolean);
    const isExclusion = fields.length > 0 && fields.every((field) => field.startsWith('-'));
    if (isExclusion) return select;

    const merged = new Set(fields);
    for (const field of requiredFields) {
      merged.add(field);
    }
    return Array.from(merged);
  }

  // After the string + Array.isArray branches above, `select` is the
  // Record form. `Array.isArray` does not narrow `readonly string[]` out
  // of the union (its predicate is `x is any[]`), so the manual cast
  // restores the correct shape without a runtime check.
  const record = select as Record<string, 0 | 1>;
  const projection: Record<string, 0 | 1> = { ...record };
  const isInclusion = Object.values(projection).some((value) => value === 1);
  if (!isInclusion) return select;

  for (const field of requiredFields) {
    projection[field] = 1;
  }

  return projection;
}

/**
 * Internal pagination config with required values
 */
interface ResolvedPaginationConfig {
  defaultLimit: number;
  maxLimit: number;
  maxPage: number;
  deepPageThreshold: number;
  cursorVersion: number;
  minCursorVersion: number;
  strictKeysetSortFields: string[] | undefined;
  useEstimatedCount: boolean;
  defaultCountStrategy: CountStrategy;
  defaultCountLimit: number;
  cursorSecret: CursorSecret | undefined;
  defaultMode: 'offset' | 'keyset' | undefined;
  maxOffset: number;
  countCacheTtlMs: number;
}

/** The library's ceiling when a deployment names none. GitHub shows `1000+`; Elasticsearch stops at 10000. */
const DEFAULT_COUNT_LIMIT = 10_000;

/**
 * A count ceiling must be a positive whole number.
 *
 * `0`, a negative, a fraction and `NaN` all reach `.limit()` as "no limit" in
 * one driver path or another — so an operator who set `COUNT_LIMIT=0` meaning
 * "never count" would instead get the unbounded scan the strategy exists to
 * prevent, and nothing would say so. Fall back to the library's own ceiling
 * rather than honouring a value that cannot mean what it says.
 */
function resolveCountLimit(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : DEFAULT_COUNT_LIMIT;
}

/**
 * Production-grade pagination engine for MongoDB
 * Supports offset, keyset (cursor), and aggregate pagination
 */
interface CountMemoKey {
  key: string;
  run: () => Promise<number>;
}

export class PaginationEngine<TDoc = AnyDocument> {
  public readonly Model: Model<TDoc>;
  public readonly config: ResolvedPaginationConfig;
  /**
   * Lazily-cached schema index snapshot used by stream() to decide whether
   * to emit the "missing compound index" warning. Computed on first use.
   */
  private _cachedSchemaIndexes: SchemaIndexTuple[] | null = null;

  /**
   * Create a new pagination engine
   *
   * @param Model - Mongoose model to paginate
   * @param config - Pagination configuration
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /** Memoised capped counts for `countStrategy: 'cached'`, rebuilt when the TTL changes. */
  private _memo: { ttl: number; memo: TtlMemo<CountMemoKey, { total: number; countedAt: Date }> } | undefined;

  /** The `cached` count memo (repo-core `createTtlMemo`: single flight, a failed count caches nothing). */
  _countMemo(): TtlMemo<CountMemoKey, { total: number; countedAt: Date }> {
    const ttl = this.config.countCacheTtlMs;
    if (!this._memo || this._memo.ttl !== ttl) {
      this._memo = {
        ttl,
        memo: createTtlMemo(async (k: CountMemoKey) => ({ total: await k.run(), countedAt: new Date() }), {
          ttlMs: ttl,
          keyOf: (k) => k.key,
        }),
      };
    }
    return this._memo.memo;
  }

  constructor(Model: Model<TDoc, any, any, any>, config: PaginationConfig = {}) {
    this.Model = Model as Model<TDoc>;
    /**
     * `defaultCountStrategy`, `defaultCountLimit`, `defaultMode` and `maxPage`
     * are NOT resolved
     * here — `bindPaginationDefaults` installs them as getters that fall back
     * to the deployment policy (`configurePaginationDefaults`). A kernel-built
     * repository passes no config at all, so without that seam a host has no
     * way to say "this deployment does not count rows" and inherits an
     * O(matching rows) `countDocuments` on every page. Reading them through
     * `this.config.*` is unchanged for every call site.
     */
    this.config = bindPaginationDefaults(
      {
        defaultLimit: config.defaultLimit ?? 10,
        maxLimit: config.maxLimit ?? 100,
        deepPageThreshold: config.deepPageThreshold ?? 100,
        cursorVersion: config.cursorVersion ?? 1,
        minCursorVersion: config.minCursorVersion ?? 1,
        strictKeysetSortFields: config.strictKeysetSortFields,
        useEstimatedCount: config.useEstimatedCount ?? false,
      } as ResolvedPaginationConfig,
      config,
    );
  }

  /** Memoized schema index lookup — avoids re-walking schema on every stream(). */
  private _getSchemaIndexes(): SchemaIndexTuple[] {
    if (this._cachedSchemaIndexes !== null) return this._cachedSchemaIndexes;
    this._cachedSchemaIndexes = readSchemaIndexes(this.Model as unknown as Model<unknown>);
    return this._cachedSchemaIndexes;
  }

  /**
   * Offset-based pagination using skip/limit
   * Best for small datasets and when users need random page access
   * O(n) performance - slower for deep pages
   *
   * @param options - Pagination options
   * @returns Pagination result with total count
   *
   * @example
   * const result = await engine.paginate({
   *   filters: { status: 'active' },
   *   sort: { createdAt: -1 },
   *   page: 1,
   *   limit: 20
   * });
   * console.log(result.data, result.total, result.hasNext);
   */
  async paginate(
    options: OffsetPaginationOptions = {},
  ): Promise<OffsetPaginationResult<TDoc, MongokitPageExtras>> {
    const {
      filters = {},
      // No default sort here — callers (Repository) decide. When sort is
      // explicitly undefined, we skip `.sort()` entirely so MongoDB can apply
      // the implicit ordering required by `$near` / `$nearSphere`. Callers
      // that want a stable default sort should pass it explicitly (Repository
      // defaults to `-createdAt` for non-geo queries before reaching here).
      sort,
      countFilters,
      page = 1,
      limit = this.config.defaultLimit,
      select,
      populate = [],
      lean = true,
      session,
      hint,
      countStrategy = this.config.defaultCountStrategy,
      countLimit = this.config.defaultCountLimit,
      collation,
    } = options;
    const qo = options.queryOptions ?? resolveQueryOptions('read', options);

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);
    assertOffsetWithinCap(skip, this.config.maxOffset);

    // limit+1 answers hasNext for every strategy; a count never decides it.
    let query = this.Model.find(filters as Record<string, unknown>);
    if (select) query = query.select(select);
    if (populate && (Array.isArray(populate) ? populate.length : populate)) {
      // Support string, string[], PopulateOptions, or PopulateOptions[]
      query = query.populate(populate as Parameters<typeof query.populate>[0]);
    }
    // No sort for `$near` (the server's implicit distance order forbids one); otherwise the
    // caller's sort plus a unique `_id` tiebreaker, so pages partition the rows.
    if (sort) query = query.sort(withIdTiebreak(sort));
    query = query.skip(skip).limit(sanitizedLimit + 1).lean(lean);
    if (collation) query = query.collation(collation);
    if (session) query = query.session(session as ClientSession);
    if (hint) query = query.hint(hint);
    applyToQuery(query, qo);

    const countTarget = (countFilters ?? filters) as Record<string, unknown>;
    const hasFilters = Object.keys(countTarget).length > 0;
    const ceiling = resolveCountLimit(countLimit);
    const countQuery = (bounded: boolean) => {
      const q = this.Model.countDocuments(countTarget).session((session ?? null) as ClientSession | null);
      if (bounded) q.limit(ceiling);
      // The count sees the SAME result set as the rows (collation, hint, bound, concerns).
      if (collation) q.collation(collation);
      if (hint) q.hint(hint);
      applyToQuery(q, qo);
      return q.exec();
    };

    // A THUNK, not a started promise: inside a transaction the count must wait for the find.
    let runCount: () => Promise<{ total: number; totalIsEstimate: boolean; countedAt: Date | null }>;
    const at = (total: number, totalIsEstimate: boolean) => ({ total, totalIsEstimate, countedAt: new Date() });
    // estimatedDocumentCount ignores filters and cannot run in a transaction.
    if ((countStrategy === 'estimated' || this.config.useEstimatedCount) && !hasFilters && !session) {
      runCount = async () => at(await this.Model.estimatedDocumentCount(), true);
    } else if (countStrategy === 'none') {
      runCount = async () => ({ total: 0, totalIsEstimate: true, countedAt: null });
    } else if (countStrategy === 'capped' || (countStrategy === 'cached' && session)) {
      // `.limit(n)` on a count is the server's own ceiling: O(n), exact below it.
      runCount = async () => {
        const total = await countQuery(true);
        return at(total, total >= ceiling);
      };
    } else if (countStrategy === 'cached') {
      const key = cursorScope(this.Model.collection.collectionName, [countTarget, ceiling, hint ?? null], collation);
      runCount = async () => ({ ...(await this._countMemo().get({ key, run: () => countQuery(true) })), totalIsEstimate: true });
    } else {
      runCount = async () => at(await countQuery(false), false);
    }

    // Parallel for throughput — except inside a transaction, which MongoDB does not let two
    // operations share at once.
    const [data, counted] = session
      ? [await query.exec(), await runCount()]
      : await Promise.all([query.exec(), runCount()]);
    const { total, totalIsEstimate, countedAt } = counted;

    const totalPages = countStrategy === 'none' ? 0 : calculateTotalPages(total, sanitizedLimit);
    const hasNext = data.length > sanitizedLimit;
    if (hasNext) data.pop();

    /**
     * A CLAMPED limit is reported, not swallowed.
     *
     * `validateLimit` caps silently by design — an over-ask is benign and rejecting it
     * would be worse (that contradiction cost a day: the querystring schema's `maximum`
     * made the parser's documented clamp unreachable, so `?limit=200` 400'd and two UI
     * callers rendered the failure as an empty list).
     *
     * But clamping quietly has its own cost. A caller asking for 1000 and receiving 100
     * gets an arbitrary slice with no signal — which is exactly how a bank-account
     * picker rendered "No accounts found" against 696 accounts, because the rows it
     * wanted were outside the first page. `limit` in the response already carries the
     * effective value; nobody compares it. A warning is the channel that is actually
     * read.
     *
     * Deep-pagination takes precedence when both apply: it is the more actionable of
     * the two, and stacking warnings turns a signal into noise.
     */
    const requestedLimit = Number(limit);
    const wasClamped = Number.isFinite(requestedLimit) && requestedLimit > sanitizedLimit;

    const warning = shouldWarnDeepPagination(sanitizedPage, this.config.deepPageThreshold)
      ? `Deep pagination (page ${sanitizedPage}). Consider getAll({ after, sort, limit }) for better performance.`
      : wasClamped
        ? `Requested limit ${Math.floor(requestedLimit)} exceeds this repository's cap; returning ${sanitizedLimit}. Filter server-side or sort deterministically — the returned page is otherwise an arbitrary slice.`
        : undefined;

    return {
      method: 'offset',
      data: data as TDoc[],
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      pages: totalPages,
      hasNext,
      hasPrev: sanitizedPage > 1,
      totalIsEstimate,
      countedAt,
      ...(warning && { warning }),
    };
  }

  /**
   * Keyset (cursor-based) pagination for high-performance streaming.
   * Best for large datasets, infinite scroll, real-time feeds.
   *
   * **Constant cost per page — but ONLY with an index that covers the whole
   * sort, tiebreaker included.** Keyset removes `skip(n)`; it does not by
   * itself remove a sort. `validateKeysetSort` appends `_id` to every sort, so
   * an index stopping at the primary field leaves Mongo to order the ties
   * itself: a blocking `SORT` over every row the filter matches, paid again on
   * every page. Measured at 20,000 documents examined to return 20, against 20
   * with the tiebreaker in the index.
   *
   * The dev-time warning below names the index to declare. Read it as a
   * correctness requirement for the performance claim, not as advice.
   *
   * @param options - Pagination options (sort is required)
   * @returns Pagination result with next cursor
   *
   * @example
   * // First page
   * const page1 = await engine.stream({
   *   sort: { createdAt: -1 },
   *   limit: 20
   * });
   *
   * // Next page using cursor
   * const page2 = await engine.stream({
   *   sort: { createdAt: -1 },
   *   after: page1.next,
   *   limit: 20
   * });
   */
  async stream(options: KeysetPaginationOptions): Promise<KeysetPaginationResult<TDoc>> {
    const {
      filters = {},
      sort,
      after,
      before,
      limit = this.config.defaultLimit,
      select,
      populate = [],
      lean = true,
      session,
      hint,
      collation,
    } = options;
    const qo = options.queryOptions ?? resolveQueryOptions('read', options);

    if (!sort) {
      throw createError(400, 'sort is required for keyset pagination');
    }
    if (after && before) {
      // Two anchors describe two different pages. Picking one silently would
      // return a page the caller never asked for.
      throw createError(400, 'Pass `after` or `before`, not both');
    }

    const sanitizedLimit = validateLimit(limit, this.config);
    const normalizedSort = validateKeysetSort(sort, this.config.strictKeysetSortFields);

    // Warn if filters + sort combination likely needs a compound index,
    // but only when no schema-declared index actually satisfies the query.
    //
    // Previous behavior warned purely from query shape, which produced false
    // positives in consumers that already had a matching compound index —
    // especially once policy plugins inject filters like `deletedAt` / tenant
    // fields that happen to be part of that index.
    //
    // We skip entirely in NODE_ENV === 'test' because test suites routinely
    // exercise every permutation without caring about index planning, and
    // routing via configureLogger is still available for finer control.
    // `validateKeysetSort` auto-appends `_id` as a tiebreaker, so the effective
    // sort always ends in `_id`. For the index-compat check, strip that tail —
    // an index covering the primary sort is still efficient in practice: the
    // planner uses the index for ordering and only pays an in-memory tiebreak
    // on duplicate primary values. Users shouldn't be forced to declare `_id`
    // in every compound index just to silence the warning.
    const filterKeys = Object.keys(filters).filter((k) => !k.startsWith('$'));
    // Adequacy is judged against the sort Mongo actually receives — `_id`
    // included. The trimmed list is for the human-readable half only.
    const effectiveSortFields = sortFieldsForMessage(normalizedSort);
    if (
      process.env.NODE_ENV !== 'test' &&
      filterKeys.length > 0 &&
      effectiveSortFields.length > 0
    ) {
      const indexes = this._getSchemaIndexes();
      // ESR-aware acceptance. An index is adequate if EITHER:
      //   (a) the full filter set forms the leading prefix — the legacy check,
      //       which is exact for all-equality queries; OR
      //   (b) just the EQUALITY predicates lead with the sort keys immediately
      //       after — the ESR-correct shape, where range predicates (`$ne`,
      //       `$elemMatch`, `$gt`, …) legitimately trail as residuals.
      // Path (b) recognizes genuinely-optimal indexes that (a) rejects, so a
      // range predicate no longer nags the caller into declaring a WORSE index
      // (one with the range field wedged into the equality prefix, stranding
      // the selective equalities behind it). Purely additive — it can only
      // silence a warning, never introduce one.
      const { equality } = classifyFilterFields(filters);
      const compatible =
        hasCompatibleKeysetIndex(indexes, filterKeys, normalizedSort) ||
        (equality.length !== filterKeys.length &&
          hasCompatibleKeysetIndex(indexes, equality, normalizedSort));
      if (!compatible) {
        // Includes the `_id` tiebreaker — stopping short of it is the blocking-sort shape.
        const indexFields = recommendKeysetIndex(filters, normalizedSort).map(
          ([f, dir]) => `${f}: ${dir}`,
        );
        warn(
          `[mongokit] Keyset pagination with filters [${filterKeys.join(', ')}] and sort [${effectiveSortFields.join(', ')}] ` +
            `has no matching schema-declared compound index. ` +
            `Without one, the tiebreaker forces a BLOCKING SORT over every matching row, on every page. ` +
            `Declare: { ${indexFields.join(', ')} }. ` +
            `(Collection-level indexes created outside the schema are not visible here.)`,
        );
      }
    }

    /**
     * Walking BACKWARDS is the forward walk with every direction inverted.
     *
     * `before: c` means "the page ending just before c", which is the same set
     * as "the first `limit` rows after c in the opposite order" — so the query
     * runs inverted and the rows are reversed back afterwards, leaving the
     * caller with data in the order they asked for.
     *
     * The CURSOR is still validated against the caller's own sort (that is what
     * it was minted under); only the QUERY is inverted.
     */
    const backward = Boolean(before);
    const querySort = backward ? (invertSort(normalizedSort) as SortSpec) : normalizedSort;
    const cursor = backward ? before : after;

    let query: Record<string, unknown> = { ...filters };
    // A cursor is a position within THIS collection + filter (tenant scope included) + collation.
    const scope = cursorScope(this.Model.collection.collectionName, filters, collation);

    if (cursor) {
      query = resolveCursorFilter(
        cursor,
        normalizedSort,
        this.config.cursorVersion,
        query,
        this.config.minCursorVersion,
        querySort,
        scope,
        this.config.cursorSecret,
      );
    }

    const effectiveSelect = ensureKeysetSelectIncludesCursorFields(select, normalizedSort);

    let mongoQuery = this.Model.find(query);
    if (effectiveSelect) mongoQuery = mongoQuery.select(effectiveSelect);
    if (populate && (Array.isArray(populate) ? populate.length : populate)) {
      // Support string, string[], PopulateOptions, or PopulateOptions[]
      mongoQuery = mongoQuery.populate(populate as Parameters<typeof mongoQuery.populate>[0]);
    }
    mongoQuery = mongoQuery
      .sort(querySort)
      .limit(sanitizedLimit + 1)
      .lean(lean);
    if (collation) mongoQuery = mongoQuery.collation(collation);
    if (session) mongoQuery = mongoQuery.session(session as ClientSession);
    if (hint) mongoQuery = mongoQuery.hint(hint);
    applyToQuery(mongoQuery, qo);

    const data = (await mongoQuery.exec()) as (TDoc & Record<string, unknown>)[];

    // The extra row answers "is there another page IN THE DIRECTION WE WALKED".
    const moreThatWay = data.length > sanitizedLimit;
    if (moreThatWay) data.pop();
    // Back into the caller's requested order.
    if (backward) data.reverse();

    /**
     * Which end of the walk the extra row spoke for.
     *
     * Forward, it says a next page exists. Backward, it says a page exists
     * BEFORE this one — and a next page certainly exists, because we arrived
     * from it. The mirror holds for the other edge: paging forward from a
     * cursor proves a previous page exists.
     */
    const hasMore = backward ? true : moreThatWay;
    const hasPrev = backward ? moreThatWay : Boolean(after);

    const primaryField = getPrimaryField(normalizedSort);
    const mint = (doc: (TDoc & Record<string, unknown>) | undefined) =>
      doc
        ? encodeCursor(
            doc,
            primaryField,
            normalizedSort,
            this.config.cursorVersion,
            scope,
            this.config.cursorSecret,
          )
        : null;

    // Both cursors are minted under the caller's own sort, so either can be fed
    // back as `after` or `before` regardless of which way this page was walked.
    return {
      method: 'keyset',
      data,
      limit: sanitizedLimit,
      hasMore,
      next: hasMore ? mint(data[data.length - 1]) : null,
      prev: hasPrev ? mint(data[0]) : null,
      hasPrev,
      // Walking backward, the page's last row in the caller's order is still data[length - 1].
      end: mint(data[data.length - 1]),
    };
  }

  /**
   * Aggregate pipeline with pagination.
   *
   * Runs the page and the count as TWO pipelines, concurrently — not one
   * `$facet`. `$facet` bundles every returned document and the count into a
   * SINGLE output document, and no stage may exceed the 16MB BSON limit, so a
   * page of large documents fails outright with `BSONObjectTooLarge` rather
   * than paginating. `$facet` also cannot use an index for the stages inside
   * it, so splitting is frequently the faster plan as well.
   *
   * The cost is that the two halves are separate reads and a concurrent write
   * can land between them, so `total` may disagree with `data` by a document.
   * That is already true of the offset path (`paginate` runs find and count
   * through one `Promise.all`) — this makes aggregate consistent with it, and
   * a count that is one row stale is a far smaller defect than a page that
   * cannot be fetched at all. `countStrategy: 'none'` runs ONE pipeline.
   *
   * @param options - Aggregation options
   * @returns Pagination result with total count
   *
   * @example
   * const result = await engine.aggregatePaginate({
   *   pipeline: [
   *     { $match: { status: 'active' } },
   *     { $group: { _id: '$category', count: { $sum: 1 } } },
   *     { $sort: { count: -1 } }
   *   ],
   *   page: 1,
   *   limit: 20
   * });
   */
  async aggregatePaginate(
    options: AggregatePaginationOptions = {},
  ): Promise<AggregatePaginationResult<TDoc, MongokitPageExtras>> {
    const {
      pipeline = [],
      page = 1,
      limit = this.config.defaultLimit,
      session,
      countStrategy = this.config.defaultCountStrategy,
      countLimit = this.config.defaultCountLimit,
    } = options;
    const qo = options.queryOptions ?? resolveQueryOptions('aggregate', options);

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);
    assertOffsetWithinCap(skip, this.config.maxOffset);

    /** Every execution option both pipelines must carry identically. */
    const run = (stages: unknown[]) => {
      const aggregation = this.Model.aggregate(
        stages as Parameters<typeof this.Model.aggregate>[0],
      );
      if (session) aggregation.session(session as ClientSession);
      applyToAggregate(aggregation, qo);
      return aggregation.exec();
    };

    /**
     * `$limit` BEFORE `$count` is the aggregate ceiling — the stage stops
     * pulling documents at the bound, so the count costs O(countLimit) instead
     * of walking the whole pipeline output.
     *
     * `estimated` has no aggregate equivalent (`estimatedDocumentCount` reads
     * collection metadata and cannot see a pipeline), so it stays exact here —
     * documented on `AggregatePaginationOptions.countStrategy`.
     */
    const ceiling = resolveCountLimit(countLimit);
    const bounded = countStrategy === 'capped' || countStrategy === 'cached';
    const countStages = bounded
      ? [...pipeline, { $limit: ceiling }, { $count: 'count' }]
      : [...pipeline, { $count: 'count' }];
    // An empty `$count` result means zero matching documents (the stage emits nothing).
    const countOnce = async () => ((await run(countStages)) as { count: number }[])[0]?.count ?? 0;

    const runData = () =>
      run([...pipeline, { $skip: skip }, { $limit: sanitizedLimit + 1 }]) as Promise<TDoc[]>;
    const runCount = async (): Promise<{ total: number; totalIsEstimate: boolean; countedAt: Date | null }> => {
      if (countStrategy === 'none') return { total: 0, totalIsEstimate: true, countedAt: null };
      if (countStrategy === 'cached' && !session) {
        const key = cursorScope(this.Model.collection.collectionName, [pipeline, ceiling], null);
        return { ...(await this._countMemo().get({ key, run: countOnce })), totalIsEstimate: true };
      }
      const total = await countOnce();
      return { total, totalIsEstimate: bounded && total >= ceiling, countedAt: new Date() };
    };
    // Sequential inside a transaction — one session, one operation at a time.
    const [data, counted] = session
      ? [await runData(), await runCount()]
      : await Promise.all([runData(), runCount()]);
    const { total, totalIsEstimate, countedAt } = counted;
    const totalPages = countStrategy === 'none' ? 0 : calculateTotalPages(total, sanitizedLimit);
    const hasNext = data.length > sanitizedLimit;
    if (hasNext) data.pop();

    const warning = shouldWarnDeepPagination(sanitizedPage, this.config.deepPageThreshold)
      ? `Deep pagination in aggregate (page ${sanitizedPage}). Uses $skip internally.`
      : undefined;

    return {
      method: 'aggregate',
      data,
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      pages: totalPages,
      hasNext,
      hasPrev: sanitizedPage > 1,
      totalIsEstimate,
      countedAt,
      ...(warning && { warning }),
    };
  }
}
