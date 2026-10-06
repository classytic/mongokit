/**
 * The cascade's root rules, each one a bug that shipped:
 *
 *   1. `parentKey` — a repository addressed by a custom `idField` (orders by
 *      `orderNumber`) whose children store the parent's `_id`. The cascade keyed
 *      the children on the NUMBER, so every child delete failed the ObjectId cast.
 *   2. A MISS cascades nothing. `after:delete` fires on a miss too, and the
 *      cascade used to run anyway, deleting children of a parent it never removed.
 *   3. A tenant plugin with a custom `contextKey` is forwarded. The cascade only
 *      knew `organizationId` / `tenantId`, so a `branchId`-scoped child refused
 *      the cascade ("Missing 'branchId'").
 *   4. One scope rule (`forwardScope`): the bypass travels only when no tenant
 *      does, because the tenant plugin honours a bypass FIRST.
 */
import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cascadePlugin,
  createOptionsExtractor,
  customIdPlugin,
  forwardScope,
  methodRegistryPlugin,
  multiTenantPlugin,
  Repository,
  repoOptionsFromCtx,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface IOrder {
  _id: Types.ObjectId;
  orderNumber: string;
  organizationId: string;
}
interface ILine {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  organizationId: string;
}

describe('cascade: parentKey, misses, custom tenant keys', () => {
  let Order: mongoose.Model<IOrder>;
  let Line: mongoose.Model<ILine>;
  // biome-ignore lint/suspicious/noExplicitAny: plugin-registered methods
  let orders: any;
  let seq = 0;

  beforeAll(async () => {
    await connectDB();
    Order = await createTestModel(
      'ParentKeyOrder',
      new Schema<IOrder>({ orderNumber: String, organizationId: { type: String, required: true } }),
    );
    Line = await createTestModel(
      'ParentKeyLine',
      new Schema<ILine>({
        orderId: { type: Schema.Types.ObjectId, required: true, index: true },
        organizationId: { type: String, required: true },
      }),
    );
    const lines = new Repository<ILine>(Line, [
      methodRegistryPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);
    orders = new Repository<IOrder>(Order, [
      methodRegistryPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      customIdPlugin({ field: 'orderNumber', generator: async () => `ORD-${++seq}` }),
      cascadePlugin({ relations: [{ repo: lines, foreignKey: 'orderId', parentKey: '_id' }] }),
    ]);
    (orders as { idField: string }).idField = 'orderNumber';
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Order.deleteMany({});
    await Line.deleteMany({});
  });

  async function orderWithLines(org: string, n = 2) {
    const order = await orders.create({ organizationId: org }, { organizationId: org });
    for (let i = 0; i < n; i++) await Line.create({ orderId: order._id, organizationId: org });
    return order as IOrder;
  }

  it('delete(orderNumber) cascades to children that store the _id', async () => {
    const order = await orderWithLines('org_1');
    const other = await orderWithLines('org_1', 1);

    await orders.delete(order.orderNumber, { organizationId: 'org_1' });

    expect(await Order.countDocuments({ _id: order._id })).toBe(0);
    expect(await Line.countDocuments({ orderId: order._id })).toBe(0);
    expect(await Line.countDocuments({ orderId: other._id })).toBe(1);
  });

  it('deleteMany collects the parentKey, not the idField', async () => {
    const a = await orderWithLines('org_1');
    const b = await orderWithLines('org_1');

    await orders.deleteMany(
      { orderNumber: { $in: [a.orderNumber, b.orderNumber] } },
      { organizationId: 'org_1' },
    );

    expect(await Line.countDocuments({})).toBe(0);
  });

  it("a MISS cascades nothing: another tenant's order and its lines survive", async () => {
    const theirs = await orderWithLines('org_2');

    const result = await orders.delete(theirs.orderNumber, { organizationId: 'org_1' });

    expect(result).toBeNull();
    expect(await Order.countDocuments({ _id: theirs._id })).toBe(1);
    expect(await Line.countDocuments({ orderId: theirs._id })).toBe(2);
  });

  it('a platform admin (bypass, no tenant) cascades across tenants', async () => {
    const theirs = await orderWithLines('org_2');
    await orders.delete(theirs.orderNumber, { bypassTenant: true });
    expect(await Line.countDocuments({ orderId: theirs._id })).toBe(0);
  });
});

describe('cascade: a tenant plugin with a custom contextKey', () => {
  it('forwards the declared key to the child repo', async () => {
    await connectDB();
    const Branch = await createTestModel(
      'CtxKeyParent',
      new Schema({ name: String, branch: { type: String, required: true } }),
    );
    const Stock = await createTestModel(
      'CtxKeyChild',
      new Schema({
        parent: { type: Schema.Types.ObjectId, index: true },
        branch: { type: String, required: true },
      }),
    );
    const tenant = { tenantField: 'branch', contextKey: 'branchId' } as const;
    const stock = new Repository(Stock, [methodRegistryPlugin(), multiTenantPlugin(tenant)]);
    const parents = new Repository(Branch, [
      methodRegistryPlugin(),
      multiTenantPlugin(tenant),
      cascadePlugin({ relations: [{ repo: stock as never, foreignKey: 'parent' }] }),
    ]);

    const parent = await Branch.create({ name: 'p', branch: 'b1' });
    await Stock.create({ parent: parent._id, branch: 'b1' });

    await parents.delete(String(parent._id), { branchId: 'b1' } as never);

    expect(await Stock.countDocuments({ parent: parent._id })).toBe(0);
  });
});

describe('forwardScope: the one rule', () => {
  it('carries the bypass only when no tenant is present', () => {
    expect(forwardScope({ bypassTenant: true })).toEqual({ bypassTenant: true });
    expect(forwardScope({ bypassTenant: true, organizationId: 'org_1' })).toEqual({
      organizationId: 'org_1',
    });
  });

  it('a null tenant is forwarded as given and does not suppress the bypass', () => {
    expect(forwardScope({ organizationId: null, bypassTenant: true })).toEqual({
      organizationId: null,
      bypassTenant: true,
    });
  });

  it('repoOptionsFromCtx and createOptionsExtractor follow it, whatever fields are listed', () => {
    const ctx = { organizationId: 'org_1', bypassTenant: true, actorRef: 'u1' };
    expect(repoOptionsFromCtx(ctx)).toEqual({ organizationId: 'org_1' });
    const extract = createOptionsExtractor<typeof ctx>(['bypassTenant', 'actorRef']);
    expect(extract(ctx)).toEqual({ organizationId: 'org_1', actorRef: 'u1' });
  });
});
