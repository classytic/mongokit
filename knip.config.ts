import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  project: ['src/**/*.ts'],
  rules: {
    types: 'off',        // Published library — exported types consumed externally
    duplicates: 'off',   // Repository: intentional named + default export
  },
};

export default config;
