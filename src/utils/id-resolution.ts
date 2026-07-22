/**
 * ID Resolution Primitive
 *
 * Pure functions for detecting a Mongoose schema's _id type and validating
 * id values against it. Used by Repository.getById to decide whether to
 * run ObjectId validation (for ObjectId schemas) or skip it (for String /
 * Number / UUID schemas).
 *
 * Also usable standalone — Arc controllers, custom repositories, migration
 * scripts, or test harnesses can import these directly to make the same
 * decision without depending on Repository.
 *
 * Design: no `this`, no Model, no DB calls. Only reads `schema.paths._id.instance`.
 */

import mongoose from 'mongoose';

/** Normalized _id type — covers the common Mongoose _id declarations */
export type IdType = 'objectid' | 'string' | 'number' | 'uuid' | 'unknown';

/**
 * Null-tolerant `id → ObjectId` coercion — the single seam for optional
 * reference/audit-stamp fields (`approvedBy`, `submittedBy`, …) where an
 * absent actor is a legitimate `null`, not an error. Invalid non-empty
 * strings still throw (mongoose's own constructor validation) — this helper
 * only absorbs the absent case, never bad input. Hosts were hand-rolling
 * this identically at every approval-hook write; import it instead.
 */
export function toObjectId(id: string | null | undefined): mongoose.Types.ObjectId | null {
  return id ? new mongoose.Types.ObjectId(id) : null;
}

/**
 * Check if a Mongoose SchemaType `instance` string is an ObjectId variant.
 * Mongoose 9.x uses `'ObjectId'`, older versions use `'ObjectID'`. This
 * is the single source of truth — use it instead of inline
 * `instance === 'ObjectId' || instance === 'ObjectID'` checks.
 */
export function isObjectIdInstance(instance: string | undefined): boolean {
  return instance === 'ObjectId' || instance === 'ObjectID';
}

/** Minimal structural type for schema introspection (decoupled from Mongoose version) */
interface SchemaLike {
  paths?: Record<string, { instance?: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Detect an id path's type from a Mongoose schema. Defaults to the `_id`
 * path; pass `field` to resolve a custom id field (Repository's `idField`).
 *
 * For `_id`, returns 'objectid' as the safe default when:
 *   - No schema is provided (mock models, test harnesses)
 *   - The schema has no `paths._id` (auto-generated ObjectId)
 *   - The instance string is unrecognized
 *
 * This safe-default means existing callers that don't set _id explicitly
 * get the same ObjectId validation they always had — the behavioral change
 * is strictly opt-in via schema declaration.
 *
 * For a custom `field` with no resolvable path, returns 'unknown' instead —
 * custom id fields carry no ObjectId convention, so validation stays
 * permissive and the DB remains the authority.
 */
export function getSchemaIdType(schema?: SchemaLike | null, field = '_id'): IdType {
  const instance = schema?.paths?.[field]?.instance;
  if (!instance) return field === '_id' ? 'objectid' : 'unknown';

  if (isObjectIdInstance(instance)) return 'objectid';
  switch (instance) {
    case 'String':
      return 'string';
    case 'Number':
      return 'number';
    case 'UUID':
      return 'uuid';
    default:
      return 'unknown';
  }
}

/**
 * Validate an id value against a known _id type — WITHOUT hitting the DB.
 *
 * Returns `true` when the value is structurally valid for the given type.
 * Returns `false` when it's definitely invalid (Repository should return
 * 404 / null immediately rather than wasting a round-trip).
 *
 * For `'string'` and `'unknown'` types, validation is intentionally
 * permissive: any truthy, non-empty value is accepted. The DB is the
 * authority for whether the document exists — we only reject values that
 * are structurally impossible (null, undefined, empty string).
 */
export function isValidIdForType(id: unknown, idType: IdType): boolean {
  if (id === null || id === undefined) return false;

  switch (idType) {
    case 'objectid': {
      if (typeof id === 'object') {
        // ObjectId instance — Mongoose validates internally
        return mongoose.Types.ObjectId.isValid(id as unknown as string);
      }
      const s = String(id);
      return s.length > 0 && mongoose.Types.ObjectId.isValid(s);
    }
    case 'string': {
      const s = String(id);
      return s.length > 0;
    }
    case 'number': {
      if (typeof id === 'number') return Number.isFinite(id);
      const n = Number(id);
      return Number.isFinite(n);
    }
    case 'uuid': {
      return typeof id === 'string' && UUID_RE.test(id);
    }
    case 'unknown': {
      // Permissive — let the DB decide
      const s = String(id);
      return s.length > 0;
    }
  }
}

/**
 * Return every form an id might be stored as, for use in a `{ field: { $in: ... } }`
 * match. The Better Auth mongo adapter (and mixed mongoose/overlay writes) store
 * the same logical id as either a hex STRING or an ObjectId depending on the code
 * path, so a query keyed on one form silently misses rows stored as the other.
 *
 * - A 12-byte / 24-hex string that `ObjectId.isValid` accepts → `[hex, ObjectId(hex)]`.
 * - Anything else (non-ObjectId string, number, an ObjectId instance, …) → `[id]`.
 *
 * Over-matching is harmless — the extra `$in` term can't match a non-existent doc.
 * Replaces the `Types.ObjectId.isValid(id) ? [id, new Types.ObjectId(id)] : [id]`
 * one-liner that tends to get re-implemented at every call site.
 *
 * @example
 * await col.deleteMany({ customerId: { $in: idVariants(userId) } });
 */
export function idVariants(id: unknown): unknown[] {
  if (typeof id === 'string' && id.length > 0 && mongoose.Types.ObjectId.isValid(id)) {
    return [id, new mongoose.Types.ObjectId(id)];
  }
  return [id];
}
