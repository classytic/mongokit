/**
 * Utility Functions for MongoKit
 * Reusable helpers for field selection, filtering, query parsing, and schema generation
 */

// Cache-key builders moved to `@classytic/repo-core/cache` (`buildCacheKey`,
// `tagIndexKey`, `versionKey`) — import from there directly. Mongokit's
// local copies were redundant once the unified cache plugin shipped.

// Error utilities
export type { CreateErrorOptions, ParseDuplicateKeyOptions } from './error.js';
export { createError } from './error.js';
export {
  createFieldPreset,
  filterResponseData,
  getFieldsForUser,
  getMongooseProjection,
} from './field-selection.js';
// Shared id-set primitives for both chunking idioms — snapshot-then-act
// (collectIds/idChunks) and progressive keyset (keysetFilter/selectKeysetChunk/
// narrowToIds); the module docblock says when each applies
export {
  collectIds,
  DEFAULT_ID_CHUNK,
  idChunks,
  keysetFilter,
  narrowToIds,
  selectKeysetChunk,
} from './id-chunks.js';
// ID resolution — detect _id type from schema, validate id values pre-query;
// null-tolerant string → ObjectId coercion for optional reference fields
export {
  getSchemaIdType,
  type IdType,
  isObjectIdInstance,
  isValidIdForType,
  toObjectId,
} from './id-resolution.js';

// Logger
export type { LoggerConfig } from './logger.js';
export { configureLogger } from './logger.js';
// Cache utilities
export { createMemoryCache } from './memory-cache.js';
// Mongoose → JSON Schema converter. Policy helpers
// (`getImmutableFields`, `getSystemManagedFields`, `isFieldUpdateAllowed`,
// `validateUpdateBody`) live in `@classytic/repo-core/schema` so every kit
// shares identical semantics — import them from there when you need them.
export type { CrudSchemasFramework } from './mongooseToJsonSchema.js';
export {
  buildCrudSchemasFromModel,
  buildCrudSchemasFromMongooseSchema,
} from './mongooseToJsonSchema.js';
// Spread-safety for hydrated (sub)documents in domain verbs
export { toPlain } from './to-plain.js';
