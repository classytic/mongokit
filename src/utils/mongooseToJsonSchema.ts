/**
 * Mongoose to JSON Schema Converter with Field Rules
 *
 * Generates Fastify JSON schemas from Mongoose models with declarative field rules.
 *
 * Field Rules (options.fieldRules):
 * - immutable: Field cannot be updated (omitted from update schema)
 * - immutableAfterCreate: Alias for immutable
 * - systemManaged: System-only field (omitted from create/update)
 * - optional: Remove from required array
 *
 * Additional Options:
 * - strictAdditionalProperties: Set to true to add "additionalProperties: false" to schemas
 *   This makes Fastify reject unknown fields at validation level (default: false for backward compatibility)
 * - update.requireAtLeastOne: Set to true to add "minProperties: 1" to update schema
 *   This prevents empty update payloads (default: false)
 *
 * @example
 * buildCrudSchemasFromModel(Model, {
 *   strictAdditionalProperties: true, // Reject unknown fields
 *   fieldRules: {
 *     organizationId: { immutable: true },
 *     status: { systemManaged: true },
 *   },
 *   create: { omitFields: ['verifiedAt'] },
 *   update: {
 *     omitFields: ['customerId'],
 *     requireAtLeastOne: true // Reject empty updates
 *   }
 * })
 */

import mongoose, { type Schema } from 'mongoose';
import type { CrudSchemas, JsonSchema, SchemaBuilderOptions, ValidationResult } from '../types.js';
import { isObjectIdInstance } from './id-resolution.js';

function isMongooseSchema(value: unknown): value is Schema {
  return value instanceof mongoose.Schema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isObjectIdType(t: unknown): boolean {
  return t === mongoose.Schema.Types.ObjectId || t === mongoose.Types.ObjectId;
}

/**
 * Build CRUD schemas from Mongoose schema
 */
export function buildCrudSchemasFromMongooseSchema(
  mongooseSchema: Schema,
  options: SchemaBuilderOptions = {},
): CrudSchemas {
  // Use schema.paths for accurate type information
  const jsonCreate = buildJsonSchemaFromPaths(mongooseSchema, options);
  const jsonUpdate = buildJsonSchemaForUpdate(jsonCreate, options);
  const jsonParams: JsonSchema = {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } },
    required: ['id'],
  };

  // For query, still use the old tree-based approach as it's simpler for filters
  const tree = (mongooseSchema as Schema & { obj?: Record<string, unknown> })?.obj || {};
  const jsonQuery = buildJsonSchemaForQuery(tree, options);

  return {
    createBody: jsonCreate,
    updateBody: jsonUpdate,
    params: jsonParams,
    listQuery: jsonQuery,
  };
}

/**
 * Build CRUD schemas from Mongoose model
 */
export function buildCrudSchemasFromModel(
  mongooseModel: mongoose.Model<unknown>,
  options: SchemaBuilderOptions = {},
): CrudSchemas {
  if (!mongooseModel?.schema) {
    throw new Error('Invalid mongoose model');
  }
  return buildCrudSchemasFromMongooseSchema(mongooseModel.schema, options);
}

/**
 * Collect fields to omit from a generated schema based on field rules and
 * explicit omit lists. This is the single source of truth for "which fields
 * should NOT appear in the create/update body" — called by both the
 * path-based and tree-based schema builders.
 */
function collectFieldsToOmit(
  options: SchemaBuilderOptions,
  purpose: 'create' | 'update',
): Set<string> {
  const result = new Set(['createdAt', 'updatedAt', '__v']);
  const rules = options?.fieldRules || {};

  for (const [field, rule] of Object.entries(rules)) {
    if (rule.systemManaged) result.add(field);
    if (purpose === 'update' && (rule.immutable || rule.immutableAfterCreate)) {
      result.add(field);
    }
  }

  const explicit = purpose === 'create' ? options?.create?.omitFields : options?.update?.omitFields;
  if (explicit) {
    for (const f of explicit) result.add(f);
  }

  return result;
}

