# Contributing to mongokit

Thanks for your interest in contributing! This guide will help you get started.

## Quick Start

```bash
# Clone and install
git clone https://github.com/classytic/mongokit.git
cd mongokit
npm install

# Run tests (requires MongoDB or uses memory server)
npm test

# Type check (src only)
npm run typecheck

# StandardRepo conformance check — runs the compile-time assertion that
# `Repository<T>` satisfies MinimalRepo / StandardRepo / RepositoryLike
# from @classytic/repo-core. Must pass before any release.
npm run typecheck:tests

# Build
npm run build
```

## Before changing any signature on Repository<TDoc> or any type in src/types.ts

Read [`docs/CONFORMANCE.md`](./CONFORMANCE.md) first. Mongokit's `Repository<TDoc>` MUST structurally satisfy `StandardRepo<TDoc>` from `@classytic/repo-core/repository` — arc 2.10 and every future kit-portable consumer depend on it. Four specific traps have caused every drift we've shipped a fix for; the doc lists them with rules.

The short version:

- Public `session?:` fields are `unknown`, not `ClientSession`. Narrow at mongoose call sites, never at the boundary.
- Don't let boundary types inherit a `[key: string]: unknown` index signature via an interface chain when the contract type it mirrors doesn't have one.
- Array types mirrored from the contract are `readonly`.
- Don't add extra generics to methods that map onto `StandardRepo<TDoc>` — use overloads.

If `npm run typecheck:tests` fails after your change, you've drifted. Don't silence the test with a cast — fix the signature.

## Development Workflow

1. **Fork & Branch** - Create a feature branch from `main`
2. **Code** - Make your changes
3. **Test** - Ensure all tests pass (`npm test`)
4. **Type Check** - Run `npm run typecheck`
5. **PR** - Submit a pull request

## Code Standards

- **TypeScript** - All code must be typed (strict mode)
- **Tests** - Add tests for new features
- **JSDoc** - Document public APIs with examples
- **No Dependencies** - Keep mongoose as the only peer dep

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new validation plugin
fix: resolve cursor pagination edge case
docs: update README examples
test: add cache plugin tests
```

## Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] Types check (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
- [ ] JSDoc added for public APIs
- [ ] CHANGELOG.md updated (for features/fixes)

## Project Structure

```
src/
├── Repository.ts      # Core repository class
├── types.ts           # All type definitions
├── actions/           # CRUD operations (pure functions)
├── pagination/        # Pagination engine
├── plugins/           # Built-in plugins
├── query/             # Query builders
└── utils/             # Utilities
```

## Questions?

Open an issue for bugs or feature requests.
