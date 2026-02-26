/**
 * Audit Trail Plugin Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  methodRegistryPlugin,
  softDeletePlugin,
  auditTrailPlugin,
  AuditTrailQuery,
} from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';

// ─── Test Model ─────────────────────────────────────────────────────────────

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  price: number;
  category?: string;
  secret?: string;
  deletedAt?: Date | null;
}

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String },
  secret: { type: String },
  deletedAt: { type: Date, default: null },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const AUDIT_COLLECTION = 'audit_trails_test';

function getAuditCollection() {
  return mongoose.connection.collection(AUDIT_COLLECTION);
}

/** Wait for fire-and-forget writes to complete */
async function waitForAudit(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearAuditCollection(): Promise<void> {
  try {
    await getAuditCollection().deleteMany({});
  } catch {
    // Collection may not exist yet
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('auditTrailPlugin', () => {
  let ProductModel: mongoose.Model<IProduct>;

  beforeAll(async () => {
    await connectDB();

    const modelName = 'AuditTrailProduct';
    if (mongoose.models[modelName]) delete mongoose.models[modelName];
    ProductModel = mongoose.model<IProduct>(modelName, ProductSchema);
    await ProductModel.init();
  });

  afterAll(async () => {
    // Clean up audit models from cache
    const auditModelName = `AuditTrail_${AUDIT_COLLECTION}`;
    if (mongoose.models[auditModelName]) delete mongoose.models[auditModelName];

    await disconnectDB();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
    await clearAuditCollection();
  });

  // ─── Create Tracking ─────────────────────────────────────────────

  describe('create tracking', () => {
    it('should log create operations', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].operation).toBe('create');
      expect(audits[0].model).toBe('AuditTrailProduct');
      expect(audits[0].documentId).toBeDefined();
      expect(audits[0].timestamp).toBeInstanceOf(Date);
    });

    it('should include user and org context', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const userId = new Types.ObjectId();
      const orgId = new Types.ObjectId();

      await repo.create(
        { name: 'Widget', price: 10 },
        { user: { _id: userId }, organizationId: orgId },
      );
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].userId.toString()).toBe(userId.toString());
      expect(audits[0].orgId.toString()).toBe(orgId.toString());
    });

    it('should store document snapshot when trackDocument is true', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({
          collectionName: AUDIT_COLLECTION,
          trackDocument: true,
        }),
      ]);

      await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].document).toBeDefined();
      expect(audits[0].document.name).toBe('Widget');
    });

    it('should NOT store document snapshot by default', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].document).toBeUndefined();
    });
  });

  // ─── Update Tracking ─────────────────────────────────────────────

  describe('update tracking', () => {
    it('should log update operations', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();
      await clearAuditCollection(); // Clear create audit

      await repo.update(product._id, { price: 20 });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].operation).toBe('update');
      expect(audits[0].documentId.toString()).toBe(product._id.toString());
    });

    it('should track field-level changes by default', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();
      await clearAuditCollection();

      await repo.update(product._id, { price: 25, name: 'Super Widget' });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].changes).toBeDefined();
      expect(audits[0].changes.price).toEqual({ from: 10, to: 25 });
      expect(audits[0].changes.name).toEqual({ from: 'Widget', to: 'Super Widget' });
    });

    it('should not include unchanged fields in changes', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();
      await clearAuditCollection();

      await repo.update(product._id, { price: 25 });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].changes).toBeDefined();
      expect(audits[0].changes.price).toEqual({ from: 10, to: 25 });
      expect(audits[0].changes.name).toBeUndefined();
    });

    it('should skip change tracking when trackChanges is false', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({
          collectionName: AUDIT_COLLECTION,
          trackChanges: false,
        }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();
      await clearAuditCollection();

      await repo.update(product._id, { price: 25 });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].changes).toBeUndefined();
    });
  });

  // ─── Delete Tracking ─────────────────────────────────────────────

  describe('delete tracking', () => {
    it('should log delete operations', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();
      await clearAuditCollection();

      await repo.delete(product._id);
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].operation).toBe('delete');
      expect(audits[0].documentId.toString()).toBe(product._id.toString());
    });

    it('should log soft delete operations', async () => {
      const repo = new Repository(ProductModel, [
        softDeletePlugin({ deletedField: 'deletedAt' }),
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();
      await clearAuditCollection();

      await repo.delete(product._id);
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].operation).toBe('delete');
    });
  });

  // ─── Selective Operations ─────────────────────────────────────────

  describe('selective operations', () => {
    it('should only track specified operations', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({
          collectionName: AUDIT_COLLECTION,
          operations: ['update'],
        }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();

      // Create should NOT be tracked
      let audits = await getAuditCollection().find({}).toArray();
      expect(audits).toHaveLength(0);

      // Update SHOULD be tracked
      await repo.update(product._id, { price: 20 });
      await waitForAudit();

      audits = await getAuditCollection().find({}).toArray();
      expect(audits).toHaveLength(1);
      expect(audits[0].operation).toBe('update');
    });

    it('should handle empty operations array (track nothing)', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({
          collectionName: AUDIT_COLLECTION,
          operations: [],
        }),
      ]);

      await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits).toHaveLength(0);
    });
  });

  // ─── Custom Metadata ─────────────────────────────────────────────

  describe('custom metadata', () => {
    it('should include custom metadata from callback', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({
          collectionName: AUDIT_COLLECTION,
          metadata: (context) => ({
            source: 'test',
            operation: context.operation,
          }),
        }),
      ]);

      await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].metadata).toBeDefined();
      expect(audits[0].metadata.source).toBe('test');
      expect(audits[0].metadata.operation).toBe('create');
    });
  });

  // ─── Excluded Fields ──────────────────────────────────────────────

  describe('excluded fields', () => {
    it('should exclude specified fields from change tracking', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({
          collectionName: AUDIT_COLLECTION,
          excludeFields: ['secret'],
        }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10, secret: 'abc' });
      await waitForAudit();
      await clearAuditCollection();

      await repo.update(product._id, { price: 25, secret: 'xyz' });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].changes).toBeDefined();
      expect(audits[0].changes.price).toEqual({ from: 10, to: 25 });
      expect(audits[0].changes.secret).toBeUndefined();
    });

    it('should exclude fields from document snapshot', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({
          collectionName: AUDIT_COLLECTION,
          trackDocument: true,
          excludeFields: ['secret'],
        }),
      ]);

      await repo.create({ name: 'Widget', price: 10, secret: 'abc' });
      await waitForAudit();

      const audits = await getAuditCollection().find({}).toArray();
      expect(audits[0].document).toBeDefined();
      expect(audits[0].document.name).toBe('Widget');
      expect(audits[0].document.secret).toBeUndefined();
    });
  });

  // ─── Query Methods ────────────────────────────────────────────────

  describe('getAuditTrail method', () => {
    it('should register getAuditTrail when methodRegistryPlugin is loaded', async () => {
      const repo = new Repository(ProductModel, [
        methodRegistryPlugin(),
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]) as Repository<IProduct> & {
        getAuditTrail: (id: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
      };

      expect(typeof repo.getAuditTrail).toBe('function');
    });

    it('should return paginated audit trail for a document', async () => {
      const repo = new Repository(ProductModel, [
        methodRegistryPlugin(),
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]) as Repository<IProduct> & {
        getAuditTrail: (
          id: unknown,
          opts?: { page?: number; limit?: number; operation?: string },
        ) => Promise<{
          docs: unknown[];
          page: number;
          limit: number;
          total: number;
          pages: number;
          hasNext: boolean;
          hasPrev: boolean;
        }>;
      };

      const product = await repo.create({ name: 'Widget', price: 10 });
      await repo.update(product._id, { price: 20 });
      await repo.update(product._id, { price: 30 });
      await waitForAudit();

      const trail = await repo.getAuditTrail(product._id);
      expect(trail.total).toBe(3); // create + 2 updates
      expect(trail.docs).toHaveLength(3);
      expect(trail.page).toBe(1);
      expect(trail.limit).toBe(20);
    });

    it('should filter audit trail by operation', async () => {
      const repo = new Repository(ProductModel, [
        methodRegistryPlugin(),
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]) as Repository<IProduct> & {
        getAuditTrail: (
          id: unknown,
          opts?: { page?: number; limit?: number; operation?: string },
        ) => Promise<{
          docs: Array<{ operation: string }>;
          total: number;
        }>;
      };

      const product = await repo.create({ name: 'Widget', price: 10 });
      await repo.update(product._id, { price: 20 });
      await repo.update(product._id, { price: 30 });
      await waitForAudit();

      const trail = await repo.getAuditTrail(product._id, { operation: 'update' });
      expect(trail.total).toBe(2);
      expect(trail.docs.every((d) => d.operation === 'update')).toBe(true);
    });

    it('should support pagination', async () => {
      const repo = new Repository(ProductModel, [
        methodRegistryPlugin(),
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]) as Repository<IProduct> & {
        getAuditTrail: (
          id: unknown,
          opts?: { page?: number; limit?: number },
        ) => Promise<{
          docs: unknown[];
          page: number;
          total: number;
          pages: number;
          hasNext: boolean;
          hasPrev: boolean;
        }>;
      };

      const product = await repo.create({ name: 'Widget', price: 10 });
      for (let i = 0; i < 5; i++) {
        await repo.update(product._id, { price: 10 + i });
      }
      await waitForAudit();

      const page1 = await repo.getAuditTrail(product._id, { page: 1, limit: 3 });
      expect(page1.docs).toHaveLength(3);
      expect(page1.hasNext).toBe(true);
      expect(page1.hasPrev).toBe(false);
      expect(page1.pages).toBe(2);

      const page2 = await repo.getAuditTrail(product._id, { page: 2, limit: 3 });
      expect(page2.docs).toHaveLength(3);
      expect(page2.hasPrev).toBe(true);
    });
  });

  // ─── Fire & Forget ────────────────────────────────────────────────

  describe('fire and forget', () => {
    it('should not block the main operation', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      // The create should return immediately, audit write happens async
      const start = performance.now();
      const product = await repo.create({ name: 'Widget', price: 10 });
      const elapsed = performance.now() - start;

      expect(product).toBeDefined();
      expect(product.name).toBe('Widget');
      // Should be fast — audit write is async
      expect(elapsed).toBeLessThan(1000);
    });

    it('should not throw when audit write fails', async () => {
      // Even if the audit model has issues, the main operation should succeed
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      expect(product.name).toBe('Widget');
    });
  });

  // ─── Multiple Operations ──────────────────────────────────────────

  describe('multiple operations', () => {
    it('should track full lifecycle (create → update → delete)', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await repo.update(product._id, { price: 20 });
      await repo.delete(product._id);
      await waitForAudit();

      const audits = await getAuditCollection()
        .find({})
        .sort({ timestamp: 1 })
        .toArray();

      expect(audits).toHaveLength(3);
      expect(audits[0].operation).toBe('create');
      expect(audits[1].operation).toBe('update');
      expect(audits[2].operation).toBe('delete');
    });

    it('should track audits across different models separately', async () => {
      const OtherSchema = new Schema({ title: String });
      const otherModelName = 'AuditTrailOther';
      if (mongoose.models[otherModelName]) delete mongoose.models[otherModelName];
      const OtherModel = mongoose.model(otherModelName, OtherSchema);
      await OtherModel.init();

      const productRepo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);
      const otherRepo = new Repository(OtherModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      await productRepo.create({ name: 'Widget', price: 10 });
      await otherRepo.create({ title: 'Test' });
      await waitForAudit();

      const productAudits = await getAuditCollection()
        .find({ model: 'AuditTrailProduct' })
        .toArray();
      const otherAudits = await getAuditCollection()
        .find({ model: otherModelName })
        .toArray();

      expect(productAudits).toHaveLength(1);
      expect(otherAudits).toHaveLength(1);

      // Cleanup
      delete mongoose.models[otherModelName];
    });
  });

  // ─── AuditTrailQuery (standalone) ─────────────────────────────────

  describe('AuditTrailQuery', () => {
    let auditQuery: AuditTrailQuery;

    beforeAll(() => {
      auditQuery = new AuditTrailQuery(AUDIT_COLLECTION);
    });

    it('should query all audits', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      await repo.create({ name: 'A', price: 1 });
      await repo.create({ name: 'B', price: 2 });
      await waitForAudit();

      const result = await auditQuery.query();
      expect(result.total).toBe(2);
      expect(result.docs).toHaveLength(2);
      expect(result.page).toBe(1);
    });

    it('should filter by model', async () => {
      const OtherSchema = new Schema({ title: String });
      const otherModelName = 'AuditQueryOther';
      if (mongoose.models[otherModelName]) delete mongoose.models[otherModelName];
      const OtherModel = mongoose.model(otherModelName, OtherSchema);
      await OtherModel.init();

      const productRepo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);
      const otherRepo = new Repository(OtherModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      await productRepo.create({ name: 'Widget', price: 10 });
      await otherRepo.create({ title: 'Test' });
      await waitForAudit();

      const result = await auditQuery.query({ model: 'AuditTrailProduct' });
      expect(result.total).toBe(1);
      expect(result.docs[0].model).toBe('AuditTrailProduct');

      delete mongoose.models[otherModelName];
    });

    it('should filter by operation', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await repo.update(product._id, { price: 20 });
      await waitForAudit();

      const result = await auditQuery.query({ operation: 'update' });
      expect(result.total).toBe(1);
      expect(result.docs[0].operation).toBe('update');
    });

    it('should filter by userId', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const userId = new Types.ObjectId();
      await repo.create({ name: 'Widget', price: 10 }, { user: { _id: userId } });
      await repo.create({ name: 'Other', price: 5 }); // no user
      await waitForAudit();

      const result = await auditQuery.query({ userId });
      expect(result.total).toBe(1);
    });

    it('should filter by orgId', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const orgId = new Types.ObjectId();
      await repo.create({ name: 'Widget', price: 10 }, { organizationId: orgId });
      await repo.create({ name: 'Other', price: 5 }); // no org
      await waitForAudit();

      const result = await auditQuery.getOrgTrail(orgId);
      expect(result.total).toBe(1);
    });

    it('should filter by date range', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      await repo.create({ name: 'Widget', price: 10 });
      await waitForAudit();

      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const result = await auditQuery.query({ from: hourAgo, to: now });
      expect(result.total).toBeGreaterThanOrEqual(1);

      // Future date range should return nothing
      const futureResult = await auditQuery.query({
        from: new Date(now.getTime() + 60 * 60 * 1000),
      });
      expect(futureResult.total).toBe(0);
    });

    it('should support pagination', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      for (let i = 0; i < 5; i++) {
        await repo.create({ name: `Item ${i}`, price: i });
      }
      await waitForAudit();

      const page1 = await auditQuery.query({ page: 1, limit: 3 });
      expect(page1.docs).toHaveLength(3);
      expect(page1.hasNext).toBe(true);
      expect(page1.hasPrev).toBe(false);

      const page2 = await auditQuery.query({ page: 2, limit: 3 });
      expect(page2.docs).toHaveLength(2);
      expect(page2.hasNext).toBe(false);
      expect(page2.hasPrev).toBe(true);
    });

    it('should expose underlying model via getModel()', () => {
      const model = auditQuery.getModel();
      expect(model).toBeDefined();
      expect(model.modelName).toContain('AuditTrail');
    });

    it('should provide getDocumentTrail shortcut', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const product = await repo.create({ name: 'Widget', price: 10 });
      await repo.update(product._id, { price: 20 });
      await waitForAudit();

      const trail = await auditQuery.getDocumentTrail(
        'AuditTrailProduct',
        product._id,
      );
      expect(trail.total).toBe(2);
    });

    it('should provide getUserTrail shortcut', async () => {
      const repo = new Repository(ProductModel, [
        auditTrailPlugin({ collectionName: AUDIT_COLLECTION }),
      ]);

      const userId = new Types.ObjectId();
      await repo.create({ name: 'A', price: 1 }, { user: { _id: userId } });
      await repo.create({ name: 'B', price: 2 }, { user: { _id: userId } });
      await repo.create({ name: 'C', price: 3 }); // different user
      await waitForAudit();

      const trail = await auditQuery.getUserTrail(userId);
      expect(trail.total).toBe(2);
    });
  });
});