/**
 * Apply omissions + optional-overrides to a built JSON schema in-place.
 * Removes properties and adjusts the `required` array.
 */
function applyFieldRules(
  schema: JsonSchema,
  fieldsToOmit: Set<string>,
  options: SchemaBuilderOptions,
): void {
  for (const field of fieldsToOmit) {
    if (schema.properties?.[field]) {
      delete (schema.properties as Record<string, unknown>)[field];
    }
    if (schema.required) {
      schema.required = schema.required.filter((k) => k !== field);
    }
  }

  // Apply per-field optional overrides from fieldRules
  const rules = options?.fieldRules || {};
  for (const [field, rule] of Object.entries(rules)) {
    if (rule.optional && schema.required) {
      schema.required = schema.required.filter((k) => k !== field);
    }
  }
}

/**
 * Get fields that are immutable (cannot be updated).
 * Delegates to `collectFieldsToOmit` internally.
 */
export function getImmutableFields(options: SchemaBuilderOptions = {}): string[] {
  const immutable: string[] = [];
  const rules = options?.fieldRules || {};

  for (const [field, rule] of Object.entries(rules)) {
    if (rule.immutable || rule.immutableAfterCreate) {
      immutable.push(field);
    }
  }

  // Add explicit update.omitFields
  for (const f of options?.update?.omitFields || []) {
    if (!immutable.includes(f)) immutable.push(f);
  }

  return immutable;
}

/**
 * Get fields that are system-managed (cannot be set by users).
 */
export function getSystemManagedFields(options: SchemaBuilderOptions = {}): string[] {
  const systemManaged: string[] = [];
  const rules = options?.fieldRules || {};

  for (const [field, rule] of Object.entries(rules)) {
    if (rule.systemManaged) {
      systemManaged.push(field);
    }
  }

  return systemManaged;
}

/**
 * Check if field is allowed in update
 */
export function isFieldUpdateAllowed(
  fieldName: string,
  options: SchemaBuilderOptions = {},
): boolean {
  const immutableFields = getImmutableFields(options);
  const systemManagedFields = getSystemManagedFields(options);

  return !immutableFields.includes(fieldName) && !systemManagedFields.includes(fieldName);
}

/**
 * Validate update body against field rules
 */
