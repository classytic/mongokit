# Changelog

All notable changes to this project are documented here.

This repository now keeps the top-level changelog short and archives detailed
history by major version:

- [v3 history](./changelog/v3.md)
- [v2 history](./changelog/v2.md)
- [v1 history](./changelog/v1.md)

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Current Line

### [3.11.1] - 2026-04-25

- Added structured `SEARCH_NOT_CONFIGURED` errors for index-free search setup
  issues.
- Added warnings for nested reserved query keys like
  `?filters[limit]=5`.
- Widened CRUD schema builder return typing for framework adapters without
  changing runtime behavior.
- Tightened tests and refreshed docs.

### [3.11.0] - 2026-04-22

- Promoted `updateMany` and `deleteMany` to core `Repository` methods.
- Added portable update IR support in `findOneAndUpdate` and `updateMany`.
- Renamed the single-document patch type to `UpdatePatch<TDoc>` and kept the
  old name as a deprecated alias.
- Locked repo-core / arc conformance with compile-time tests.

### [3.10.x] - 2026-04-20 to 2026-04-21

- Aligned mongokit with `@classytic/repo-core` contracts.
- Standardized miss semantics, lookup result envelopes, transaction callback
  shape, and cache adapter naming.
- Added portable lookup, filter, aggregate, and bulk-write surfaces.
- Hardened structural compatibility with arc and cross-kit conformance tests.

## Archive Policy

- `CHANGELOG.md` stays focused on the current line and recent releases.
- Older details live under [`changelog/`](./changelog/).
- Archive files are grouped by major version, which is a common pattern once a
  package changelog becomes too long to scan comfortably.

## Major History

- `v3`:
  portability, repo-core alignment, stronger pagination, search, multi-tenancy,
  vector support, and transaction hardening.
- `v2`:
  zero-dependency architecture, built-in plugins, query parser hardening, JSON
  Schema / OpenAPI support.
- `v1`:
  initial repository, hooks, and pagination foundation.

[3.11.1]: https://github.com/classytic/mongokit/compare/v3.11.0...v3.11.1
[3.11.0]: https://github.com/classytic/mongokit/compare/v3.10.3...v3.11.0
