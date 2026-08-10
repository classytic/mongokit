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
    // The mongo outbox TABLE (schema + the four indexes that make claim, dedupe and
    // retention correct). Deliberately NOT an `OutboxStore` — arc's
    // `repositoryAsOutboxStore` is the contract half, and keeping them apart is what
    // stops mongokit depending on arc.
    'src/outbox/index.ts',
    // Better Auth × Mongoose overlay — bridges BA-managed collections into
    // `DataAdapter<TDoc>` so any host (arc, custom) gets pagination, query
    // parser, OpenAPI, audit, permissions over BA's own user/org/member tables.
    'src/better-auth/index.ts',
    // Distributed lock primitive — implements `LockAdapter` from
    // `@classytic/repo-core/lock` against a Mongoose collection. Used
    // for cron leader election in multi-replica deployments.
    'src/lock/index.ts',
    // Usage counters — implements `UsageStore` from
    // `@classytic/repo-core/usage` (doc per (actor, period, kind),
    // atomic $inc upsert). Consumed by @classytic/arc/usage's plugin.
    'src/usage/index.ts',
    // Query primitives — individual module entries so each is importable via
    // `@classytic/mongokit/query/primitives/<name>` without going through the
    // top-level barrel. Each file is pure and tree-shake friendly.
    'src/query/primitives/geo.ts',
    'src/query/primitives/coercion.ts',
    'src/query/primitives/indexes.ts',
    // In-memory MongoDB test harness — `@classytic/mongokit/testkit`. Dev-time
    // only; `mongodb-memory-server` is an OPTIONAL peer, dynamically imported.
    'src/testkit/index.ts',
    // Executable Kernel Construction Standard — `@classytic/mongokit/kernel-conformance`.
    // Test-only, but it imports NO test runner: `describe`/`it` are injected by the
    // consumer, so mongokit never depends (not even optionally) on vitest, and a kernel
    // can run the suite under whatever runner it already has. Kernels must never depend
    // on arc, which is why this lives here and not beside arc's port contract suites.
    'src/kernel-conformance/index.ts',
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
    //
    // REGEX, NOT BARE STRINGS — and this is the whole point of the line.
    //
    // A string entry in `neverBundle` matches only the EXACT specifier. It does not
    // cover subpaths, and neither does the glob form. Falsified directly (harness: a
    // package with no declared deps, `skipNodeModulesBundle` stripped, importing
    // `@classytic/repo-core/filter`):
    //
    //   ['@classytic/repo-core']        -> ✔ Build complete, 8317 B, repo-core INLINED
    //   ['@classytic/repo-core/**']     -> ✔ Build complete, 8317 B, repo-core INLINED
    //   [/^@classytic\//]               -> ✔ Build complete,  156 B, import preserved
    //
    // repo-core has NO root export — every real import of it is a subpath (this file's
    // entry list alone reaches `/adapter`, `/lock`, `/usage`) — so the old string form
    // matched nothing and the externalizing was being done incidentally by the
    // `peerDependencies` declaration, which tsdown auto-externalizes. The rule was
    // decoration: drop the peer entry, or import a sibling that isn't declared, and this
    // silently ships a second copy. Same for `drizzle-orm/*`-style subpaths elsewhere in
    // the fleet.
    //
    // What inlining actually costs: two copies of a stateful kernel in ONE process. For
    // repo-core that is duplicated module-scope caches; for an engine, registry or outbox
    // relay it is a correctness bug, not a size regression. And the violating build says
    // `✔ Build complete` — nothing fails, which is why the pattern has to be right rather
    // than merely present.
    //
    // `@spinekit/` is listed even though mongokit must never import the spine (it is a
    // kernel; the layer gate forbids it). A gate that would not fire is cheap; a gate
    // that stops matching after a scope rename is exactly how the spine's own config
    // went blind — see commerce/AGENTS.md §"eight things that are NOT a source grep".
    neverBundle: [
      /^@classytic\//,
      /^@spinekit\//,
      /^mongoose(\/|$)/,
      /^mongodb-memory-server(\/|$)/,
    ],
  },
  publint: 'ci-only',
  attw: 'ci-only',
});