export function validateUpdateBody(
  body: Record<string, unknown> = {},
  options: SchemaBuilderOptions = {},
): ValidationResult {
  const violations: ValidationResult['violations'] = [];
  const immutableFields = getImmutableFields(options);
  const systemManagedFields = getSystemManagedFields(options);

  Object.keys(body).forEach((field) => {
    if (immutableFields.includes(field)) {
      violations.push({ field, reason: 'Field is immutable' });
    } else if (systemManagedFields.includes(field)) {
      violations.push({ field, reason: 'Field is system-managed' });
    }
  });

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ==== JSON Schema helpers ====

/**
 * Build JSON schema from Mongoose schema.paths (accurate type information)
 */
function buildJsonSchemaFromPaths(
  mongooseSchema: Schema,
  options: SchemaBuilderOptions,
): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const paths = mongooseSchema.paths;
  const softRequiredSet = new Set(options?.softRequiredFields ?? []);

  const isSoftRequired = (name: string, schemaType: any): boolean => {
    if (softRequiredSet.has(name)) return true;
    return schemaType?.options?.softRequired === true;
  };

  // Group paths by their root field to handle nested objects
  const rootFields = new Map<string, { path: string; schemaType: any }[]>();

  for (const [path, schemaType] of Object.entries(paths)) {
    // Always skip __v (Mongoose version key — internal, never user-supplied).
    // Skip _id ONLY when it's the default auto-generated ObjectId. For
    // explicitly declared _id types (String, Number, UUID), include it in the
    // schema as an optional field so users can supply their own id in the
    // create body (e.g. UUIDs, sequential IDs, slugs).
    // Skip Map value-template paths (`something.$*`) — Mongoose exposes them
    // as siblings of the Map path itself; they're internal and would otherwise
    // cause the Map to be rendered as a nested object with synthetic keys.
    if (path === '__v') continue;
    if (path.includes('$*')) continue;
    if (path === '_id') {
      const instance = (schemaType as { instance?: string }).instance;
      if (!instance || isObjectIdInstance(instance)) {
        continue; // auto-generated ObjectId — skip as before
      }
      // Explicit non-ObjectId _id: fall through to include in the schema
    }

    const parts = path.split('.');
    const rootField = parts[0];

    if (!rootFields.has(rootField)) {
      rootFields.set(rootField, []);
    }
    rootFields.get(rootField)?.push({ path, schemaType });
  }

  // Convert each root field to JSON schema
  for (const [rootField, fieldPaths] of rootFields.entries()) {
    if (fieldPaths.length === 1 && fieldPaths[0].path === rootField) {
      // Simple field (not nested)
      const schemaType = fieldPaths[0].schemaType;
      properties[rootField] = schemaTypeToJsonSchema(schemaType, options);
      if (schemaType.isRequired && !isSoftRequired(rootField, schemaType)) {
        required.push(rootField);
      }
    } else {
      // Nested object - reconstruct the structure
      const nestedSchema = buildNestedJsonSchema(fieldPaths, rootField, options);
      properties[rootField] = nestedSchema.schema;
      if (nestedSchema.required) {
        required.push(rootField);
      }
    }
  }

  const schema: JsonSchema = { type: 'object', properties };
  if (required.length) schema.required = required;

  // Apply field rules (omit system-managed, apply optional overrides)
  const fieldsToOmit = collectFieldsToOmit(options, 'create');
  applyFieldRules(schema, fieldsToOmit, options);

  // Apply create-specific overrides (requiredOverrides / optionalOverrides)
  const reqOv = options?.create?.requiredOverrides || {};
  const optOv = options?.create?.optionalOverrides || {};
  schema.required = schema.required || [];

  for (const [k, v] of Object.entries(reqOv)) {
    if (v && !schema.required.includes(k)) schema.required.push(k);
  }

  for (const [k, v] of Object.entries(optOv)) {
    if (v && schema.required) schema.required = schema.required.filter((x) => x !== k);
  }

  // schemaOverrides
  const schemaOverrides = options?.create?.schemaOverrides || {};
  for (const [k, override] of Object.entries(schemaOverrides)) {
    if (schema.properties?.[k]) {
      (schema.properties as Record<string, unknown>)[k] = override;
    }
  }

  // Apply strictAdditionalProperties option
  if (options?.strictAdditionalProperties === true) {
    schema.additionalProperties = false;
  }

  return schema;
}

/**
 * Build nested JSON schema from dot-notation paths
 */
function buildNestedJsonSchema(
  fieldPaths: { path: string; schemaType: any }[],
  rootField: string,
  options: SchemaBuilderOptions = {},
): { schema: JsonSchema; required: boolean } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  let hasRequiredFields = false;

  for (const { path, schemaType } of fieldPaths) {
    const relativePath = path.substring(rootField.length + 1); // Remove 'rootField.'
    const parts = relativePath.split('.');

    if (parts.length === 1) {
      // Direct child
      properties[parts[0]] = schemaTypeToJsonSchema(schemaType, options);
      if (schemaType.isRequired) {
        required.push(parts[0]);
        hasRequiredFields = true;
      }
    } else {
      // Deeper nesting - for now, simplify by creating nested objects
      // This is a simplified approach; full nesting would require recursive structure
      const fieldName = parts[0];
      if (!properties[fieldName]) {
        properties[fieldName] = { type: 'object', properties: {} };
      }
      // For deeper paths, we'd need more complex logic
      // For now, treat as nested object with additionalProperties
      const nestedObj = properties[fieldName] as any;
      if (!nestedObj.properties) nestedObj.properties = {};

      const deepPath = parts.slice(1).join('.');
      nestedObj.properties[deepPath] = schemaTypeToJsonSchema(schemaType, options);
    }
  }

  const schema: JsonSchema = { type: 'object', properties };
  if (required.length) schema.required = required;

  return { schema, required: hasRequiredFields };
}

