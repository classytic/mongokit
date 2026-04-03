import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: ['src/index.ts', 'src/plugins/index.ts', 'src/utils/index.ts', 'src/actions/index.ts', 'src/ai/index.ts'],
  project: ['src/**/*.ts'],
  ignore: ['tests/**', 'dist/**', 'skills/**', 'docs/**', 'examples/**'],
  ignoreDependencies: ['mongodb-memory-server'],
};

export default config;
