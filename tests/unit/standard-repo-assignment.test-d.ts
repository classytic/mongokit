/**
 * Compile-time assertion: Repository<TDoc> assigns to MinimalRepo<TDoc>
 * and StandardRepo<TDoc> from @classytic/repo-core without casts.
 *
 * This is the conformance gate: if it compiles, arc's BaseController,
 * createMongooseAdapter, and repositoryAs{Audit,Outbox,Idempotency}Store
 * accept mongokit repos without `as unknown as RepositoryLike<TDoc>`
 * wrappers. Every drift between mongokit types and repo-core types
 * shows up here as a TS2345 / TS2322.
 */
import type { Document, Types } from 'mongoose';
import type { MinimalRepo, StandardRepo } from '@classytic/repo-core/repository';
import type { Repository } from '../../src/Repository.js';

interface Branch extends Document {
  _id: Types.ObjectId;
  code: string;
  name: string;
}

/**
 * Arc 2.10's `RepositoryLike<TDoc>` — inlined here to avoid a dev-dep
 * cycle. Keep in sync with `@classytic/arc`'s `adapters/interface.ts`.
 *
 * `Partial<StandardRepo<TDoc>>` converts methods into optional function-
 * typed properties, which engages `strictFunctionTypes` contravariance —
 * that's the assignability check arc consumers trip on. Assigning
 * `Repository<TDoc>` to this alias reproduces the exact arc boundary.
 */
type RepositoryLike<TDoc = unknown> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>;

declare const repo: Repository<Branch>;

// ── Whole-interface structural assignment ──────────────────────────────
// If any optional method's signature drifts from repo-core, these three
// assignments fail at compile time.
const asMinimal: MinimalRepo<Branch> = repo;
const asStandard: StandardRepo<Branch> = repo;
const asRepositoryLike: RepositoryLike<Branch> = repo;

void asMinimal;
void asStandard;
void asRepositoryLike;

// ── Per-method structural lockdown ─────────────────────────────────────
// TypeScript method-shorthand uses bivariant parameter checks, so some
// signature drifts pass whole-interface assignment. Force strict
// function-type variance per method by assigning each optional method
// to its function-typed field on RepositoryLike (which goes through
// Partial<StandardRepo> and engages strictFunctionTypes).
//
// Each line here is one claim from the community drift inventory. If a
// line errors, that specific method has drifted — fix it in isolation.
type Method<K extends keyof RepositoryLike<Branch>> = NonNullable<RepositoryLike<Branch>[K]>;

const mLookupPopulate: Method<'lookupPopulate'> = repo.lookupPopulate.bind(repo);
const mGetOne: Method<'getOne'> = repo.getOne.bind(repo);
const mGetByQuery: Method<'getByQuery'> = repo.getByQuery.bind(repo);
const mFindAll: Method<'findAll'> = repo.findAll.bind(repo);
const mGetOrCreate: Method<'getOrCreate'> = repo.getOrCreate.bind(repo);
const mCount: Method<'count'> = repo.count.bind(repo);
const mExists: Method<'exists'> = repo.exists.bind(repo);
const mDistinct: Method<'distinct'> = repo.distinct.bind(repo);
const mFindOneAndUpdate: Method<'findOneAndUpdate'> = repo.findOneAndUpdate.bind(repo);
const mAggregatePaginate: Method<'aggregatePaginate'> = repo.aggregatePaginate.bind(repo);
const mAggregate: Method<'aggregate'> = repo.aggregate.bind(repo);
const mCreateMany: Method<'createMany'> = repo.createMany.bind(repo);
const mIsDuplicateKeyError: Method<'isDuplicateKeyError'> =
  repo.isDuplicateKeyError.bind(repo);
const mWithTransaction: Method<'withTransaction'> = repo.withTransaction.bind(repo);

// `updateMany` + `deleteMany` are class primitives as of mongokit 3.11.0,
// matching the repo-core 0.2.0 contract that promotes them from optional
// to required on `StandardRepo`. Per-method bindings lock down the
// signatures against silent drift at the class boundary.
const mUpdateMany: Method<'updateMany'> = repo.updateMany.bind(repo);
const mDeleteMany: Method<'deleteMany'> = repo.deleteMany.bind(repo);

// NOTE: `bulkWrite` is still contributed by `batchOperationsPlugin` at
// runtime — it stays optional on `StandardRepo` (no clean SQL analogue)
// and therefore isn't declared on the class. The whole-interface
// assignment above (`asRepositoryLike`) already covers its optionality.

void mLookupPopulate;
void mGetOne;
void mGetByQuery;
void mFindAll;
void mGetOrCreate;
void mCount;
void mExists;
void mDistinct;
void mFindOneAndUpdate;
void mAggregatePaginate;
void mAggregate;
void mCreateMany;
void mIsDuplicateKeyError;
void mWithTransaction;
void mUpdateMany;
void mDeleteMany;

