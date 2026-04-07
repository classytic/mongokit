/**
 * Geo query primitives
 *
 * Pure functions that translate ergonomic URL syntax into the canonical
 * GeoJSON-shaped MongoDB query operators ($near, $nearSphere, $geoWithin).
 *
 * Coordinate convention: ALWAYS lng,lat (matches GeoJSON, opposite of Google
 * Maps' lat,lng). The parser is responsible for documenting this so users
 * don't pass coordinates in the wrong order.
 *
 * These functions are pure (no `this`, no I/O) and unit-testable in isolation.
 * QueryParser orchestrates by calling them when it sees a `[near]`,
 * `[nearSphere]`, or `[geoWithin]` operator on a field.
 */

/** Geo operators recognized by the parser */
export const GEO_OPERATORS = ['near', 'nearSphere', 'geoWithin', 'withinRadius'] as const;
export type GeoOperator = (typeof GEO_OPERATORS)[number];

/** Earth radius in meters — used to convert meters → radians for $centerSphere */
const EARTH_RADIUS_METERS = 6378137;

/**
 * True iff `operator` is one of the geo operators we handle.
 * Used by the operator router in QueryParser to short-circuit before the
 * generic numeric/string operator handling kicks in.
 */
export function isGeoOperator(operator: string): operator is GeoOperator {
  return (GEO_OPERATORS as readonly string[]).includes(operator);
}

/**
 * Parse a comma-separated coordinate list into numbers, validating each value
 * is a finite number. Returns null on any parse failure — callers must treat
 * null as "drop this filter entirely" rather than substituting defaults
 * (which would silently widen the query).
 */
