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
    neverBundle: ['mongoose'],
  },
  publint: 'ci-only',
  attw: 'ci-only',
});