/**
 * Introspect the element type of a Mongoose array SchemaType and produce a
 * JSON Schema `items` clause that matches what clients will actually POST.
 *
 * Falls through four tiers so we cover every Mongoose array shape:
 *
 *   1. DocumentArray / explicit subschema — `schemaType.schema.paths` exists.
 *      Recurse into the inner paths so `[{ name, url }]` yields
 *      `items: { type: 'object', properties: { name, url }, required: [...] }`.
 *   2. Legacy Mongoose (v6/v7) — `schemaType.caster` exposes the casted
 *      element's `instance` ('String', 'Number', 'ObjectId', …).
 *   3. Modern Mongoose (v8+/v9) — `caster` is undefined for
 *      `[{ type: String }]`; the declaration lives on
 *      `schemaType.options.type[0]`. Hand it to `jsonTypeFor` which already
 *      handles bare constructors, `{ type: Fn }` shorthand, and Mixed.
 *   4. Everything else (Mixed arrays, unknown casters) — a permissive
 *      `{ type: 'object', additionalProperties: true }` so we never block a
 *      valid payload with the old `{ type: 'string' }` default.
 */
function introspectArrayItems(
  schemaType: any,
  options: SchemaBuilderOptions = {},
): Record<string, unknown> {
  if (hasInnerSchema(schemaType)) {
    return subSchemaToJsonSchema(schemaType.schema, options);
  }

  const caster = schemaType?.caster;
  if (caster && typeof caster === 'object' && 'instance' in caster && caster.instance) {
    return schemaTypeToJsonSchema(caster, options);
  }

  const declaredType = schemaType?.options?.type;
  if (Array.isArray(declaredType) && declaredType.length > 0) {
    const inner = declaredType[0];
    if (inner === mongoose.Schema.Types.Mixed) {
      return { type: 'object', additionalProperties: true };
    }
    // Pass `options` (not `{}`) so vendor-extension flags like
    // `openApiExtensions` propagate into jsonTypeFor's ObjectId-with-ref
    // branch — otherwise `[{type:ObjectId,ref:'X'}]` shorthand silently
    // drops `x-ref` even when the caller opted in.
    return jsonTypeFor(inner, options, new WeakSet());
  }

  return { type: 'object', additionalProperties: true };
}

/**
 * Convert a Mongoose sub-Schema (as found on a DocumentArray's `.schema`)
 * into a JSON Schema object clause. Unlike `buildJsonSchemaFromPaths`, this
 * does NOT apply create/update field rules — subdocument shape should faithfully
 * reflect the declared schema, not the top-level CRUD-mode omissions.
 */
function subSchemaToJsonSchema(
  subSchema: Schema,
  options: SchemaBuilderOptions = {},
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const paths = subSchema.paths ?? {};

  for (const [path, st] of Object.entries(paths)) {
    if (path === '__v') continue;
    if (path === '_id') {
      const instance = (st as { instance?: string }).instance;
      if (!instance || isObjectIdInstance(instance)) continue;
    }
    properties[path] = schemaTypeToJsonSchema(st, options);
    if ((st as { isRequired?: boolean }).isRequired) {
      required.push(path);
    }
  }

  const result: Record<string, unknown> = { type: 'object', properties };
  if (required.length) result.required = required;
  return result;
}

/**
 * Convert Mongoose SchemaType to JSON Schema
 */
