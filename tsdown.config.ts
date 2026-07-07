import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/pagination/PaginationEngine.ts',
    'src/plugins/index.ts',
    'src/utils/index.ts',
    'src/actions/index.ts',
    'src/ai/index.ts',
    // Framework-agnostic adapter — produces `DataAdapter<TDoc>` from
    // `@classytic/repo-core/adapter`. Any host consuming that contract
    // (arc 3+, future arc-next, custom frameworks) wires this in.
    'src/adapter/index.ts',
    // Better Auth × Mongoose overlay — bridges BA-managed collections into
    // `DataAdapter<TDoc>` so any host (arc, custom) gets pagination, query
    // parser, OpenAPI, audit, permissions over BA's own user/org/member tables.
    'src/better-auth/index.ts',
    // Distributed lock primitive — implements `LockAdapter` from
    // `@classytic/repo-core/lock` against a Mongoose collection. Used
    // for cron leader election in multi-replica deployments.
    'src/lock/index.ts',
    // Query primitives — individual module entries so each is importable via
    // `@classytic/mongokit/query/primitives/<name>` without going through the
    // top-level barrel. Each file is pure and tree-shake friendly.
    'src/query/primitives/geo.ts',
    'src/query/primitives/coercion.ts',
    'src/query/primitives/indexes.ts',
    // In-memory MongoDB test harness — `@classytic/mongokit/testkit`. Dev-time
    // only; `mongodb-memory-server` is an OPTIONAL peer, dynamically imported.
    'src/testkit/index.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  deps: {
    // Peers stay external — users bring their own `mongoose` and
    // `@classytic/repo-core`, so bundling either would duplicate them
    // in the final app. `mongodb-memory-server` (testkit's optional peer)
    // stays external too — dynamically imported, never vendored. Kept in a
    // single `neverBundle` list so the contract stays obvious: this package
    // is a thin layer, not a vendored copy of its peers.
    neverBundle: ['mongoose', '@classytic/repo-core', 'mongodb-memory-server'],
  },
  publint: 'ci-only',
  attw: 'ci-only',
});
