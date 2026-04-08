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
 * Detect the _id path type from a Mongoose schema.
 *
 * Returns 'objectid' as the safe default when:
 *   - No schema is provided (mock models, test harnesses)
 *   - The schema has no `paths._id` (auto-generated ObjectId)
 *   - The instance string is unrecognized
 *
 * This safe-default means existing callers that don't set _id explicitly
 * get the same ObjectId validation they always had — the behavioral change
 * is strictly opt-in via schema declaration.
 */
export function getSchemaIdType(schema?: SchemaLike | null): IdType {
  const instance = schema?.paths?._id?.instance;
  if (!instance) return 'objectid'; // safe default

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