function schemaTypeToJsonSchema(
  schemaType: any,
  builderOptions: SchemaBuilderOptions = {},
): Record<string, unknown> {
  // Extension point for custom Schema Types.
  //
  // Convention: if a SchemaType (or its prototype) defines its own
  // `jsonSchema()` method, we defer to it. This matches the pattern used by
  // `mongoose-schema-jsonschema` — users who already declare
  // `MyType.prototype.jsonSchema = function() { ... }` for custom types get
  // correct output here for free, with no extra wiring.
  //
  // We guard with a try/catch so a buggy third-party implementation can't
  // crash mongokit's whole schema build — the built-in introspection below
  // is always a safe fallback.
  if (typeof schemaType?.jsonSchema === 'function') {
    try {
      const custom = schemaType.jsonSchema();
      if (custom && typeof custom === 'object') {
        return custom as Record<string, unknown>;
      }
    } catch {
      // fall through to built-in introspection
    }
  }

  const result: Record<string, unknown> = {};
  const instance = schemaType.instance;
  const options = schemaType.options || {};

  // Set type
  if (instance === 'String') {
    result.type = 'string';
    // Mongoose accepts both `minlength`/`maxlength` (legacy) and `minLength`/
    // `maxLength` (modern). Take whichever is present.
    const minLen =
      typeof options.minlength === 'number'
        ? options.minlength
        : typeof options.minLength === 'number'
          ? options.minLength
          : undefined;
    const maxLen =
      typeof options.maxlength === 'number'
        ? options.maxlength
        : typeof options.maxLength === 'number'
          ? options.maxLength
          : undefined;
    if (minLen !== undefined) result.minLength = minLen;
    if (maxLen !== undefined) result.maxLength = maxLen;
    if (options.match instanceof RegExp) result.pattern = options.match.source;
    else if (typeof options.match === 'string') result.pattern = options.match;
    // Mongoose enum is either `[...values]` OR `{ values: [...], message }`.
    const enumValues = Array.isArray(options.enum)
      ? options.enum
      : options.enum && Array.isArray(options.enum.values)
        ? options.enum.values
        : undefined;
    if (enumValues) result.enum = enumValues;
  } else if (instance === 'Number') {
    result.type = 'number';
    if (typeof options.min === 'number') result.minimum = options.min;
    if (typeof options.max === 'number') result.maximum = options.max;
  } else if (instance === 'Boolean') {
    result.type = 'boolean';
  } else if (instance === 'Date') {
    result.type = 'string';
    result.format = 'date-time';
  } else if (isObjectIdInstance(instance)) {
    result.type = 'string';
    result.pattern = '^[0-9a-fA-F]{24}$';
    // Populated-ref hint — `{ type: ObjectId, ref: 'User' }` carries the
    // referenced collection. Surface it as `x-ref` (OpenAPI vendor extension)
    // ONLY when the caller opts in, because Ajv strict mode throws on any
    // unknown `x-*` keyword. Default OFF = Ajv-strict-safe for validation
    // schemas; turn ON for docgen / OpenAPI / Swagger pipelines.
    if (
      builderOptions.openApiExtensions === true &&
      typeof options.ref === 'string' &&
      options.ref.length > 0
    ) {
      result['x-ref'] = options.ref;
    }
  } else if (instance === 'Array') {
    result.type = 'array';
    result.items = introspectArrayItems(schemaType, builderOptions);
  } else if (instance === 'Map') {
    result.type = 'object';
    // `of:` defines the value type; without it, accept anything.
    const ofDef = options.of;
    if (ofDef !== undefined && ofDef !== null) {
      result.additionalProperties = jsonTypeFor(ofDef, {}, new WeakSet());
    } else {
      result.additionalProperties = true;
    }
  } else if (hasInnerSchema(schemaType)) {
    // Single-embedded subdocument — Mongoose v9 reports `instance === 'Embedded'`
    // (and occasionally 'SingleNestedPath' in older majors). Key off the
    // structural `schema.paths` signal so alternate names still route here.
    return subSchemaToJsonSchema(schemaType.schema, builderOptions);
  } else {
    result.type = 'object';
    result.additionalProperties = true;
  }

  // Universal passthroughs — apply to every type that flowed through the
  // built-in branches above. Custom-type returns (early-return at top of
  // function) skip this on purpose: the custom impl owns its own shape.

  // Nullable: `{ default: null }` widens the JSON Schema type to allow null.
  // Mirrors mongoose-schema-jsonschema's convention.
  if (options.default === null && typeof result.type === 'string') {
    result.type = [result.type, 'null'];
    result.default = null;
  }

  // OpenAPI / docgen passthroughs — only emit when the user set them, so we
  // don't pollute schemas that don't care about docs.
  if (typeof options.description === 'string' && options.description.length > 0) {
    result.description = options.description;
  }
  if (typeof options.title === 'string' && options.title.length > 0) {
    result.title = options.title;
  }

  return result;
}