// ── Direct function-arg passing (the original arc BaseController repro) ─
// The community-reported TS2345 was at call sites like
// `new BaseController(repo, ...)` — i.e. `repo` passed as a function
// argument typed `RepositoryLike<TDoc>`. Reproduce that path here so any
// regression to the originally reported bug is caught.
function acceptRepositoryLike<T>(_r: RepositoryLike<T>): void {}
acceptRepositoryLike<Branch>(repo);

// ── Filter IR call-site contravariance (drift claim C) ─────────────────
// Claim: consumers typed against `StandardRepo<TDoc>` may pass Filter IR
// (`and(eq('code', 'x'))`) to read methods; mongokit historically typed
// these as `Record<string, unknown>` which fails contravariance.
// Verify that routing through the StandardRepo reference accepts both
// plain records AND Filter IR nodes, exercising the through-contract path.
declare const asStandardRef: StandardRepo<Branch>;
declare const filterIR: import('@classytic/repo-core/filter').Filter;
declare const filterRecord: Record<string, unknown>;

void asStandardRef.getOne?.(filterRecord);
void asStandardRef.getOne?.(filterIR);
void asStandardRef.getByQuery?.(filterRecord);
void asStandardRef.getByQuery?.(filterIR);
void asStandardRef.findAll?.(filterRecord);
void asStandardRef.findAll?.(filterIR);
void asStandardRef.count?.(filterRecord);
void asStandardRef.count?.(filterIR);
void asStandardRef.exists?.(filterRecord);
void asStandardRef.exists?.(filterIR);
void asStandardRef.distinct?.('code', filterRecord);
void asStandardRef.distinct?.('code', filterIR);
void asStandardRef.findOneAndUpdate?.(filterIR, { $set: { name: 'x' } });
void asStandardRef.getOrCreate?.(filterIR, { code: 'x' });

// ── Schema generator assignment (arc adapter boundary) ─────────────────
// `buildCrudSchemasFromModel` is wired into arc's
// `MongooseAdapterOptions.schemaGenerator`, typed as
// `(model, opts?, ctx?) => OpenApiSchemas | Record<string, unknown>`.
// `CrudSchemas` itself doesn't carry an index signature (intentional —
// it's a closed 4-field contract in repo-core), so the kit widens its
// return to `CrudSchemas & Record<string, unknown>`. If a future change
// narrows the return back to `CrudSchemas`, this assignment fails and
// arc consumers re-acquire the `as unknown as Record<string, unknown>`
// cast we just removed.
import type { Model } from 'mongoose';
import { buildCrudSchemasFromModel } from '../../src/utils/mongooseToJsonSchema.js';
type SchemaGenFn = (
  model: Model<unknown>,
  options?: Record<string, unknown>,
) => Record<string, unknown>;
const schemaGen: SchemaGenFn = buildCrudSchemasFromModel;
void schemaGen;

// ── Public type-export lock-in (mongokit-owned types only) ─────────────
// 3.12 completes the "single source of truth" migration: types owned by
// repo-core are imported from repo-core, NOT re-exported from mongokit.
// The two-paths-for-one-type pattern caused docs / dist / consumers to
// drift silently in 3.10–3.11. This file locks the boundary:
//
//   - Mongokit-owned types (declared in `src/types.ts`) MUST stay in the
//     barrel — consumers have nowhere else to import them from.
//   - Repo-core-owned types are NOT imported here; consumers go to
//     `@classytic/repo-core/{pagination,errors,schema,...}` directly
//     (CHANGELOG 3.12.0 documents the breaking removal).
//
// Adding a mongokit-owned type to `docs/TYPES_GUIDE.md`? Add a probe
// here too — `tsc -p tsconfig.tests.json` (wired into `prepublishOnly`)
// fails with TS2305 / TS2614 if the barrel ever drops it.
// Pin: `MongoOperatorUpdate` MUST assign to `Record<string, unknown>`
// without a cast — that's the entire reason the type carries an index
// signature. If the index signature is removed, this assignment fails
// at TS2322 and the conformance gate goes red.
import type { MongoOperatorUpdate as Probe_MongoOperatorUpdate } from '../../src/index.js';
type _MongoOperatorUpdateAssignsToRecord =
  Probe_MongoOperatorUpdate extends Record<string, unknown> ? true : false;
const _operatorUpdateProbe: _MongoOperatorUpdateAssignsToRecord = true;
void _operatorUpdateProbe;

