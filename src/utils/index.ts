/**
 * Utility Functions for MongoKit
 * Reusable helpers for field selection, filtering, query parsing, and schema generation
 */

export {
  getFieldsForUser,
  getMongooseProjection,
  filterResponseData,
  createFieldPreset,
} from './field-selection.js';

// Mongoose to JSON Schema converter for Fastify/OpenAPI
export {
  buildCrudSchemasFromMongooseSchema,
  buildCrudSchemasFromModel,
  getImmutableFields,
  getSystemManagedFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
} from './mongooseToJsonSchema.js';

// Error utilities
export { createError } from './error.js';

// Cache utilities
export { createMemoryCache } from './memory-cache.js';
export {
  byIdKey,
  byQueryKey,
  listQueryKey,
  versionKey,
  modelPattern,
  listPattern,
} from './cache-keys.js';