function hasInnerSchema(schemaType: unknown): schemaType is { schema: Schema } {
  const inner = (schemaType as { schema?: unknown })?.schema;
  return (
    !!inner &&
    typeof inner === 'object' &&
    'paths' in (inner as Record<string, unknown>) &&
    typeof (inner as { paths?: unknown }).paths === 'object'
  );
}

function jsonTypeFor(
  def: unknown,
  options: SchemaBuilderOptions,
  seen: WeakSet<object>,
): Record<string, unknown> {
  if (Array.isArray(def)) {
    // Check if it's an array of Mixed
    if (def[0] === mongoose.Schema.Types.Mixed) {
      return { type: 'array', items: { type: 'object', additionalProperties: true } };
    }
    return { type: 'array', items: jsonTypeFor(def[0] ?? String, options, seen) };
  }

  if (isPlainObject(def) && 'type' in def) {
    const typedDef = def as Record<string, unknown>;

    if (typedDef.enum && Array.isArray(typedDef.enum) && typedDef.enum.length) {
      return { type: 'string', enum: (typedDef.enum as unknown[]).map(String) };
    }

    // Array typed via { type: [X] }
    if (Array.isArray(typedDef.type)) {
      const inner = typedDef.type[0] !== undefined ? typedDef.type[0] : String;
      // Check if it's an array of Mixed
      if (inner === mongoose.Schema.Types.Mixed) {
        return { type: 'array', items: { type: 'object', additionalProperties: true } };
      }
      return { type: 'array', items: jsonTypeFor(inner, options, seen) };
    }

    // Extract validators from Mongoose schema definition
    const validators: Record<string, unknown> = {};

    if (typedDef.type === String) {
      validators.type = 'string';
      // String validators
      if (typeof typedDef.minlength === 'number') validators.minLength = typedDef.minlength;
      if (typeof typedDef.maxlength === 'number') validators.maxLength = typedDef.maxlength;
      if (typedDef.match instanceof RegExp) validators.pattern = typedDef.match.source;
      if (typeof typedDef.lowercase === 'boolean' && typedDef.lowercase) {
        // Lowercase enforced - add pattern for lowercase only
        validators.pattern = validators.pattern ? `(?=.*[a-z])${validators.pattern}` : '^[a-z]*$';
      }
      if (typeof typedDef.uppercase === 'boolean' && typedDef.uppercase) {
        // Uppercase enforced - add pattern for uppercase only
        validators.pattern = validators.pattern ? `(?=.*[A-Z])${validators.pattern}` : '^[A-Z]*$';
      }
      if (typeof typedDef.trim === 'boolean') {
        // Note: trim is preprocessing, not a validation constraint
        // Cannot be enforced via JSON schema
      }
      return validators;
    }

    if (typedDef.type === Number) {
      validators.type = 'number';
      // Number validators
      if (typeof typedDef.min === 'number') validators.minimum = typedDef.min;
      if (typeof typedDef.max === 'number') validators.maximum = typedDef.max;
      return validators;
    }

    if (typedDef.type === Boolean) return { type: 'boolean' };
    if (typedDef.type === Date) {
      const mode = options?.dateAs || 'datetime';
      return mode === 'date'
        ? { type: 'string', format: 'date' }
        : { type: 'string', format: 'date-time' };
    }
    if (typedDef.type === Map || typedDef.type === mongoose.Schema.Types.Map) {
      const ofSchema = jsonTypeFor(typedDef.of || String, options, seen);
      return { type: 'object', additionalProperties: ofSchema };
    }
    if (typedDef.type === mongoose.Schema.Types.Mixed) {
      // Mixed type - accepts any valid JSON value
      return { type: 'object', additionalProperties: true };
    }
    if (typedDef.type === Object) {
      // Handle plain Object type - if it has nested schema properties, convert them
      if (isPlainObject(typedDef) && Object.keys(typedDef).some((k) => k !== 'type')) {
        // Has additional properties beyond 'type' - might be a structured subdocument
        const nested: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(typedDef)) {
          if (k !== 'type') nested[k] = v;
        }
        if (Object.keys(nested).length > 0) {
          if (seen.has(nested)) return { type: 'object', additionalProperties: true };
          seen.add(nested);
          return convertTreeToJsonSchema(nested, options, seen) as unknown as Record<
            string,
            unknown
          >;
        }
      }
      return { type: 'object', additionalProperties: true };
    }
    if (isObjectIdType(typedDef.type)) {
      const objIdResult: Record<string, unknown> = {
        type: 'string',
        pattern: '^[0-9a-fA-F]{24}$',
      };
      // Honor x-ref opt-in for the `[{type:ObjectId,ref:'X'}]` shorthand path
      // (this branch is reached from introspectArrayItems → jsonTypeFor).
      if (
        options?.openApiExtensions === true &&
        typeof typedDef.ref === 'string' &&
        (typedDef.ref as string).length > 0
      ) {
        objIdResult['x-ref'] = typedDef.ref;
      }
      return objIdResult;
    }
    if (isMongooseSchema(typedDef.type)) {
      const obj = (typedDef.type as Schema & { obj?: Record<string, unknown> }).obj;
      if (obj && typeof obj === 'object') {
        if (seen.has(obj)) return { type: 'object', additionalProperties: true };
        seen.add(obj);
        return convertTreeToJsonSchema(obj, options, seen) as unknown as Record<string, unknown>;
      }
    }
  }

  if (def === String) return { type: 'string' };
  if (def === Number) return { type: 'number' };
  if (def === Boolean) return { type: 'boolean' };
  if (def === Date) {
    const mode = options?.dateAs || 'datetime';
    return mode === 'date'
      ? { type: 'string', format: 'date' }
      : { type: 'string', format: 'date-time' };
  }
  if (isObjectIdType(def)) return { type: 'string', pattern: '^[0-9a-fA-F]{24}$' };
  // Bare Mongoose Schema instance — happens for `[[SubSchema]]` (array-of-
  // array of subdocs). Recurse via the same helper used by DocumentArray.
  // Pass `options` so vendor-extension flags (e.g. openApiExtensions) reach
  // the leaf path's introspection inside the sub-schema.
  if (isMongooseSchema(def)) {
    if (seen.has(def as object)) return { type: 'object', additionalProperties: true };
    seen.add(def as object);
    return subSchemaToJsonSchema(def, options);
  }
  if (isPlainObject(def)) {
    if (seen.has(def)) return { type: 'object', additionalProperties: true };
    seen.add(def);
    return convertTreeToJsonSchema(def, options, seen) as unknown as Record<string, unknown>;
  }
  return {};
}