import type {
  AggregateOptions as Probe_AggregateOptions,
  AggregatePaginationOptions as Probe_AggregatePaginationOptions,
  AllPluginMethods as Probe_AllPluginMethods,
  AnyDocument as Probe_AnyDocument,
  AnyModel as Probe_AnyModel,
  BasePaginationOptions as Probe_BasePaginationOptions,
  CacheOperationOptions as Probe_CacheOperationOptions,
  CacheableOptions as Probe_CacheableOptions,
  CascadeOptions as Probe_CascadeOptions,
  CascadeRelation as Probe_CascadeRelation,
  CollationOptions as Probe_CollationOptions,
  CreateInput as Probe_CreateInput,
  CreateOptions as Probe_CreateOptions,
  CursorPayload as Probe_CursorPayload,
  DecodedCursor as Probe_DecodedCursor,
  DeepPartial as Probe_DeepPartial,
  DeleteResult as Probe_DeleteResult,
  DocField as Probe_DocField,
  EventHandlers as Probe_EventHandlers,
  EventPayload as Probe_EventPayload,
  EventPhase as Probe_EventPhase,
  FieldPreset as Probe_FieldPreset,
  FilterQuery as Probe_FilterQuery,
  InferDocument as Probe_InferDocument,
  InferRawDoc as Probe_InferRawDoc,
  KeysOfType as Probe_KeysOfType,
  KeysetPaginationOptions as Probe_KeysetPaginationOptions,
  Logger as Probe_Logger,
  LookupPopulateOptions as Probe_LookupPopulateOptions,
  LookupPopulateResult as Probe_LookupPopulateResult,
  NonNullableFields as Probe_NonNullableFields,
  ObjectId as Probe_ObjectId,
  OffsetPaginationOptions as Probe_OffsetPaginationOptions,
  OperationOptions as Probe_OperationOptions,
  PaginationConfig as Probe_PaginationConfig,
  PartialBy as Probe_PartialBy,
  Plugin as Probe_Plugin,
  PluginFunction as Probe_PluginFunction,
  PluginType as Probe_PluginType,
  PopulateSpec as Probe_PopulateSpec,
  PrioritizedHook as Probe_PrioritizedHook,
  ReadOptions as Probe_ReadOptions,
  ReadPreferenceType as Probe_ReadPreferenceType,
  RepositoryContext as Probe_RepositoryContext,
  RepositoryEvent as Probe_RepositoryEvent,
  RepositoryInstance as Probe_RepositoryInstance,
  RepositoryOperation as Probe_RepositoryOperation,
  RequiredBy as Probe_RequiredBy,
  SelectSpec as Probe_SelectSpec,
  SessionOptions as Probe_SessionOptions,
  SoftDeleteOptions as Probe_SoftDeleteOptions,
  SoftDeleteRepository as Probe_SoftDeleteRepository,
  SortDirection as Probe_SortDirection,
  Strict as Probe_Strict,
  UpdateManyResult as Probe_UpdateManyResult,
  UpdateOptions as Probe_UpdateOptions,
  UpdateWithValidationResult as Probe_UpdateWithValidationResult,
  UserContext as Probe_UserContext,
  ValidationChainOptions as Probe_ValidationChainOptions,
  ValidatorDefinition as Probe_ValidatorDefinition,
  ValueType as Probe_ValueType,
  WithPlugins as Probe_WithPlugins,
} from '../../src/index.js';

type _MongokitOwnedExportLockIn = [
  Probe_AggregateOptions,
  Probe_AggregatePaginationOptions,
  Probe_AllPluginMethods<unknown>,
  Probe_AnyDocument,
  Probe_AnyModel,
  Probe_BasePaginationOptions,
  Probe_CacheOperationOptions,
  Probe_CacheableOptions,
  Probe_CascadeOptions,
  Probe_CascadeRelation,
  Probe_CollationOptions,
  Probe_CreateInput<{ id: string }>,
  Probe_CreateOptions,
  Probe_CursorPayload,
  Probe_DecodedCursor,
  Probe_DeepPartial<{ a: string }>,
  Probe_DeleteResult,
  Probe_DocField<{ a: string }>,
  Probe_EventHandlers,
  Probe_EventPayload,
  Probe_EventPhase,
  Probe_FieldPreset,
  Probe_FilterQuery,
  Probe_InferDocument<unknown>,
  Probe_InferRawDoc<unknown>,
  Probe_KeysOfType<{ a: string }, string>,
  Probe_KeysetPaginationOptions,
  Probe_Logger,
  Probe_LookupPopulateOptions,
  Probe_LookupPopulateResult,
  Probe_NonNullableFields<{ a: string | null }>,
  Probe_ObjectId,
  Probe_OffsetPaginationOptions,
  Probe_OperationOptions,
  Probe_PaginationConfig,
  Probe_PartialBy<{ a: string; b: number }, 'a'>,
  Probe_Plugin,
  Probe_PluginFunction,
  Probe_PluginType,
  Probe_PopulateSpec,
  Probe_PrioritizedHook,
  Probe_ReadOptions,
  Probe_ReadPreferenceType,
  Probe_RepositoryContext,
  Probe_RepositoryEvent,
  Probe_RepositoryInstance,
  Probe_RepositoryOperation,
  Probe_RequiredBy<{ a?: string; b: number }, 'a'>,
  Probe_SelectSpec,
  Probe_SessionOptions,
  Probe_SoftDeleteOptions,
  Probe_SoftDeleteRepository<{ id: string }>,
  Probe_SortDirection,
  Probe_Strict<{ a: string }>,
  Probe_UpdateManyResult,
  Probe_UpdateOptions,
  Probe_UpdateWithValidationResult<{ id: string }>,
  Probe_UserContext,
  Probe_ValidationChainOptions,
  Probe_ValidatorDefinition,
  Probe_ValueType,
  Probe_WithPlugins<{ id: string }, never>,
];
void (null as unknown as _MongokitOwnedExportLockIn);
