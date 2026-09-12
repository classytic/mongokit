/**
 * `dateSequentialId({ scope: 'tenant' })` — per-tenant sequences in a shared
 * database. Each tenant increments its own `_mongokit_counters` document
 * (`<Model>:<tenantId>:<period>`), so numbering starts at 1 per tenant and
 * the global write hot spot splits. Missing tenant fails closed.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { customIdPlugin, dateSequentialId, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrder {
  _id: Types.ObjectId;
  orderNumber?: string;
  organizationId?: string;
  total: number;
}

const MODEL_NAME = 'CustomIdTenantOrder';

/** The raw counters collection — string `_id`s, so `$regex` filters type-check. */
const counters = () =>
  mongoose.connection.collection<{ _id: string; seq: number }>('_mongokit_counters');

describe('dateSequentialId — tenant scope', () => {
  let Model: mongoose.Model<IOrder>;

  // Only clear counter keys owned by this file — `_mongokit_counters` is
  // shared across every test file that uses customIdPlugin.
  const clearOwnCounters = async () => {
    await counters().deleteMany({ _id: { $regex: `^${MODEL_NAME}` } });
  };

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      MODEL_NAME,
      new Schema<IOrder>({
        orderNumber: String,
        organizationId: String,
        total: { type: Number, required: true },
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await clearOwnCounters();
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    await clearOwnCounters();
  });

  const year = String(new Date().getFullYear());

  it('two tenants get independent sequences, each starting at 1', async () => {
    const repo = new Repository<IOrder>(Model, [
      customIdPlugin({
        field: 'orderNumber',
        generator: dateSequentialId({
          prefix: 'ORD',
          model: Model,
          partition: 'yearly',
          scope: 'tenant',
        }),
      }),
    ]);

    const a1 = await repo.create({ total: 1 }, { organizationId: 'org-a' });
    const a2 = await repo.create({ total: 2 }, { organizationId: 'org-a' });
    const b1 = await repo.create({ total: 3 }, { organizationId: 'org-b' });
    const a3 = await repo.create({ total: 4 }, { organizationId: 'org-a' });

    expect(a1.orderNumber).toBe(`ORD-${year}-0001`);
    expect(a2.orderNumber).toBe(`ORD-${year}-0002`);
    expect(b1.orderNumber).toBe(`ORD-${year}-0001`);
    expect(a3.orderNumber).toBe(`ORD-${year}-0003`);

    // One counter document per tenant — the hot spot is split, not shared.
    const owned = await counters()
      .find({ _id: { $regex: `^${MODEL_NAME}:` } })
      .toArray();
    expect(owned.map((c) => c._id).sort()).toEqual([
      `${MODEL_NAME}:org-a:${year}`,
      `${MODEL_NAME}:org-b:${year}`,
    ]);
  });

  it('createMany numbers every doc within the calling tenant', async () => {
    const repo = new Repository<IOrder>(Model, [
      customIdPlugin({
        field: 'orderNumber',
        generator: dateSequentialId({
          prefix: 'ORD',
          model: Model,
          partition: 'yearly',
          scope: 'tenant',
        }),
      }),
    ]);

    const docs = await repo.createMany([{ total: 1 }, { total: 2 }], {
      organizationId: 'org-c',
    });
    expect(docs.map((d) => d.orderNumber)).toEqual([`ORD-${year}-0001`, `ORD-${year}-0002`]);
  });

  it('honours a custom tenantKey', async () => {
    const repo = new Repository<IOrder>(Model, [
      customIdPlugin({
        field: 'orderNumber',
        generator: dateSequentialId({
          prefix: 'ORD',
          model: Model,
          partition: 'yearly',
          scope: 'tenant',
          tenantKey: 'shopId',
        }),
      }),
    ]);

    const doc = await repo.create({ total: 1 }, { shopId: 'shop-9' } as Record<string, unknown>);
    expect(doc.orderNumber).toBe(`ORD-${year}-0001`);
    const counter = await counters().findOne({ _id: `${MODEL_NAME}:shop-9:${year}` });
    expect(counter?.seq).toBe(1);
  });

  it('fails closed when the tenant is missing — never falls back to the global counter', async () => {
    const repo = new Repository<IOrder>(Model, [
      customIdPlugin({
        field: 'orderNumber',
        generator: dateSequentialId({
          prefix: 'ORD',
          model: Model,
          partition: 'yearly',
          scope: 'tenant',
        }),
      }),
    ]);

    await expect(repo.create({ total: 1 })).rejects.toThrow(
      /scope 'tenant' requires 'organizationId' in context for 'CustomIdTenantOrder' create/,
    );
    await expect(repo.create({ total: 1 }, { organizationId: '' })).rejects.toThrow(
      /requires 'organizationId'/,
    );

    // Nothing was written and no counter (tenant OR global) was bumped.
    expect(await Model.countDocuments()).toBe(0);
    const owned = await counters()
      .find({ _id: { $regex: `^${MODEL_NAME}` } })
      .toArray();
    expect(owned).toHaveLength(0);
  });

  it("scope: 'global' (the default) is unchanged — one sequence across tenants", async () => {
    const repo = new Repository<IOrder>(Model, [
      customIdPlugin({
        field: 'orderNumber',
        generator: dateSequentialId({ prefix: 'ORD', model: Model, partition: 'yearly' }),
      }),
    ]);

    const a = await repo.create({ total: 1 }, { organizationId: 'org-a' });
    const b = await repo.create({ total: 2 }, { organizationId: 'org-b' });
    const none = await repo.create({ total: 3 });

    expect(a.orderNumber).toBe(`ORD-${year}-0001`);
    expect(b.orderNumber).toBe(`ORD-${year}-0002`);
    expect(none.orderNumber).toBe(`ORD-${year}-0003`);
    const counter = await counters().findOne({ _id: `${MODEL_NAME}:${year}` });
    expect(counter?.seq).toBe(3);
  });

  it('padding is a minimum width — the sequence grows past it instead of truncating', async () => {
    // Pre-seed the counter just below the padding boundary.
    await counters().insertOne({ _id: `${MODEL_NAME}:org-a:${year}`, seq: 99 });

    const repo = new Repository<IOrder>(Model, [
      customIdPlugin({
        field: 'orderNumber',
        generator: dateSequentialId({
          prefix: 'ORD',
          model: Model,
          partition: 'yearly',
          padding: 2,
          scope: 'tenant',
        }),
      }),
    ]);

    const doc = await repo.create({ total: 1 }, { organizationId: 'org-a' });
    expect(doc.orderNumber).toBe(`ORD-${year}-100`);
  });
});
