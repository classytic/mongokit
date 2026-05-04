/**
 * Mongoose-specific type helpers for the framework adapter.
 *
 * Internal mongokit types — exposed alongside `createMongooseAdapter` so
 * hosts that want to infer document types from a Mongoose model (rather
 * than from a `Repository<TDoc>`) have the standard utilities at hand.
 */

import type { StandardRepo } from '@classytic/repo-core/repository';
import type { Document, Model } from 'mongoose';

/**
 * Infer document type from a Mongoose model.
 *
 * @example
 * const ProductModel = mongoose.model('Product', productSchema);
 * type ProductDoc = InferMongooseDoc<typeof ProductModel>;
 */
export type InferMongooseDoc<M> = M extends Model<infer D> ? D : never;

/**
 * Infer document type from a `Repository<TDoc>` / `StandardRepo<TDoc>`.
 */
export type InferRepoDoc<R> = R extends StandardRepo<infer D> ? D : never;

/**
 * Infer document type from a `DataAdapter`.
 */
export type InferAdapterDoc<A> = A extends { repository: StandardRepo<infer D> } ? D : never;

/**
 * Strip Mongoose-specific surface from a hydrated document type.
 */
export type CleanDoc<T> = T extends Document
  ? Omit<T, keyof Document | '_id' | '__v' | '$__' | '$isNew' | 'save' | 'remove'>
  : T;

/**
 * Mongoose document with index signature — usable as a generic constraint.
 */
export type MongooseDocument = Document & Record<string, unknown>;

/**
 * Pin a Mongoose model's document type to match a repository's document type.
 */
export type MatchingModel<TDoc> = Model<TDoc & Document>;

/**
 * Runtime guard: is `value` a Mongoose model?
 */
export function isMongooseModel(value: unknown): value is Model<Document> {
  return (
    typeof value === 'function' && value.prototype && 'modelName' in value && 'schema' in value
  );
}

/**
 * Mongoose SchemaType internal shape (not fully exposed by `@types/mongoose`).
 * Used to extract field metadata from schema paths.
 */
export interface MongooseSchemaType {
  instance: string;
  isRequired?: boolean;
  options?: {
    ref?: string;
    enum?: Array<string | number>;
    minlength?: number;
    maxlength?: number;
    min?: number;
    max?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
