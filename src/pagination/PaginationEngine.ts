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
import { createError } from '../utils/error.js';
import { warn } from '../utils/logger.js';
import { bindPaginationDefaults } from './defaults.js';
import { encodeCursor, resolveCursorFilter } from './utils/cursor.js';
import {
  classifyFilterFields,
  hasCompatibleKeysetIndex,
  readSchemaIndexes,
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
      maxTimeMS,
      countStrategy = this.config.defaultCountStrategy,
      countLimit = this.config.defaultCountLimit,
      readPreference,
      collation,
    } = options;

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);

    /**
     * Fetch limit+1 whenever the count cannot answer `hasNext`.
     *
     * `none` never counts. `capped` counts only to the ceiling, so once `total`
     * sits AT the ceiling it no longer knows whether a further page exists —
     * deriving `hasNext` from `page < pages` there reports "no more results" in
     * the middle of a collection, which is a wrong answer that looks like a
     * right one. One extra document is the whole cost of avoiding it.
     */
    const countBounded = countStrategy === 'none' || countStrategy === 'capped';
    const fetchLimit = countBounded ? sanitizedLimit + 1 : sanitizedLimit;

    let query = this.Model.find(filters as Record<string, unknown>);
    if (select) query = query.select(select);
    if (populate && (Array.isArray(populate) ? populate.length : populate)) {
      // Support string, string[], PopulateOptions, or PopulateOptions[]
      query = query.populate(populate as Parameters<typeof query.populate>[0]);
    }
    // Only apply .sort() when an explicit sort is provided. This matters for
    // $near / $nearSphere queries — MongoDB applies an implicit distance sort
    // and forbids any explicit sort, so callers (Repository) pass `sort:
    // undefined` to opt out. For all other queries Repository defaults to
    // -createdAt before reaching here, so this branch is rarely taken from
    // Repository — but other PaginationEngine consumers (custom controllers)
    // also benefit from being able to opt out.
    if (sort) {
      query = query.sort(sort);
    }
    query = query.skip(skip).limit(fetchLimit).lean(lean);
    if (collation) query = query.collation(collation);
    if (session) query = query.session(session as ClientSession);
    if (hint) query = query.hint(hint);
    if (maxTimeMS) query = query.maxTimeMS(maxTimeMS);
    if (readPreference) query = query.read(readPreference);

    const hasFilters = Object.keys(filters).length > 0;
    const useEstimated = this.config.useEstimatedCount && !hasFilters;

    // Build count promise (runs in parallel with find)
    let countPromise: Promise<number>;

    // estimatedDocumentCount ignores filters — only safe for unfiltered queries.
    // When 'estimated' is requested with filters, fall back to exact countDocuments.
    if ((countStrategy === 'estimated' || useEstimated) && !hasFilters) {
      countPromise = this.Model.estimatedDocumentCount();
    } else if (countStrategy === 'none') {
      countPromise = Promise.resolve(0);
    } else if (countStrategy === 'capped') {
      /**
       * `.limit(n)` on a count is MongoDB's own ceiling — the server stops
       * scanning at n and returns n, so the work is O(n) rather than O(matching
       * rows). Below the ceiling it returns the exact figure, so a small
       * collection is unaffected by the strategy being on.
       */
      const cappedTarget = (countFilters ?? filters) as Record<string, unknown>;
      const cappedQuery = this.Model.countDocuments(cappedTarget)
        .limit(resolveCountLimit(countLimit))
        .session((session ?? null) as ClientSession | null);
      if (hint) cappedQuery.hint(hint);
      if (maxTimeMS) cappedQuery.maxTimeMS(maxTimeMS);
      if (readPreference) cappedQuery.read(readPreference);
      countPromise = cappedQuery.exec();
    } else {
      // 'exact' or 'estimated' with filters → use countDocuments.
      // When the caller provides `countFilters` (e.g. Repository rewriting
      // `$near` to `$geoWithin: $centerSphere` because MongoDB forbids count
      // on sort operators), count against that instead of the primary
      // find filter. Both return the same document set for a correctly
      // constructed rewrite — see primitives/geo.ts::rewriteNearForCount.
      const countTarget = (countFilters ?? filters) as Record<string, unknown>;
      const countQuery = this.Model.countDocuments(countTarget).session(
        (session ?? null) as ClientSession | null,
      );
      if (hint) countQuery.hint(hint);
      if (maxTimeMS) countQuery.maxTimeMS(maxTimeMS);
      if (readPreference) countQuery.read(readPreference);
      countPromise = countQuery.exec();
    }

    // Execute find + count in parallel for maximum throughput
    const [data, total] = await Promise.all([query.exec(), countPromise]);

    const totalPages = countStrategy === 'none' ? 0 : calculateTotalPages(total, sanitizedLimit);

    /**
     * A capped count that came back AT its ceiling is a floor, not a total.
     *
     * Reported rather than inferred: `total === countLimit` is also what a
     * collection of exactly that size legitimately returns, so a consumer
     * cannot tell the two apart, and one that guesses renders `10,000+` over an
     * exact 10,000 forever.
     */
    const totalIsLowerBound = countStrategy === 'capped' && total >= resolveCountLimit(countLimit);

    // A bounded count fetched limit+1 — trim it back off and use it for hasNext.
    let hasNext: boolean;
    if (countBounded) {
      hasNext = data.length > sanitizedLimit;
      if (hasNext) data.pop();
    } else {
      hasNext = sanitizedPage < totalPages;
    }

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
      ...(totalIsLowerBound && { totalIsLowerBound }),
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
      maxTimeMS,
      readPreference,
      collation,
    } = options;

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
      const { equality, range } = classifyFilterFields(filters);
      const compatible =
        hasCompatibleKeysetIndex(indexes, filterKeys, normalizedSort) ||
        (equality.length !== filterKeys.length &&
          hasCompatibleKeysetIndex(indexes, equality, normalizedSort));
      if (!compatible) {
        // Recommend the ESR-ordered index: equality → sort → range.
        const indexFields = [
          ...equality.map((f) => `${f}: 1`),
          // Every sort key INCLUDING `_id` — an index that stops short of the
          // tiebreaker is the blocking-sort shape this warning exists to prevent.
          ...Object.keys(normalizedSort).map((f) => `${f}: ${normalizedSort[f]}`),
          ...range.map((f) => `${f}: 1`),
        ];
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

    if (cursor) {
      query = resolveCursorFilter(
        cursor,
        normalizedSort,
        this.config.cursorVersion,
        query,
        this.config.minCursorVersion,
        querySort,
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
    if (maxTimeMS) mongoQuery = mongoQuery.maxTimeMS(maxTimeMS);
    if (readPreference) mongoQuery = mongoQuery.read(readPreference);

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
  ): Promise<AggregatePaginationResult<TDoc>> {
    const {
      pipeline = [],
      page = 1,
      limit = this.config.defaultLimit,
      session,
      hint,
      maxTimeMS,
      countStrategy = this.config.defaultCountStrategy,
      countLimit = this.config.defaultCountLimit,
      readPreference,
      allowDiskUse,
    } = options;

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);

    // Same contract as the offset path: a count that stops early cannot answer
    // `hasNext`, so fetch one extra document and answer from that instead.
    const countBounded = countStrategy === 'none' || countStrategy === 'capped';
    const fetchLimit = countBounded ? sanitizedLimit + 1 : sanitizedLimit;

    /** Every execution option both pipelines must carry identically. */
    const run = (stages: unknown[]) => {
      const aggregation = this.Model.aggregate(
        stages as Parameters<typeof this.Model.aggregate>[0],
      );
      if (session) aggregation.session(session as ClientSession);
      if (hint) aggregation.hint(hint as Record<string, unknown>);
      if (maxTimeMS) aggregation.option({ maxTimeMS });
      if (readPreference) aggregation.read(readPreference as import('mongodb').ReadPreferenceLike);
      // A `$sort`/`$group` over more than 100MB fails with
      // QueryExceededMemoryLimitNoDiskUseAllowed unless the pipeline may spill.
      if (allowDiskUse) aggregation.allowDiskUse(true);
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
    const countStages =
      countStrategy === 'capped'
        ? [...pipeline, { $limit: resolveCountLimit(countLimit) }, { $count: 'count' }]
        : [...pipeline, { $count: 'count' }];

    const [dataRows, countRows] = await Promise.all([
      run([...pipeline, { $skip: skip }, { $limit: fetchLimit }]) as Promise<TDoc[]>,
      countStrategy === 'none'
        ? Promise.resolve([] as { count: number }[])
        : (run(countStages) as Promise<{ count: number }[]>),
    ]);

    const data = dataRows;
    // An empty `$count` result means zero matching documents — the stage emits
    // no document at all rather than `{ count: 0 }`.
    const total = countRows[0]?.count || 0;
    const totalPages = countStrategy === 'none' ? 0 : calculateTotalPages(total, sanitizedLimit);
    const totalIsLowerBound = countStrategy === 'capped' && total >= resolveCountLimit(countLimit);

    // A bounded count fetched limit+1 — trim it back off and use it for hasNext.
    let hasNext: boolean;
    if (countBounded) {
      hasNext = data.length > sanitizedLimit;
      if (hasNext) data.pop();
    } else {
      hasNext = sanitizedPage < totalPages;
    }

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
      ...(totalIsLowerBound && { totalIsLowerBound }),
      ...(warning && { warning }),
    };
  }
}
