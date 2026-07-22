/**
 * Pure pipeline-construction helpers for `Repository.lookupPopulate()`.
 *
 * The facade method owns orchestration (context, hooks, middleware, the
 * aggregate round-trip); everything here is deterministic pipeline math —
 * projection building and lookup/coalesce/project stage assembly — kept
 * side-effect free so it is unit-testable without a repository.
 */

import type { PipelineStage } from 'mongoose';
import { LookupBuilder, type LookupOptions } from '../query/LookupBuilder.js';
import type { SelectSpec, SortSpec } from '../types/core.js';

/**
 * Inclusion projections must carry the keyset sort fields (plus `_id`) or
 * cursor encoding has no values to serialize. No-op for exclusion
 * projections and cursor-less calls.
 */
function ensureLookupProjectionIncludesCursorFields(
  projection: Record<string, 0 | 1> | undefined,
  sort: SortSpec | undefined,
): Record<string, 0 | 1> | undefined {
  if (!projection || !sort) return projection;

  const isInclusion = Object.values(projection).some((value) => value === 1);
  if (!isInclusion) return projection;

  const nextProjection = { ...projection };
  for (const field of [...Object.keys(sort), '_id']) {
    nextProjection[field] = 1;
  }

  return nextProjection;
}

/**
 * Build the `$project` map from a caller's select spec (string / array /
 * inclusion-exclusion record). For inclusion projections, every lookup's
 * `as` field is auto-included so `$project` doesn't strip the joined data.
 * Returns a fresh object (callers may add fields for cursor encoding).
 */
export function buildLookupProjection(
  selectSpec: SelectSpec | undefined,
  lookups: LookupOptions[],
): Record<string, 0 | 1> | undefined {
  if (!selectSpec) return undefined;

  let projection: Record<string, 0 | 1>;
  if (typeof selectSpec === 'string') {
    projection = {};
    for (const field of selectSpec.split(',').map((f) => f.trim())) {
      if (field.startsWith('-')) {
        projection[field.substring(1)] = 0;
      } else {
        projection[field] = 1;
      }
    }
  } else if (Array.isArray(selectSpec)) {
    projection = {};
    for (const field of selectSpec) {
      if (field.startsWith('-')) {
        projection[field.substring(1)] = 0;
      } else {
        projection[field] = 1;
      }
    }
  } else {
    // After string + Array.isArray checks above, selectSpec is the Record
    // form. Array.isArray's predicate (`x is any[]`) does not narrow
    // `readonly string[]` out of the union, so cast.
    projection = { ...(selectSpec as Record<string, 0 | 1>) };
  }

  // Auto-include lookup `as` fields so $project doesn't strip joined data
  const isInclusion = Object.values(projection).some((v) => v === 1);
  if (isInclusion) {
    for (const lookup of lookups) {
      const asField = lookup.as || lookup.from;
      if (!(asField in projection)) {
        projection[asField] = 1;
      }
    }
  }

  return projection;
}

/**
 * Append the shared pipeline tail: `$lookup` stages, `$ifNull` coalescing
 * for `single` lookups, and the final `$project` (with cursor fields kept
 * when a keyset sort is active). Mutates `pipeline` in place — it is the
 * tail-builder both the keyset and offset modes share.
 */
export function appendLookupStages(
  pipeline: PipelineStage[],
  lookups: LookupOptions[],
  projection: Record<string, 0 | 1> | undefined,
  keysetSort: SortSpec | undefined,
): void {
  pipeline.push(...LookupBuilder.multiple(lookups));
  for (const lookup of lookups) {
    if (lookup.single) {
      const asField = lookup.as || lookup.from;
      pipeline.push({
        $addFields: { [asField]: { $ifNull: [`$${asField}`, null] } },
      } as PipelineStage);
    }
  }
  const finalProjection = ensureLookupProjectionIncludesCursorFields(projection, keysetSort);
  if (finalProjection) {
    pipeline.push({ $project: finalProjection });
  }
}
