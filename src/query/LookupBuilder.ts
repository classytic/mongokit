/**
 * LookupBuilder - MongoDB $lookup Utility
 *
 * Standalone builder for efficient custom field joins using MongoDB $lookup aggregation.
 * Optimized for millions of records with proper index usage.
 *
 * Features:
 * - Join on custom fields (slugs, SKUs, codes, etc.)
 * - Pipeline support for complex transformations
 * - Index-aware query building
 * - Single vs Array result handling
 * - Nested lookups
 *
 * @example
 * ```typescript
 * // Simple lookup - join employees with departments by slug
 * const lookup = new LookupBuilder('departments')
 *   .localField('departmentSlug')
 *   .foreignField('slug')
 *   .as('department')
 *   .single();  // Unwrap array to single object
 *
 * const pipeline = lookup.build();
 * const results = await Employee.aggregate(pipeline);
 *
 * // Advanced lookup with pipeline
 * const lookup = new LookupBuilder('products')
 *   .localField('productIds')
 *   .foreignField('sku')
 *   .pipeline([
 *     { $match: { status: 'active' } },
 *     { $project: { name: 1, price: 1 } }
 *   ])
 *   .as('products');
 * ```
 */

import type { ClientSession, PipelineStage } from 'mongoose';
import { warn } from '../utils/logger.js';

/** Stages that are never valid inside a $lookup pipeline */
const BLOCKED_PIPELINE_STAGES = [
  '$out',
  '$merge',
  '$unionWith',
  '$collStats',
  '$currentOp',
  '$listSessions',
];

/** Operators that can enable arbitrary code execution.
 * Note: $expr is intentionally NOT blocked — it's needed for pipeline-form
 * $lookup correlations (let + $match.$expr) and is a comparison operator,
 * not a code execution vector like $where/$function/$accumulator. */
const DANGEROUS_OPERATORS = ['$where', '$function', '$accumulator'];

export interface LookupOptions {
  /** Collection to join with */
  from: string;
  /** Field from the input documents */
  localField: string;
  /** Field from the documents of the "from" collection */
  foreignField: string;
  /** Name of the new array field to add to the input documents */
  as?: string;
  /** Whether to unwrap array to single object */
  single?: boolean;
  /** Field selection on the joined collection (shorthand for $project pipeline) */
  select?: string | Record<string, 0 | 1>;
  /** Additional pipeline to run on the joined collection */
  pipeline?: PipelineStage[];
  /** Optional let variables for pipeline */
  let?: Record<string, string>;
  /** Query filter to apply before join (legacy, for aggregate.ts compatibility) */
  query?: Record<string, unknown>;
  /** Query options (legacy, for aggregate.ts compatibility) */
  options?: { session?: ClientSession };
  /** Sanitize pipeline stages (default: true). Set false only for trusted server-side pipelines */
  sanitize?: boolean;
}

/**
 * Fluent builder for MongoDB $lookup aggregation stage
 * Optimized for custom field joins at scale
 */
export class LookupBuilder {
  private options: Partial<LookupOptions> = {};

  constructor(from?: string) {
    if (from) this.options.from = from;
  }

  /**
   * Set the collection to join with
   */
  from(collection: string): this {
    this.options.from = collection;
    return this;
  }

  /**
   * Set the local field (source collection)
   * IMPORTANT: This field should be indexed for optimal performance
   */
  localField(field: string): this {
    this.options.localField = field;
    return this;
  }

  /**
   * Set the foreign field (target collection)
   * IMPORTANT: This field should be indexed (preferably unique) for optimal performance
   */
  foreignField(field: string): this {
    this.options.foreignField = field;
    return this;
  }

  /**
   * Set the output field name
   * Defaults to the collection name if not specified
   */
  as(fieldName: string): this {
    this.options.as = fieldName;
    return this;
  }

  /**
   * Mark this lookup as returning a single document
   * Automatically unwraps the array result to a single object or null
   */
  single(isSingle: boolean = true): this {
    this.options.single = isSingle;
    return this;
  }

  /**
   * Add a pipeline to filter/transform joined documents
   * Useful for filtering, sorting, or limiting joined results
   *
   * @example
   * ```typescript
   * lookup.pipeline([
   *   { $match: { status: 'active' } },
   *   { $sort: { priority: -1 } },
   *   { $limit: 5 }
   * ]);
   * ```
   */
  pipeline(stages: PipelineStage[]): this {
    this.options.pipeline = stages;
    return this;
  }

  /**
   * Set let variables for use in pipeline
   * Allows referencing local document fields in the pipeline
   */
  let(variables: Record<string, string>): this {
    this.options.let = variables;
    return this;
  }

  /**
   * Control pipeline sanitization (default: true)
   * Set to false for auto-generated pipelines that are known safe
   */
  sanitize(enabled: boolean): this {
    this.options.sanitize = enabled;
    return this;
  }

