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

import type { Model } from "mongoose";
import {
  encodeCursor,
  decodeCursor,
  validateCursorSort,
  validateCursorVersion,
} from "./utils/cursor.js";
import { validateKeysetSort, getPrimaryField } from "./utils/sort.js";
import { buildKeysetFilter } from "./utils/filter.js";
import {
  validateLimit,
  validatePage,
  shouldWarnDeepPagination,
  calculateSkip,
  calculateTotalPages,
} from "./utils/limits.js";
import { createError } from "../utils/error.js";
import { warn } from "../utils/logger.js";
import type {
  PaginationConfig,
  OffsetPaginationOptions,
  KeysetPaginationOptions,
  AggregatePaginationOptions,
  OffsetPaginationResult,
  KeysetPaginationResult,
  AggregatePaginationResult,
  AnyDocument,
} from "../types.js";

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
   * Create a new pagination engine
   *
   * @param Model - Mongoose model to paginate
   * @param config - Pagination configuration
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(
    Model: Model<TDoc, any, any, any>,
    config: PaginationConfig = {},
  ) {
    this.Model = Model as Model<TDoc>;
    this.config = {
      defaultLimit: config.defaultLimit || 10,
      maxLimit: config.maxLimit || 100,
      maxPage: config.maxPage || 10000,
      deepPageThreshold: config.deepPageThreshold || 100,
      cursorVersion: config.cursorVersion || 1,
      useEstimatedCount: config.useEstimatedCount || false,
    };
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
  async paginate(
    options: OffsetPaginationOptions = {},
  ): Promise<OffsetPaginationResult<TDoc>> {
    const {
      filters = {},
      sort = { _id: -1 },
      page = 1,
      limit = this.config.defaultLimit,
      select,
      populate = [],
      lean = true,
      session,
      hint,
      maxTimeMS,
      countStrategy = "exact",
      readPreference,
    } = options;

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);

    let query = this.Model.find(filters as Record<string, unknown>);
    if (select) query = query.select(select);
    if (populate && (Array.isArray(populate) ? populate.length : populate)) {
      // Support string, string[], PopulateOptions, or PopulateOptions[]
      query = query.populate(populate as Parameters<typeof query.populate>[0]);
    }
    query = query.sort(sort).skip(skip).limit(sanitizedLimit).lean(lean);
    if (session) query = query.session(session);
    if (hint) query = query.hint(hint);
    if (maxTimeMS) query = query.maxTimeMS(maxTimeMS);
    if (readPreference) query = query.read(readPreference);

    const hasFilters = Object.keys(filters).length > 0;
    const useEstimated = this.config.useEstimatedCount && !hasFilters;

    let total = 0;

    if (
      countStrategy === "estimated" ||
      (useEstimated && countStrategy !== "exact")
    ) {
      total = await this.Model.estimatedDocumentCount();
    } else if (countStrategy === "exact") {
      const countQuery = this.Model.countDocuments(
        filters as Record<string, unknown>,
      ).session(session ?? null);
      if (hint) countQuery.hint(hint);
      if (maxTimeMS) countQuery.maxTimeMS(maxTimeMS);
      if (readPreference) countQuery.read(readPreference);
      total = await countQuery;
    }

    const [docs] = await Promise.all([
      query.exec(),
      // Remove old count logic
    ]);

    const totalPages =
      countStrategy === "none" ? 0 : calculateTotalPages(total, sanitizedLimit);
    const warning = shouldWarnDeepPagination(
      sanitizedPage,
      this.config.deepPageThreshold,
    )
      ? `Deep pagination (page ${sanitizedPage}). Consider getAll({ after, sort, limit }) for better performance.`
      : undefined;

    return {
      method: "offset",
      docs: docs as TDoc[],
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      pages: totalPages,
      hasNext:
        countStrategy === "none"
          ? docs.length === sanitizedLimit
          : sanitizedPage < totalPages,
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
  async stream(
    options: KeysetPaginationOptions,
  ): Promise<KeysetPaginationResult<TDoc>> {
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
    } = options;

    if (!sort) {
      throw createError(400, "sort is required for keyset pagination");
    }

    const sanitizedLimit = validateLimit(limit, this.config);
    const normalizedSort = validateKeysetSort(sort);

    // Warn if filters + sort combination likely needs a compound index
    const filterKeys = Object.keys(filters).filter((k) => !k.startsWith("$"));
    const sortFields = Object.keys(normalizedSort);
    if (filterKeys.length > 0 && sortFields.length > 0) {
      const indexFields = [
        ...filterKeys.map((f) => `${f}: 1`),
        ...sortFields.map((f) => `${f}: ${normalizedSort[f]}`),
      ];
      warn(
        `[mongokit] Keyset pagination with filters [${filterKeys.join(", ")}] and sort [${sortFields.join(", ")}] ` +
          `requires a compound index for O(1) performance. ` +
          `Ensure index exists: { ${indexFields.join(", ")} }`,
      );
    }

    let query: Record<string, unknown> = { ...filters };

    if (after) {
      const cursor = decodeCursor(after);
      validateCursorVersion(cursor.version, this.config.cursorVersion);
      validateCursorSort(cursor.sort, normalizedSort);
      query = buildKeysetFilter(query, normalizedSort, cursor.value, cursor.id);
    }

    let mongoQuery = this.Model.find(query);
    if (select) mongoQuery = mongoQuery.select(select);
    if (populate && (Array.isArray(populate) ? populate.length : populate)) {
      // Support string, string[], PopulateOptions, or PopulateOptions[]
      mongoQuery = mongoQuery.populate(
        populate as Parameters<typeof mongoQuery.populate>[0],
      );
    }
    mongoQuery = mongoQuery
      .sort(normalizedSort)
      .limit(sanitizedLimit + 1)
      .lean(lean);
    if (session) mongoQuery = mongoQuery.session(session);
    if (hint) mongoQuery = mongoQuery.hint(hint);
    if (maxTimeMS) mongoQuery = mongoQuery.maxTimeMS(maxTimeMS);
    if (readPreference) mongoQuery = mongoQuery.read(readPreference);

    const docs = (await mongoQuery.exec()) as (TDoc &
      Record<string, unknown>)[];

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
      method: "keyset",
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
      countStrategy = "exact",
      readPreference,
    } = options;

    const sanitizedPage = validatePage(page, this.config);
    const sanitizedLimit = validateLimit(limit, this.config);
    const skip = calculateSkip(sanitizedPage, sanitizedLimit);

    // Build facet pipeline — skip count stage if countStrategy is 'none'
    const facetStages: Record<string, unknown[]> = {
      docs: [{ $skip: skip }, { $limit: sanitizedLimit }],
    };
    if (countStrategy !== "none") {
      facetStages.total = [{ $count: "count" }];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facetPipeline = [
      ...pipeline,
      { $facet: facetStages as any },
    ] as Parameters<typeof this.Model.aggregate>[0];

    const aggregation = this.Model.aggregate(facetPipeline);
    if (session) aggregation.session(session);
    if (hint) aggregation.hint(hint as Record<string, unknown>);
    if (maxTimeMS) aggregation.option({ maxTimeMS });
    if (readPreference) aggregation.read(readPreference as any);

    const [result] = (await aggregation.exec()) as [
      { docs: TDoc[]; total?: { count: number }[] },
    ];
    const docs = result.docs;
    const total = result.total?.[0]?.count || 0;
    const totalPages =
      countStrategy === "none" ? 0 : calculateTotalPages(total, sanitizedLimit);

    const warning = shouldWarnDeepPagination(
      sanitizedPage,
      this.config.deepPageThreshold,
    )
      ? `Deep pagination in aggregate (page ${sanitizedPage}). Uses $skip internally.`
      : undefined;

    return {
      method: "aggregate",
      docs,
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      pages: totalPages,
      hasNext:
        countStrategy === "none"
          ? docs.length === sanitizedLimit
          : sanitizedPage < totalPages,
      hasPrev: sanitizedPage > 1,
      ...(warning && { warning }),
    };
  }
}
