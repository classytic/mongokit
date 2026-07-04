import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  project: ['src/**/*.ts'],
  ignore: ['src/contract.ts'], // Compile-time StandardRepo conformance check — no runtime importers
  ignoreDependencies: ['@arethetypeswrong/cli'], // Consumed by tsdown (attw: 'ci-only'), not imported
  rules: {
    types: 'off',        // Published library — exported types consumed externally
    duplicates: 'off',   // Repository: intentional named + default export
  },
};

export default config;
