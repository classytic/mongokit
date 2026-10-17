/**
 * Core query/document primitives shared across every mongokit module —
 * sort/select/populate/filter specs and the mongoose-facing aliases.
 *
 * Also the home of the `softRequired` Mongoose declaration merge (this file
 * is loaded by every module, so the augmentation is always in the program).
 */

/**
 * Global declaration merge: adds `softRequired` to Mongoose's SchemaTypeOptions
 * so consumers can annotate paths type-safely without importing anything.
 *
 * A path with `softRequired: true` keeps its DB-level `required: true`
 * invariant but is excluded from the auto-generated CRUD body `required[]`
 * array (see buildCrudSchemasFromModel).
 */
declare module 'mongoose' {
  interface SchemaTypeOptions<
    T,
    EnforcedDocType = any,
    THydratedDocumentType = HydratedDocument<EnforcedDocType>,
  > {
    /** mongokit: omit from auto-generated CRUD body `required` array. */
    softRequired?: boolean;
  }
}

import type { Document, Model, PopulateOptions, Types } from 'mongoose';

/** Read Preference Type for replica sets */
export type ReadPreferenceType =
  | 'primary'
  | 'primaryPreferred'
  | 'secondary'
  | 'secondaryPreferred'
  | 'nearest'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** Re-export mongoose ObjectId */
export type ObjectId = Types.ObjectId;

/** Generic document type */
export type AnyDocument = Document & Record<string, unknown>;

/** Generic model type */
export type AnyModel = Model<AnyDocument>;

/** Sort direction */
export type SortDirection = 1 | -1;

/** Sort specification for MongoDB queries */
export type SortSpec = Record<string, SortDirection>;

/** Populate specification */
export type PopulateSpec = string | string[] | PopulateOptions | PopulateOptions[];

/**
 * Select specification. `readonly string[]` widens the legacy `string[]`
 * form to also accept the immutable variant repo-core's contract uses
 * (`LookupPopulateOptions.select: readonly string[] | Record<string, 0
 * | 1>`), so `Repository<TDoc>` assigns to `StandardRepo<TDoc>` without
 * TS2322 on the `select` field. Any existing mutable-array caller stays
 * compatible — `string[]` is assignable to `readonly string[]`.
 */
export type SelectSpec = string | readonly string[] | Record<string, 0 | 1>;

/** Filter query type for MongoDB queries (compatible with Mongoose 8 & 9) */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type FilterQuery<_T = unknown> = Record<string, unknown>;
