# CLAUDE.md — AI maintainer guidance for mongokit

Read this when opening this repo. It exists because we've shipped fix releases (3.10.1 + 3.10.2) after AI-authored patches silently drifted mongokit's `Repository<TDoc>` away from `@classytic/repo-core`'s `StandardRepo<TDoc>` contract. Every such drift breaks arc 2.10+ at every consumer boundary.

## The one thing you must not do

**Do not change any method signature on `Repository<TDoc>` (in `src/Repository.ts`) or any type in `src/types.ts` without running [`npm run typecheck:tests`](./tsconfig.tests.json) after the change.**

That script runs the compile-time conformance assertion at [`tests/unit/standard-repo-assignment.test-d.ts`](./tests/unit/standard-repo-assignment.test-d.ts). It proves `Repository<T>` assigns to `MinimalRepo<T>`, `StandardRepo<T>`, and arc's `RepositoryLike<T>` — whole-interface AND per-method binding AND function-arg passing. If it errors after your change, you have drifted from the contract.

**Do not silence a conformance error with a cast in the test file.** That hides the drift from the next consumer. Fix the signature instead.

## Before touching signatures — read this doc

[`docs/CONFORMANCE.md`](./docs/CONFORMANCE.md) lists the exact contravariance traps that have caused every drift we've shipped a fix for. Four categories:

1. Declaring `session?: ClientSession` anywhere public — must be `unknown`, narrow at mongoose call sites.
2. Inheriting `[key: string]: unknown` index signatures into types that mirror a repo-core contract type (which won't have one).
3. Using `string[]` instead of `readonly string[]` for array fields mirrored from the contract.
4. Adding extra generic parameters to methods that map onto `StandardRepo<TDoc>`.

If your work involves any of these, read the doc. If the report you're responding to mentions any of these, the doc probably already explains the right fix.

## Verifying a community drift report

1. Reproduce the drift by adding a per-method binding to the conformance test first. If TS errors in the test file, the drift is real.
2. If it compiles, the report is overstated — reply with the verified test (3.10.2 did this for 5 of the 7 claims in the inventory).
3. Fix only the real drifts. Don't widen preemptively.

## Release flow

[`docs/RELEASE_CHECKLIST.md`](./docs/RELEASE_CHECKLIST.md) is the source of truth. Non-negotiable steps:

1. `npm run typecheck` — src only.
2. `npm run typecheck:tests` — **the conformance gate, wired into `prepublishOnly`**. Must pass.
3. `npm test` — runtime verification. Session widening etc. can cascade; tests catch regressions the type-checker can't.
4. `npm run build` — declaration emit matches source.
5. Bump `package.json` version AND `skills/mongokit/SKILL.md` frontmatter version AND `C:\Users\Siam\.claude\skills\mongokit\SKILL.md` (user's global skill).
6. CHANGELOG entry — follow the 3.10.1 + 3.10.2 format: explicit "Real drifts resolved" vs "Claims audited and confirmed NOT drift" so future maintainers see which patterns are settled.
7. Stage ONLY files relevant to the release. Other uncommitted files in the repo are pre-existing work; don't bundle them.
8. Commit message: NO `Co-Authored-By:` trailer. User has vetoed it.
9. Tag `vMAJOR.MINOR.PATCH`. Push main + tag.

## Repository layout

- [`src/Repository.ts`](./src/Repository.ts) — the main class. Every method declaration here is a potential drift point.
- [`src/types.ts`](./src/types.ts) — boundary types. Every `session?:`, every `select?:`, every option interface lives here.
- [`src/actions/`](./src/actions/) — internal pure functions called by Repository methods. Types here may differ from boundary types; cast at the mongoose call, not at the interface.
- [`src/plugins/`](./src/plugins/) — plugin methods contributed at runtime (e.g. `updateMany`, `deleteMany`, `bulkWrite` via `batchOperationsPlugin`). Not declared on the class type; not checked by the conformance test per-method (optional via `Partial<StandardRepo>`).

## Do not

- Edit `@classytic/repo-core` types from within mongokit work. That's a separate package.
- Add AI attribution (`Co-Authored-By: Claude ...`) to git commits in this workspace.
- Use `git add -A` / `git add .`. Stage specific files only — this repo often has in-progress work from prior sessions.
- Silence type errors with `as unknown as ...` or `@ts-ignore` in the conformance test file. The whole point of the test is to fail loudly.
- Create new files unless necessary. Prefer editing.
