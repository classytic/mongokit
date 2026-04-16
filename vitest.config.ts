import path from 'node:path';
import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config — tiered per packages/testing-infrastructure.md.
 *
 * Tiers:
 *   - unit        tests/unit/**            pure, no mongo/network, 10s budget
 *   - integration tests/integration/** + legacy tests/*.test.ts at the root,
 *                 uses the shared MongoMemoryServer from global-setup.ts,
 *                 30s budget.
 *   - e2e         tests/e2e/**             real Atlas cluster (or real Mongo),
 *                 gated by MONGOKIT_E2E_URI and the safety check in
 *                 tests/helpers/e2e-safety.ts. 120s budget. Skipped entirely
 *                 when the gate is disabled — never touches the shared
 *                 memory server.
 *
 * `npm test` runs unit + integration. e2e is explicit: `npm run test:e2e`.
 *
 * Legacy flat tests (tests/*.test.ts written before the tier split) remain
 * matched by the integration project so the full 1.7k-test suite keeps
 * running as part of default CI.
 */

const forks = Math.min(4, Math.max(1, cpus().length - 1));

export default defineConfig({
  resolve: {
    alias: {
      '@classytic/mongokit': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000,
          pool: 'forks',
          poolOptions: { forks: { minForks: 1, maxForks: forks } },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          // Legacy flat tests at tests/*.test.ts and subdirectories
          // (tests/query/**, tests/utils/**) keep working; new tier-split
          // tests live under tests/integration/**. tests/unit/** is excluded so
          // unit tests don't pay the mongo-memory startup cost twice.
          include: ['tests/**/*.test.ts'],
          exclude: [
            'tests/benchmark-*.test.ts',
            'tests/_shared/**',
            'tests/unit/**',
            'tests/e2e/**',
            'tests/smoke/**',
          ],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          globalSetup: ['./tests/_shared/global-setup.ts'],
          pool: 'forks',
          poolOptions: { forks: { minForks: 1, maxForks: forks } },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
          // Load .env before the test module imports the safety helper.
          setupFiles: ['dotenv/config'],
          // 120s per testing-infrastructure.md. Long enough for Atlas vector
          // index propagation while still catching stuck processes. Index
          // builds on new clusters can take ~1-3 minutes on first create,
          // so hookTimeout is loose.
          testTimeout: 180_000,
          hookTimeout: 300_000,
          // No globalSetup — e2e connects to a real cluster, not the shared
          // memory-server. Serialize forks so the real DB isn't hammered.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