function convertTreeToJsonSchema(
  tree: Record<string, unknown>,
  options: SchemaBuilderOptions,
  seen: WeakSet<object> = new WeakSet(),
): JsonSchema {
  if (!tree || typeof tree !== 'object') {
    return { type: 'object', properties: {} };
  }
  if (seen.has(tree)) {
    return { type: 'object', additionalProperties: true };
  }
  seen.add(tree);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries(tree || {})) {
    if (key === '__v' || key === '_id' || key === 'id') continue;
    const cfg = isPlainObject(val) && 'type' in val ? val : { type: val };
    properties[key] = jsonTypeFor(val, options, seen);
    if ((cfg as Record<string, unknown>).required === true) required.push(key);
  }

  const schema: JsonSchema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

function _buildJsonSchemaForCreate(
  tree: Record<string, unknown>,
  options: SchemaBuilderOptions,
): JsonSchema {
  const base = convertTreeToJsonSchema(tree, options, new WeakSet());

  // Collect fields to omit
  const fieldsToOmit = new Set(['createdAt', 'updatedAt', '__v']);

  // Add explicit omitFields
  (options?.create?.omitFields || []).forEach((f) => {
    fieldsToOmit.add(f);
  });

  // Auto-detect systemManaged fields from fieldRules
  const fieldRules = options?.fieldRules || {};
  Object.entries(fieldRules).forEach(([field, rules]) => {
    if (rules.systemManaged) {
      fieldsToOmit.add(field);
    }
  });

  // Apply omissions
  fieldsToOmit.forEach((field) => {
    if (base.properties?.[field]) {
      delete (base.properties as Record<string, unknown>)[field];
    }
    if (base.required) {
      base.required = base.required.filter((k) => k !== field);
    }
  });

  // Apply overrides
  const reqOv = options?.create?.requiredOverrides || {};
  const optOv = options?.create?.optionalOverrides || {};
  base.required = base.required || [];

  for (const [k, v] of Object.entries(reqOv)) {
    if (v && !base.required.includes(k)) base.required.push(k);
  }

  for (const [k, v] of Object.entries(optOv)) {
    if (v && base.required) base.required = base.required.filter((x) => x !== k);
  }

  // Auto-apply optional from fieldRules
  Object.entries(fieldRules).forEach(([field, rules]) => {
    if (rules.optional && base.required) {
      base.required = base.required.filter((x) => x !== field);
    }
  });

  // schemaOverrides
  const schemaOverrides = options?.create?.schemaOverrides || {};
  for (const [k, override] of Object.entries(schemaOverrides)) {
    if (base.properties?.[k]) {
      (base.properties as Record<string, unknown>)[k] = override;
    }
  }

  // Strict additional properties (opt-in for better security)
  if (options?.strictAdditionalProperties === true) {
    base.additionalProperties = false;
  }

  return base;
}

