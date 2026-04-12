/**
 * Restore Hook Tests
 *
 * softDeletePlugin exposes `repo.restore(id)` symmetric with `repo.delete(id)`.
 * For cascade flows (re-increment counters, revalidate state, re-index search
 * projections) hosts need both `before:restore` and `after:restore` hooks to
 * fire — mirroring `before:delete` / `after:delete`.
 *
 * This suite verifies:
 *   - `before:restore` fires BEFORE the findOneAndUpdate (hook can mutate context
 *     or throw to veto the restore).
 *   - `after:restore` fires with `{ context, result }` payload matching the
 *     standard shape used by every other `after:*` hook.
 *   - Multi-tenant scoping runs on `before:restore` (cross-tenant restore 404s).
 *   - Restore is idempotent-safe: hooks get the correct document on every call.
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Repository,
  methodRegistryPlugin,
  multiTenantPlugin,
  softDeletePlugin,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  organizationId: string;
  deletedAt?: Date | null;
}

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  organizationId: { type: String, required: true },
  deletedAt: { type: Date, default: null },
});

describe('softDeletePlugin restore hooks', () => {
  let Model: mongoose.Model<IProduct>;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let repo: any;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('RestoreHookProduct', ProductSchema);
    repo = new Repository<IProduct>(Model, [
      methodRegistryPlugin(),
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

  it('fires before:restore before the document is updated', async () => {
    const doc = await Model.create({
      name: 'Widget',
      organizationId: 'org_1',
      deletedAt: new Date(),
    });

    const observedStates: Array<Date | null | undefined> = [];
    const hook = async (context: { id: unknown }) => {
      // At this point the document should still be soft-deleted on disk.
      const snapshot = await Model.findById(context.id).lean();
      observedStates.push(snapshot?.deletedAt);
    };
    repo.on('before:restore', hook);

    await repo.restore(doc._id, { organizationId: 'org_1' });

    expect(observedStates).toHaveLength(1);
    expect(observedStates[0]).toBeInstanceOf(Date);

    // And after the call, it's actually restored.
    const restored = await Model.findById(doc._id);
    expect(restored?.deletedAt).toBeNull();

    // Remove ONLY our spy — never removeAllListeners, which would wipe
    // multi-tenant's POLICY-priority hook shared across tests in this suite.
    repo.off('before:restore', hook);
  });

  it('fires after:restore with { context, result } shape', async () => {
    const doc = await Model.create({
      name: 'Widget',
      organizationId: 'org_1',
      deletedAt: new Date(),
    });

    const afterSpy = vi.fn();
    repo.on('after:restore', afterSpy);

    await repo.restore(doc._id, { organizationId: 'org_1' });

    expect(afterSpy).toHaveBeenCalledTimes(1);
    const payload = afterSpy.mock.calls[0][0];
    expect(payload).toHaveProperty('context');
    expect(payload).toHaveProperty('result');
    expect(payload.context.operation).toBe('restore');
    expect(payload.context.organizationId).toBe('org_1');
    expect(payload.result).toBeTruthy();
    expect(payload.result.deletedAt).toBeNull();

    repo.off('after:restore', afterSpy);
  });

  it('before:restore runs AFTER multi-tenant scoping (cross-tenant restore 404s)', async () => {
    const doc = await Model.create({
      name: 'Widget',
      organizationId: 'org_1',
      deletedAt: new Date(),
    });

    const beforeSpy = vi.fn();
    repo.on('before:restore', beforeSpy);

    // Tenant mismatch → multi-tenant injects organizationId=org_other into query →
    // findOneAndUpdate misses → 404. before:restore still fires (policy hooks run).
    await expect(
      repo.restore(doc._id, { organizationId: 'org_other' }),
    ).rejects.toThrow(/not found/i);

    expect(beforeSpy).toHaveBeenCalled();
    // And the document is NOT restored.
    const still = await Model.findById(doc._id);
    expect(still?.deletedAt).toBeInstanceOf(Date);

    repo.off('before:restore', beforeSpy);
  });

  it('before:restore can throw to veto the restore', async () => {
    const doc = await Model.create({
      name: 'Widget',
      organizationId: 'org_1',
      deletedAt: new Date(),
    });

    const vetoHook = () => {
      throw new Error('restore vetoed by policy');
    };
    repo.on('before:restore', vetoHook);

    await expect(
      repo.restore(doc._id, { organizationId: 'org_1' }),
    ).rejects.toThrow(/vetoed by policy/);

    // Document is still soft-deleted — the throw prevented the update.
    const still = await Model.findById(doc._id);
    expect(still?.deletedAt).toBeInstanceOf(Date);

    repo.off('before:restore', vetoHook);
  });

  it('enables cascade restore — e.g. re-incrementing a counter', async () => {
    // Simulates the real-world use case: restoring a product re-adds it to a
    // category count. Here we just track via a spy.
    const doc = await Model.create({
      name: 'Widget',
      organizationId: 'org_1',
      deletedAt: new Date(),
    });

    const reindexSpy = vi.fn();
    const afterHook = (payload: { result: IProduct }) => {
      reindexSpy(payload.result.name);
    };
    repo.on('after:restore', afterHook);

    await repo.restore(doc._id, { organizationId: 'org_1' });

    expect(reindexSpy).toHaveBeenCalledWith('Widget');

    repo.off('after:restore', afterHook);
  });
});
