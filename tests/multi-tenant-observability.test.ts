/**
 * Multi-Tenant & Observability Plugins Integration Tests
 *
 * Tests multi-tenant isolation and observability metrics using real MongoDB
 * via mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { multiTenantPlugin } from '../src/plugins/multi-tenant.plugin.js';
import { observabilityPlugin, type OperationMetric } from '../src/plugins/observability.plugin.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

// ============================================================================
// Shared schema / model
// ============================================================================

interface ITenantDoc {
  _id: Types.ObjectId;
  name: string;
  organizationId?: string | Types.ObjectId;
  tenantCode?: string;
}

const TenantSchema = new Schema<ITenantDoc>({
  name: String,
  organizationId: String,
  tenantCode: String,
});

// Schema with ObjectId tenant field — for fieldType: 'objectId' tests
interface IOidTenantDoc {
  _id: Types.ObjectId;
  name: string;
  organizationId?: Types.ObjectId;
}

const OidTenantSchema = new Schema<IOidTenantDoc>({
  name: String,
  organizationId: { type: Schema.Types.ObjectId },
});

// ============================================================================
// MULTI-TENANT PLUGIN
// ============================================================================

describe('Multi-Tenant & Observability Plugins', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // ==========================================================================
  // Multi-Tenant
  // ==========================================================================

  describe('multiTenantPlugin', () => {
    let TenantModel: mongoose.Model<ITenantDoc>;

    beforeAll(async () => {
      TenantModel = await createTestModel('MultiTenantTest', TenantSchema);
    });

    beforeEach(async () => {
      await TenantModel.deleteMany({});
    });

    afterAll(async () => {
      await TenantModel.deleteMany({});
    });

    // -----------------------------------------------------------------------
    // 1. Auto-injects tenantField into create data
    // -----------------------------------------------------------------------
    it('should auto-inject tenantField into create data', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin()]);

      const doc = await repo.create(
        { name: 'Invoice A' },
        { organizationId: 'org_abc' } as any,
      );

      expect(doc.organizationId).toBe('org_abc');
    });

    // -----------------------------------------------------------------------
    // 2. Auto-injects tenantField into getAll filters
    // -----------------------------------------------------------------------
    it('should auto-inject tenantField into getAll filters', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin()]);

      // Seed two orgs
      await TenantModel.create([
        { name: 'Org1-Doc', organizationId: 'org_1' },
        { name: 'Org2-Doc', organizationId: 'org_2' },
      ]);

      const result = await repo.getAll(
        { page: 1, limit: 10, organizationId: 'org_1' } as any,
      );

      expect(result.docs).toHaveLength(1);
      expect((result.docs[0] as ITenantDoc).name).toBe('Org1-Doc');
    });

    // -----------------------------------------------------------------------
    // 3. Auto-injects tenantField into getByQuery query
    // -----------------------------------------------------------------------
    it('should auto-inject tenantField into getByQuery query', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin()]);

      await TenantModel.create([
        { name: 'Shared Name', organizationId: 'org_x' },
        { name: 'Shared Name', organizationId: 'org_y' },
      ]);

      const doc = await repo.getByQuery(
        { name: 'Shared Name' },
        { organizationId: 'org_y' } as any,
      );

      expect(doc).not.toBeNull();
      expect((doc as ITenantDoc).organizationId).toBe('org_y');
    });

    // -----------------------------------------------------------------------
    // 4. Throws when required tenantId is missing from context
    // -----------------------------------------------------------------------
    it('should throw when required tenantId is missing from context', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin({ required: true })]);

      await expect(repo.create({ name: 'No tenant' })).rejects.toThrow(
        /Missing 'organizationId' in context/,
      );
    });

    // -----------------------------------------------------------------------
    // 5. Allows missing tenantId when required: false
    // -----------------------------------------------------------------------
    it('should allow missing tenantId when required is false', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin({ required: false })]);

      const doc = await repo.create({ name: 'No tenant ok' });
      expect(doc.name).toBe('No tenant ok');
      // organizationId should not have been injected
      expect(doc.organizationId).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // 6. Custom tenantField and contextKey work
    // -----------------------------------------------------------------------
    it('should support custom tenantField and contextKey', async () => {
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({ tenantField: 'tenantCode', contextKey: 'tenantCode' }),
      ]);

      const doc = await repo.create(
        { name: 'Custom field' },
        { tenantCode: 'TC-42' } as any,
      );

      expect(doc.tenantCode).toBe('TC-42');

      // Seed another doc for a different tenant to validate getAll filtering
      await TenantModel.create({ name: 'Other', tenantCode: 'TC-99' });

      const result = await repo.getAll(
        { page: 1, limit: 10, tenantCode: 'TC-42' } as any,
      );

      expect(result.docs).toHaveLength(1);
      expect((result.docs[0] as ITenantDoc).tenantCode).toBe('TC-42');
    });

    // -----------------------------------------------------------------------
    // 7. skipOperations excludes specified operations
    // -----------------------------------------------------------------------
    it('should skip tenant injection for skipOperations', async () => {
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({ required: true, skipOperations: ['create'] }),
      ]);

      // 'create' is skipped - should NOT throw even without organizationId
      const doc = await repo.create({ name: 'Skipped create' });
      expect(doc.name).toBe('Skipped create');
      expect(doc.organizationId).toBeUndefined();

      // 'getAll' is NOT skipped - should throw without organizationId
      await expect(
        repo.getAll({ mode: 'offset', page: 1, limit: 10 }),
      ).rejects.toThrow(/Missing 'organizationId' in context/);
    });

    // -----------------------------------------------------------------------
    // 8. Update is scoped by tenant — prevents cross-tenant mutation
    // -----------------------------------------------------------------------
    it('should prevent cross-tenant update', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin()]);

      // Create docs for two orgs directly in DB
      const [docA] = await TenantModel.create([
        { name: 'Org A Doc', organizationId: 'org_a' },
        { name: 'Org B Doc', organizationId: 'org_b' },
      ]);

      // Try to update org_a's doc while scoped to org_b — should fail (404)
      await expect(
        repo.update(
          docA._id.toString(),
          { name: 'Hijacked' },
          { organizationId: 'org_b' } as any,
        ),
      ).rejects.toThrow(/not found/i);

      // Verify doc A is unchanged
      const unchanged = await TenantModel.findById(docA._id);
      expect(unchanged!.name).toBe('Org A Doc');
    });

    // -----------------------------------------------------------------------
    // 9. Update succeeds when scoped to correct tenant
    // -----------------------------------------------------------------------
    it('should allow update when scoped to correct tenant', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin()]);

      const doc = await TenantModel.create({ name: 'Original', organizationId: 'org_a' });

      const updated = await repo.update(
        doc._id.toString(),
        { name: 'Updated' },
        { organizationId: 'org_a' } as any,
      );

      expect(updated.name).toBe('Updated');
    });

    // -----------------------------------------------------------------------
    // 10. Delete is scoped by tenant — prevents cross-tenant deletion
    // -----------------------------------------------------------------------
    it('should prevent cross-tenant delete', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin()]);

      const [docA] = await TenantModel.create([
        { name: 'Org A Doc', organizationId: 'org_a' },
        { name: 'Org B Doc', organizationId: 'org_b' },
      ]);

      // Try to delete org_a's doc while scoped to org_b — should fail (404)
      await expect(
        repo.delete(
          docA._id.toString(),
          { organizationId: 'org_b' } as any,
        ),
      ).rejects.toThrow(/not found/i);

      // Verify doc A still exists
      const stillExists = await TenantModel.findById(docA._id);
      expect(stillExists).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // 11. Delete succeeds when scoped to correct tenant
    // -----------------------------------------------------------------------
    it('should allow delete when scoped to correct tenant', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin()]);

      const doc = await TenantModel.create({ name: 'To Delete', organizationId: 'org_a' });

      const result = await repo.delete(
        doc._id.toString(),
        { organizationId: 'org_a' } as any,
      );

      expect(result.success).toBe(true);
      const gone = await TenantModel.findById(doc._id);
      expect(gone).toBeNull();
    });

    // -----------------------------------------------------------------------
    // 12. skipWhen bypasses scoping per-request
    // -----------------------------------------------------------------------
    it('should bypass scoping when skipWhen returns true', async () => {
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({
          skipWhen: (context) => (context as any).role === 'superadmin',
        }),
      ]);

      // Seed docs for two orgs
      await TenantModel.create([
        { name: 'Org A', organizationId: 'org_a' },
        { name: 'Org B', organizationId: 'org_b' },
      ]);

      // Super admin sees ALL docs (no tenant scoping)
      const result = await repo.getAll(
        { page: 1, limit: 10, role: 'superadmin' } as any,
      );
      expect(result.docs.length).toBeGreaterThanOrEqual(2);
    });

    // -----------------------------------------------------------------------
    // 13. skipWhen still enforces scoping when it returns false
    // -----------------------------------------------------------------------
    it('should enforce scoping when skipWhen returns false', async () => {
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({
          skipWhen: (context) => (context as any).role === 'superadmin',
        }),
      ]);

      await TenantModel.create([
        { name: 'Org A', organizationId: 'org_a' },
        { name: 'Org B', organizationId: 'org_b' },
      ]);

      // Regular user — scoped to org_a only
      const result = await repo.getAll(
        { page: 1, limit: 10, organizationId: 'org_a', role: 'user' } as any,
      );
      expect(result.docs).toHaveLength(1);
      expect((result.docs[0] as ITenantDoc).organizationId).toBe('org_a');
    });

    // -----------------------------------------------------------------------
    // 14. skipWhen receives operation name
    // -----------------------------------------------------------------------
    it('should pass operation name to skipWhen', async () => {
      const skipWhen = vi.fn(() => true);
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({ required: false, skipWhen }),
      ]);

      await repo.create({ name: 'Test' });

      expect(skipWhen).toHaveBeenCalledWith(
        expect.anything(),
        'create',
      );
    });

    // -----------------------------------------------------------------------
    // 15. skipWhen allows super admin to update any tenant's doc
    // -----------------------------------------------------------------------
    it('should allow super admin to update cross-tenant doc via skipWhen', async () => {
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({
          skipWhen: (context) => (context as any).role === 'superadmin',
        }),
      ]);

      const doc = await TenantModel.create({ name: 'Org A Doc', organizationId: 'org_a' });

      // Super admin updates org_a's doc without passing organizationId
      const updated = await repo.update(
        doc._id.toString(),
        { name: 'Admin Updated' },
        { role: 'superadmin' } as any,
      );

      expect(updated.name).toBe('Admin Updated');
    });

    // -----------------------------------------------------------------------
    // 16. resolveContext provides tenant ID from external source
    // -----------------------------------------------------------------------
    it('should use resolveContext when tenant ID is not in context', async () => {
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({
          resolveContext: () => 'org_from_store',
        }),
      ]);

      // Create without passing organizationId — resolveContext provides it
      const doc = await repo.create({ name: 'Auto-resolved' });
      expect(doc.organizationId).toBe('org_from_store');
    });

    // -----------------------------------------------------------------------
    // 17. resolveContext scopes reads when context is empty
    // -----------------------------------------------------------------------
    it('should scope reads via resolveContext', async () => {
      let currentTenant: string | undefined = 'org_a';

      const repo = new Repository(TenantModel, [
        multiTenantPlugin({
          resolveContext: () => currentTenant,
        }),
      ]);

      await TenantModel.create([
        { name: 'A Doc', organizationId: 'org_a' },
        { name: 'B Doc', organizationId: 'org_b' },
      ]);

      // resolveContext returns 'org_a' — should only see org_a docs
      const resultA = await repo.getAll({ mode: 'offset', page: 1, limit: 10 });
      expect(resultA.docs).toHaveLength(1);
      expect((resultA.docs[0] as ITenantDoc).organizationId).toBe('org_a');

      // Switch tenant context
      currentTenant = 'org_b';
      const resultB = await repo.getAll({ mode: 'offset', page: 1, limit: 10 });
      expect(resultB.docs).toHaveLength(1);
      expect((resultB.docs[0] as ITenantDoc).organizationId).toBe('org_b');
    });

    // -----------------------------------------------------------------------
    // 18. context takes priority over resolveContext
    // -----------------------------------------------------------------------
    it('should prefer context over resolveContext', async () => {
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({
          resolveContext: () => 'org_fallback',
        }),
      ]);

      // Pass organizationId explicitly — should use it, not resolveContext
      const doc = await repo.create(
        { name: 'Explicit' },
        { organizationId: 'org_explicit' } as any,
      );
      expect(doc.organizationId).toBe('org_explicit');
    });

    // -----------------------------------------------------------------------
    // 19. resolveContext returning undefined with required: true throws
    // -----------------------------------------------------------------------
    it('should throw when resolveContext returns undefined and required is true', async () => {
      const repo = new Repository(TenantModel, [
        multiTenantPlugin({
          required: true,
          resolveContext: () => undefined,
        }),
      ]);

      await expect(repo.create({ name: 'No tenant' })).rejects.toThrow(
        /Missing 'organizationId' in context/,
      );
    });

    // -----------------------------------------------------------------------
    // 20. lookupPopulate respects tenant filter from context
    // -----------------------------------------------------------------------
    it('should scope lookupPopulate by tenant', async () => {
      const repo = new Repository(TenantModel, [multiTenantPlugin()]);

      // Create docs for two orgs
      await TenantModel.create([
        { name: 'Lookup A1', organizationId: 'org_a' },
        { name: 'Lookup A2', organizationId: 'org_a' },
        { name: 'Lookup B1', organizationId: 'org_b' },
      ]);

      const result = await repo.lookupPopulate({
        lookups: [],
        page: 1,
        limit: 10,
        organizationId: 'org_a',
      } as any);

      expect(result.data).toHaveLength(2);
      for (const doc of result.data) {
        expect((doc as ITenantDoc).organizationId).toBe('org_a');
      }
    });
  });

  // ==========================================================================
  // Multi-Tenant — fieldType: 'objectId'
  // ==========================================================================

  describe('multiTenantPlugin fieldType: objectId', () => {
    let OidModel: mongoose.Model<IOidTenantDoc>;
    const ORG_ID_HEX = '507f1f77bcf86cd799439011';
    const ORG_OID = new Types.ObjectId(ORG_ID_HEX);

    beforeAll(async () => {
      OidModel = await createTestModel('OidTenantTest', OidTenantSchema);
    });

    beforeEach(async () => {
      await OidModel.deleteMany({});
    });

    afterAll(async () => {
      await OidModel.deleteMany({});
    });

    // -----------------------------------------------------------------------
    // 1. Injects ObjectId into create data
    // -----------------------------------------------------------------------
    it('should inject ObjectId into create data when fieldType is objectId', async () => {
      const repo = new Repository(OidModel, [
        multiTenantPlugin({ fieldType: 'objectId' }),
      ]);

      const doc = await repo.create(
        { name: 'OID Create' },
        { organizationId: ORG_ID_HEX } as any,
      );

      expect(doc.organizationId).toBeInstanceOf(Types.ObjectId);
      expect(doc.organizationId!.toString()).toBe(ORG_ID_HEX);
    });

    // -----------------------------------------------------------------------
    // 2. Injects ObjectId into getAll filters
    // -----------------------------------------------------------------------
    it('should inject ObjectId into getAll filters when fieldType is objectId', async () => {
      const repo = new Repository(OidModel, [
        multiTenantPlugin({ fieldType: 'objectId' }),
      ]);

      await OidModel.create([
        { name: 'Org1-Doc', organizationId: ORG_OID },
        { name: 'Org2-Doc', organizationId: new Types.ObjectId() },
      ]);

      const result = await repo.getAll(
        { page: 1, limit: 10, organizationId: ORG_ID_HEX } as any,
      );

      expect(result.docs).toHaveLength(1);
      expect((result.docs[0] as IOidTenantDoc).name).toBe('Org1-Doc');
    });

    // -----------------------------------------------------------------------
    // 3. Scopes update by ObjectId tenant
    // -----------------------------------------------------------------------
    it('should scope update by ObjectId tenant', async () => {
      const repo = new Repository(OidModel, [
        multiTenantPlugin({ fieldType: 'objectId' }),
      ]);

      const doc = await OidModel.create({ name: 'Original', organizationId: ORG_OID });

      const updated = await repo.update(
        doc._id.toString(),
        { name: 'Updated' },
        { organizationId: ORG_ID_HEX } as any,
      );

      expect(updated.name).toBe('Updated');
    });

    // -----------------------------------------------------------------------
    // 4. Prevents cross-tenant update with ObjectId
    // -----------------------------------------------------------------------
    it('should prevent cross-tenant update with ObjectId', async () => {
      const repo = new Repository(OidModel, [
        multiTenantPlugin({ fieldType: 'objectId' }),
      ]);

      const doc = await OidModel.create({ name: 'Org A', organizationId: ORG_OID });
      const otherOrg = new Types.ObjectId().toString();

      await expect(
        repo.update(
          doc._id.toString(),
          { name: 'Hijacked' },
          { organizationId: otherOrg } as any,
        ),
      ).rejects.toThrow(/not found/i);
    });

    // -----------------------------------------------------------------------
    // 5. Works with resolveContext
    // -----------------------------------------------------------------------
    it('should cast resolveContext value to ObjectId', async () => {
      const repo = new Repository(OidModel, [
        multiTenantPlugin({
          fieldType: 'objectId',
          resolveContext: () => ORG_ID_HEX,
        }),
      ]);

      const doc = await repo.create({ name: 'Resolved OID' });
      expect(doc.organizationId).toBeInstanceOf(Types.ObjectId);
      expect(doc.organizationId!.toString()).toBe(ORG_ID_HEX);
    });

    // -----------------------------------------------------------------------
    // 6. Default fieldType remains string (backward compat)
    // -----------------------------------------------------------------------
    it('should default to string fieldType for backward compatibility', async () => {
      const StringModel = await createTestModel('StringDefaultTest', TenantSchema);
      const repo = new Repository(StringModel, [multiTenantPlugin()]);

      const doc = await repo.create(
        { name: 'String default' },
        { organizationId: ORG_ID_HEX } as any,
      );

      expect(typeof doc.organizationId).toBe('string');
      expect(doc.organizationId).toBe(ORG_ID_HEX);
      await StringModel.deleteMany({});
    });
  });

  // ==========================================================================
  // Observability
  // ==========================================================================

  describe('observabilityPlugin', () => {
    let ObsModel: mongoose.Model<ITenantDoc>;

    beforeAll(async () => {
      ObsModel = await createTestModel('ObservabilityTest', TenantSchema);
    });

    beforeEach(async () => {
      await ObsModel.deleteMany({});
    });

    afterAll(async () => {
      await ObsModel.deleteMany({});
    });

    // -----------------------------------------------------------------------
    // 1. Calls onMetric after successful operation
    // -----------------------------------------------------------------------
    it('should call onMetric after a successful operation', async () => {
      const onMetric = vi.fn();
      const repo = new Repository(ObsModel, [observabilityPlugin({ onMetric })]);

      await repo.create({ name: 'Hello' });

      expect(onMetric).toHaveBeenCalledTimes(1);
      expect(onMetric).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'create', success: true }),
      );
    });

    // -----------------------------------------------------------------------
    // 2. Metric contains correct operation, model, durationMs
    // -----------------------------------------------------------------------
    it('should include correct operation, model, and durationMs in metric', async () => {
      const metrics: OperationMetric[] = [];
      const repo = new Repository(ObsModel, [
        observabilityPlugin({ onMetric: (m) => metrics.push(m) }),
      ]);

      await repo.create({ name: 'Metric test' });

      expect(metrics).toHaveLength(1);
      const metric = metrics[0];
      expect(metric.operation).toBe('create');
      expect(metric.model).toBe('ObservabilityTest');
      expect(typeof metric.durationMs).toBe('number');
      expect(metric.durationMs).toBeGreaterThanOrEqual(0);
      expect(metric.success).toBe(true);
      expect(metric.startedAt).toBeInstanceOf(Date);
    });

    // -----------------------------------------------------------------------
    // 3. Calls onMetric with success:false on error
    // -----------------------------------------------------------------------
    it('should call onMetric with success:false on error', async () => {
      const metrics: OperationMetric[] = [];
      const repo = new Repository(ObsModel, [
        observabilityPlugin({ onMetric: (m) => metrics.push(m) }),
      ]);

      // Trigger an error by updating a non-existent document
      try {
        await repo.update(new Types.ObjectId().toString(), { name: 'Nope' });
      } catch {
        // expected to throw
      }

      // The error hook should have been invoked
      const errorMetric = metrics.find((m) => m.success === false);
      expect(errorMetric).toBeDefined();
      expect(errorMetric!.operation).toBe('update');
      expect(errorMetric!.success).toBe(false);
      expect(typeof errorMetric!.error).toBe('string');
    });

    // -----------------------------------------------------------------------
    // 4. Respects slowThresholdMs (fast ops not reported)
    // -----------------------------------------------------------------------
    it('should not report metrics for ops faster than slowThresholdMs', async () => {
      const onMetric = vi.fn();
      const repo = new Repository(ObsModel, [
        observabilityPlugin({
          onMetric,
          // Threshold so high that the fast in-memory op won't be reported
          slowThresholdMs: 60_000,
        }),
      ]);

      await repo.create({ name: 'Fast op' });

      // The create should have completed in well under 60 seconds
      expect(onMetric).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 5. Fires error metric on read path failures (getById)
    // -----------------------------------------------------------------------
    it('should call onMetric with success:false on getById error', async () => {
      const metrics: OperationMetric[] = [];
      const repo = new Repository(ObsModel, [
        observabilityPlugin({ onMetric: (m) => metrics.push(m) }),
      ]);

      // CastError — invalid ObjectId triggers error in getById
      try {
        await repo.getById('not-a-valid-id', { throwOnNotFound: true });
      } catch {
        // expected
      }

      const errorMetric = metrics.find((m) => m.operation === 'getById' && m.success === false);
      expect(errorMetric).toBeDefined();
      expect(errorMetric!.success).toBe(false);
      expect(typeof errorMetric!.error).toBe('string');
    });

    // -----------------------------------------------------------------------
    // 6. Fires error metric on read path failures (getByQuery)
    // -----------------------------------------------------------------------
    it('should call onMetric with success:false on getByQuery error', async () => {
      const metrics: OperationMetric[] = [];
      const repo = new Repository(ObsModel, [
        observabilityPlugin({ onMetric: (m) => metrics.push(m) }),
      ]);

      // CastError — invalid ObjectId in query triggers error
      try {
        await repo.getByQuery({ _id: 'not-valid' }, { throwOnNotFound: true });
      } catch {
        // expected
      }

      const errorMetric = metrics.find((m) => m.operation === 'getByQuery' && m.success === false);
      expect(errorMetric).toBeDefined();
      expect(errorMetric!.success).toBe(false);
      expect(typeof errorMetric!.error).toBe('string');
    });

    // -----------------------------------------------------------------------
    // 7. Fires error metric on read path failures (getAll)
    // -----------------------------------------------------------------------
    it('should call onMetric with success:false on getAll error', async () => {
      const metrics: OperationMetric[] = [];
      const repo = new Repository(ObsModel, [
        observabilityPlugin({ onMetric: (m) => metrics.push(m) }),
      ]);

      // Force an error by injecting a bad filter via before:getAll hook
      repo.on('before:getAll', (context: any) => {
        context.filters = { $badOperator: true };
      });

      try {
        await repo.getAll({ mode: 'offset', page: 1, limit: 10 });
      } catch {
        // expected
      }

      const errorMetric = metrics.find((m) => m.operation === 'getAll' && m.success === false);
      expect(errorMetric).toBeDefined();
      expect(errorMetric!.success).toBe(false);
      expect(typeof errorMetric!.error).toBe('string');
    });

    // -----------------------------------------------------------------------
    // 8. Tracks timing across before -> after lifecycle
    // -----------------------------------------------------------------------
    it('should track timing across before and after lifecycle', async () => {
      const metrics: OperationMetric[] = [];
      const repo = new Repository(ObsModel, [
        observabilityPlugin({ onMetric: (m) => metrics.push(m) }),
      ]);

      // Perform several operations
      const doc = await repo.create({ name: 'Lifecycle' });
      await repo.getAll({ mode: 'offset', page: 1, limit: 10 });
      await repo.update(doc._id.toString(), { name: 'Updated' });

      // We expect one metric per operation
      expect(metrics).toHaveLength(3);
      const ops = metrics.map((m) => m.operation);
      expect(ops).toContain('create');
      expect(ops).toContain('getAll');
      expect(ops).toContain('update');

      // Every metric should have a positive (or zero) duration
      for (const m of metrics) {
        expect(m.durationMs).toBeGreaterThanOrEqual(0);
        expect(m.success).toBe(true);
      }
    });
  });
});
