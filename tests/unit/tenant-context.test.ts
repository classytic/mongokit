/**
 * Unit tests for createTenantContext — AsyncLocalStorage wrapper.
 *
 * Validates that the helper:
 *   - propagates the tenant ID through async boundaries
 *   - returns undefined outside an active context
 *   - throws on requireTenantId() when no context is active
 *   - works composed with multiTenantPlugin's resolveContext hook
 */

import { describe, expect, it, vi } from 'vitest';
import { createTenantContext } from '../../src/plugins/tenant-context.js';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant.plugin.js';

describe('createTenantContext — AsyncLocalStorage behavior', () => {
  it('returns undefined tenant when no context is active', () => {
    const tc = createTenantContext();
    expect(tc.getTenantId()).toBeUndefined();
    expect(tc.getStore()).toBeUndefined();
  });

  it('run() makes the tenant ID visible to synchronous callees', () => {
    const tc = createTenantContext();
    const seen = tc.run({ tenantId: 'org_123' }, () => tc.getTenantId());
    expect(seen).toBe('org_123');
  });

  it('run() propagates the tenant ID across async boundaries', async () => {
    const tc = createTenantContext();
    const seen = await tc.run({ tenantId: 'org_async' }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      return tc.getTenantId();
    });
    expect(seen).toBe('org_async');
  });

  it('nested run() overrides the parent tenant for its async subtree', async () => {
    const tc = createTenantContext();
    const result = await tc.run({ tenantId: 'outer' }, async () => {
      const inner = await tc.run({ tenantId: 'inner' }, async () => {
        await Promise.resolve();
        return tc.getTenantId();
      });
      return { outer: tc.getTenantId(), inner };
    });
    expect(result).toEqual({ outer: 'outer', inner: 'inner' });
  });

  it('requireTenantId throws outside a context', () => {
    const tc = createTenantContext();
    expect(() => tc.requireTenantId()).toThrow(/No tenant context active/);
  });

  it('requireTenantId returns the id inside a context', () => {
    const tc = createTenantContext();
    const id = tc.run({ tenantId: 'org_req' }, () => tc.requireTenantId());
    expect(id).toBe('org_req');
  });

  it('allows arbitrary metadata on the store alongside tenantId', () => {
    const tc = createTenantContext();
    tc.run({ tenantId: 'org_meta', userId: 'u_1', requestId: 'r_42' }, () => {
      expect(tc.getStore()).toMatchObject({
        tenantId: 'org_meta',
        userId: 'u_1',
        requestId: 'r_42',
      });
    });
  });
});

describe('createTenantContext — wiring through multiTenantPlugin.resolveContext', () => {
  /**
   * Builds a minimal fake Repository that captures hook registrations, so we
   * can invoke the `before:*` hooks directly without spinning up MongoDB.
   * We only assert that the plugin populates `context.organizationId` from
   * the AsyncLocalStorage store when the caller didn't pass one.
   */
  function makeFakeRepo() {
    const hooks = new Map<string, ((ctx: Record<string, unknown>) => void)[]>();
    const repo = {
      on(event: string, listener: (ctx: Record<string, unknown>) => void) {
        if (!hooks.has(event)) hooks.set(event, []);
        hooks.get(event)!.push(listener);
        return repo;
      },
    };
    return { repo, hooks };
  }

  it('resolveContext picks up tenantId from the AsyncLocalStorage store', async () => {
    const tc = createTenantContext();
    const plugin = multiTenantPlugin({
      tenantField: 'organizationId',
      contextKey: 'organizationId',
      required: true,
      resolveContext: () => tc.getTenantId(),
    });

    const { repo, hooks } = makeFakeRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugin.apply(repo as any);

    const beforeGetAll = hooks.get('before:getAll');
    expect(beforeGetAll?.length).toBe(1);

    const ctx: Record<string, unknown> = { filters: { status: 'paid' } };
    await tc.run({ tenantId: 'org_als' }, () => {
      beforeGetAll![0](ctx);
    });

    expect(ctx.organizationId).toBe('org_als');
    expect(ctx.filters).toMatchObject({ organizationId: 'org_als', status: 'paid' });
  });

  it('without resolveContext or explicit context, required:true still throws — safe default', () => {
    const plugin = multiTenantPlugin({
      tenantField: 'organizationId',
      contextKey: 'organizationId',
      required: true,
    });
    const { repo, hooks } = makeFakeRepo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugin.apply(repo as any);
    const beforeGetAll = hooks.get('before:getAll')![0];

    expect(() => beforeGetAll({ filters: {} })).toThrow(/Missing 'organizationId'/);
  });
});
