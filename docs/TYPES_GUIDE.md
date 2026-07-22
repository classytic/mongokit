# MongoKit Type Organization

How MongoKit's boundary types are organized, and where to add a new one.

## Type Architecture: six domain files under `src/types/`

As of 3.25 the old monolithic `src/types.ts` (~1,700 lines) is **deleted**.
There is **no compatibility barrel** — internal code imports each type from
the module that owns it, and the public package surface is re-exported from
[`src/index.ts`](../src/index.ts) (grouped by domain). Two import paths for
one type is exactly the drift this split prevents.

| File | Owns | Notable types |
|---|---|---|
| [`types/core.ts`](../src/types/core.ts) | Query/document primitives + the `softRequired` mongoose declaration merge | `ObjectId`, `AnyDocument`, `AnyModel`, `SortDirection`, `SortSpec`, `PopulateSpec`, `SelectSpec`, `FilterQuery<T>`, `ReadPreferenceType` |
| [`types/type-utils.ts`](../src/types/type-utils.ts) | Type-level helpers + write-payload shapes | `InferDocument`, `InferRawDoc`, `PartialBy`, `RequiredBy`, `KeysOfType`, `DeepPartial`, `Strict`, `NonNullableFields`, `CreateInput`, `UpdatePatch`, `MongoOperatorUpdate`, `DocField`, `UpdateWithValidationResult` |
| [`types/pagination.ts`](../src/types/pagination.ts) | Pagination config + per-mode options + cursor wire format + the minimal `ParsedQuery` | `PaginationConfig`, `CollationOptions`, `BasePaginationOptions`, `OffsetPaginationOptions`, `KeysetPaginationOptions`, `AggregatePaginationOptions`, `ParsedQuery`, `ValueType`, `CursorPayload`, `DecodedCursor` |
| [`types/operations.ts`](../src/types/operations.ts) | Per-operation option bags + **repo-core result-envelope re-exports** | `SessionOptions`, `ReadOptions`, `OperationOptions`, `CacheableOptions`, `CacheOperationOptions`, `WithTransactionOptions`, `CreateOptions`, `UpdateOptions`, `FindOneAndUpdateOptions`, `AggregateOptions`, `LookupPopulateOptions`, `GroupResult`, `MinMaxResult` — plus re-exported `DeleteResult` / `DeleteManyResult` / `UpdateManyResult` / `LookupPopulateResult` / `LookupRow` |
| [`types/repository.ts`](../src/types/repository.ts) | Construction options, operation context, plugin protocol, middleware, events, the plugin-method intersection | `RepositoryOptions`, `RepositoryContext`, `UserContext`, `HookMode`, `Plugin`, `PluginFunction`, `PluginType`, `PrioritizedHook`, `RepositoryInstance`, `Middleware`, `MiddlewareContext`, `MinimalRepoView`, `RepositoryOperation`, `EventPhase`, `RepositoryEvent`, `EventHandlers`, `EventPayload`, `AllPluginMethods`, `WithPlugins`, `RepositorySearchMode` |
| [`types/plugin-options.ts`](../src/types/plugin-options.ts) | Option shapes for the bundled plugins that declare them in the shared layer | `FieldPreset`, `ValidatorDefinition`, `ValidationChainOptions`, `Logger`, `SoftDeleteFilterMode`, `SoftDeleteOptions`, `SoftDeleteRepository`, `CascadeRelation`, `CascadeOptions` |

Dependency direction is one-way and acyclic: `core` → `type-utils` →
`pagination` → `operations` → `repository` → `plugin-options`. A file only
imports from files to its left. If you find yourself wanting a leftward file
to import a rightward one, the type is in the wrong place.

## What lives in repo-core, NOT here

These are **owned by `@classytic/repo-core`** and imported directly by
consumers — mongokit does NOT re-export them (two import paths would drift):

```typescript
// Pagination RESULT shapes (mongokit owns the option shapes; repo-core owns results)
import type {
  OffsetPaginationResult,
  KeysetPaginationResult,
  AggregatePaginationResult,
  AnyPaginationResult,           // the type formerly called PaginationResult
} from '@classytic/repo-core/pagination';

// The throwable error contract + CRUD schema shape (shared across every kit)
import type { HttpError } from '@classytic/repo-core/errors';
import type { CrudSchemas } from '@classytic/repo-core/schema';

// Cache contracts (unified plugin owns them; mongokit's cache.plugin re-exports)
import type { CacheAdapter, CacheOptions, RepositoryCacheHandle } from '@classytic/repo-core/cache';
```

`types/operations.ts` DOES re-export the delete/update/lookup **result
envelopes** (`DeleteResult`, `UpdateManyResult`, `LookupPopulateResult`, …)
from `@classytic/repo-core/repository` — that is the one sanctioned re-export,
because those envelopes are the return types of `Repository` methods and every
kit must produce the identical shape. Everything else from repo-core stays a
direct import.

## Rules for adding a type

### 1. Put it in the owning domain file, export it there

```typescript
// src/types/operations.ts
export interface MyOperationOptions extends OperationOptions {
  myFlag?: boolean;
}

// src/some-module.ts
import type { MyOperationOptions } from './types/operations.js';
```

If it's part of the public API, add it to the matching grouped `export type`
block in [`src/index.ts`](../src/index.ts) (blocks are labeled by domain).

### 2. Keep module-specific types internal

Types used by exactly one module stay in that module, unexported. knip fails
the build on an exported type nothing imports.

```typescript
// src/actions/update.ts
interface ValidationOptions {  // internal — not a boundary type
  buildConstraints?: ...;
}
```

Plugin-specific repository extensions are the standard exception — they're
declared in the plugin file (e.g. `MethodRegistryRepository` in
`method-registry.plugin.ts`), not in `src/types/`.

### 3. Never duplicate a definition

If two modules need the same type, one owns it (per the table above) and the
other imports it. A parallel local `interface` with the same name is drift
waiting to happen — the reason `CursorPayload` was consolidated into
`types/pagination.ts` and imported by `pagination/utils/cursor.ts`.

### 4. Respect the boundary-type traps

Any type on the `Repository<TDoc>` ⇄ `StandardRepo<TDoc>` boundary
(`operations.ts`, `repository.ts`, `core.ts`) must follow the conformance
rules in [`CONFORMANCE.md`](./CONFORMANCE.md): `session?: unknown` (never
`ClientSession`), `readonly` arrays where the contract has them, no stray
`[key: string]: unknown` index signature inherited through an interface chain.
Run `npm run typecheck:tests` after any change to these files.

## Verification

```bash
# Both type lanes (src + tests/conformance). Boundary drift fails here.
npm run typecheck && npm run typecheck:tests

# Dead exports (an exported type with no importer) fail the build.
npx knip

# Find accidental duplicate type/interface names across the tree
grep -rhoE "^export (interface|type) [A-Za-z0-9_]+" src/ \
  | awk '{print $3}' | sort | uniq -d
```
