/**
 * Unit tests for plugin order validation at Repository construction.
 *
 * Uses a fake Mongoose-model shape so no mongo connection is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model } from 'mongoose';
import { Repository } from '../../src/Repository.js';
import type { Plugin } from '../../src/types.js';
import * as logger from '../../src/utils/logger.js';

function fakeModel(name = 'FakeDoc'): Model<Record<string, unknown>> {
  return {
    modelName: name,
    schema: { indexes: () => [], obj: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function namedPlugin(name: string): Plugin {
  return { name, apply: () => {} };
}

describe('Repository plugin order validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when soft-delete comes after batch-operations', () => {
    new Repository(fakeModel(), [namedPlugin('batch-operations'), namedPlugin('soft-delete')]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/soft-delete must precede batch-operations/);
  });

  it('warns when multi-tenant comes after cache', () => {
    new Repository(fakeModel(), [namedPlugin('cache'), namedPlugin('multi-tenant')]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/multi-tenant must precede cache/);
  });

  it('warns once per constraint when multiple are violated', () => {
    new Repository(fakeModel(), [
      namedPlugin('batch-operations'),
      namedPlugin('cache'),
      namedPlugin('soft-delete'),
      namedPlugin('multi-tenant'),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('stays silent for a correct composition', () => {
    new Repository(fakeModel(), [
      namedPlugin('multi-tenant'),
      namedPlugin('soft-delete'),
      namedPlugin('cache'),
      namedPlugin('batch-operations'),
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays silent when only one of the pair is present', () => {
    new Repository(fakeModel(), [namedPlugin('cache')]);
    new Repository(fakeModel(), [namedPlugin('soft-delete')]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ignores plain-function plugins (no .name) — no false positives', () => {
    const fnPlugin = () => {};
    new Repository(fakeModel(), [fnPlugin, namedPlugin('soft-delete')]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws when pluginOrderChecks: "throw" and a constraint is violated', () => {
    expect(
      () =>
        new Repository(
          fakeModel(),
          [namedPlugin('cache'), namedPlugin('multi-tenant')],
          {},
          { pluginOrderChecks: 'throw' },
        ),
    ).toThrow(/multi-tenant must precede cache/);
  });

  it('stays silent when pluginOrderChecks: "off" even with a violation', () => {
    new Repository(
      fakeModel(),
      [namedPlugin('cache'), namedPlugin('multi-tenant')],
      {},
      { pluginOrderChecks: 'off' },
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('includes a helpful actionable error message (index positions + swap suggestion)', () => {
    new Repository(fakeModel('Invoice'), [
      namedPlugin('batch-operations'),
      namedPlugin('soft-delete'),
    ]);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('Invoice');
    expect(msg).toContain("'batch-operations' at index 0");
    expect(msg).toContain("'soft-delete' at index 1");
    expect(msg).toContain('Swap them');
  });
});
