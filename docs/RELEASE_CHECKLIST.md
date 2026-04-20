# MongoKit Release Checklist

A version-agnostic pre-release checklist. Run through it before any `npm publish`.

## Required Pre-Release Checks

### 1) Quality gates

- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`
- [ ] **StandardRepo conformance passes: `npm run typecheck:tests`** — this is the gate that catches arc-boundary drift. If it fails, read [CONFORMANCE.md](./CONFORMANCE.md) before touching any signature. Do not silence errors by casting in the test file.
- [ ] Lint passes: `npm run lint`
- [ ] Tests pass: `npm test` (must be green — do not ship with red/skipped-for-"later")
- [ ] Perf tests still correct (opt-in): `RUN_PERF=1 npx vitest run tests/perf-*.test.ts`

### 2) Package metadata

- [ ] `package.json` version bumped (semver — breaking → major, additive → minor, fix → patch)
- [ ] `type` is `module`
- [ ] `engines.node` still matches current baseline
- [ ] `peerDependencies.mongoose` still matches supported range
- [ ] `CHANGELOG.md` has a new dated entry describing Added / Changed / Fixed / Removed

### 3) Export map and files

- [ ] Root export: `@classytic/mongokit`
- [ ] Subpath exports still resolve: `/pagination`, `/plugins`, `/utils`, `/actions`, `/ai`
- [ ] Type definitions included for every exported entry point (`.d.mts`)
- [ ] `tests/dist-exports.test.ts` green — catches a re-export regressing

### 4) Publish package contents

- [ ] Included: `dist/`, `README.md`, `LICENSE`
- [ ] Excluded: `src/`, `tests/`, config and local development files
- [ ] Dry run passes: `npm run publish:dry` (or `npm pack --dry-run`)
- [ ] Tarball size is sane — investigate anything > ~150 kB unless expected

### 5) Docs

- [ ] `README.md` has no stale version refs or removed API mentions
- [ ] `skills/mongokit/SKILL.md` frontmatter `version` matches `package.json`
- [ ] JSDoc on any changed public surface is updated (params, examples)
- [ ] New/changed behavior has at least one code example a consumer can copy

## Current Build System (Source of Truth)

- Build config file: `tsdown.config.ts`
- Build command: `npm run build`
- Output format: ESM (`.mjs`) + declarations (`.d.mts`)

## JavaScript and TypeScript Consumption

### ESM (supported)

```javascript
import { Repository } from '@classytic/mongokit';
```

### TypeScript (supported)

```typescript
import { Repository, type PaginationConfig } from '@classytic/mongokit';
```

### CommonJS (not supported)

```javascript
// This package is ESM-only. Use dynamic import in CJS projects.
const { Repository } = await import('@classytic/mongokit');
```

## Release Commands

### Dry run

```bash
npm run publish:dry
```

### Publish current version (reads from package.json)

```bash
npm run release
```

### Bump + release

```bash
npm run release:patch   # x.y.z → x.y.(z+1)
npm run release:minor   # x.y.z → x.(y+1).0
npm run release:major   # x.y.z → (x+1).0.0
```

## Post-Release

1. Tag release: `git tag v<version>` (e.g. `git tag v3.6.2`)
2. Push tag: `git push origin v<version>`
3. Publish GitHub release notes — copy the matching `CHANGELOG.md` entry
4. Verify the npm package page shows the new version and correct tarball size

## Notes

- `prepublishOnly` enforces `build + typecheck + test`.
- `release` enforces `build + typecheck + test + publish`.
- Never `npm publish --ignore-scripts` — the script gate is the only thing stopping a red build from shipping.
