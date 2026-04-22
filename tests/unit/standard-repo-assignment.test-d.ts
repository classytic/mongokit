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
