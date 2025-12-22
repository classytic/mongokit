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
 * 
 * @example
 * buildCrudSchemasFromModel(Model, {
 *   strictAdditionalProperties: true, // Reject unknown fields
 *   fieldRules: {
 *     organizationId: { immutable: true },
 *     status: { systemManaged: true },
 *   },
 *   create: { omitFields: ['verifiedAt'] },
 *   update: { omitFields: ['customerId'] }
 * })
 */

import mongoose, { Schema } from 'mongoose';
import type { SchemaBuilderOptions, JsonSchema, CrudSchemas, ValidationResult } from '../types.js';

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
  options: SchemaBuilderOptions = {}
): CrudSchemas {
  const tree = (mongooseSchema as Schema & { obj?: Record<string, unknown> })?.obj || {};

  // Always generate JSON schemas
  const jsonCreate = buildJsonSchemaForCreate(tree, options);
  const jsonUpdate = buildJsonSchemaForUpdate(jsonCreate, options);
  const jsonParams: JsonSchema = {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } },
    required: ['id'],
  };
  const jsonQuery = buildJsonSchemaForQuery(tree, options);

  return { createBody: jsonCreate, updateBody: jsonUpdate, params: jsonParams, listQuery: jsonQuery };
}

/**
 * Build CRUD schemas from Mongoose model
 */
export function buildCrudSchemasFromModel(
  mongooseModel: mongoose.Model<unknown>,
  options: SchemaBuilderOptions = {}
): CrudSchemas {
  if (!mongooseModel || !mongooseModel.schema) {
    throw new Error('Invalid mongoose model');
  }
  return buildCrudSchemasFromMongooseSchema(mongooseModel.schema, options);
}

/**
 * Get fields that are immutable (cannot be updated)
 */
export function getImmutableFields(options: SchemaBuilderOptions = {}): string[] {
  const immutable: string[] = [];
  const fieldRules = options?.fieldRules || {};

  Object.entries(fieldRules).forEach(([field, rules]) => {
    if (rules.immutable || rules.immutableAfterCreate) {
      immutable.push(field);
    }
  });

  // Add explicit update.omitFields
  (options?.update?.omitFields || []).forEach(f => {
    if (!immutable.includes(f)) immutable.push(f);
  });

  return immutable;
}

/**
 * Get fields that are system-managed (cannot be set by users)
 */
export function getSystemManagedFields(options: SchemaBuilderOptions = {}): string[] {
  const systemManaged: string[] = [];
  const fieldRules = options?.fieldRules || {};

  Object.entries(fieldRules).forEach(([field, rules]) => {
    if (rules.systemManaged) {
      systemManaged.push(field);
    }
  });

  return systemManaged;
}

/**
 * Check if field is allowed in update
 */
export function isFieldUpdateAllowed(fieldName: string, options: SchemaBuilderOptions = {}): boolean {
  const immutableFields = getImmutableFields(options);
  const systemManagedFields = getSystemManagedFields(options);

  return !immutableFields.includes(fieldName) && !systemManagedFields.includes(fieldName);
}

/**
 * Validate update body against field rules
 */
