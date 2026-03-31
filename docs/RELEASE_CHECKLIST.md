# MongoKit v3.2.2 Release Checklist

## Release Status
- [x] Ready to release as `@classytic/mongokit@3.2.2`
- [x] Package format verified: ESM-only
- [x] Build tool verified: `tsdown`

## Required Pre-Release Checks

### 1) Quality gates
- [x] Build passes: `npm run build`
- [x] Type checking passes: `npm run typecheck`
- [x] Tests pass: `npm test`

### 2) Package metadata
- [x] `package.json` version is `3.2.2`
- [x] `type` is `module`
- [x] `engines.node` is `>=22`
- [x] `peerDependencies.mongoose` is `^9.0.0`

### 3) Export map and files
- [x] Root export: `@classytic/mongokit`
- [x] Subpath export: `@classytic/mongokit/pagination`
- [x] Subpath export: `@classytic/mongokit/plugins`
- [x] Subpath export: `@classytic/mongokit/utils`
- [x] Subpath export: `@classytic/mongokit/actions`
- [x] Subpath export: `@classytic/mongokit/ai`
- [x] Type definitions included for all exported entry points (`.d.mts`)

### 4) Publish package contents
- [x] Included: `dist/`, `README.md`, `LICENSE`
- [x] Excluded: `src/`, `tests/`, config and local development files
- [x] Dry run passes: `npm run publish:dry`

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

### Publish current version (3.2.2)
```bash
npm run release
```

### Bump + release
```bash
npm run release:patch
npm run release:minor
npm run release:major
```

## Post-Release
1. Tag release: `git tag v3.2.2`
2. Push tag: `git push origin v3.2.2`
3. Publish GitHub release notes from `CHANGELOG.md`
4. Verify npm package page

## Notes
- `prepublishOnly` now enforces `build + typecheck + test`.
- `release` now enforces `build + typecheck + test + publish`.
