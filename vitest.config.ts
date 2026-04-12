import path from 'node:path';
import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config.
 *
 * - `globalSetup` starts one MongoMemoryServer per `vitest run` invocation
 *   and publishes its URI. Every test file reuses it — eliminating the
 *   per-file start/stop that used to dominate run time.
 *
 * - Parallel forks (cap at 4 to keep memory-server pressure sane). Each
 *   fork connects to the SAME shared server; test files use unique
 *   collection-name prefixes to prevent cross-file interference.
 *
 * - Suite isolation is by file: run a single suite with
 *       `npx vitest run tests/<file>.test.ts`
 *   The global server still starts once for that single file, which is
 *   fine — the shared bit only matters across files.
 *
 * - Set `MONGODB_URI` externally to target a real replica set (transaction
 *   tests will then actually run transactions instead of hitting the
 *   standalone fallback).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@classytic/mongokit': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/benchmark-*.test.ts', 'tests/_shared/**'],
    testTimeout: 30000,
    hookTimeout: 60000, // startup can take up to ~30s on cold Windows boxes
    globalSetup: ['./tests/_shared/global-setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // Parallel forks, capped so the shared memory server isn't overwhelmed.
        minForks: 1,
        maxForks: Math.min(4, Math.max(1, cpus().length - 1)),
        // Each fork is a fresh Node process — no in-process state leaks
        // between files in different forks.
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
    },
  },
});
