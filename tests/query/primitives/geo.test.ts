/**
 * Unit tests for geo primitives — pure functions, no Mongo, no schema, no
 * QueryParser. If these break, the bug is in `src/query/primitives/geo.ts`,
 * not in the orchestrator. This is the level the user asked for: testable
 * primitives composable into a flexible API.
 */

import { describe, expect, it } from 'vitest';
import {
  buildGeoWithinBoxFilter,
  buildNearFilter,
  buildWithinRadiusFilter,
  GEO_OPERATORS,
  hasNearOperator,
  isGeoOperator,
  isValidLngLat,
  parseCoordinateList,
  parseGeoFilter,
  rewriteNearForCount,
} from '../../../src/query/primitives/geo.js';

describe('geo primitive: parseCoordinateList', () => {
  it('parses a comma-separated string of numbers', () => {
    expect(parseCoordinateList('-73.97,40.78,5000')).toEqual([-73.97, 40.78, 5000]);
  });

  it('parses an array of strings', () => {
    expect(parseCoordinateList(['-73.97', '40.78'])).toEqual([-73.97, 40.78]);
  });

  it('returns null on any non-numeric element', () => {
    expect(parseCoordinateList('foo,40.78')).toBeNull();
    expect(parseCoordinateList('-73.97,bar')).toBeNull();
  });

  it('returns null on Infinity and NaN', () => {
    expect(parseCoordinateList('Infinity,40')).toBeNull();
    expect(parseCoordinateList('NaN,40')).toBeNull();
  });

  it('returns null for non-string non-array input', () => {
    expect(parseCoordinateList(undefined)).toBeNull();
    expect(parseCoordinateList(null)).toBeNull();
    expect(parseCoordinateList({})).toBeNull();
  });
});

describe('geo primitive: isValidLngLat', () => {
  it('accepts valid coordinates at the extremes', () => {
    expect(isValidLngLat(-180, -90)).toBe(true);
    expect(isValidLngLat(180, 90)).toBe(true);
    expect(isValidLngLat(0, 0)).toBe(true);
  });

  it('rejects out-of-range longitude', () => {
    expect(isValidLngLat(180.1, 0)).toBe(false);
    expect(isValidLngLat(-180.1, 0)).toBe(false);
  });

  it('rejects out-of-range latitude', () => {
    expect(isValidLngLat(0, 90.1)).toBe(false);
    expect(isValidLngLat(0, -90.1)).toBe(false);
  });
});

describe('geo primitive: buildNearFilter', () => {
  it('builds $near with $maxDistance from [lng,lat,r]', () => {
    expect(buildNearFilter('near', [-73.97, 40.78, 5000])).toEqual({
      $near: {
        $geometry: { type: 'Point', coordinates: [-73.97, 40.78] },
        $maxDistance: 5000,
      },
    });
  });

  it('builds $near without $maxDistance from [lng,lat]', () => {
    expect(buildNearFilter('near', [-73.97, 40.78])).toEqual({
      $near: {
        $geometry: { type: 'Point', coordinates: [-73.97, 40.78] },
      },
    });
  });

  it('builds $nearSphere with the same shape as $near', () => {
    expect(buildNearFilter('nearSphere', [-73.97, 40.78, 2000])).toEqual({
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [-73.97, 40.78] },
        $maxDistance: 2000,
      },
    });
  });

  it('returns null for invalid coordinate counts', () => {
    expect(buildNearFilter('near', [])).toBeNull();
    expect(buildNearFilter('near', [-73.97])).toBeNull();
    expect(buildNearFilter('near', [-73.97, 40.78, 5000, 1])).toBeNull();
  });

  it('returns null when lng/lat are out of range', () => {
    expect(buildNearFilter('near', [999, 40.78, 5000])).toBeNull();
    expect(buildNearFilter('near', [-73.97, 999, 5000])).toBeNull();
  });

  it('returns null for negative or non-finite maxDistance', () => {
    expect(buildNearFilter('near', [-73.97, 40.78, -1])).toBeNull();
    expect(buildNearFilter('near', [-73.97, 40.78, Number.NaN])).toBeNull();
  });
});