function buildJsonSchemaForUpdate(
  createJson: JsonSchema,
  options: SchemaBuilderOptions,
): JsonSchema {
  const clone = JSON.parse(JSON.stringify(createJson)) as JsonSchema;
  delete clone.required;

  // Omit immutable + system-managed + explicit omitFields via shared helper
  const fieldsToOmit = collectFieldsToOmit(options, 'update');
  applyFieldRules(clone, fieldsToOmit, options);

  // Strict additional properties (opt-in for better security)
  if (options?.strictAdditionalProperties === true) {
    clone.additionalProperties = false;
  }

  // Require at least one field to be provided (prevents empty update payloads)
  if (options?.update?.requireAtLeastOne === true) {
    clone.minProperties = 1;
  }

  return clone;
}

function buildJsonSchemaForQuery(
  _tree: Record<string, unknown>,
  options: SchemaBuilderOptions,
): JsonSchema {
  // Query-string params arrive as strings over HTTP, but Fastify's default
  // validator coerces them per the declared type (`coerceTypes: 'array'`).
  // Declaring the semantic type — not `string` — lets Ajv reject bad values
  // (`?page=0`, `?lean=maybe`) AND gives handlers typed values. Mixing
  // `{type:'string', minimum:N}` with downstream validators produces an Ajv
  // strict-mode warning ("keyword minimum is not allowed for type string")
  // which is the tell that the old declarations were wrong.
  //
  // Runtime limit/page enforcement still happens on the Repository
  // (`defaultLimit`, `maxLimit`, `maxPage`); the schema just needs to be
  // permissive-but-well-typed so downstream merges don't flag warnings.
  const basePagination: JsonSchema = {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, default: 20 },
      sort: { type: 'string' },
      populate: { type: 'string' },
      search: { type: 'string' },
      select: { type: 'string' },
      after: { type: 'string' }, // keyset-pagination cursor (opaque base64)
      lean: { type: 'boolean', default: false },
      includeDeleted: { type: 'boolean', default: false },
    },
    additionalProperties: true,
  };

  const filterable = options?.query?.filterableFields || {};
  for (const [k, v] of Object.entries(filterable)) {
    if (basePagination.properties) {
      (basePagination.properties as Record<string, unknown>)[k] =
        v && typeof v === 'object' && 'type' in v ? v : { type: 'string' };
    }
  }

  return basePagination;
}
