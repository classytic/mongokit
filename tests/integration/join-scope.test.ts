/**
 * Join scope: every `$lookup` / `$unionWith` / `$graphLookup` (nested and `$facet` included, IR
 * `lookups[]` and `lookupPopulate` too) reads the joined collection under ITS repository's
 * tenant + soft-delete policy; a `from` no model owns, or no repository governs, is refused.
 */

import mongoose, { type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JOIN_ERROR_CODES,
  multiTenantPlugin,
  Repository,
  softDeletePlugin,
} from '../../src/index.js';
import { connectDB, createTestModel } from '../setup.js';

interface IOrder {
  organizationId: string;
  sku: string;
  branchCode: string;
}
interface IStock {
  organizationId: string;
  sku: string;
  qty: number;
  parentSku?: string;
  deletedAt?: Date | null;
}
interface IBranch {
  code: string;
  name: string;
}

const ORG_A = 'org-a';
const ORG_B = 'org-b';

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe('join scope', () => {
  let Order: Model<IOrder>;
  let Stock: Model<IStock>;
  let Branch: Model<IBranch>;
  let Loose: Model<{ k: string }>;
  let orders: Repository<IOrder>;
  let branches: Repository<IBranch>;
  let stockColl: string;

  beforeAll(async () => {
    await connectDB();
    Order = await createTestModel('JoinScopeOrder', new Schema<IOrder>({ organizationId: String, sku: String, branchCode: String }));
    Stock = await createTestModel(
      'JoinScopeStock',
      new Schema<IStock>({
        organizationId: String,
        sku: String,
        qty: Number,
        parentSku: String,
        deletedAt: { type: Date, default: null },
      }),
    );
    // The silent-empty-join shape: the model is 'JoinScopeBranch', its collection is not the plural.
    Branch = mongoose.model<IBranch>(
      'JoinScopeBranch',
      new Schema<IBranch>({ code: String, name: String }),
      'join_scope_organization',
    );
    Loose = await createTestModel('JoinScopeLoose', new Schema({ k: String }));
    stockColl = Stock.collection.collectionName;

    orders = new Repository<IOrder>(Order, [multiTenantPlugin({ tenantField: 'organizationId' })]);
    // The stock repository declares the policy every join into its collection must carry.
    new Repository<IStock>(Stock, [multiTenantPlugin({ tenantField: 'organizationId' }), softDeletePlugin()]);
    branches = new Repository<IBranch>(Branch);

    await Promise.all([Order.deleteMany({}), Stock.deleteMany({}), Branch.deleteMany({})]);
    await Order.insertMany([
      { organizationId: ORG_A, sku: 'S1', branchCode: 'A' },
      { organizationId: ORG_B, sku: 'S1', branchCode: 'B' },
    ]);
    await Stock.insertMany([
      { organizationId: ORG_A, sku: 'S1', qty: 5 },
      { organizationId: ORG_A, sku: 'S1', qty: 99, deletedAt: new Date() },
      { organizationId: ORG_B, sku: 'S1', qty: 7 },
      { organizationId: ORG_A, sku: 'S0', qty: 1, parentSku: 'S1' },
      { organizationId: ORG_B, sku: 'S0', qty: 2, parentSku: 'S1' },
    ]);
    await Branch.insertMany([{ code: 'A', name: 'Branch A' }]);
  });
  afterAll(async () => {
    await Promise.all([Order.deleteMany({}), Stock.deleteMany({}), Branch.deleteMany({})]);
    mongoose.deleteModel('JoinScopeBranch');
  });

  const qtys = (rows: unknown[], as = 'stock') =>
    rows.flatMap((r) => ((r as Record<string, unknown>)[as] as Array<{ qty: number }>).map((s) => s.qty)).sort((a, b) => a - b);

  it('$lookup (localField form) carries the joined collection tenant + live-docs scope', async () => {
    const rows = await orders.aggregatePipeline(
      [{ $lookup: { from: stockColl, localField: 'sku', foreignField: 'sku', as: 'stock' } }],
      { organizationId: ORG_A },
    );
    expect(rows).toHaveLength(1);
    expect(qtys(rows)).toEqual([5]);
  });

  it('$lookup (pipeline form) is scoped', async () => {
    const rows = await orders.aggregatePipeline(
      [
        {
          $lookup: {
            from: stockColl,
            let: { s: '$sku' },
            pipeline: [{ $match: { $expr: { $eq: ['$sku', '$$s'] } } }],
            as: 'stock',
          },
        },
      ],
      { organizationId: ORG_A },
    );
    expect(qtys(rows)).toEqual([5]);
  });

  it('$unionWith (string and object form) is scoped', async () => {
    const asString = await orders.aggregatePipeline([{ $unionWith: stockColl }], { organizationId: ORG_A });
    expect(asString.filter((r) => 'qty' in (r as object))).toHaveLength(2);
    const asObject = await orders.aggregatePipeline(
      [{ $unionWith: { coll: stockColl, pipeline: [{ $match: { sku: 'S1' } }] } }],
      { organizationId: ORG_A },
    );
    expect(asObject.filter((r) => 'qty' in (r as object))).toHaveLength(1);
  });

  it('$graphLookup restricts the search to the scope', async () => {
    const rows = await orders.aggregatePipeline(
      [
        {
          $graphLookup: {
            from: stockColl,
            startWith: '$sku',
            connectFromField: 'sku',
            connectToField: 'parentSku',
            as: 'stock',
          },
        },
      ],
      { organizationId: ORG_A },
    );
    expect(qtys(rows)).toEqual([1]);
  });

  it('a $lookup inside a $facet branch is scoped', async () => {
    const [facet] = await orders.aggregatePipeline<{ joined: unknown[] }>(
      [{ $facet: { joined: [{ $lookup: { from: stockColl, localField: 'sku', foreignField: 'sku', as: 'stock' } }] } }],
      { organizationId: ORG_A },
    );
    expect(qtys(facet?.joined ?? [])).toEqual([5]);
  });

  it('portable aggregate(lookups[]) and lookupPopulate are scoped', async () => {
    const { rows } = await orders.aggregate(
      {
        lookups: [{ from: stockColl, localField: 'sku', foreignField: 'sku', as: 'stock', single: true }],
        groupBy: 'sku',
        measures: { qty: { op: 'sum', field: 'stock.qty' } },
      },
      { organizationId: ORG_A },
    );
    expect(rows[0]?.qty).toBe(5);
    const page = await orders.lookupPopulate({
      filters: {},
      lookups: [{ from: stockColl, localField: 'sku', foreignField: 'sku', as: 'stock' }],
      organizationId: ORG_A,
    });
    expect(qtys(page.data)).toEqual([5]);
  });

  it('bypassTenant on the base read lifts the joined tenant scope but keeps live-docs only', async () => {
    const rows = await orders.aggregatePipeline(
      [{ $lookup: { from: stockColl, localField: 'sku', foreignField: 'sku', as: 'stock' } }],
      { bypassTenant: true },
    );
    expect(qtys(rows)).toEqual([5, 5, 7, 7]);
  });

  it('a company-wide base joining a per-branch collection without a tenant fails loud', async () => {
    await expect(
      branches.aggregatePipeline([{ $lookup: { from: stockColl, localField: 'code', foreignField: 'sku', as: 'stock' } }]),
    ).rejects.toThrow(/Missing 'organizationId'/);
  });

  it('a from that no model owns is refused, naming the model and its real collection', async () => {
    let caught: { code?: string; message?: string } = {};
    try {
      await orders.aggregatePipeline(
        [{ $lookup: { from: 'joinscopebranches', localField: 'branchCode', foreignField: 'code', as: 'b' } }],
        { organizationId: ORG_A },
      );
    } catch (err) {
      caught = err as typeof caught;
    }
    expect(caught.code).toBe(JOIN_ERROR_CODES.UNKNOWN_COLLECTION);
    expect(caught.message).toContain("model 'JoinScopeBranch' lives in collection 'join_scope_organization'");
    const ok = await orders.aggregatePipeline(
      [{ $lookup: { from: Branch.collection.collectionName, localField: 'branchCode', foreignField: 'code', as: 'b' } }],
      { organizationId: ORG_A },
    );
    expect((ok[0] as { b: unknown[] }).b).toHaveLength(1);
  });

  it('a collection no repository governs is refused unless listed in unscopedJoins', async () => {
    const join = [{ $lookup: { from: Loose.collection.collectionName, localField: 'sku', foreignField: 'k', as: 'l' } }];
    expect(await codeOf(orders.aggregatePipeline(join, { organizationId: ORG_A }))).toBe(
      JOIN_ERROR_CODES.UNGOVERNED_COLLECTION,
    );
    await expect(
      orders.aggregatePipeline(join, { organizationId: ORG_A, unscopedJoins: [Loose.collection.collectionName] }),
    ).resolves.toHaveLength(1);
  });

  it('a scoped collection cannot be unscoped through unscopedJoins', async () => {
    const join = [{ $lookup: { from: stockColl, localField: 'sku', foreignField: 'sku', as: 's' } }];
    expect(await codeOf(orders.aggregatePipeline(join, { organizationId: ORG_A, unscopedJoins: [stockColl] }))).toBe(
      JOIN_ERROR_CODES.UNSCOPE_REFUSED,
    );
  });

  it('aggregate(req, { explain }) returns the rows and the winning plan', async () => {
    const result = await orders.aggregate(
      { groupBy: 'sku', measures: { n: { op: 'count' } } },
      { organizationId: ORG_A, explain: 'executionStats' },
    );
    expect(result.rows).toEqual([{ sku: 'S1', n: 1 }]);
    expect(JSON.stringify(result.plan)).toMatch(/queryPlanner|stages/);
  });

  it('hint reaches aggregatePipeline and findOneAndUpdate (an unknown index is a server error)', async () => {
    await expect(
      orders.aggregatePipeline([{ $match: {} }], { organizationId: ORG_A, hint: 'no_such_index' }),
    ).rejects.toThrow(/hint/i);
    await expect(
      orders.findOneAndUpdate({ sku: 'S1' }, { $set: { branchCode: 'A' } }, { organizationId: ORG_A, hint: 'no_such_index' }),
    ).rejects.toThrow(/hint/i);
  });
});
