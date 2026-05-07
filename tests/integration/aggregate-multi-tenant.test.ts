/**
 * `Repository.aggregate(req)` ↔ `multiTenantPlugin` integration.
 *
 * Demonstrates the gap: every other repo method accepts a second
 * options bag (`{ organizationId }`), but `aggregate(req)` is single-arg,
 * so callers can't pass tenant context to a multi-tenant scoped repo.
 *
 * The fix should land in mongokit (and sqlitekit) by accepting an
 * options arg — `aggregate(req, options)` — that gets spread into the
 * operation context built by `_buildContext('aggregate', ...)`. The
 * existing `_injectPolicyScopeIntoAgg` helper already merges
 * `context.query` (where multi-tenant writes the tenant filter) into
 * `req.filter`, so once the orgId reaches `context`, the merge layer
 * already does the right thing.
 *
 * Mirrors the patterns in:
 *   - tests/integration/aggregate-ir.test.ts (aggregate test setup)
 *   - tests/integration/multi-tenant-primitives.test.ts (multiTenantPlugin)
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { multiTenantPlugin, Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface ITxn {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  amount: number;
  method: string;
  status: string;
}

describe('aggregate(req) ↔ multiTenantPlugin', () => {
  let Model: mongoose.Model<ITxn>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'AggMultiTenantTxn',
      new Schema<ITxn>({
        organizationId: { type: String, required: true, index: true },
        amount: { type: Number, required: true },
        method: { type: String, required: true },
        status: { type: String, required: true },
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  describe('required orgId still enforced when omitted', () => {
    it('throws "Missing organizationId" when neither arg carries one (required: true)', async () => {
      // After the second-arg fix, calling `aggregate(req)` with no
      // options still has no way to know the tenant — the plugin's
      // require-check fires, same as findAll() / count() / etc. This
      // test pins the contract: "tenant context is required" is
      // enforced at the SAME boundary across every read.
      const repo = new Repository<ITxn>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      await Model.create([
        { organizationId: 'org-a', amount: 100, method: 'cash', status: 'verified' },
      ]);

      await expect(
        repo.aggregate({
          measures: { total: { op: 'sum', field: 'amount' } },
        }),
      ).rejects.toThrow(/Missing 'organizationId'/);
    });
  });

  describe('the fix — second-arg options bag carries tenant context', () => {
    it('scopes results when organizationId is passed as the second arg', async () => {
      const repo = new Repository<ITxn>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      await Model.create([
        { organizationId: 'org-a', amount: 100, method: 'cash', status: 'verified' },
        { organizationId: 'org-a', amount: 200, method: 'cash', status: 'verified' },
        { organizationId: 'org-b', amount: 9999, method: 'cash', status: 'verified' },
      ]);

      // After fix: `repo.aggregate(req, { organizationId })` works
      // identically to `repo.findAll({}, { organizationId })`.
      const { rows } = await (
        repo as unknown as {
          aggregate: (
            req: unknown,
            options: { organizationId: string },
          ) => Promise<{ rows: Array<{ total: number }> }>;
        }
      ).aggregate(
        { measures: { total: { op: 'sum', field: 'amount' } } },
        { organizationId: 'org-a' },
      );
      expect(rows[0]?.total).toBe(300); // org-a only — org-b's 9999 is filtered out
    });

    it('groupBy + filter both honour tenant scope', async () => {
      const repo = new Repository<ITxn>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      await Model.create([
        { organizationId: 'org-a', amount: 100, method: 'cash', status: 'verified' },
        { organizationId: 'org-a', amount: 50, method: 'card', status: 'verified' },
        { organizationId: 'org-a', amount: 25, method: 'cash', status: 'pending' },
        { organizationId: 'org-b', amount: 9999, method: 'cash', status: 'verified' },
      ]);

      const { rows } = await (
        repo as unknown as {
          aggregate: (
            req: unknown,
            options: { organizationId: string },
          ) => Promise<{ rows: Array<{ method: string; total: number; count: number }> }>;
        }
      ).aggregate(
        {
          groupBy: 'method',
          measures: {
            total: { op: 'sum', field: 'amount' },
            count: { op: 'count' },
          },
        },
        { organizationId: 'org-a' },
      );
      const sorted = rows.slice().sort((a, b) => a.method.localeCompare(b.method));
      expect(sorted).toEqual([
        { method: 'card', total: 50, count: 1 },
        { method: 'cash', total: 125, count: 2 }, // 100 + 25, NOT 9999
      ]);
    });

    it('bypassTenant: true skips tenant scoping just like the other ops', async () => {
      const repo = new Repository<ITxn>(Model, [
        multiTenantPlugin({ tenantField: 'organizationId', required: true }),
      ]);
      await Model.create([
        { organizationId: 'org-a', amount: 100, method: 'cash', status: 'verified' },
        { organizationId: 'org-b', amount: 200, method: 'cash', status: 'verified' },
      ]);

      const { rows } = await (
        repo as unknown as {
          aggregate: (
            req: unknown,
            options: { bypassTenant: true },
          ) => Promise<{ rows: Array<{ total: number }> }>;
        }
      ).aggregate({ measures: { total: { op: 'sum', field: 'amount' } } }, { bypassTenant: true });
      expect(rows[0]?.total).toBe(300); // both orgs
    });
  });
});
