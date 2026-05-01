/**
 * Regression: portable aggregate filters break when a policy plugin
 * injects scope.
 *
 * `_injectPolicyScopeIntoAgg` was merging the caller's `req.filter` into
 * a Mongo `$and` literal alongside the plugin-injected scope. When the
 * caller passed a Filter IR node (`eq('status', 'paid')` — an object
 * `{ op, field, value }`), the merged value carried the IR literal
 * inside `$and`. `compileFilterToMongo` saw `$and` at the top, found no
 * top-level `op`, and passed the whole thing through to Mongo unchanged
 * — leaving `{ op: 'eq', field: 'status', value: 'paid' }` as a literal
 * `$and` clause. Mongo cannot match those keys against a real document,
 * so the aggregate silently returned 0 rows even when matching docs
 * existed.
 *
 * Fix: compile each part through `compileFilterToMongo` *before* building
 * the `$and`.
 */

import { eq, gte } from '@classytic/repo-core/filter';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IPayment {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  status: 'paid' | 'pending' | 'failed';
  amount: number;
}

function makeSchema() {
  return new mongoose.Schema<IPayment>(
    {
      organizationId: { type: String, required: true, index: true },
      status: { type: String, required: true },
      amount: { type: Number, required: true },
    },
    { timestamps: false },
  );
}

/** Stand-in policy plugin: stamps `context.query = { organizationId }` on every read op,
 *  same shape `multiTenantPlugin` injects. Lets us test the scope-merge code path
 *  without depending on AsyncLocalStorage / `resolveContext`. */
function fakeTenantScopePlugin(orgId: string) {
  return {
    name: 'fake-tenant-scope',
    apply(repo: { on: (event: string, listener: (ctx: Record<string, unknown>) => void) => void }) {
      const stamp = (ctx: Record<string, unknown>) => {
        ctx.query = { ...(ctx.query as Record<string, unknown>), organizationId: orgId };
      };
      for (const op of ['aggregate', 'aggregatePaginate', 'getAll', 'count', 'findAll']) {
        repo.on(`before:${op}`, stamp);
      }
    },
  };
}

describe('aggregate IR + policy plugin scope (regression)', () => {
  let Model: mongoose.Model<IPayment>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel('PolicyScopeAggIr', makeSchema());
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
    await Model.create([
      { organizationId: 'org-a', status: 'paid', amount: 10 },
      { organizationId: 'org-a', status: 'paid', amount: 20 },
      { organizationId: 'org-a', status: 'pending', amount: 30 },
      { organizationId: 'org-b', status: 'paid', amount: 99 },
      { organizationId: 'org-b', status: 'paid', amount: 7 },
    ]);
  });

  it('counts only tenant rows that match the IR filter', async () => {
    const repo = new Repository<IPayment>(Model, [fakeTenantScopePlugin('org-a')]);

    const { rows } = await repo.aggregate<{ count: number; total: number }>({
      filter: eq('status', 'paid'),
      measures: {
        count: { op: 'count' },
        total: { op: 'sum', field: 'amount' },
      },
    });

    // org-a × paid → 2 rows summing to 30. The bug returned 0 rows
    // because the IR literal sat as garbage inside $and.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.total).toBe(30);
  });

  it('paginated aggregate also honors IR filter + scope', async () => {
    const repo = new Repository<IPayment>(Model, [fakeTenantScopePlugin('org-a')]);

    const result = await repo.aggregatePaginate<{ count: number }>({
      filter: gte('amount', 5),
      measures: { count: { op: 'count' } },
      page: 1,
      limit: 10,
    });

    // org-a × amount >= 5 → all 3 org-a docs. Bug returned 0.
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0]?.count).toBe(3);
  });

  it('plain mongo filter still works (passthrough path)', async () => {
    // Sanity check: the merge path is also taken for mongo-shaped filters,
    // and that codepath was working pre-fix. Don't regress it.
    const repo = new Repository<IPayment>(Model, [fakeTenantScopePlugin('org-a')]);

    const { rows } = await repo.aggregate<{ count: number }>({
      filter: { status: 'paid' },
      measures: { count: { op: 'count' } },
    });

    expect(rows[0]?.count).toBe(2);
  });
});
