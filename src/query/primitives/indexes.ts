/**
 * Schema index introspection
 *
 * Pure functions that read a Mongoose-like schema's `.indexes()` output and
 * extract structured information about which fields are indexed how. Used by
 * QueryParser to:
 *
 *   - Detect 2dsphere/2d-indexed fields → enable geo operator routing.
 *   - Detect text-indexed fields → expose to repositories that need it.
 *   - Surface compound index hints → useful for query planners and Arc MCP
 *     auto-generation.
 *
 * Stays decoupled from a specific Mongoose major version: only depends on
 * `.indexes()` returning a list of `[indexSpec, options?]` tuples, which has
 * been stable since Mongoose 4.x.
 */

/** Minimal structural type for a Mongoose-like schema. */
export interface IndexableSchema {
  indexes(): Array<[Record<string, unknown>, Record<string, unknown>?]>;
}

/** Structured view of a schema's indexes, indexed by purpose. */
export interface SchemaIndexes {
  /** Field paths with a 2dsphere or 2d index — eligible for geo operators */
  geoFields: string[];
  /** Field paths with a text index — eligible for $text queries */
  textFields: string[];
  /** All other indexes as raw spec/options pairs (for hints, plan analysis) */
  other: Array<{ spec: Record<string, unknown>; options?: Record<string, unknown> }>;
}

const EMPTY: SchemaIndexes = { geoFields: [], textFields: [], other: [] };

/**
 * Extract structured index information from a Mongoose schema. Returns an
 * empty `SchemaIndexes` shape (not null) when no schema is provided so callers
 * can read `.geoFields`/`.textFields` unconditionally without null checks.
 */
export function extractSchemaIndexes(schema?: IndexableSchema | null): SchemaIndexes {
  if (!schema || typeof schema.indexes !== 'function') return EMPTY;

  const geoFields: string[] = [];
  const textFields: string[] = [];
  const other: SchemaIndexes['other'] = [];

  let raw: Array<[Record<string, unknown>, Record<string, unknown>?]>;
  try {
    raw = schema.indexes();
  } catch {
    return EMPTY;
  }

  for (const entry of raw) {
    const [spec, options] = entry;
    if (!spec || typeof spec !== 'object') continue;

    let classified = false;
    for (const [field, value] of Object.entries(spec)) {
      if (value === '2dsphere' || value === '2d') {
        geoFields.push(field);
        classified = true;
      } else if (value === 'text') {
        textFields.push(field);
        classified = true;
      }
    }
    if (!classified) {
      other.push({ spec, options });
    }
  }

  return { geoFields, textFields, other };
}
