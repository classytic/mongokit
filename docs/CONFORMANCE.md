# StandardRepo Conformance Guide

**Read this before changing any method signature on `Repository<TDoc>` or any boundary type in `src/types/*`.** Boundary types the conformance gate cares about live in `src/types/operations.ts` (per-op option bags + repo-core result re-exports), `src/types/repository.ts` (`RepositoryInstance`, context, plugin protocol), and `src/types/core.ts` (`SelectSpec`, `SortSpec`, `ObjectId`). The three drift traps (readonly arrays, no stray index signatures, `session?: unknown`) apply wherever those types are declared.

Mongokit's `Repository<TDoc>` MUST satisfy `MinimalRepo<TDoc>` and `StandardRepo<TDoc>` from `@classytic/repo-core/repository` structurally. Arc 2.10+ (`BaseController`, `createMongooseAdapter`, `repositoryAs{Audit,Outbox,Idempotency}Store`) accepts mongokit repos through `RepositoryLike<TDoc> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>`. Any drift forces downstream apps into `as unknown as RepositoryLike<TDoc>` casts at every integration boundary — which is exactly how we got 3.10.1 and 3.10.2 as fix releases.

## The gate

`tests/unit/standard-repo-assignment.test-d.ts` is a **compile-time-only** conformance assertion. It proves three things:

1. `Repository<Branch>` assigns to `MinimalRepo<Branch>`, `StandardRepo<Branch>`, and `RepositoryLike<Branch>` as a whole-interface value.
2. Each optional method on `StandardRepo<TDoc>` binds to its expected function type, forcing strict `strictFunctionTypes` contravariance (which method-shorthand bivariance would otherwise mask).
3. The arc `BaseController(repo, ...)` call path — `repo` passed as a function arg typed `RepositoryLike<T>` — compiles.

Wired into `npm run typecheck:tests` (via `tsconfig.tests.json`). Runs on `prepublishOnly`. **If this file errors, do not ship — the repo has drifted from repo-core.**

## Why method-shorthand doesn't catch everything

```ts
// Method shorthand — bivariant parameter check:
interface StandardRepo<T> {
  getOne?(filter: FilterInput, options?: QueryOptions): Promise<T | null>;
}

// When mongokit's Repository<T>.getOne declares a narrower param type,
// bivariance silently accepts it. Assignment to StandardRepo<T> passes
// even though the param types disagree.
```

But `RepositoryLike<T> = MinimalRepo<T> & Partial<StandardRepo<T>>` transforms optional methods into function-typed properties, and `strictFunctionTypes` applies. **That's where drift actually bites consumers** — and it's why the conformance test binds each method explicitly.

If a new drift sneaks in, the whole-interface assignment may still pass while per-method binding fails. Always check the per-method block too.

## The contravariance traps

These are the specific patterns that have caused drift. Before touching any of them, read the comment and stop to think.

### 1. Mongoose-native handle types on public option bags

**Trap.** Declaring `session?: ClientSession` on any option type consumed by a `Repository<TDoc>` method.

**Why it breaks.** Repo-core types `session?: RepositorySession = unknown` — every kit agrees to `unknown` at the boundary so SQL / Prisma kits can pass their own handle types through the same options shape. `ClientSession` is narrower than `unknown`; under contravariance, mongokit's parameter must be a SUPERTYPE of repo-core's to accept anything a caller typed against `StandardRepo<T>` might pass. Nothing is a proper supertype of `unknown`, so only `unknown` works.

**Rule.** Every public option interface (everything exported from `src/types/*` — chiefly `src/types/operations.ts` — and used as a `Repository<TDoc>` method parameter) declares `session?: unknown`. Internal mongoose calls cast: `aggregation.session(options.session as ClientSession)`, `{ session: options.session as ClientSession | undefined }`, `.session((options.session ?? null) as ClientSession | null)`. Narrow at the use site, not at the boundary.

### 2. Index signatures on boundary types without an index signature in the contract

**Trap.** `LookupPopulateOptions<TBase> extends ReadOptions` picks up `[key: string]: unknown` from `SessionOptions`. Repo-core's `LookupPopulateOptions<TBase>` has no index signature.