export function parseCoordinateList(raw: unknown): number[] | null {
  if (typeof raw !== 'string' && !Array.isArray(raw)) return null;
  const parts = Array.isArray(raw) ? raw : raw.split(',').map((s) => s.trim());
  const nums: number[] = [];
  for (const part of parts) {
    const n = Number(String(part));
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * Validate a [lng, lat] pair against MongoDB's accepted ranges.
 * Longitude: [-180, 180]. Latitude: [-90, 90]. Out-of-range coordinates
 * return false so the parser can drop the filter — emitting a $near query
 * with `coordinates: [999, 40]` would either error inside Mongo or worse,
 * silently behave unexpectedly.
 */
export function isValidLngLat(lng: number, lat: number): boolean {
  return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

/**
 * Build a `$near` or `$nearSphere` filter for a single field from a coordinate
 * list. Accepts:
 *   [lng, lat]                — proximity sort, no distance bound
 *   [lng, lat, maxDistance]   — proximity sort within `maxDistance` meters
 *
 * Returns null on any validation failure (drop the filter).
 */
export function buildNearFilter(
  variant: 'near' | 'nearSphere',
  coords: number[],
): Record<string, unknown> | null {
  if (coords.length < 2 || coords.length > 3) return null;
  const [lng, lat, maxDistance] = coords;
  if (!isValidLngLat(lng, lat)) return null;

  const operator = variant === 'near' ? '$near' : '$nearSphere';
  const inner: Record<string, unknown> = {
    $geometry: { type: 'Point', coordinates: [lng, lat] },
  };
  if (maxDistance !== undefined) {
    if (!Number.isFinite(maxDistance) || maxDistance < 0) return null;
    inner.$maxDistance = maxDistance;
  }
  return { [operator]: inner };
}

/**
 * Build a `$geoWithin: $centerSphere` filter from [lng, lat, radiusMeters].
 *
 * IMPORTANT: this is the count-compatible alternative to `$near`. MongoDB
 * forbids `$near` / `$nearSphere` in any context that requires sorting (which
 * `countDocuments`, `$lookup`, `$facet`, and several others do), because they
 * are themselves sort operators. `$geoWithin: $centerSphere` is a *filter*
 * operator, returns the same set of documents within a radius, and works
 * everywhere `$near` does not — including paginated `Repository.getAll`.
 *
 * Use `[near]` when you want results sorted by distance and don't need a
 * total count. Use `[withinRadius]` for pagination, counts, and joins.
 *
 * `$centerSphere` takes the radius in radians, so we convert from the
 * caller-friendly meters using Earth's equatorial radius.
 */
export function buildWithinRadiusFilter(coords: number[]): Record<string, unknown> | null {
  if (coords.length !== 3) return null;
  const [lng, lat, radiusMeters] = coords;
  if (!isValidLngLat(lng, lat)) return null;
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) return null;
  const radiusRadians = radiusMeters / EARTH_RADIUS_METERS;
  return {
    $geoWithin: {
      $centerSphere: [[lng, lat], radiusRadians],
    },
  };
}

/**
 * Build a `$geoWithin: $box` filter from a 4-element coordinate list:
 *   [minLng, minLat, maxLng, maxLat]
 *
 * Returns null on any validation failure (drop the filter).
 */
export function buildGeoWithinBoxFilter(coords: number[]): Record<string, unknown> | null {
  if (coords.length !== 4) return null;
  const [minLng, minLat, maxLng, maxLat] = coords;
  if (!isValidLngLat(minLng, minLat) || !isValidLngLat(maxLng, maxLat)) return null;
  if (minLng > maxLng || minLat > maxLat) return null;
  return {
    $geoWithin: {
      $box: [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
    },
  };
}

/**
 * Rewrite a filter object that contains `$near` / `$nearSphere` into an
 * equivalent count-compatible filter using `$geoWithin: $centerSphere`.
 *
 * Background: MongoDB refuses `countDocuments` on any query that uses a
 * sort-operator like `$near` (they consume the query plan slot that count
 * would use). The equivalent `$geoWithin: $centerSphere` is NOT a sort
 * operator and counts/composes freely — and since both are evaluated
 * against the same 2dsphere index, they return the same document set.
 *
 * This lets Repository run `find().sort(...)` with `$near` for the page
 * results AND `countDocuments()` with the rewritten filter for the total,
 * without ever breaking the parser → repo contract.
 *
 * Returns null when:
 *   - `filters` is not an object
 *   - No `$near` / `$nearSphere` is present (caller can use filters as-is)
 *   - A `$near` operator lacks `$maxDistance` (unbounded — cannot be
 *     rewritten to a bounded `$centerSphere`; caller should fall back to
 *     `countStrategy: 'none'`)
 */
export function rewriteNearForCount(filters: unknown): Record<string, unknown> | null {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return null;
  const src = filters as Record<string, unknown>;
  const rewritten: Record<string, unknown> = {};
  let anyRewritten = false;

  for (const [key, value] of Object.entries(src)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      rewritten[key] = value;
      continue;
    }
    const inner = value as Record<string, unknown>;
    const nearOp = '$near' in inner ? '$near' : '$nearSphere' in inner ? '$nearSphere' : null;
    if (!nearOp) {
      rewritten[key] = value;
      continue;
    }
    const nearVal = inner[nearOp] as Record<string, unknown>;
    const geometry = nearVal?.$geometry as { type?: string; coordinates?: number[] } | undefined;
    const maxDistance = nearVal?.$maxDistance as number | undefined;
    if (
      !geometry?.coordinates ||
      geometry.coordinates.length < 2 ||
      typeof maxDistance !== 'number' ||
      !Number.isFinite(maxDistance) ||
      maxDistance < 0
    ) {
      // Unbounded or malformed $near — cannot produce an equivalent bounded
      // count filter. Caller must fall back to countStrategy: 'none'.
      return null;
    }
    const [lng, lat] = geometry.coordinates;
    if (!isValidLngLat(lng, lat)) return null;
    const radiusRadians = maxDistance / EARTH_RADIUS_METERS;
    rewritten[key] = {
      $geoWithin: { $centerSphere: [[lng, lat], radiusRadians] },
    };
    anyRewritten = true;
  }

  return anyRewritten ? rewritten : null;
}

/**
 * Detect whether a Mongo filter object contains a `$near` or `$nearSphere`
 * operator on any field at the top level. These are SORT operators in
 * MongoDB — they cannot coexist with an explicit `.sort()` clause and they
 * cannot be used with `countDocuments`. Repositories must check this before
 * injecting their default sort or running a count.
 *
 * Walks the top level only. Geo operators nested inside `$or` / `$and` are
 * also forbidden by MongoDB so we check those one level down too.
 *
 * Returns false for falsy / non-object inputs.
 */
export function hasNearOperator(filters: unknown): boolean {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return false;
  for (const value of Object.values(filters as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      // $or / $and arrays — recurse one level
      for (const branch of value) {
        if (hasNearOperator(branch)) return true;
      }
      continue;
    }
    const inner = value as Record<string, unknown>;
    if ('$near' in inner || '$nearSphere' in inner) return true;
  }
  return false;
}

/**
 * High-level entry point: given an operator name and the raw value from the
 * URL, return the MongoDB filter for that field — or null if the operator is
 * not a geo operator (caller should fall through to normal handling) or the
 * value is invalid (caller should drop the filter).
 */
export function parseGeoFilter(operator: string, raw: unknown): Record<string, unknown> | null {
  if (!isGeoOperator(operator)) return null;
  const coords = parseCoordinateList(raw);
  if (!coords) return null;

  if (operator === 'near') return buildNearFilter('near', coords);
  if (operator === 'nearSphere') return buildNearFilter('nearSphere', coords);
  if (operator === 'geoWithin') return buildGeoWithinBoxFilter(coords);
  if (operator === 'withinRadius') return buildWithinRadiusFilter(coords);

  // Exhaustive — TypeScript will catch a missing case at compile time.
  return null;
}
