/**
 * `requirePlugins` constructor assertion — fail-closed plugin presence
 * check at boot.
 *
 * Replaces convention-by-documentation ("always wire multiTenantPlugin"
 * repeated in 7+ CLAUDE.md files; "always wire softDeletePlugin"
 * repeated in 9+) with a runtime check that throws if a plugin name
 * in the list isn't present in the chain. Eliminates the silent-
 * misconfig shape where a host forgets a plugin and ships a tenant-
 * leak / missing-soft-delete-filter to production.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLogPlugin,
  multiTenantPlugin,
  Repository,
  softDeletePlugin,
  timestampPlugin,
} from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  _id?: mongoose.Types.ObjectId;
  name: string;
  organizationId: string;
}

describe('requirePlugins — constructor presence assertion', () => {
  let Model: mongoose.Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'RequirePluginsDoc',
      new Schema<IDoc>({
        name: { type: String, required: true },
        organizationId: { type: String, required: true, index: true },
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  it('does NOT throw when every required plugin is present', () => {
    expect(() => {
      new Repository<IDoc>(
        Model,
        [multiTenantPlugin({ tenantField: 'organizationId' }), softDeletePlugin()],
        {},
        { requirePlugins: ['multi-tenant', 'softDelete'] },
      );
    }).not.toThrow();
  });

  it('throws TypeError when ANY required plugin is missing', () => {
    expect(() => {
      new Repository<IDoc>(
        Model,
        [multiTenantPlugin({ tenantField: 'organizationId' })],
        {},
        { requirePlugins: ['multi-tenant', 'softDelete', 'auditLog'] },
      );
    }).toThrow(TypeError);
  });

  it('error message lists every missing plugin (one round-trip fix)', () => {
    let caught: Error | undefined;
    try {
      new Repository<IDoc>(
        Model,
        [multiTenantPlugin({ tenantField: 'organizationId' })],
        {},
        { requirePlugins: ['multi-tenant', 'softDelete', 'auditLog'] },
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    // Both missing plugins are in the message — host doesn't have to
    // bisect to find them all.
    expect(caught?.message).toMatch(/softDelete/);
    expect(caught?.message).toMatch(/auditLog/);
    // The model name is in the message so multi-repo apps know which
    // boot site failed.
    expect(caught?.message).toContain(Model.modelName);
  });

  it('error message lists installed plugins so host can diff against required', () => {
    let caught: Error | undefined;
    try {
      new Repository<IDoc>(
        Model,
        [timestampPlugin(), multiTenantPlugin({ tenantField: 'organizationId' })],
        {},
        { requirePlugins: ['multi-tenant', 'softDelete', 'auditLog'] },
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toMatch(/Installed plugins:/);
    expect(caught?.message).toMatch(/timestamp/);
    expect(caught?.message).toMatch(/multi-tenant/);
  });

  it('empty requirePlugins list (default) does NOT throw', () => {
    // Backwards compat: every existing repo construction without
    // requirePlugins must continue to work.
    expect(() => {
      new Repository<IDoc>(Model, [], {}, {});
    }).not.toThrow();

    expect(() => {
      new Repository<IDoc>(Model, [], {}, { requirePlugins: [] });
    }).not.toThrow();
  });

  it('checks plugin names against installed `name` properties (NOT plugin function names)', () => {
    // Each plugin's exported `name` field is the canonical identifier
    // (e.g. multiTenantPlugin returns { name: 'multi-tenant', apply })
    // — NOT the JavaScript function name. Verify the check uses the
    // right identifier so a function-name mismatch doesn't false-pass.
    expect(() => {
      new Repository<IDoc>(
        Model,
        [softDeletePlugin()],
        {},
        // 'softDelete' is the plugin's `name`, not 'softDeletePlugin'.
        { requirePlugins: ['softDelete'] },
      );
    }).not.toThrow();

    // The function name `softDeletePlugin` is NOT what we check.
    expect(() => {
      new Repository<IDoc>(
        Model,
        [softDeletePlugin()],
        {},
        { requirePlugins: ['softDeletePlugin'] }, // wrong name
      );
    }).toThrow(/softDeletePlugin/);
  });

  it('repository works normally after passing the assertion', async () => {
    // Sanity: nothing in the assertion path should leak state into
    // the constructed repo. Verify a normal CRUD round-trip works.
    const repo = new Repository<IDoc>(
      Model,
      [
        multiTenantPlugin({ tenantField: 'organizationId' }),
        softDeletePlugin(),
        auditLogPlugin({ logger: () => {} }),
      ],
      {},
      { requirePlugins: ['multi-tenant', 'softDelete', 'auditLog'] },
    );

    const created = await repo.create({ name: 'A' }, { organizationId: 'org-1' });
    expect(created.name).toBe('A');

    const found = await repo.getById(String(created._id), { organizationId: 'org-1' });
    expect(found?.name).toBe('A');
  });
});
