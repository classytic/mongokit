/**
 * `multiTenantPlugin` host-composition primitives — `bypassTenant`
 * per-call option, `adminBypass` factory, `after:tenant-bypass` audit
 * event, plus the host-composition patterns the plugin's narrow scope
 * leaves to userland (branch sub-scoping via stacked instances,
 * owner/team scoping via `before:*` hooks).
 *
 * The plugin owns ONE thing: deterministic injection of one tenant
 * field into queries / payloads / bulkWrite ops. Everything else
 * (branches, teams, owners, regional admins) composes on top.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminBypass, multiTenantPlugin, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IDoc {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  branchId?: string;
  ownerId?: string;
  status: string;
  name: string;
}

describe('multiTenantPlugin — host-composition primitives', () => {
  let Model: mongoose.Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'TenantPrimDoc',
      new Schema<IDoc>({
        organizationId: { type: String, required: true, index: true },
        branchId: { type: String, index: true },
        ownerId: { type: String, index: true },
        status: { type: String, required: true },
        name: { type: String, required: true },
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

  // ────────────────────────────────────────────────────────────────────
  // bypassTenant — per-call escape hatch
  // ────────────────────────────────────────────────────────────────────

  describe('bypassTenant: true — per-call escape hatch', () => {
    it('with required: true, normally throws when context lacks the tenant', async () => {
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      // Missing organizationId in context → throw.
      await expect(repo.getAll({ filters: {} })).rejects.toThrow(/Missing 'organizationId'/);
    });

    it('bypassTenant: true with required: true does NOT throw and returns cross-tenant data', async () => {
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      await Model.create([
        { organizationId: 'org-a', status: 'active', name: 'A' },
        { organizationId: 'org-b', status: 'active', name: 'B' },
      ]);

      // Per-call bypass — no tenant filter injected.
      const result = await repo.findAll({}, { bypassTenant: true });
      const names = (result as Array<{ name: string }>).map((d) => d.name).sort();
      expect(names).toEqual(['A', 'B']);
    });

    it('bypassTenant scopes to ONE call, not subsequent calls on the same repo', async () => {
      // Critical safety property: bypass is per-call, NOT sticky on
      // the repo. A support engineer's bypassed query must not
      // accidentally turn off scoping for the next request that
      // reuses the same repo instance.
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      await Model.create([
        { organizationId: 'org-a', status: 'active', name: 'A' },
        { organizationId: 'org-b', status: 'active', name: 'B' },
      ]);

      const bypassed = await repo.findAll({}, { bypassTenant: true });
      expect(bypassed).toHaveLength(2);

      // Next call without bypass — must still throw on missing tenant.
      await expect(repo.findAll({})).rejects.toThrow(/Missing 'organizationId'/);

      // Next call with proper tenant — scopes correctly.
      const scoped = await repo.findAll({}, { organizationId: 'org-a' });
      expect(scoped).toHaveLength(1);
      expect((scoped[0] as { name: string }).name).toBe('A');
    });

    it('bypassTenant: true on writes — caller controls the org field manually', async () => {
      // When bypassing on writes, the caller is responsible for
      // setting the tenant field (or leaving it absent). The plugin
      // does NOT inject it. This is the migration-script use case.
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);

      const created = await repo.create(
        { organizationId: 'org-special', status: 'active', name: 'manual' },
        { bypassTenant: true },
      );
      expect(created.organizationId).toBe('org-special');
      expect(created.name).toBe('manual');
    });

    it('bypassTenant: false (or absent) keeps the normal scoping path', async () => {
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      await Model.create([
        { organizationId: 'org-a', status: 'active', name: 'A' },
        { organizationId: 'org-b', status: 'active', name: 'B' },
      ]);

      // Explicit `bypassTenant: false` — same as not passing it.
      const result = await repo.findAll({}, { bypassTenant: false, organizationId: 'org-a' });
      expect(result).toHaveLength(1);
      expect((result[0] as { name: string }).name).toBe('A');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // adminBypass — canonical role-based skipWhen factory
  // ────────────────────────────────────────────────────────────────────

  describe('adminBypass — role-based skipWhen factory', () => {
    it('returns true when the role is in adminRoles', () => {
      const skip = adminBypass({ adminRoles: ['superadmin', 'platform_admin'] });

      expect(skip({ role: 'superadmin' } as never, 'getAll')).toBe(true);
      expect(skip({ role: 'platform_admin' } as never, 'getAll')).toBe(true);
      expect(skip({ role: 'user' } as never, 'getAll')).toBe(false);
      expect(skip({ role: 'admin' } as never, 'getAll')).toBe(false); // 'admin' is not in the list
    });

    it('returns false when the role field is absent or wrong type', () => {
      const skip = adminBypass({ adminRoles: ['superadmin'] });

      expect(skip({} as never, 'getAll')).toBe(false);
      expect(skip({ role: undefined } as never, 'getAll')).toBe(false);
      expect(skip({ role: 123 } as never, 'getAll')).toBe(false); // number, not string
      expect(skip({ role: null } as never, 'getAll')).toBe(false);
    });

    it('honors a custom roleField', () => {
      const skip = adminBypass({
        roleField: 'principalRole',
        adminRoles: ['superadmin'],
      });
      expect(skip({ principalRole: 'superadmin' } as never, 'getAll')).toBe(true);
      // The default `role` field is ignored when roleField is overridden.
      expect(skip({ role: 'superadmin' } as never, 'getAll')).toBe(false);
    });

    it('mutating the input adminRoles array AFTER factory creation does NOT change behaviour', () => {
      // Defensive freeze — same property as createOptionsExtractor.
      const adminRoles: string[] = ['superadmin'];
      const skip = adminBypass({ adminRoles });
      expect(skip({ role: 'superadmin' } as never, 'getAll')).toBe(true);

      adminRoles.push('platform_admin'); // try to add post-creation
      // The factory's frozen Set ignores the mutation.
      expect(skip({ role: 'platform_admin' } as never, 'getAll')).toBe(false);
    });

    it('integration: skipWhen: adminBypass(...) lets superadmins see all orgs', async () => {
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({
          tenantField: 'organizationId',
          required: true,
          skipWhen: adminBypass({ adminRoles: ['superadmin'] }),
        }),
      ]);
      await Model.create([
        { organizationId: 'org-a', status: 'active', name: 'A' },
        { organizationId: 'org-b', status: 'active', name: 'B' },
      ]);

      // Regular user — scoped to their org.
      const userResult = await repo.findAll({}, { role: 'user', organizationId: 'org-a' });
      expect(userResult).toHaveLength(1);

      // Super-admin — sees both.
      const adminResult = await repo.findAll({}, { role: 'superadmin' });
      expect(adminResult).toHaveLength(2);
    });

    it('admin role does NOT bypass — must be in the explicit list', async () => {
      // Defensive: a "role: 'admin'" that isn't in adminRoles must
      // still be tenant-scoped. Prevents accidental privilege
      // escalation if someone adds 'admin' as a domain role without
      // realising it would now bypass tenancy.
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({
          tenantField: 'organizationId',
          required: true,
          skipWhen: adminBypass({ adminRoles: ['superadmin'] }),
        }),
      ]);

      // 'admin' (NOT 'superadmin') — must still throw on missing tenant.
      await expect(repo.findAll({}, { role: 'admin' })).rejects.toThrow(/Missing 'organizationId'/);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // after:tenant-bypass — audit event
  // ────────────────────────────────────────────────────────────────────

  describe('after:tenant-bypass — audit event for compliance', () => {
    it('emits when bypassTenant: true is used (reason: option)', async () => {
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      const onBypass = vi.fn();
      repo.on('after:tenant-bypass', onBypass);

      await repo.findAll({}, { bypassTenant: true });

      // Fires once for findAll's `before:findAll` hook (the only op
      // exercised here).
      expect(onBypass).toHaveBeenCalled();
      const payload = onBypass.mock.calls[0]?.[0] as {
        reason: string;
        operation: string;
        context: unknown;
      };
      expect(payload.reason).toBe('option');
      expect(payload.operation).toBe('findAll');
      expect(payload.context).toBeDefined();
    });

    it('emits when skipWhen returns true (reason: callback)', async () => {
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({
          tenantField: 'organizationId',
          required: true,
          skipWhen: adminBypass({ adminRoles: ['superadmin'] }),
        }),
      ]);
      const onBypass = vi.fn();
      repo.on('after:tenant-bypass', onBypass);

      await repo.findAll({}, { role: 'superadmin' });

      expect(onBypass).toHaveBeenCalled();
      const payload = onBypass.mock.calls[0]?.[0] as { reason: string };
      expect(payload.reason).toBe('callback');
    });

    it('does NOT emit when the call is normally tenant-scoped', async () => {
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      const onBypass = vi.fn();
      repo.on('after:tenant-bypass', onBypass);

      await repo.findAll({}, { organizationId: 'org-a' });

      expect(onBypass).not.toHaveBeenCalled();
    });

    it('per-call bypass takes precedence over skipWhen (reason stays "option")', async () => {
      // When BOTH bypassTenant: true AND skipWhen would fire, the
      // per-call form wins — it's the more specific decision.
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({
          tenantField: 'organizationId',
          required: true,
          skipWhen: adminBypass({ adminRoles: ['superadmin'] }),
        }),
      ]);
      const onBypass = vi.fn();
      repo.on('after:tenant-bypass', onBypass);

      await repo.findAll({}, { role: 'superadmin', bypassTenant: true });

      expect(onBypass).toHaveBeenCalled();
      const payload = onBypass.mock.calls[0]?.[0] as { reason: string };
      expect(payload.reason).toBe('option');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Host composition — branches, teams, owner-id (the patterns the
  // plugin deliberately leaves to userland)
  // ────────────────────────────────────────────────────────────────────

  describe('host composition — branch sub-scoping via stacked plugin instances', () => {
    it('two multiTenantPlugin instances scope by org AND branch independently', async () => {
      // Real-world pattern: a tenant has branches, branch managers
      // see only their branch's data, org admins see all branches.
      // Achieved by stacking two `multiTenantPlugin` instances —
      // one for the org (always required), one for the branch
      // (optional — only branch managers pass it).
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({
          tenantField: 'organizationId',
          contextKey: 'organizationId',
          required: true,
        }),
        multiTenantPlugin({
          tenantField: 'branchId',
          contextKey: 'branchId',
          required: false, // branch is optional — org admins see all branches
        }),
      ]);
      await Model.create([
        { organizationId: 'org-a', branchId: 'br-1', status: 'active', name: 'A1' },
        { organizationId: 'org-a', branchId: 'br-2', status: 'active', name: 'A2' },
        { organizationId: 'org-b', branchId: 'br-1', status: 'active', name: 'B1' },
      ]);

      // Org admin (no branchId) — sees all of org-a, both branches.
      const orgAdmin = await repo.findAll({}, { organizationId: 'org-a' });
      expect((orgAdmin as Array<{ name: string }>).map((d) => d.name).sort()).toEqual(['A1', 'A2']);

      // Branch manager (with branchId) — sees only their branch.
      const branchMgr = await repo.findAll({}, { organizationId: 'org-a', branchId: 'br-1' });
      expect((branchMgr as Array<{ name: string }>).map((d) => d.name)).toEqual(['A1']);

      // Different tenant's same branch id — still scoped by org.
      const orgB = await repo.findAll({}, { organizationId: 'org-b', branchId: 'br-1' });
      expect((orgB as Array<{ name: string }>).map((d) => d.name)).toEqual(['B1']);
    });

    it('writes get tagged with both org and branch when both are in context', async () => {
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
        multiTenantPlugin({ tenantField: 'branchId', contextKey: 'branchId', required: false }),
      ]);

      const created = await repo.create(
        { status: 'active', name: 'auto-tagged' },
        { organizationId: 'org-a', branchId: 'br-1' },
      );
      expect(created.organizationId).toBe('org-a');
      expect(created.branchId).toBe('br-1');
    });
  });

  describe('host composition — owner-id scoping via custom before:* hook', () => {
    it("layers ownerId === userId scoping on top of tenant via repo.on('before:*')", async () => {
      // The plugin doesn't ship owner/team scoping primitives — those
      // are domain logic. The supported pattern: register a
      // `before:*` hook that injects an additional filter into
      // `context.query` / `context.filters`. Composes on top of the
      // tenant scope (which runs at HOOK_PRIORITY.POLICY 100).
      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);

      // Owner-id scoping for read-shaped ops. Real hosts would wire
      // this in their domain layer, not inline in test setup.
      const ownerScopeOps = ['findAll', 'getAll', 'getOne', 'getById'] as const;
      for (const op of ownerScopeOps) {
        repo.on(`before:${op}`, (ctx: Record<string, unknown>) => {
          const userId = ctx.userId as string | undefined;
          const role = ctx.role as string | undefined;
          if (!userId || role === 'admin') return; // admins see all rows in the org
          // Non-admin: scope to their own rows.
          if (op === 'getAll') {
            ctx.filters = { ...(ctx.filters as Record<string, unknown>), ownerId: userId };
          } else {
            ctx.query = { ...(ctx.query as Record<string, unknown>), ownerId: userId };
          }
        });
      }

      await Model.create([
        { organizationId: 'org-a', ownerId: 'u-1', status: 'active', name: 'mine-1' },
        { organizationId: 'org-a', ownerId: 'u-2', status: 'active', name: 'theirs' },
        { organizationId: 'org-a', ownerId: 'u-1', status: 'active', name: 'mine-2' },
      ]);

      // u-1 (regular user) — sees only their own rows.
      const myRows = await repo.findAll({}, { organizationId: 'org-a', userId: 'u-1' });
      expect((myRows as Array<{ name: string }>).map((d) => d.name).sort()).toEqual([
        'mine-1',
        'mine-2',
      ]);

      // org admin — sees every row in the org.
      const allRows = await repo.findAll(
        {},
        { organizationId: 'org-a', userId: 'admin-x', role: 'admin' },
      );
      expect(allRows as Array<{ name: string }>).toHaveLength(3);
    });
  });

  describe('audit composition — wiring after:tenant-bypass into a sink', () => {
    it("a host's audit logger captures every bypass with reason + operation + context", async () => {
      // Real-world wiring: the host listens once per repo for
      // `after:tenant-bypass` and writes to whatever audit sink they
      // use (DB, file, SIEM). This test simulates the sink with a
      // simple array and verifies the payload has everything an
      // auditor needs.
      type AuditEntry = {
        reason: 'option' | 'callback';
        operation: string;
        actorId?: string;
        timestamp: Date;
      };
      const auditLog: AuditEntry[] = [];

      const repo = new Repository<IDoc>(Model, [
        multiTenantPlugin({
          tenantField: 'organizationId',
          required: true,
          skipWhen: adminBypass({ adminRoles: ['superadmin'] }),
        }),
      ]);
      repo.on(
        'after:tenant-bypass',
        (data: {
          reason: 'option' | 'callback';
          operation: string;
          context: Record<string, unknown>;
        }) => {
          auditLog.push({
            reason: data.reason,
            operation: data.operation,
            actorId: data.context.userId as string | undefined,
            timestamp: new Date(),
          });
        },
      );

      await Model.create({ organizationId: 'org-a', status: 'active', name: 'A' });

      // Two bypasses — one via option, one via role.
      await repo.findAll({}, { bypassTenant: true, userId: 'support-eng-1' });
      await repo.findAll({}, { role: 'superadmin', userId: 'admin-1' });
      // One non-bypassed call — must NOT appear in the audit log.
      await repo.findAll({}, { organizationId: 'org-a', userId: 'user-1' });

      expect(auditLog).toHaveLength(2);
      expect(auditLog[0]).toMatchObject({
        reason: 'option',
        operation: 'findAll',
        actorId: 'support-eng-1',
      });
      expect(auditLog[1]).toMatchObject({
        reason: 'callback',
        operation: 'findAll',
        actorId: 'admin-1',
      });
    });
  });
});
