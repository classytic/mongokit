import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/pagination/PaginationEngine.ts',
    'src/plugins/index.ts',
    'src/utils/index.ts',
    'src/actions/index.ts',
    'src/ai/index.ts',
    // Query primitives — individual module entries so each is importable via
    // `@classytic/mongokit/query/primitives/<name>` without going through the
    // top-level barrel. Each file is pure and tree-shake friendly.
    'src/query/primitives/geo.ts',
    'src/query/primitives/coercion.ts',
    'src/query/primitives/indexes.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  deps: {
    // Peers stay external — users bring their own `mongoose` and
    // `@classytic/repo-core`, so bundling either would duplicate them
    // in the final app. Kept in a single `neverBundle` list so the
    // contract stays obvious: this package is a thin layer, not a
    // vendored copy of its peers.
    neverBundle: ['mongoose', '@classytic/repo-core'],
  },
  publint: 'ci-only',
  attw: 'ci-only',
});
