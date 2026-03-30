/**
 * Utility Functions for MongoKit
 * Reusable helpers for field selection, filtering, query parsing, and schema generation
 */

export {
  byIdKey,
  byQueryKey,
  listPattern,
  listQueryKey,
  modelPattern,
  versionKey,
} from './cache-keys.js';
// Error utilities
export { createError } from './error.js';
export {
  createFieldPreset,
  filterResponseData,
  getFieldsForUser,
  getMongooseProjection,
} from './field-selection.js';

// Logger
export { configureLogger } from './logger.js';

// Cache utilities
export { createMemoryCache } from './memory-cache.js';
// Mongoose to JSON Schema converter for Fastify/OpenAPI
export {
  buildCrudSchemasFromModel,
  buildCrudSchemasFromMongooseSchema,
  getImmutableFields,
  getSystemManagedFields,
  isFieldUpdateAllowed,
  validateUpdateBody,
} from './mongooseToJsonSchema.js';
