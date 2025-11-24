# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2025-01-25

### 🎉 Major Release - Production Ready

#### Breaking Changes
- **Removed `paginate()` and `stream()` methods from Repository** - Use unified `getAll()` instead
  - Migration: `repo.paginate({ page: 1, limit: 20 })` → `repo.getAll({ page: 1, limit: 20 })`
  - Migration: `repo.stream({ sort, after })` → `repo.getAll({ sort, after })`

#### Added
- ✨ **Unified `getAll()` API** - One method that auto-detects offset vs keyset pagination
  - Auto-detects based on parameters (`page` → offset, `after`/`cursor` → keyset, `sort` → keyset)
  - Simplified developer experience - no need to choose between methods
- ✨ **Zero external dependencies** - Removed `http-errors` dependency
  - Only `mongoose` as peer dependency
  - Smaller package size, fewer security vulnerabilities
- ✨ **Improved auto-detection** - No need for `after: null` on first keyset page
  - Just provide `sort` parameter for keyset mode
  - Natural, intuitive API
- 📚 **Comprehensive new README** with real-world examples
  - Text search + infinite scroll examples
  - Multi-tenancy patterns
  - Performance tips and indexing strategies
  - Migration guides from mongoose-paginate-v2, Prisma, TypeORM
- 📖 **Developer-friendly examples directory**
  - Express REST API example
  - NestJS integration example
  - Next.js API routes example
  - Infinite scroll example with React frontend
  - Getting started guide with copy-paste snippets
- 📝 **Enhanced JSDoc documentation** across all modules
- 🔧 **Better TypeScript support** with discriminated unions for pagination results

#### Fixed
- 🐛 **Fixed broken `aggregatePaginate()`** - Now uses native MongoDB `$facet`
  - Previously called non-existent `Model.aggregatePaginate()` method
  - Added 16MB safety warning for large aggregations
- 🐛 **Fixed type surface** - `warning?: string` and `next: string | null` are now accurate
- 🐛 **Fixed package exports** - Point to correct auto-generated type files
- 🔧 **Fixed pagination warning message** - Now references `getAll()` instead of `stream()`

#### Improved
- ⚡ **Better performance** - Cursor pagination O(1) regardless of position
- 🎯 **Cleaner codebase** - Removed redundant methods, simpler architecture
- 📊 **Better test coverage** - 68 tests including real-world scenarios
- 🔍 **Documented `useEstimatedCount` behavior** - Inline comments about O(1) counts

#### Test Results
```
✅ 67/68 tests passing (1 skipped - requires replica set)
✅ Zero TypeScript errors
✅ All real-world scenarios tested
```

---

## [1.0.2] - 2024-12-XX

### Fixed
- Bug fixes and stability improvements

## [1.0.1] - 2024-12-XX

### Fixed
- Minor bug fixes

## [1.0.0] - 2024-12-XX

### Added
- Initial release
- Repository pattern for MongoDB
- Basic pagination support
- Plugin system
- Event hooks
- TypeScript support

[2.0.0]: https://github.com/classytic/mongokit/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/classytic/mongokit/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/classytic/mongokit/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/classytic/mongokit/releases/tag/v1.0.0