describe('geo primitive: buildWithinRadiusFilter ($centerSphere)', () => {
  it('builds $geoWithin $centerSphere from [lng,lat,radiusMeters]', () => {
    // 5000 m / 6378137 m ≈ 0.000783891... radians
    const filter = buildWithinRadiusFilter([-73.97, 40.78, 5000]);
    expect(filter).toMatchObject({
      $geoWithin: {
        $centerSphere: [[-73.97, 40.78], expect.any(Number)],
      },
    });
    const radius = (filter as { $geoWithin: { $centerSphere: [unknown, number] } }).$geoWithin
      .$centerSphere[1];
    expect(radius).toBeGreaterThan(0.00078);
    expect(radius).toBeLessThan(0.00079);
  });

  it('returns null when radius is missing or wrong arity', () => {
    expect(buildWithinRadiusFilter([-73.97, 40.78])).toBeNull();
    expect(buildWithinRadiusFilter([-73.97, 40.78, 5000, 1])).toBeNull();
  });

  it('returns null when radius is negative or non-finite', () => {
    expect(buildWithinRadiusFilter([-73.97, 40.78, -1])).toBeNull();
    expect(buildWithinRadiusFilter([-73.97, 40.78, Number.NaN])).toBeNull();
  });

  it('returns null when coordinates are out of range', () => {
    expect(buildWithinRadiusFilter([999, 40.78, 5000])).toBeNull();
  });
});

describe('geo primitive: buildGeoWithinBoxFilter', () => {
  it('builds $geoWithin $box from 4 coordinates', () => {
    expect(buildGeoWithinBoxFilter([-74.05, 40.65, -73.9, 40.8])).toEqual({
      $geoWithin: {
        $box: [
          [-74.05, 40.65],
          [-73.9, 40.8],
        ],
      },
    });
  });

  it('returns null for the wrong coordinate count', () => {
    expect(buildGeoWithinBoxFilter([-74, 40.7, -73.9])).toBeNull();
    expect(buildGeoWithinBoxFilter([-74, 40.7])).toBeNull();
  });

  it('returns null when min > max in either axis', () => {
    expect(buildGeoWithinBoxFilter([-73.9, 40.65, -74.05, 40.8])).toBeNull();
    expect(buildGeoWithinBoxFilter([-74.05, 40.8, -73.9, 40.65])).toBeNull();
  });

  it('returns null when any coordinate is out of range', () => {
    expect(buildGeoWithinBoxFilter([-74, 40.7, 999, 40.8])).toBeNull();
  });
});

describe('geo primitive: rewriteNearForCount ($near → $centerSphere for countDocuments)', () => {
  it('rewrites bounded $near to $geoWithin $centerSphere preserving the radius', () => {
    const out = rewriteNearForCount({
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [-73.97, 40.78] },
          $maxDistance: 5000,
        },
      },
    });
    expect(out).toMatchObject({
      location: {
        $geoWithin: {
          $centerSphere: [[-73.97, 40.78], expect.any(Number)],
        },
      },
    });
    const r = (out as { location: { $geoWithin: { $centerSphere: [unknown, number] } } }).location
      .$geoWithin.$centerSphere[1];
    expect(r).toBeCloseTo(5000 / 6378137, 10);
  });

  it('rewrites $nearSphere the same way', () => {
    const out = rewriteNearForCount({
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [-73.97, 40.78] },
          $maxDistance: 2000,
        },
      },
    });
    expect(out).toBeTruthy();
    expect((out as { location: { $geoWithin: unknown } }).location.$geoWithin).toBeDefined();
  });

  it('returns null when $near is unbounded (no $maxDistance)', () => {
    expect(
      rewriteNearForCount({
        location: { $near: { $geometry: { type: 'Point', coordinates: [-73.97, 40.78] } } },
      }),
    ).toBeNull();
  });

  it('returns null when no $near / $nearSphere is present (caller uses filter as-is)', () => {
    expect(rewriteNearForCount({ status: 'active' })).toBeNull();
    expect(rewriteNearForCount({ location: { $geoWithin: {} } })).toBeNull();
  });

  it('preserves non-geo sibling filters when rewriting', () => {
    const out = rewriteNearForCount({
      status: 'active',
      category: 'park',
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [-73.97, 40.78] },
          $maxDistance: 5000,
        },
      },
    });
    expect(out).toMatchObject({
      status: 'active',
      category: 'park',
      location: { $geoWithin: { $centerSphere: expect.any(Array) } },
    });
  });

  it('returns null on invalid coordinates inside $near', () => {
    expect(
      rewriteNearForCount({
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [999, 40.78] },
            $maxDistance: 5000,
          },
        },
      }),
    ).toBeNull();
  });

  it('returns null for nullish / non-object input', () => {
    expect(rewriteNearForCount(null)).toBeNull();
    expect(rewriteNearForCount(undefined)).toBeNull();
    expect(rewriteNearForCount('foo')).toBeNull();
  });
});