  /**
   * Build the $lookup aggregation stage(s)
   * Returns an array of pipeline stages including $lookup and optional $unwind
   *
   * IMPORTANT: MongoDB $lookup has two mutually exclusive forms:
   * 1. Simple form: { from, localField, foreignField, as }
   * 2. Pipeline form: { from, let, pipeline, as }
   *
   * When pipeline or let is specified, we use the pipeline form.
   * Otherwise, we use the simpler localField/foreignField form.
   */
  build(): PipelineStage[] {
    const { from, localField, foreignField, as, single, pipeline, let: letVars } = this.options;

    if (!from) {
      throw new Error('LookupBuilder: "from" collection is required');
    }

    const outputField = as || from;
    const stages: PipelineStage[] = [];

    // MongoDB $lookup forms are mutually exclusive
    const usePipelineForm = pipeline || letVars;

    let lookupStage: PipelineStage.Lookup;

    if (usePipelineForm) {
      // Pipeline form: { from, let, pipeline, as }
      // Used for complex joins with filtering, transformations, or let variables
      if (!pipeline || pipeline.length === 0) {
        // If let is specified but no pipeline, create a default pipeline with $match
        if (!localField || !foreignField) {
          throw new Error(
            'LookupBuilder: When using pipeline form without a custom pipeline, ' +
              'both localField and foreignField are required to auto-generate the pipeline',
          );
        }

        // Auto-generate pipeline that performs the same join as simple form
        const autoPipeline: PipelineStage[] = [
          {
            $match: {
              $expr: {
                $eq: [`$${foreignField}`, `$$${localField}`],
              },
            },
          },
        ];

        lookupStage = {
          $lookup: {
            from,
            let: { [localField]: `$${localField}`, ...(letVars || {}) },
            pipeline: autoPipeline,
            as: outputField,
          },
        } as PipelineStage.Lookup;
      } else {
        // Custom pipeline provided — sanitize unless opted out
        const safePipeline =
          this.options.sanitize !== false ? LookupBuilder.sanitizePipeline(pipeline) : pipeline;

        // If localField/foreignField are given but no let, auto-generate the
        // join correlation so the pipeline is NOT a cartesian product.
        let effectiveLet = letVars;
        let effectivePipeline = safePipeline;

        if (localField && foreignField && !letVars) {
          effectiveLet = { lookupJoinVal: `$${localField}` };
          const joinStage: PipelineStage = {
            $match: { $expr: { $eq: [`$${foreignField}`, '$$lookupJoinVal'] } },
          };
          effectivePipeline = [joinStage, ...safePipeline];
        }

        lookupStage = {
          $lookup: {
            from,
            ...(effectiveLet && { let: effectiveLet }),
            pipeline: effectivePipeline,
            as: outputField,
          },
        } as PipelineStage.Lookup;
      }
    } else {
      // Simple form: { from, localField, foreignField, as }
      // Faster and simpler for basic equality joins
      if (!localField || !foreignField) {
        throw new Error(
          'LookupBuilder: localField and foreignField are required for simple lookup',
        );
      }

      lookupStage = {
        $lookup: {
          from,
          localField,
          foreignField,
          as: outputField,
        },
      };
    }

    stages.push(lookupStage);

    // If single=true, unwrap the array to a single object
    if (single) {
      stages.push({
        $unwind: {
          path: `$${outputField}`,
          preserveNullAndEmptyArrays: true, // Keep documents even if no match found
        },
      });
    }

    return stages;
  }

  /**
   * Build and return only the $lookup stage (without $unwind)
   * Useful when you want to handle unwrapping yourself
   */
  buildLookupOnly(): PipelineStage.Lookup {
    const stages = this.build();
    return stages[0] as PipelineStage.Lookup;
  }

  /**
   * Static helper: Create a simple lookup in one line
   */
  static simple(
    from: string,
    localField: string,
    foreignField: string,
    options: { as?: string; single?: boolean } = {},
  ): PipelineStage[] {
    return new LookupBuilder(from)
      .localField(localField)
      .foreignField(foreignField)
      .as(options.as || from)
      .single(options.single || false)
      .build();
  }

  /**
   * Static helper: Create multiple lookups at once
   *
   * @example
   * ```typescript
   * const pipeline = LookupBuilder.multiple([
   *   { from: 'departments', localField: 'deptSlug', foreignField: 'slug', single: true },
   *   { from: 'managers', localField: 'managerId', foreignField: '_id', single: true }
   * ]);
   * ```
   */
  static multiple(lookups: LookupOptions[]): PipelineStage[] {
    return lookups.flatMap((lookup) => {
      const builder = new LookupBuilder(lookup.from)
        .localField(lookup.localField)
        .foreignField(lookup.foreignField);

      if (lookup.as) builder.as(lookup.as);
      if (lookup.single) builder.single(lookup.single);

      // Convert select shorthand to $project pipeline stage
      if (lookup.select) {
        let projection: Record<string, 0 | 1>;
        if (typeof lookup.select === 'string') {
          projection = {};
          for (const field of lookup.select.split(',').map((f) => f.trim())) {
            if (field.startsWith('-')) {
              projection[field.substring(1)] = 0;
            } else {
              projection[field] = 1;
            }
          }
        } else {
          projection = lookup.select;
        }

        // When select triggers pipeline form, we must auto-generate the join condition
        // otherwise it becomes a cartesian join (no $match.$expr filtering)
        const joinStage: PipelineStage = {
          $match: {
            $expr: {
              $eq: [`$${lookup.foreignField}`, '$$lookupJoinVal'],
            },
          },
        };
        const existing = lookup.pipeline || [];
        // Use sanitize: false — the join $match.$expr is safe (auto-generated, not user input)
        builder.pipeline([joinStage, ...existing, { $project: projection } as PipelineStage]);
        builder.let({ lookupJoinVal: `$${lookup.localField}`, ...(lookup.let || {}) });
        // Skip sanitization for auto-generated join pipeline (contains safe $expr)
        builder.sanitize(false);
      } else if (lookup.pipeline) {
        builder.pipeline(lookup.pipeline);
        if (lookup.let) builder.let(lookup.let);
      } else {
        if (lookup.let) builder.let(lookup.let);
      }

      return builder.build();
    });
  }

