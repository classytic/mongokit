/**
 * Delete Mode Tests
 *
 * Covers `Repository.delete(id, { mode })` + `deleteMany(query, { mode })` —
 * the unified GDPR / admin-cleanup bypass of softDeletePlugin.
 *
 * Real-world scenarios:
 *   1. GDPR erasure: a customer requests physical deletion. Soft-delete is on
 *      (retention window), but the record must leave the DB.
 *   2. Admin retention cleanup: bulk-purge stale soft-deleted records.
 *   3. Cross-tenant safety: hard delete must still honor multi-tenant scoping.
 *   4. Audit trail: after:delete hooks still fire so compliance logging runs.
 *   5. Default behavior unchanged — `delete(id)` is still soft when plugin wired.
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Repository,
  batchOperationsPlugin,
  methodRegistryPlugin,
  multiTenantPlugin,
  softDeletePlugin,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface ICustomer {
  _id: Types.ObjectId;
  name: string;
  email: string;
  organizationId: string;
  status: 'active' | 'pending' | 'churned';
  deletedAt?: Date | null;
}

const CustomerSchema = new Schema<ICustomer>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  organizationId: { type: String, required: true, index: true },
  status: { type: String, enum: ['active', 'pending', 'churned'], default: 'active' },
  deletedAt: { type: Date, default: null },
});

const TENANT_A = 'org_tenant_a';
const TENANT_B = 'org_tenant_b';

describe('Repository.delete / deleteMany with mode option', () => {
  let Model: mongoose.Model<ICustomer>;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let repo: any;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('DeleteModeCustomer', CustomerSchema);
    repo = new Repository<ICustomer>(Model, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
    ]);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  // ==========================================================================
  // delete(id) — default path (soft when plugin wired)
  // ==========================================================================

  describe('delete(id) — default behavior', () => {
    it('soft-deletes when softDeletePlugin is wired (no mode option)', async () => {
      const doc = await Model.create({
        name: 'Alice',
        email: 'alice@example.com',
        organizationId: TENANT_A,
      });

      const result = await repo.delete(doc._id, { organizationId: TENANT_A });
      expect(result.success).toBe(true);
      expect(result.soft).toBe(true);

      const after = await Model.findById(doc._id);
      expect(after).not.toBeNull();
      expect(after?.deletedAt).toBeInstanceOf(Date);
    });

    it('mode:"soft" is equivalent to default when plugin is wired', async () => {
      const doc = await Model.create({
        name: 'Alice2',
        email: 'alice2@example.com',
        organizationId: TENANT_A,
      });

      const result = await repo.delete(doc._id, {
        organizationId: TENANT_A,
        mode: 'soft',
      });
      expect(result.soft).toBe(true);

      const after = await Model.findById(doc._id);
      expect(after?.deletedAt).toBeInstanceOf(Date);
    });
  });

  // ==========================================================================
  // delete(id, { mode: 'hard' }) — GDPR / force path
  // ==========================================================================

  describe('delete(id, { mode: "hard" })', () => {
    it('physically removes the document even though softDeletePlugin is active', async () => {
      const doc = await Model.create({
        name: 'Alice',
        email: 'alice@example.com',
        organizationId: TENANT_A,
      });

      const result = await repo.delete(doc._id, {
        organizationId: TENANT_A,
        mode: 'hard',
      });
      expect(result.success).toBe(true);
      expect(result.soft).toBeUndefined();

      const after = await Model.findById(doc._id);
      expect(after).toBeNull();
    });

    it('still enforces tenant scoping (cross-tenant hard delete returns success:false)', async () => {
      const doc = await Model.create({
        name: 'Carol',
        email: 'carol@example.com',
        organizationId: TENANT_A,
      });

      // Contract: cross-tenant miss → { success: false }, not throw.
      // The isolation guarantee is that the doc stays put.
      const result = await repo.delete(doc._id, {
        organizationId: TENANT_B,
        mode: 'hard',
      });
      expect(result.success).toBe(false);

      const stillThere = await Model.findById(doc._id);
      expect(stillThere).not.toBeNull();
      expect(stillThere?.deletedAt).toBeNull();
    });

    it('can physically remove an already soft-deleted document (retention cleanup)', async () => {
      const doc = await Model.create({
        name: 'Dave',
        email: 'dave@example.com',
        organizationId: TENANT_A,
        deletedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      });

      const result = await repo.delete(doc._id, {
        organizationId: TENANT_A,
        mode: 'hard',
      });
      expect(result.success).toBe(true);

      const gone = await Model.findById(doc._id);
      expect(gone).toBeNull();
    });

    it('fires after:delete hook so audit trails still log the event', async () => {
      const auditSpy = vi.fn();
      repo.on('after:delete', auditSpy);

      const doc = await Model.create({
        name: 'Eve',
        email: 'eve@example.com',
        organizationId: TENANT_A,
      });

      await repo.delete(doc._id, { organizationId: TENANT_A, mode: 'hard' });

      expect(auditSpy).toHaveBeenCalledTimes(1);
      const payload = auditSpy.mock.calls[0][0];
      expect(payload.context.deleteMode).toBe('hard');
      expect(payload.context.organizationId).toBe(TENANT_A);
      expect(payload.result.success).toBe(true);

      repo.off('after:delete', auditSpy);
    });

    it('fires before:delete hook — caller-registered hooks see deleteMode', async () => {
      const beforeSpy = vi.fn();
      repo.on('before:delete', beforeSpy);

      const doc = await Model.create({
        name: 'Frank',
        email: 'frank@example.com',
        organizationId: TENANT_A,
      });

      await repo.delete(doc._id, { organizationId: TENANT_A, mode: 'hard' });

      expect(beforeSpy).toHaveBeenCalled();
      const ctxArg = beforeSpy.mock.calls[beforeSpy.mock.calls.length - 1][0];
      expect(ctxArg.deleteMode).toBe('hard');

      repo.off('before:delete', beforeSpy);
    });

    it('returns success:false when document does not exist (MinimalRepo contract)', async () => {
      const ghostId = new mongoose.Types.ObjectId();
      const result = await repo.delete(ghostId, {
        organizationId: TENANT_A,
        mode: 'hard',
      });
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // deleteMany(query, { mode: 'hard' }) — bulk cleanup
  // ==========================================================================

  describe('deleteMany(query, { mode: "hard" })', () => {
    beforeEach(async () => {
      await Model.insertMany([
        { name: 'A1', email: 'a1@x.com', organizationId: TENANT_A, status: 'churned' },
        { name: 'A2', email: 'a2@x.com', organizationId: TENANT_A, status: 'churned' },
        { name: 'A3', email: 'a3@x.com', organizationId: TENANT_A, status: 'active' },
        { name: 'B1', email: 'b1@x.com', organizationId: TENANT_B, status: 'churned' },
      ]);
    });

    it('default deleteMany is soft when plugin wired', async () => {
      await repo.deleteMany(
        { status: 'churned' },
        { organizationId: TENANT_A },
      );

      const all = await Model.find({}).lean();
      const softDeletedA = all.filter(
        (r) => r.organizationId === TENANT_A && r.deletedAt !== null,
      );
      expect(softDeletedA).toHaveLength(2);
    });

    it('mode:"hard" physically removes matching documents', async () => {
      const result = await repo.deleteMany(
        { status: 'churned' },
        { organizationId: TENANT_A, mode: 'hard' },
      );

      expect(result.acknowledged).toBe(true);
      expect(result.deletedCount).toBe(2);

      const remaining = await Model.find({}).lean();
      const remainingA = remaining.filter((r) => r.organizationId === TENANT_A);
      expect(remainingA).toHaveLength(1);
      expect(remainingA[0].name).toBe('A3');

      const remainingB = remaining.filter((r) => r.organizationId === TENANT_B);
      expect(remainingB).toHaveLength(1);
      expect(remainingB[0].deletedAt).toBeNull();
    });

    it('still scopes to calling tenant even if query names another', async () => {
      await repo.deleteMany(
        { status: 'churned', organizationId: TENANT_B },
        { organizationId: TENANT_A, mode: 'hard' },
      );

      const tenantB = await Model.find({ organizationId: TENANT_B }).lean();
      expect(tenantB).toHaveLength(1);
      expect(tenantB[0].deletedAt).toBeNull();
    });

    it('throws when the query filter is empty', async () => {
      await expect(
        repo.deleteMany({}, { organizationId: TENANT_A, mode: 'hard' }),
      ).rejects.toThrow(/non-empty query/i);

      const all = await Model.find({}).lean();
      expect(all).toHaveLength(4);
    });

    it('fires after:deleteMany hook for bulk-purge audit logging', async () => {
      const auditSpy = vi.fn();
      repo.on('after:deleteMany', auditSpy);

      await repo.deleteMany(
        { status: 'churned' },
        { organizationId: TENANT_A, mode: 'hard' },
      );

      expect(auditSpy).toHaveBeenCalledTimes(1);
      const payload = auditSpy.mock.calls[0][0];
      expect(payload.context.deleteMode).toBe('hard');
      expect(payload.context.organizationId).toBe(TENANT_A);

      repo.off('after:deleteMany', auditSpy);
    });

    it('deletes zero rows when filter matches nothing (no error)', async () => {
      const result = await repo.deleteMany(
        { status: 'nonexistent' },
        { organizationId: TENANT_A, mode: 'hard' },
      );
      expect(result.acknowledged).toBe(true);
      expect(result.deletedCount).toBe(0);
    });
  });

  // ==========================================================================
  // Contrast — both paths on the same repo
  // ==========================================================================

  describe('contrast: soft vs hard on the same repo', () => {
    it('delete() is soft, delete({mode:"hard"}) is hard — same repo, same doc shape', async () => {
      const softDoc = await Model.create({
        name: 'Soft',
        email: 'soft@x.com',
        organizationId: TENANT_A,
      });
      const hardDoc = await Model.create({
        name: 'Hard',
        email: 'hard@x.com',
        organizationId: TENANT_A,
      });

      await repo.delete(softDoc._id, { organizationId: TENANT_A });
      await repo.delete(hardDoc._id, { organizationId: TENANT_A, mode: 'hard' });

      const softStill = await Model.findById(softDoc._id);
      expect(softStill).not.toBeNull();
      expect(softStill?.deletedAt).toBeInstanceOf(Date);

      const hardGone = await Model.findById(hardDoc._id);
      expect(hardGone).toBeNull();
    });
  });
});
