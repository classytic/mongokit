# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.1] - 2024-12-XX

### Fixed
- Minor bug fixes and cleanup

### Added
- Lookup aggregation support (`lookupPopulate`, `LookupBuilder`, `AggregationBuilder`)
- Fallback transaction support with `allowFallback` option
- New types for better TypeScript inference

## [3.0.1] - 2024-XX-XX

### Added
- Async event support (`emitAsync`, configurable hook mode)
- Cascade delete plugin
- Enhanced soft-delete plugin with TTL support

### Changed
- Migrated entire codebase to TypeScript
- Added comprehensive caching support with Redis adapter

## [2.0.0] - 2024-XX-XX

### Changed
- **BREAKING**: Zero dependencies architecture (mongoose as peer dep only)
- Production-ready release with battle-tested plugins

### Added
- 12 built-in plugins (timestamp, soft-delete, cache, audit-log, validation, etc.)
- QueryParser with security hardening
- JSON Schema generator for OpenAPI/Fastify

## [1.0.2] - 2024-XX-XX

### Added
- Mongoose 9 support (`^8.0.0 || ^9.0.0`)

## [1.0.1] - 2024-XX-XX

### Fixed
- Dependency updates

## [1.0.0] - 2024-XX-XX

### Added
- Initial release
- Repository pattern with CRUD operations
- Offset and keyset pagination
- Plugin system architecture
- Event-driven hooks

[3.1.1]: https://github.com/classytic/mongokit/compare/v3.0.1...v3.1.1
[3.0.1]: https://github.com/classytic/mongokit/compare/v2.0.0...v3.0.1
[2.0.0]: https://github.com/classytic/mongokit/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/classytic/mongokit/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/classytic/mongokit/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/classytic/mongokit/releases/tag/v1.0.0
