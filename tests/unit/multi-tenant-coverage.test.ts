/**
 * Multi-tenant scope coverage — table-driven over the op registry.
 *
 * Iterates ALL_OPERATIONS and asserts that `multiTenantPlugin` injects
 * the tenant scope into the policy target declared by each op's
 * `policyKey`. New operations added to OP_REGISTRY are covered
 * automatically — an op can't silently skip tenancy: either its
 * policyKey routes it through one of the asserted branches, or the
 * explicit `none`-allowlist assertion at the bottom fails and forces a
 * conscious decision.
 *
 * Also locks the fail-closed posture:
 *   - missing tenant under `required: true` throws (reads AND writes)
 *   - caller-supplied MISMATCHING tenant values are rejected
 *     (`onMismatch: 'throw'` default), incl. operator-shaped values
 *   - matching values pass; `onMismatch: 'overwrite'` restores legacy
 */

import type { Model } from 'mongoose';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS, OP_REGISTRY, type PolicyKey } from '../../src/operations.js';
import { multiTenantPlugin } from '../../src/plugins/multi-tenant.plugin.js';
import { Repository } from '../../src/Repository.js';

const ORG = 'org_scope_test';
const OTHER_ORG = 'org_other';

function fakeModel(name = 'TenantCoverageDoc'): Model<Record<string, unknown>> {
  return {
    modelName: name,
    schema: { indexes: () => [], obj: {}, paths: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRepo(options: Parameters<typeof multiTenantPlugin>[0] = {}) {
  return new Repository(fakeModel(), [
    multiTenantPlugin({ tenantField: 'organizationId', required: true, ...options }),
  ]);
}

/** Policy-target inputs per policyKey — what the op hands to _buildContext. */
function inputsFor(policyKey: PolicyKey): Record<string, unknown> {
  switch (policyKey) {
    case 'filters':
      return { filters: { status: 'active' } };
    case 'query':
      return { query: { status: 'active' } };
    case 'data':
      return { data: { name: 'doc' } };
    case 'dataArray':
      return { dataArray: [{ name: 'a' }, { name: 'b' }] };
    case 'operations':
      return {
        operations: [
          { updateOne: { filter: { name: 'a' }, update: { $set: { name: 'a2' } } } },
          { deleteMany: { filter: { status: 'stale' } } },
          { insertOne: { document: { name: 'new' } } },
        ],
      };
    case 'none':
      return {};
  }
}

/** Assert the tenant scope landed in the op's policy target. */
function assertScoped(policyKey: PolicyKey, context: Record<string, unknown>): void {
  switch (policyKey) {
    case 'filters':
      expect(context.filters).toMatchObject({ organizationId: ORG, status: 'active' });
      break;
    case 'query':
      expect(context.query).toMatchObject({ organizationId: ORG, status: 'active' });
      break;
    case 'data':
      expect(context.data).toMatchObject({ organizationId: ORG });
      break;
    case 'dataArray':
      for (const doc of context.dataArray as Record<string, unknown>[]) {
        expect(doc).toMatchObject({ organizationId: ORG });
      }
      break;
    case 'operations': {
      const [upd, del, ins] = context.operations as Record<
        string,
        { filter?: Record<string, unknown>; document?: Record<string, unknown> }
      >[];
      expect(upd.updateOne?.filter).toMatchObject({ organizationId: ORG });
      expect(del.deleteMany?.filter).toMatchObject({ organizationId: ORG });
      expect(ins.insertOne?.document).toMatchObject({ organizationId: ORG });
      break;
    }
    case 'none':
      throw new Error('none ops are asserted separately');
  }
}

describe('multi-tenant scope covers EVERY registered operation (table-driven)', () => {
  const scopedOps = ALL_OPERATIONS.filter((op) => OP_REGISTRY[op].policyKey !== 'none');

  it.each(
    scopedOps.map((op) => [op, OP_REGISTRY[op].policyKey] as const),
  )('injects tenant scope on %s (policyKey: %s)', async (op, policyKey) => {
    const repo = makeRepo();
    const context = await repo._buildContext(op, {
      ...inputsFor(policyKey),
      organizationId: ORG,
    });
    assertScoped(policyKey, context as unknown as Record<string, unknown>);
  });

  it.each(
    scopedOps.map((op) => [op] as const),
  )('fails closed on %s when no tenant is resolvable (required: true)', async (op) => {
    const repo = makeRepo();
    const policyKey = OP_REGISTRY[op].policyKey;
    await expect(repo._buildContext(op, inputsFor(policyKey))).rejects.toThrow(
      /Missing 'organizationId'/,
    );
  });

  it("every op with policyKey 'none' is consciously allowlisted here", () => {
    // No registered op is currently exempt from tenant scoping. If a
    // future op genuinely takes no filter input (policyKey 'none'), add
    // it to this allowlist WITH a justification — this test exists so
    // that exemption is a reviewed decision, not an accident.
    const noneAllowlist: string[] = [];
    const noneOps = ALL_OPERATIONS.filter((op) => OP_REGISTRY[op].policyKey === 'none');
    expect(noneOps.map(String).sort()).toEqual(noneAllowlist.sort());
  });

  it("covers soft-delete's getDeleted extra op (filters policy)", async () => {
    const repo = makeRepo();
    const context = await repo._buildContext('getDeleted', {
      filters: { status: 'active' },
      organizationId: ORG,
    });
    expect(context.filters).toMatchObject({ organizationId: ORG });
  });
});

describe('multi-tenant mismatch guard (fail-closed by default)', () => {
  it('rejects a caller-supplied DIFFERENT tenant value in query', async () => {
    const repo = makeRepo();
    await expect(
      repo._buildContext('getOne', {
        query: { organizationId: OTHER_ORG },
        organizationId: ORG,
      }),
    ).rejects.toThrow(/does not match the resolved tenant scope/);
  });

  it('rejects a mismatching tenant value in write payloads (create data)', async () => {
    const repo = makeRepo();
    await expect(
      repo._buildContext('create', {
        data: { name: 'x', organizationId: OTHER_ORG },
        organizationId: ORG,
      }),
    ).rejects.toThrow(/does not match the resolved tenant scope/);
  });

  it('rejects operator-shaped tenant values (multi-value scoping requires explicit bypass)', async () => {
    const repo = makeRepo();
    await expect(
      repo._buildContext('findAll', {
        query: { organizationId: { $in: [ORG, OTHER_ORG] } },
        organizationId: ORG,
      }),
    ).rejects.toThrow(/does not match the resolved tenant scope/);
  });

  it('rejects mismatches inside bulkWrite sub-operations', async () => {
    const repo = makeRepo();
    await expect(
      repo._buildContext('bulkWrite', {
        operations: [{ updateOne: { filter: { organizationId: OTHER_ORG }, update: {} } }],
        organizationId: ORG,
      }),
    ).rejects.toThrow(/does not match the resolved tenant scope/);
  });

  it('accepts a MATCHING caller-supplied value and normalizes it', async () => {
    const repo = makeRepo();
    const context = await repo._buildContext('getOne', {
      query: { organizationId: ORG, status: 'active' },
      organizationId: ORG,
    });
    expect(context.query).toMatchObject({ organizationId: ORG, status: 'active' });
  });

  it('treats string vs ObjectId representations of the same tenant as a match', async () => {
    const oid = new mongoose.Types.ObjectId();
    const repo = makeRepo({ fieldType: 'objectId' });
    const context = await repo._buildContext('getOne', {
      query: { organizationId: oid }, // ObjectId instance supplied by caller
      organizationId: oid.toString(), // string form in context
    });
    // Normalized to the configured fieldType (objectId).
    expect(String((context.query as Record<string, unknown>).organizationId)).toBe(oid.toString());
  });

  it("onMismatch: 'overwrite' restores the legacy silent-overwrite behavior", async () => {
    const repo = makeRepo({ onMismatch: 'overwrite' });
    const context = await repo._buildContext('getOne', {
      query: { organizationId: OTHER_ORG },
      organizationId: ORG,
    });
    // Resolved scope still wins (leak-safe), just silently.
    expect(context.query).toMatchObject({ organizationId: ORG });
  });

  it('bypassTenant: true skips the guard entirely (audited via after:tenant-bypass)', async () => {
    const repo = makeRepo();
    const bypasses: unknown[] = [];
    repo.on('after:tenant-bypass', (payload) => bypasses.push(payload));

    const context = await repo._buildContext('getOne', {
      query: { organizationId: OTHER_ORG },
      bypassTenant: true,
    });
    // No injection, no rejection — caller owns the scope explicitly.
    expect(context.query).toMatchObject({ organizationId: OTHER_ORG });
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0]).toMatchObject({ operation: 'getOne', reason: 'option' });
  });
});
