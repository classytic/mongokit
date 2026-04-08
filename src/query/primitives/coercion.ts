/**
 * Value coercion primitives
 *
 * Pure functions that convert raw URL-decoded values into typed values
 * suitable for MongoDB queries. Two layers:
 *
 *   1. `coerceHeuristic(value)` — string-shape based, used when no schema
 *      is configured. Safe defaults: rejects leading zeros, scientific
 *      notation, and strings >15 chars to preserve zip codes, phone codes,
 *      and long numeric IDs that exceed JS safe-integer precision.
 *
 *   2. `coerceToType(value, type)` — type-directed, used when a Mongoose
 *      schema or `fieldTypes` map declares the field's type. Strictly
 *      better than the heuristic when type information is available.
 *
 * QueryParser composes these via `coerceFieldValue(field, value, types)`
 * which prefers the type-directed path and falls back to the heuristic.
 *
 * Field-type extraction from a Mongoose schema is also here so the
 * normalization logic lives next to the coercion that consumes it.
 */

import mongoose from 'mongoose';
import { isObjectIdInstance } from '../../utils/id-resolution.js';

/** Normalized field type used for schema-aware coercion */
export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'objectid' | 'mixed';

/**
 * Minimal structural type for a Mongoose schema (read-only `.paths`).
 * Mongoose stores array element types in two different shadow properties
 * depending on version and declaration style:
 *   - `caster.instance`     — older / some array forms
 *   - `embeddedSchemaType.instance` — Mongoose 8+, both `[Type]` and `[{ type: Type }]`
 * We read both and prefer whichever is populated.
 */
export interface SchemaPathsLike {
  paths: Record<
    string,
    {
      instance?: string;
      caster?: { instance?: string };
      embeddedSchemaType?: { instance?: string };
    }
  >;
}

/**
 * Map a Mongoose `SchemaType.instance` string to our normalized FieldType.
 * For arrays (`type: [Number]` or `type: [{ type: Number }]`), Mongoose
 * stores the element type on `embeddedSchemaType.instance` (Mongoose 8+) or
 * `caster.instance` (older). We probe both — element-level coercion is what
 * `[in]`/`[nin]` operators need against typed arrays.
 *
 * Returns null for paths we cannot classify (embedded documents handled by
 * their own nested paths).
 */
export function normalizeMongooseType(schemaType: {
  instance?: string;
  caster?: { instance?: string };
  embeddedSchemaType?: { instance?: string };
}): FieldType | null {
  const raw =
    schemaType.embeddedSchemaType?.instance ?? schemaType.caster?.instance ?? schemaType.instance;
  if (!raw) return null;
  switch (raw) {
    case 'String':
      return 'string';
    case 'Number':
      return 'number';
    case 'Boolean':
      return 'boolean';
    case 'Date':
      return 'date';
    case 'Mixed':
      return 'mixed';
    default:
      if (isObjectIdInstance(raw)) return 'objectid';
      return null;
  }
}

/**
 * Build a normalized field-type map from a Mongoose schema and an optional
 * override map. The override wins on a per-path basis. Paths with unmappable
 * types are silently skipped — `coerceFieldValue` will fall back to the
 * heuristic for them.
 */
export function buildFieldTypeMap(
  schema?: SchemaPathsLike | null,
  overrides?: Record<string, FieldType>,
): Map<string, FieldType> {
  const map = new Map<string, FieldType>();
  if (schema?.paths) {
    for (const [path, schemaType] of Object.entries(schema.paths)) {
      const normalized = normalizeMongooseType(schemaType);
      if (normalized) map.set(path, normalized);
    }
  }
  if (overrides) {
    for (const [path, type] of Object.entries(overrides)) {
      map.set(path, type);
    }
  }
  return map;
}

/**
 * String-shape heuristic — used when no field type is known.
 *
 * Rules (deliberately conservative — silent miscoercion is worse than
 * leaving a string):
 *   - `null`/`undefined` pass through
 *   - Already-typed primitives (number, boolean) pass through
 *   - Arrays recurse element-wise
 *   - Objects pass through (filter operator objects, etc.)
 *   - `'true'`/`'false'` → boolean
 *   - 24-char hex → kept as string (ObjectId)
 *   - Strings 1–15 chars matching `^-?(0|[1-9]\d*)(\.\d+)?$` → number
 *     (rejects leading zeros, scientific notation, hex/octal, NaN, Infinity)
 *   - Everything else stays a string
 */
export function coerceHeuristic(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => coerceHeuristic(v));
  if (typeof value === 'object') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  const s = String(value);
  if (s === 'true') return true;
  if (s === 'false') return false;

  if (mongoose.Types.ObjectId.isValid(s) && s.length === 24) return s;

  // Safe numeric coercion — see file header for the rationale on each guard.
  if (s.length > 0 && s.length <= 15 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }

  return s;
}

/**
 * Type-directed coercion — used when a field's declared type is known.
 *
 * Returns the original value unchanged when coercion is impossible
 * (invalid date, non-numeric string for a Number field) — better to surface
 * a no-match than to silently produce `Invalid Date` or `NaN` which MongoDB
 * treats as legitimate query values.
 */
export function coerceToType(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => coerceToType(v, type));
  if (typeof value === 'object') return value;

  switch (type) {
    case 'number': {
      if (typeof value === 'number') return value;
      const num = Number(String(value));
      return Number.isFinite(num) ? num : value;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      return value;
    }
    case 'date': {
      if (value instanceof Date) return value;
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? value : d;
    }
    case 'objectid': {
      const sv = String(value);
      if (mongoose.Types.ObjectId.isValid(sv) && sv.length === 24) return sv;
      return value;
    }
    case 'string':
      // Critical: explicit String fields must NEVER coerce numerically.
      // This is the whole point of schema-awareness — `name: '12345'` stays
      // a string instead of becoming the number 12345.
      return String(value);
    case 'mixed':
      // No declared shape — fall back to heuristic
      return coerceHeuristic(value);
  }
}

/**
 * Field-aware coercion. Looks up `field` in `types` and uses
 * `coerceToType` when found, otherwise falls back to `coerceHeuristic`.
 *
 * This is the single choke point QueryParser uses for typed coercion of
 * direct equality, `[eq]`, `[in]`, `[nin]`, `[gt]`/`[gte]`/`[lt]`/`[lte]`
 * (the last only when a type is declared — see QueryParser for the
 * preserves-pre-3.5.5-behavior fallback).
 */
export function coerceFieldValue(
  field: string,
  value: unknown,
  types: Map<string, FieldType>,
): unknown {
  const type = types.get(field);
  if (!type) return coerceHeuristic(value);
  return coerceToType(value, type);
}