describe('geo primitive: hasNearOperator (Repository sort-safety detection)', () => {
  it('detects top-level $near', () => {
    expect(hasNearOperator({ location: { $near: { $geometry: { type: 'Point' } } } })).toBe(true);
  });

  it('detects top-level $nearSphere', () => {
    expect(hasNearOperator({ location: { $nearSphere: {} } })).toBe(true);
  });

  it('detects $near inside $or branches', () => {
    expect(
      hasNearOperator({
        $or: [{ status: 'active' }, { location: { $nearSphere: {} } }],
      }),
    ).toBe(true);
  });

  it('detects $near inside $and branches', () => {
    expect(
      hasNearOperator({
        $and: [{ status: 'active' }, { location: { $near: {} } }],
      }),
    ).toBe(true);
  });

  it('returns false for non-geo operators (incl $geoWithin which is safe)', () => {
    expect(hasNearOperator({ location: { $geoWithin: { $box: [] } } })).toBe(false);
    expect(hasNearOperator({ status: 'active', price: { $gte: 10 } })).toBe(false);
  });

  it('returns false for nullish / non-object input', () => {
    expect(hasNearOperator(null)).toBe(false);
    expect(hasNearOperator(undefined)).toBe(false);
    expect(hasNearOperator('string')).toBe(false);
    expect(hasNearOperator(42)).toBe(false);
    expect(hasNearOperator([])).toBe(false);
  });

  it('returns false for empty filter object', () => {
    expect(hasNearOperator({})).toBe(false);
  });
});

describe('geo primitive: isGeoOperator + parseGeoFilter routing', () => {
  it('isGeoOperator recognizes the supported operators', () => {
    for (const op of GEO_OPERATORS) {
      expect(isGeoOperator(op)).toBe(true);
    }
    expect(isGeoOperator('eq')).toBe(false);
    expect(isGeoOperator('regex')).toBe(false);
  });

  it('parseGeoFilter routes to the right builder', () => {
    expect(parseGeoFilter('near', '-73.97,40.78,5000')).toMatchObject({ $near: {} });
    expect(parseGeoFilter('nearSphere', '-73.97,40.78')).toMatchObject({ $nearSphere: {} });
    expect(parseGeoFilter('geoWithin', '-74,40.7,-73.9,40.8')).toMatchObject({
      $geoWithin: {},
    });
  });

  it('parseGeoFilter returns null for non-geo operators (caller falls through)', () => {
    expect(parseGeoFilter('eq', 'whatever')).toBeNull();
  });

  it('parseGeoFilter returns null on invalid input (caller drops the filter)', () => {
    expect(parseGeoFilter('near', 'foo,bar')).toBeNull();
    expect(parseGeoFilter('near', '999,40,5000')).toBeNull();
  });
});
