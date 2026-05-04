/**
 * Utility Functions for MongoKit
 * Reusable helpers for field selection, filtering, query parsing, and schema generation
 */

// Cache-key builders moved to `@classytic/repo-core/cache` (`buildCacheKey`,
// `tagIndexKey`, `versionKey`) — import from there directly. Mongokit's
// local copies were redundant once the unified cache plugin shipped.

// Error utilities
export { createError } from './error.js';
export {
  createFieldPreset,
  filterResponseData,
  getFieldsForUser,
  getMongooseProjection,
} from './field-selection.js';
// ID resolution — detect _id type from schema, validate id values pre-query
export {
  getSchemaIdType,
  type IdType,
  isObjectIdInstance,
  isValidIdForType,
} from './id-resolution.js';

// Logger
export { configureLogger } from './logger.js';

// Cache utilities
export { createMemoryCache } from './memory-cache.js';
// Mongoose → JSON Schema converter. Policy helpers
// (`getImmutableFields`, `getSystemManagedFields`, `isFieldUpdateAllowed`,
// `validateUpdateBody`) live in `@classytic/repo-core/schema` so every kit
// shares identical semantics — import them from there when you need them.
export {
  buildCrudSchemasFromModel,
  buildCrudSchemasFromMongooseSchema,
} from './mongooseToJsonSchema.js';
