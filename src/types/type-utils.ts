/**
 * Type-level utilities — model inference, mapped-type helpers, and the
 * write-payload shapes (`CreateInput` / `UpdatePatch` / `MongoOperatorUpdate`).
 */

import type { ValidationResult } from '@classytic/repo-core/schema';
import type { Document, Model } from 'mongoose';

/**
 * Infer document type from a Mongoose Model
 * @example
 * type UserDoc = InferDocument<typeof UserModel>;
 */
export type InferDocument<TModel> = TModel extends Model<infer TDoc> ? TDoc : never;

/**
 * Infer raw document shape (without Mongoose Document methods)
 * @example
 * type User = InferRawDoc<typeof UserModel>;
 */
export type InferRawDoc<TModel> =
  TModel extends Model<infer TDoc>
    ? TDoc extends Document
      ? Omit<TDoc, keyof Document>
      : TDoc
    : never;

/**
 * Make specific fields optional
 * @example
 * type CreateUser = PartialBy<User, 'createdAt' | 'updatedAt'>;
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Make specific fields required
 * @example
 * type UserWithId = RequiredBy<User, '_id'>;
 */
export type RequiredBy<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;

/**
 * Extract keys of type T that have values of type V
 * @example
 * type StringFields = KeysOfType<User, string>; // 'name' | 'email'
 */
export type KeysOfType<T, V> = {
  [K in keyof T]: T[K] extends V ? K : never;
}[keyof T];

/**
 * Deep partial - makes all nested properties optional
 */
export type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T;

/**
 * Strict object type - prevents excess properties
 * Use with `satisfies` for compile-time validation
 */
export type Strict<T> = T & { [K in Exclude<string, keyof T>]?: never };

/**
 * NonNullable fields extractor
 */
export type NonNullableFields<T> = {
  [K in keyof T]: NonNullable<T[K]>;
};

/**
 * Create/Update input types from document
 */
export type CreateInput<TDoc> = Omit<TDoc, '_id' | 'createdAt' | 'updatedAt' | '__v'>;

/**
 * Partial-document update patch — the shape `repo.update(id, data)` accepts
 * for its `data` parameter. A `Partial<TDoc>` minus the fields a caller must
 * never set directly (`_id`, `createdAt`, `__v`).
 *
 * **Renamed from `UpdateInput<TDoc>` in 3.11.0** to eliminate a name
 * collision with `@classytic/repo-core/update`'s `UpdateInput` (the
 * `UpdateSpec | Record | Record[]` union consumed by `updateMany` /
 * `findOneAndUpdate`).
 */
export type UpdatePatch<TDoc> = Partial<Omit<TDoc, '_id' | 'createdAt' | '__v'>>;

/**
 * Typed Mongo update document — the operator-shape that `findOneAndUpdate`
 * / `updateMany` accept on the wire (`{ $set, $inc, $unset, ... }`).
 *
 * The explicit operator keys give IDE autocomplete + per-operator value
 * typing; the trailing `[op: string]: unknown` index signature lets a
 * caller-built `MongoOperatorUpdate` value assign to `Record<string,
 * unknown>` without a cast — matching repo-core's `UpdateInput` slot
 * (`UpdateSpec | Record<string, unknown> | Record<string, unknown>[]`)
 * and unblocking the historic
 *
 *   `normalizeUpdate(update) as unknown as Record<string, unknown>`
 *
 * footgun every domain package eventually wrote.
 *
 * Trade-off: with the index signature, an operator typo (`$st` instead
 * of `$set`) won't fail TypeScript — Mongo would silently drop it. The
 * common operators are listed explicitly so `obj.$set` / `obj.$inc`
 * autocomplete stays useful; the escape hatch covers everything else
 * (`$min`, `$max`, `$rename`, `$pop`, etc.).
 *
 * @example
 * ```ts
 * import type { MongoOperatorUpdate } from '@classytic/mongokit';
 *
 * const patch: MongoOperatorUpdate = {
 *   $set: { status: 'paid', paidAt: new Date() },
 *   $inc: { revision: 1 },
 * };
 * await repo.findOneAndUpdate({ _id: id }, patch);  // no cast
 * ```
 */
export interface MongoOperatorUpdate {
  /** Assign top-level or dotted-path values. */
  $set?: Record<string, unknown>;
  /** Set only on insert (upsert path). */
  $setOnInsert?: Record<string, unknown>;
  /** Remove fields (`Mongo` accepts `''`, `1`, or `true`). */
  $unset?: Record<string, '' | 1 | true>;
  /** Atomic numeric increment / decrement. */
  $inc?: Record<string, number>;
  /** Atomic numeric multiplication. */
  $mul?: Record<string, number>;
  /** Push to array (or `{ $each, $position, $slice, $sort }`). */
  $push?: Record<string, unknown>;
  /** Pull matching values from array. */
  $pull?: Record<string, unknown>;
  /** Pull a list of literals from array. */
  $pullAll?: Record<string, unknown[]>;
  /** Push only when not already present. */
  $addToSet?: Record<string, unknown>;
  /** Remove first / last element (`-1` / `1`). */
  $pop?: Record<string, -1 | 1>;
  /** Set only when the new value is smaller / larger. */
  $min?: Record<string, unknown>;
  $max?: Record<string, unknown>;
  /** Rename top-level fields. */
  $rename?: Record<string, string>;
  /** Auto-set Date / Timestamp on this update. */
  $currentDate?: Record<string, true | { $type: 'date' | 'timestamp' }>;
  /** Bitwise ops on integer fields. */
  $bit?: Record<string, { and?: number; or?: number; xor?: number }>;
  /**
   * Escape hatch for any operator not explicitly listed above (e.g.
   * positional-array operators like `$[<identifier>]` inside a path
   * key). Index signature is what makes the type assign to
   * `Record<string, unknown>` without a cast.
   */
  [op: string]: unknown;
}

/**
 * Extract string keys from a document type, with `string` fallback for untyped usage.
 * Provides autocomplete for known fields while still accepting arbitrary strings
 * (e.g. for nested paths like 'address.city').
 */
export type DocField<TDoc> = (keyof TDoc & string) | (string & {});

/**
 * Union emitted by the validation-chain plugin. Keeps the violation shape
 * from `ValidationResult` without re-exporting the type — consumers that
 * need `ValidationResult`, `CrudSchemas`, `JsonSchema`, `SchemaBuilderOptions`,
 * `FieldRule` or `FieldRules` import them straight from
 * `@classytic/repo-core/schema`.
 */
export type UpdateWithValidationResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: {
        code: number;
        message: string;
        violations?: ValidationResult['violations'];
      };
    };
