/**
 * Contract conformance — compile-time only.
 *
 * Statically verifies that mongokit's `Repository<TDoc>` is structurally
 * assignable to repo-core's `StandardRepo<TDoc>`. Symmetric to
 * `sqlitekit/src/repository/contract.ts` — both kits opt into the same
 * drift detection so renaming a method on either side fails the build
 * before arc's CI catches it.
 *
 * Zero runtime cost: the file exports nothing executable; it just hosts
 * a type alias that tsc evaluates at typecheck time.
 */

import type { StandardRepo } from '@classytic/repo-core/repository';
import type { Repository } from './Repository.js';

// biome-ignore lint/correctness/noUnusedVariables: compile-time contract check — see file-level JSDoc.
type _ConformanceCheck<TDoc> =
  StandardRepo<TDoc> extends never
    ? never
    : Repository<TDoc> extends StandardRepo<TDoc>
      ? true
      : never;
