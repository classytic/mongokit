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

import type { Model } from 'mongoose';
import type {
  AggregatePaginationOptions,
  AggregatePaginationResult,
  AnyDocument,
  KeysetPaginationOptions,
  KeysetPaginationResult,
  OffsetPaginationOptions,
  OffsetPaginationResult,
  PaginationConfig,
} from '../types.js';
import { createError } from '../utils/error.js';
import { warn } from '../utils/logger.js';
import { encodeCursor, resolveCursorFilter } from './utils/cursor.js';
import {
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
import { getPrimaryField, validateKeysetSort } from './utils/sort.js';

/**
 * Strip a trailing `_id` tiebreaker from a normalized sort spec.
 *
 * `validateKeysetSort` always appends `_id` to the end of the sort object as
 * a stable-order guarantee. For index-compatibility matching we only care
 * about the primary ordering fields — an index covering those is efficient
 * even without `_id` in the index itself.
 *
 * Returns the sort unchanged if `_id` is the only field (degenerate case).
 */
function stripTrailingIdTiebreaker(sort: Record<string, 1 | -1>): Record<string, 1 | -1> {
  const keys = Object.keys(sort);
  if (keys.length <= 1) return sort;
  if (keys[keys.length - 1] !== '_id') return sort;
  const out: Record<string, 1 | -1> = {};
  for (let i = 0; i < keys.length - 1; i++) {
    out[keys[i]] = sort[keys[i]];
  }
  return out;
}

function ensureKeysetSelectIncludesCursorFields(
  select: string | string[] | Record<string, 0 | 1> | undefined,
  sort: Record<string, 1 | -1>,
): string | string[] | Record<string, 0 | 1> | undefined {
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

  const projection = { ...select };
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
  useEstimatedCount: boolean;
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
    this.config = {
      defaultLimit: config.defaultLimit ?? 10,
      maxLimit: config.maxLimit ?? 100,
      maxPage: config.maxPage ?? 10000,
      deepPageThreshold: config.deepPageThreshold ?? 100,
      cursorVersion: config.cursorVersion ?? 1,
      useEstimatedCount: config.useEstimatedCount ?? false,
    };
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
   * console.log(result.docs, result.total, result.hasNext);
   */
  async paginate(options: OffsetPaginationOptions = {}): Promise<OffsetPaginationResult<TDoc>> {
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
      countStrategy = 'exact',
      readPreference,
      collation,
    } = options;

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);

    // Fetch limit+1 when countStrategy=none to detect hasNext without counting
    const fetchLimit = countStrategy === 'none' ? sanitizedLimit + 1 : sanitizedLimit;

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
    if (session) query = query.session(session);
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
    } else {
      // 'exact' or 'estimated' with filters → use countDocuments.
      // When the caller provides `countFilters` (e.g. Repository rewriting
      // `$near` to `$geoWithin: $centerSphere` because MongoDB forbids count
      // on sort operators), count against that instead of the primary
      // find filter. Both return the same document set for a correctly
      // constructed rewrite — see primitives/geo.ts::rewriteNearForCount.
      const countTarget = (countFilters ?? filters) as Record<string, unknown>;
      const countQuery = this.Model.countDocuments(countTarget).session(session ?? null);
      if (hint) countQuery.hint(hint);
      if (maxTimeMS) countQuery.maxTimeMS(maxTimeMS);
      if (readPreference) countQuery.read(readPreference);
      countPromise = countQuery.exec();
    }

    // Execute find + count in parallel for maximum throughput
    const [docs, total] = await Promise.all([query.exec(), countPromise]);

    const totalPages = countStrategy === 'none' ? 0 : calculateTotalPages(total, sanitizedLimit);

    // When countStrategy=none, we fetched limit+1 — trim and detect hasNext
    let hasNext: boolean;
    if (countStrategy === 'none') {
      hasNext = docs.length > sanitizedLimit;
      if (hasNext) docs.pop();
    } else {
      hasNext = sanitizedPage < totalPages;
    }

    const warning = shouldWarnDeepPagination(sanitizedPage, this.config.deepPageThreshold)
      ? `Deep pagination (page ${sanitizedPage}). Consider getAll({ after, sort, limit }) for better performance.`
      : undefined;

    return {
      method: 'offset',
      docs: docs as TDoc[],
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      pages: totalPages,
      hasNext,
      hasPrev: sanitizedPage > 1,
      ...(warning && { warning }),
    };
  }

  /**
   * Keyset (cursor-based) pagination for high-performance streaming
   * Best for large datasets, infinite scroll, real-time feeds
   * O(1) performance - consistent speed regardless of position
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

    const sanitizedLimit = validateLimit(limit, this.config);
    const normalizedSort = validateKeysetSort(sort);

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
    const sortWithoutIdTail = stripTrailingIdTiebreaker(normalizedSort);
    const filterKeys = Object.keys(filters).filter((k) => !k.startsWith('$'));
    const effectiveSortFields = Object.keys(sortWithoutIdTail);
    if (
      process.env.NODE_ENV !== 'test' &&
      filterKeys.length > 0 &&
      effectiveSortFields.length > 0 &&
      !hasCompatibleKeysetIndex(this._getSchemaIndexes(), filterKeys, sortWithoutIdTail)
    ) {
      const indexFields = [
        ...filterKeys.map((f) => `${f}: 1`),
        ...effectiveSortFields.map((f) => `${f}: ${sortWithoutIdTail[f]}`),
      ];
      warn(
        `[mongokit] Keyset pagination with filters [${filterKeys.join(', ')}] and sort [${effectiveSortFields.join(', ')}] ` +
          `has no matching schema-declared compound index. ` +
          `For O(1) performance, declare: { ${indexFields.join(', ')} }. ` +
          `(Collection-level indexes created outside the schema are not visible here.)`,
      );
    }

    let query: Record<string, unknown> = { ...filters };

    if (after) {
      query = resolveCursorFilter(after, normalizedSort, this.config.cursorVersion, query);
    }

    const effectiveSelect = ensureKeysetSelectIncludesCursorFields(select, normalizedSort);

    let mongoQuery = this.Model.find(query);
    if (effectiveSelect) mongoQuery = mongoQuery.select(effectiveSelect);
    if (populate && (Array.isArray(populate) ? populate.length : populate)) {
      // Support string, string[], PopulateOptions, or PopulateOptions[]
      mongoQuery = mongoQuery.populate(populate as Parameters<typeof mongoQuery.populate>[0]);
    }
    mongoQuery = mongoQuery
      .sort(normalizedSort)
      .limit(sanitizedLimit + 1)
      .lean(lean);
    if (collation) mongoQuery = mongoQuery.collation(collation);
    if (session) mongoQuery = mongoQuery.session(session);
    if (hint) mongoQuery = mongoQuery.hint(hint);
    if (maxTimeMS) mongoQuery = mongoQuery.maxTimeMS(maxTimeMS);
    if (readPreference) mongoQuery = mongoQuery.read(readPreference);

    const docs = (await mongoQuery.exec()) as (TDoc & Record<string, unknown>)[];

    const hasMore = docs.length > sanitizedLimit;
    if (hasMore) docs.pop();

    const primaryField = getPrimaryField(normalizedSort);
    const nextCursor =
      hasMore && docs.length > 0
        ? encodeCursor(
            docs[docs.length - 1],
            primaryField,
            normalizedSort,
            this.config.cursorVersion,
          )
        : null;

    return {
      method: 'keyset',
      docs,
      limit: sanitizedLimit,
      hasMore,
      next: nextCursor,
    };
  }

  /**
   * Aggregate pipeline with pagination
   * Best for complex queries requiring aggregation stages
   * Uses $facet to combine results and count in single query
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
      countStrategy = 'exact',
      readPreference,
    } = options;

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);

    // Build facet pipeline — skip count stage if countStrategy is 'none'
    // Fetch limit+1 when countStrategy=none to detect hasNext without counting
    const fetchLimit = countStrategy === 'none' ? sanitizedLimit + 1 : sanitizedLimit;
    const facetStages: Record<string, unknown[]> = {
      docs: [{ $skip: skip }, { $limit: fetchLimit }],
    };
    if (countStrategy !== 'none') {
      facetStages.total = [{ $count: 'count' }];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facetPipeline = [...pipeline, { $facet: facetStages as any }] as Parameters<
      typeof this.Model.aggregate
    >[0];

    const aggregation = this.Model.aggregate(facetPipeline);
    if (session) aggregation.session(session);
    if (hint) aggregation.hint(hint as Record<string, unknown>);
    if (maxTimeMS) aggregation.option({ maxTimeMS });
    if (readPreference) aggregation.read(readPreference as import('mongodb').ReadPreferenceLike);

    const [result] = (await aggregation.exec()) as [{ docs: TDoc[]; total?: { count: number }[] }];
    const docs = result.docs;
    const total = result.total?.[0]?.count || 0;
    const totalPages = countStrategy === 'none' ? 0 : calculateTotalPages(total, sanitizedLimit);

    // When countStrategy=none, we fetched limit+1 — trim and detect hasNext
    let hasNext: boolean;
    if (countStrategy === 'none') {
      hasNext = docs.length > sanitizedLimit;
      if (hasNext) docs.pop();
    } else {
      hasNext = sanitizedPage < totalPages;
    }

    const warning = shouldWarnDeepPagination(sanitizedPage, this.config.deepPageThreshold)
      ? `Deep pagination in aggregate (page ${sanitizedPage}). Uses $skip internally.`
      : undefined;

    return {
      method: 'aggregate',
      docs,
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      pages: totalPages,
      hasNext,
      hasPrev: sanitizedPage > 1,
      ...(warning && { warning }),
    };
  }
}
