/**
 * Dist Export Verification Tests
 *
 * Validates that the built package exports everything correctly:
 * - All public classes, functions, plugins resolve from dist/
 * - All subpath exports (./plugins, ./utils, ./actions, ./ai, ./pagination) resolve
 * - Type declarations (.d.mts) exist for every .mjs
 * - No accidental undefined exports (broken re-exports)
 * - package.json exports map matches actual files
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist');

// ─── Main entry: dist/index.mjs ─────────────────────────────────────────────

describe('Main entry exports (dist/index.mjs)', () => {
  let mod: Record<string, unknown>;

  beforeAll(async () => {
    mod = await import(resolve(DIST, 'index.mjs'));
  });

  const EXPECTED_CLASSES = [
    'Repository', 'QueryParser', 'AggregationBuilder', 'LookupBuilder',
    'PaginationEngine', 'AuditTrailQuery',
  ];

  const EXPECTED_PLUGINS = [
    'softDeletePlugin', 'batchOperationsPlugin', 'methodRegistryPlugin',
    'multiTenantPlugin', 'cachePlugin', 'timestampPlugin', 'cascadePlugin',
    'observabilityPlugin', 'mongoOperationsPlugin', 'aggregateHelpersPlugin',
    'subdocumentPlugin', 'customIdPlugin', 'validationChainPlugin',
    'auditTrailPlugin', 'auditLogPlugin', 'fieldFilterPlugin', 'elasticSearchPlugin',
  ];

  const EXPECTED_UTILS = [
    'createError', 'parseDuplicateKeyError', 'configureLogger',
    'createRepository', 'createMemoryCache', 'buildCrudSchemasFromModel',
    'getNextSequence', 'HOOK_PRIORITY',
  ];

  const EXPECTED_VALIDATORS = [
    'requireField', 'uniqueField', 'immutableField',
  ];

  const EXPECTED_ID_GENERATORS = [
    'sequentialId', 'dateSequentialId', 'prefixedId',
  ];

  for (const name of EXPECTED_CLASSES) {
    it(`exports ${name} (class/function)`, () => {
      expect(mod[name]).toBeDefined();
      expect(typeof mod[name]).toBe('function');
    });
  }

  for (const name of EXPECTED_PLUGINS) {
    it(`exports ${name} (plugin)`, () => {
      expect(mod[name]).toBeDefined();
      expect(typeof mod[name]).toBe('function');
    });
  }

  for (const name of EXPECTED_UTILS) {
    it(`exports ${name} (util)`, () => {
      expect(mod[name]).toBeDefined();
    });
  }

  for (const name of EXPECTED_VALIDATORS) {
    it(`exports ${name} (validator)`, () => {
      expect(mod[name]).toBeDefined();
      expect(typeof mod[name]).toBe('function');
    });
  }

  for (const name of EXPECTED_ID_GENERATORS) {
    it(`exports ${name} (id generator)`, () => {
      expect(mod[name]).toBeDefined();
      expect(typeof mod[name]).toBe('function');
    });
  }

  it('default export is Repository', () => {
    expect(mod.default).toBe(mod.Repository);
  });

  it('no undefined values in named exports', () => {
    const undefinedExports = Object.entries(mod)
      .filter(([key, val]) => val === undefined && key !== '__esModule')
      .map(([key]) => key);
    expect(undefinedExports).toEqual([]);
  });
});

// ─── Subpath exports ────────────────────────────────────────────────────────

describe('Subpath exports', () => {
  it('./plugins resolves', async () => {
    const mod = await import(resolve(DIST, 'plugins/index.mjs'));
    expect(mod.softDeletePlugin).toBeDefined();
    expect(mod.cachePlugin).toBeDefined();
    expect(mod.timestampPlugin).toBeDefined();
  });

  it('./utils resolves', async () => {
    const mod = await import(resolve(DIST, 'utils/index.mjs'));
    expect(mod.createError).toBeDefined();
    expect(mod.createMemoryCache).toBeDefined();
    expect(mod.configureLogger).toBeDefined();
    expect(mod.buildCrudSchemasFromModel).toBeDefined();
  });

  it('./actions resolves', async () => {
    const mod = await import(resolve(DIST, 'actions/index.mjs'));
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it('./pagination resolves', async () => {
    const mod = await import(resolve(DIST, 'pagination/PaginationEngine.mjs'));
    expect(mod.PaginationEngine).toBeDefined();
  });

  it('./ai resolves', async () => {
    const mod = await import(resolve(DIST, 'ai/index.mjs'));
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});

// ─── Declaration files ──────────────────────────────────────────────────────

describe('Type declarations exist', () => {
  const REQUIRED_DECS = [
    'dist/index.d.mts',
    'dist/plugins/index.d.mts',
    'dist/utils/index.d.mts',
    'dist/actions/index.d.mts',
    'dist/ai/index.d.mts',
    'dist/pagination/PaginationEngine.d.mts',
  ];

  for (const file of REQUIRED_DECS) {
    it(`${file} exists`, () => {
      expect(existsSync(resolve(ROOT, file))).toBe(true);
    });
  }
});

// ─── package.json exports map ───────────────────────────────────────────────

describe('package.json exports map points to real files', () => {
  let pkg: Record<string, unknown>;

  beforeAll(async () => {
    const { default: p } = await import(resolve(ROOT, 'package.json'), { with: { type: 'json' } });
    pkg = p;
  });

  it('every export path resolves to an existing file', () => {
    const exports = pkg.exports as Record<string, Record<string, string>>;
    for (const [key, value] of Object.entries(exports)) {
      if (typeof value === 'object') {
        for (const [format, path] of Object.entries(value)) {
          const fullPath = resolve(ROOT, path);
          expect(existsSync(fullPath), `${key}[${format}] → ${path} missing`).toBe(true);
        }
      }
    }
  });

  it('main field points to existing file', () => {
    expect(existsSync(resolve(ROOT, pkg.main as string))).toBe(true);
  });

  it('types field points to existing file', () => {
    expect(existsSync(resolve(ROOT, pkg.types as string))).toBe(true);
  });
});
