/**
 * Schema-aware filter casting for the aggregation `$match` path.
 *
 * WHY THIS EXISTS. On a `find`-family call Mongoose casts the query against
 * the schema: a string `'6a6a…'` becomes an `ObjectId`, an ISO string becomes
 * a `Date`, `'42'` becomes a number. **An aggregation pipeline gets none of
 * that** — `Model.aggregate([{ $match: … }])` is handed straight to the
 * driver. BSON compares by type, so a string bound against an ObjectId or
 * Date column matches NOTHING: an empty result, silently, with no error.
 *
 * That asymmetry is a footgun for any caller that can't know the column type,
 * which is precisely the position a framework is in. arc's multi-tenant preset
 * resolves the tenant id off the auth scope — a STRING — and conjoins it into
 * the caller filter as `_policyFilters`. Against an `ObjectId`-typed tenant
 * column that predicate matched zero rows on EVERY aggregation, while the
 * equivalent `find()` worked, because Mongoose had cast it there.
 *
 * So we replicate Mongoose's find-time casting for `$match`, using the public
 * `SchemaType.cast()` API rather than Mongoose's internal query caster.
 *
 * Deliberately NON-THROWING: a value that cannot cast is left untouched
 * rather than raising. A `CastError` here would turn a previously-working
 * (if empty) dashboard into a 500, and the uncast predicate simply matches
 * nothing — the same outcome as before, minus the regression risk. Callers
 * that want strict rejection should validate before querying.
 */

import type { Schema } from 'mongoose';

/** Operators whose operand is a single scalar to cast. */
const SCALAR_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);

/** Operators whose operand is an array of scalars to cast element-wise. */
const ARRAY_OPS = new Set(['$in', '$nin']);

/** Logical operators whose operand is an ARRAY of sub-filters. */
const LOGICAL_ARRAY_OPS = new Set(['$and', '$or', '$nor']);

/** Logical operators whose operand is a SINGLE nested sub-filter. */
const LOGICAL_OBJECT_OPS = new Set(['$not']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Cast one value through a schema path. Returns the original value when the
 * path is unknown, the value is nullish, or the cast throws — never raises.
 */
function castValue(schema: Schema, field: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // Only primitives need casting; an already-constructed ObjectId / Date /
  // Buffer round-trips through `cast()` unchanged, so skipping objects avoids
  // pointless work (and avoids mangling operator objects handed in by mistake).
  if (typeof value === 'object' && !(value instanceof Date)) return value;
  let schemaType: { cast?: (v: unknown) => unknown } | null | undefined;
  try {
    schemaType = schema.path(field) as typeof schemaType;
  } catch {
    return value;
  }
  if (!schemaType || typeof schemaType.cast !== 'function') return value;
  try {
    return schemaType.cast(value);
  } catch {
    // Genuinely un-castable (e.g. 'not-an-objectid' for an ObjectId path).
    // Leave it — the predicate matches nothing, exactly as before.
    return value;
  }
}

/**
 * Cast the operand(s) of a field-level operator object, leaving operators we
 * don't understand (`$regex`, `$exists`, `$size`, `$elemMatch`, …) alone.
 */
function castOperatorObject(
  schema: Schema,
  field: string,
  ops: Record<string, unknown>,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [op, operand] of Object.entries(ops)) {
    if (SCALAR_OPS.has(op)) {
      const next = castValue(schema, field, operand);
      out[op] = next;
      if (next !== operand) changed = true;
    } else if (ARRAY_OPS.has(op) && Array.isArray(operand)) {
      const arr = operand.map((entry) => castValue(schema, field, entry));
      out[op] = arr;
      if (arr.some((v, i) => v !== operand[i])) changed = true;
    } else {
      out[op] = operand;
    }
  }
  return changed ? out : ops;
}

/**
 * Cast a record-shape Mongo filter against a Mongoose schema so it is safe to
 * hand to a `$match` stage. Recurses `$and` / `$or` / `$nor` / `$not`, since a
 * policy/tenant scope conjoined with a caller filter nests one level down.
 *
 * Filter IR nodes and non-objects pass through untouched — IR values are built
 * in code (already correctly typed) and carry no schema paths to resolve.
 *
 * @example
 * ```ts
 * // organizationId is an ObjectId column; arc supplies the scope id as a string
 * castFilterToSchema({ organizationId: '6a6a…' }, Order.schema)
 * // → { organizationId: ObjectId('6a6a…') }
 * ```
 */
export function castFilterToSchema(filter: unknown, schema: Schema): unknown {
  if (!isPlainObject(filter)) return filter;
  // Filter IR — has a string `op` discriminant. Leave to the IR compiler.
  if (typeof (filter as { op?: unknown }).op === 'string') return filter;

  let changed = false;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL_ARRAY_OPS.has(key) && Array.isArray(value)) {
      const arr = value.map((entry) => castFilterToSchema(entry, schema));
      out[key] = arr;
      if (arr.some((v, i) => v !== value[i])) changed = true;
      continue;
    }
    if (LOGICAL_OBJECT_OPS.has(key) && isPlainObject(value)) {
      const nested = castFilterToSchema(value, schema);
      out[key] = nested;
      if (nested !== value) changed = true;
      continue;
    }
    // Any other `$`-prefixed top-level key ($expr, $text, $where, …) is not a
    // field path — pass through verbatim.
    if (key.startsWith('$')) {
      out[key] = value;
      continue;
    }

    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      const looksLikeOperators = keys.length > 0 && keys.every((k) => k.startsWith('$'));
      if (looksLikeOperators) {
        const nextOps = castOperatorObject(schema, key, value);
        out[key] = nextOps;
        if (nextOps !== value) changed = true;
        continue;
      }
      // A real nested document predicate (`{ address: { city: 'Dhaka' } }`).
      out[key] = value;
      continue;
    }

    const next = castValue(schema, key, value);
    out[key] = next;
    if (next !== value) changed = true;
  }

  return changed ? out : filter;
}
