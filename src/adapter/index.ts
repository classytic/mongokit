/**
 * Public entry for the `adapter` subpath — Mongoose data adapter.
 *
 * Produces a framework-agnostic `DataAdapter<TDoc>` from
 * `@classytic/repo-core/adapter`. Any HTTP framework that consumes that
 * contract can wire this adapter into its resource layer; mongokit
 * never imports the framework.
 *
 * @example
 * ```ts
 * import { createMongooseAdapter } from '@classytic/mongokit/adapter';
 * import { buildCrudSchemasFromModel } from '@classytic/mongokit';
 *
 * const adapter = createMongooseAdapter({
 *   model: ProductModel,
 *   repository: productRepository,
 *   schemaGenerator: buildCrudSchemasFromModel,
 * });
 *
 * // Hand `adapter` to any host that consumes `DataAdapter<TDoc>`
 * // (e.g. arc 3.x's `defineResource({ adapter, ... })`).
 * ```
 */

export type { MongooseAdapterOptions } from './mongoose-adapter.js';
export { createMongooseAdapter, MongooseAdapter } from './mongoose-adapter.js';
export type {
  CleanDoc,
  InferAdapterDoc,
  InferMongooseDoc,
  InferRepoDoc,
  MatchingModel,
  MongooseDocument,
  MongooseSchemaType,
} from './types.js';
export { isMongooseModel } from './types.js';