export function validateUpdateBody(
  body: Record<string, unknown> = {},
  options: SchemaBuilderOptions = {}
): ValidationResult {
  const violations: ValidationResult['violations'] = [];
  const immutableFields = getImmutableFields(options);
  const systemManagedFields = getSystemManagedFields(options);

  Object.keys(body).forEach(field => {
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

function jsonTypeFor(
  def: unknown,
  options: SchemaBuilderOptions,
  seen: WeakSet<object>
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
    
    if (typedDef.type === String) return { type: 'string' };
    if (typedDef.type === Number) return { type: 'number' };
    if (typedDef.type === Boolean) return { type: 'boolean' };
    if (typedDef.type === Date) {
      const mode = options?.dateAs || 'datetime';
      return mode === 'date' ? { type: 'string', format: 'date' } : { type: 'string', format: 'date-time' };
    }
    if (typedDef.type === Map || typedDef.type === mongoose.Schema.Types.Map) {
      const ofSchema = jsonTypeFor(typedDef.of || String, options, seen);
      return { type: 'object', additionalProperties: ofSchema };
    }
    if (typedDef.type === mongoose.Schema.Types.Mixed) {
      // Mixed type - accepts any valid JSON value
      return { type: 'object', additionalProperties: true };
    }
    if (isObjectIdType(typedDef.type)) {
      return { type: 'string', pattern: '^[0-9a-fA-F]{24}$' };
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
    return mode === 'date' ? { type: 'string', format: 'date' } : { type: 'string', format: 'date-time' };
  }
  if (isObjectIdType(def)) return { type: 'string', pattern: '^[0-9a-fA-F]{24}$' };
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
  seen: WeakSet<object> = new WeakSet()
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

function buildJsonSchemaForCreate(
  tree: Record<string, unknown>,
  options: SchemaBuilderOptions
): JsonSchema {
  const base = convertTreeToJsonSchema(tree, options, new WeakSet());

  // Collect fields to omit
  const fieldsToOmit = new Set(['createdAt', 'updatedAt', '__v']);

  // Add explicit omitFields
  (options?.create?.omitFields || []).forEach(f => fieldsToOmit.add(f));

  // Auto-detect systemManaged fields from fieldRules
  const fieldRules = options?.fieldRules || {};
  Object.entries(fieldRules).forEach(([field, rules]) => {
    if (rules.systemManaged) {
      fieldsToOmit.add(field);
    }
  });

  // Apply omissions
  fieldsToOmit.forEach(field => {
    if (base.properties?.[field]) {
      delete (base.properties as Record<string, unknown>)[field];
    }
    if (base.required) {
      base.required = base.required.filter(k => k !== field);
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
    if (v && base.required) base.required = base.required.filter(x => x !== k);
  }

  // Auto-apply optional from fieldRules
  Object.entries(fieldRules).forEach(([field, rules]) => {
    if (rules.optional && base.required) {
      base.required = base.required.filter(x => x !== field);
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
  options: SchemaBuilderOptions
): JsonSchema {
  const clone = JSON.parse(JSON.stringify(createJson)) as JsonSchema;
  delete clone.required;

  // Collect fields to omit
  const fieldsToOmit = new Set<string>();

  // 1. Explicit omitFields
  (options?.update?.omitFields || []).forEach(f => fieldsToOmit.add(f));

  // 2. Auto-detect immutable fields from fieldRules
  const fieldRules = options?.fieldRules || {};
  Object.entries(fieldRules).forEach(([field, rules]) => {
    if (rules.immutable || rules.immutableAfterCreate) {
      fieldsToOmit.add(field);
    }
  });

  // Apply omissions
  fieldsToOmit.forEach(field => {
    if (clone.properties?.[field]) {
      delete (clone.properties as Record<string, unknown>)[field];
    }
  });

  // Strict additional properties (opt-in for better security)
  if (options?.strictAdditionalProperties === true) {
    clone.additionalProperties = false;
  }

  return clone;
}

function buildJsonSchemaForQuery(
  _tree: Record<string, unknown>,
  options: SchemaBuilderOptions
): JsonSchema {
  const basePagination: JsonSchema = {
    type: 'object',
    properties: {
      page: { type: 'string' },
      limit: { type: 'string' },
      sort: { type: 'string' },
      populate: { type: 'string' },
      search: { type: 'string' },
      select: { type: 'string' },
      lean: { type: 'string' },
      includeDeleted: { type: 'string' },
    },
    additionalProperties: true,
  };

  const filterable = options?.query?.filterableFields || {};
  for (const [k, v] of Object.entries(filterable)) {
    if (basePagination.properties) {
      (basePagination.properties as Record<string, unknown>)[k] = v && typeof v === 'object' && 'type' in v ? v : { type: 'string' };
    }
  }

  return basePagination;
}

export default {
  buildCrudSchemasFromMongooseSchema,
  buildCrudSchemasFromModel,
  getImmutableFields,
  getSystemManagedFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
};
