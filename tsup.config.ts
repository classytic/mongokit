import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/pagination/PaginationEngine.ts',
    'src/plugins/index.ts',
    'src/utils/index.ts',
    'src/actions/index.ts',
  ],
  format: ['esm'],
  target: 'node18',
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: false,
  treeshake: {
    preset: 'recommended',
  },
  minify: false,
  external: ['mongoose'],
  esbuildOptions(options) {
    options.chunkNames = 'chunks/[name]-[hash]';
  },
});
