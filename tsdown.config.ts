import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/pagination/PaginationEngine.ts',
    'src/plugins/index.ts',
    'src/utils/index.ts',
    'src/actions/index.ts',
    'src/ai/index.ts',
  ],
  format: 'esm',
  dts: true,
  sourcemap: false,
  minify: false,
  external: ['mongoose'],
});
