/**
 * Unit tests for the config-driven `createRepository(model, config)`
 * factory. Uses a fake Mongoose-model shape so no mongo connection is
 * needed — these tests assert plugin composition, not driver behavior.
 */

import type { Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { createRepository } from '../../src/create-repository.js';
import type { Plugin, RepositoryInstance } from '../../src/types.js';

function fakeModel(name = 'FactoryDoc'): Model<Record<string, unknown>> {
  return {
    modelName: name,
    schema: { indexes: () => [], obj: {}, paths: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('createRepository (config-driven factory)', () => {
  it('composes tenant + softDelete + batch in a valid order (pluginOrderChecks: throw by default)', () => {
    // The factory defaults pluginOrderChecks to 'throw' — if the canonical
    // stack ever violated PLUGIN_ORDER_CONSTRAINTS (multi-tenant before
    // soft-delete/cache, soft-delete before batch-operations), this
    // construction would throw.
    expect(() =>
      createRepository(fakeModel('FactoryOrdered'), {
        tenant: { tenantField: 'organizationId' },
        softDelete: true,
        timestamps: true,
        batch: true,
      }),
    ).not.toThrow();
  });

  it('lights up features only when their config key is present', () => {
    const bare = createRepository(fakeModel('FactoryBare'));
    // methodRegistry is always installed (registerMethod available), but
    // no feature plugins are.
    expect(typeof (bare as RepositoryInstance).registerMethod).toBe('function');
    expect((bare as Record<string, unknown>).restore).toBeUndefined(); // softDelete absent
    expect((bare as Record<string, unknown>).getDeleted).toBeUndefined(); // softDelete absent
    expect((bare as Record<string, unknown>).bulkWrite).toBeUndefined(); // batch absent

    const full = createRepository(fakeModel('FactoryFull'), {
      softDelete: true,
      batch: true,
    });
    expect(typeof (full as Record<string, unknown>).restore).toBe('function');
    expect(typeof (full as Record<string, unknown>).getDeleted).toBe('function');
    expect(typeof (full as Record<string, unknown>).bulkWrite).toBe('function');
  });

  it('forwards softDelete options when an object is passed', () => {
    const repo = createRepository(fakeModel('FactorySoftOpts'), {
      softDelete: { addRestoreMethod: false, addGetDeletedMethod: false },
    });
    expect((repo as Record<string, unknown>).restore).toBeUndefined();
    expect((repo as Record<string, unknown>).getDeleted).toBeUndefined();
  });

  it('appends extra plugins AFTER the canonical stack', () => {
    let sawBatchMethodsAtApplyTime = false;
    let applied = false;
    const probe: Plugin = {
      name: 'order-probe',
      apply(repo: RepositoryInstance) {
        applied = true;
        // batch-operations is part of the canonical stack and must have
        // run before extra plugins — its contributed method proves it.
        sawBatchMethodsAtApplyTime =
          typeof (repo as Record<string, unknown>).bulkWrite === 'function';
      },
    };

    createRepository(fakeModel('FactoryExtra'), {
      batch: true,
      plugins: [probe],
    });

    expect(applied).toBe(true);
    expect(sawBatchMethodsAtApplyTime).toBe(true);
  });

  it('passes pagination + repository options through', () => {
    const repo = createRepository(fakeModel('FactoryOptions'), {
      pagination: { defaultLimit: 7 },
      idField: 'slug',
    });
    expect(repo.idField).toBe('slug');
    expect(repo._pagination.config.defaultLimit).toBe(7);
  });

  it('routes audit config to auditLogPlugin for Logger shapes and auditTrailPlugin otherwise', () => {
    // Logger shape (function members) → auditLogPlugin. The audit-log
    // plugin contributes no methods; absence of auditTrail's query API
    // plus a successful construction is the observable difference.
    const logged: string[] = [];
    const loggerRepo = createRepository(fakeModel('FactoryAuditLog'), {
      audit: { info: (msg: string) => logged.push(msg) },
    });
    expect((loggerRepo as Record<string, unknown>).getAuditTrail).toBeUndefined();

    // Options shape → auditTrailPlugin (registers the audit-trail query
    // method through the registry).
    const trailRepo = createRepository(fakeModel('FactoryAuditTrail'), {
      audit: { collectionName: 'factory_audit_trails_test' },
    });
    expect(typeof (trailRepo as Record<string, unknown>).getAuditTrail).toBe('function');
  });

  it('lets an explicit pluginOrderChecks override the throw default', () => {
    expect(() =>
      createRepository(fakeModel('FactoryChecksOff'), {
        batch: true,
        pluginOrderChecks: 'off',
      }),
    ).not.toThrow();
  });
});