**Why it breaks.** Under strict contravariance, if the target type has an index signature that the source type lacks, TypeScript can't verify the source's extra props won't violate it — assignment fails. This is why 3.10.2 flattened `LookupPopulateOptions` to declare fields directly instead of inheriting.

**Rule.** If a mongokit type shadows a repo-core contract type, match the contract's shape. Don't inherit a `[key: string]: unknown` escape hatch into a type that maps onto a contract type. If kit-specific fields are needed, add them as first-class declared fields (e.g. `collation?`, `countStrategy?` on `LookupPopulateOptions`).

### 3. Readonly array contract types

**Trap.** Typing `select?: string[]` when repo-core's shape is `readonly string[] | ...`.

**Why it breaks.** `readonly string[]` is a SUPERTYPE of `string[]` (`T[]` is assignable to `readonly T[]`, not the other way around). A value of type `readonly string[]` cannot be assigned to `string[]`. Under contravariance at the `select` field of repo-core's options, mongokit's field must accept `readonly string[]`.

**Rule.** For any field that mirrors a repo-core shape, always widen to `readonly`. Internal narrowing at `Array.isArray`:

```ts
if (Array.isArray(select)) {
  // Array.isArray's predicate is `x is any[]` — it does NOT narrow
  // `readonly string[]` OUT of a union. After this branch, the else
  // branch still sees `readonly string[] | Record<string, 0|1>`.
  // Cast explicitly when you need the Record shape.
} else {
  const record = select as Record<string, 0 | 1>;
}
```

### 4. Extra generic parameters on optional methods

**Trap.** `findOneAndUpdate<TResult = TDoc>(...)` when repo-core's declaration has no `TResult`. Latent compat issue — bivariance usually accepts it, but if anything tightens, it fails.

**Rule.** When shadowing a StandardRepo method, match its generic arity. Add kit-specific generics as OVERLOADS, not as the primary signature that maps onto the contract.

## Workflow for safe signature edits

1. **Run the conformance test first**, before touching anything: `npm run typecheck:tests`. Confirm green baseline.
2. Make the change.
3. Run `npm run typecheck` (src-only). Must pass.
4. Run `npm run typecheck:tests` (src + conformance test). **If this one starts failing, you have drifted.** Do not silence with a cast in the test file — fix the signature.
5. Run the full test suite: `npm test`. Signature widening at the boundary can cascade into internal narrowing TS errors that the type-checker surfaces; runtime tests confirm no behavior change.

## Adding a new method to the contract

If repo-core adds a method to `StandardRepo<TDoc>`:

1. Add a per-method binding to the conformance test (`const mNewMethod: Method<'newMethod'> = repo.newMethod.bind(repo);`).
2. Implement the method on `Repository<TDoc>` with a signature that structurally matches the contract. Match every generic, every param type, every return type.
3. Conformance must be green before the PR merges.

## What to do when the community reports a drift

1. **Reproduce with a conformance-test binding first.** Add a per-method binding that exercises the exact shape the user reported. If TS errors on it in the test file, the drift is real. If it compiles, the report is overstated — reply with the verified test (this is what 3.10.2's "Claims audited and confirmed NOT drift" block in the CHANGELOG did for C/D/E/F/G).
2. Fix only the real drifts. Don't widen signatures preemptively — every unnecessary widening is a future maintenance tax (internal narrowing casts, extra runtime checks).
3. Document the specific trap you hit in this file's "contravariance traps" section. Patterns repeat; the next report will cite the same category.

## Cross-reference

- [`src/types/`](../src/types/) — boundary types split by domain (all `session?: unknown` here); see [`TYPES_GUIDE.md`](./TYPES_GUIDE.md) for the file map
- [`tests/unit/standard-repo-assignment.test-d.ts`](../tests/unit/standard-repo-assignment.test-d.ts) — the gate
- [`tsconfig.tests.json`](../tsconfig.tests.json) — dedicated strict-mode check for the conformance file
- [`CHANGELOG.md`](../CHANGELOG.md) 3.10.1 + 3.10.2 entries — concrete examples of what drift looks like
- `@classytic/repo-core/repository` `src/repository/types.ts` — the contract (source of truth)