  /**
   * Static helper: Create a nested lookup (lookup within lookup)
   * Useful for multi-level joins like Order -> Product -> Category
   *
   * @example
   * ```typescript
   * // Join orders with products, then products with categories
   * const pipeline = LookupBuilder.nested([
   *   { from: 'products', localField: 'productSku', foreignField: 'sku', as: 'product', single: true },
   *   { from: 'categories', localField: 'product.categorySlug', foreignField: 'slug', as: 'product.category', single: true }
   * ]);
   * ```
   */
  static nested(lookups: LookupOptions[]): PipelineStage[] {
    return lookups.flatMap((lookup, _index) => {
      const builder = new LookupBuilder(lookup.from)
        .localField(lookup.localField)
        .foreignField(lookup.foreignField);

      if (lookup.as) builder.as(lookup.as);
      if (lookup.single !== undefined) builder.single(lookup.single);
      if (lookup.pipeline) builder.pipeline(lookup.pipeline);
      if (lookup.let) builder.let(lookup.let);

      return builder.build();
    });
  }

  /**
   * Sanitize pipeline stages by blocking dangerous stages and operators.
   * Used internally by build() and available for external use (e.g., aggregate.ts).
   */
  static sanitizePipeline(stages: PipelineStage[]): PipelineStage[] {
    const sanitized: PipelineStage[] = [];

    for (const stage of stages) {
      if (!stage || typeof stage !== 'object') continue;

      const entries = Object.entries(stage as unknown as Record<string, unknown>);
      if (entries.length !== 1) continue;

      const [op, config] = entries[0];

      if (BLOCKED_PIPELINE_STAGES.includes(op)) {
        warn(`[mongokit] Blocked dangerous pipeline stage in lookup: ${op}`);
        continue;
      }

      if (
        (op === '$match' || op === '$addFields' || op === '$set') &&
        typeof config === 'object' &&
        config !== null
      ) {
        sanitized.push({
          [op]: LookupBuilder._sanitizeDeep(config as Record<string, unknown>),
        } as unknown as PipelineStage);
      } else {
        sanitized.push(stage);
      }
    }

    return sanitized;
  }

  /**
   * Recursively remove dangerous operators from an expression object.
   */
  private static _sanitizeDeep(config: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(config)) {
      if (DANGEROUS_OPERATORS.includes(key)) {
        warn(`[mongokit] Blocked dangerous operator in lookup pipeline: ${key}`);
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = LookupBuilder._sanitizeDeep(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((item) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return LookupBuilder._sanitizeDeep(item as Record<string, unknown>);
          }
          return item;
        });
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}

/**
 * Performance Guidelines for $lookup at Scale:
 *
 * 1. **Index Requirements** (Critical for millions of records):
 *    - localField should be indexed on source collection
 *    - foreignField should be indexed on target collection (unique index preferred)
 *
 *    Example:
 *    ```typescript
 *    // Employee collection
 *    employeeSchema.index({ departmentSlug: 1 });
 *
 *    // Department collection
 *    departmentSchema.index({ slug: 1 }, { unique: true });
 *    ```
 *
 * 2. **Query Performance**:
 *    - With proper indexes: O(log n) per lookup
 *    - Without indexes: O(n * m) - AVOID THIS!
 *    - Use explain() to verify index usage: IXSCAN (good) vs COLLSCAN (bad)
 *
 * 3. **Pipeline Optimization**:
 *    - Place $match stages as early as possible
 *    - Use $project to reduce field size before lookups
 *    - Limit joined results with pipeline: [{ $match: {...} }, { $limit: n }]
 *
 * 4. **Memory Considerations**:
 *    - Each lookup creates a new field in memory
 *    - Use $project after lookup to remove unnecessary fields
 *    - Consider allowDiskUse: true for very large datasets
 *
 * 5. **Alternative Approaches**:
 *    - For 1:1 relationships with high read frequency: Consider storing ObjectId + slug
 *    - For read-heavy workloads: Consider caching or materialized views
 *    - For real-time dashboards: Consider separate aggregation collections
 */
