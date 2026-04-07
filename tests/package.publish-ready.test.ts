import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

describe('Package publish readiness', () => {
  let pkg: Record<string, unknown>;

  beforeAll(async () => {
    const { default: p } = await import(resolve(ROOT, 'package.json'), {
      with: { type: 'json' },
    });
    pkg = p;
  });

  it('every declared package export has a built JS file and declaration file', () => {
    const exportsMap = pkg.exports as Record<string, Record<string, string>>;

    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (typeof target !== 'object' || !target) continue;

      const jsPath = target.default;
      const dtsPath = target.types;

      expect(typeof jsPath, `${subpath} is missing a default export target`).toBe('string');
      expect(typeof dtsPath, `${subpath} is missing a types export target`).toBe('string');

      expect(existsSync(resolve(ROOT, jsPath!)), `${subpath} JS target missing: ${jsPath}`).toBe(true);
      expect(existsSync(resolve(ROOT, dtsPath!)), `${subpath} types target missing: ${dtsPath}`).toBe(true);
    }
  });
});
