/**
 * Phase 2B integration tests for aggregate-with-lookups on mongokit.
 *
 * Mirrors `sqlitekit/tests/integration/aggregate-with-lookups-phase-2b.test.ts` —
 * same seed data, same queries, same expected results. Cross-kit
 * portability: a dashboard query that filters on a joined-alias field
 * should produce identical row counts whether the backend is Mongo or
 * SQLite.
 *
 * Mongokit splits the filter into pre-lookup (`$match` BEFORE
 * `$lookup`) and post-lookup (`$match` AFTER `$lookup`) stages so
 * predicates referencing a joined-alias path resolve correctly.
 */

import { and, eq, gt, in_ } from '@classytic/repo-core/filter';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, disconnectDB } from '../setup.js';

interface IDepartment {
  _id?: mongoose.Types.ObjectId;
  id: string;
  name: string;
  code: string;
  active: boolean;
}

interface IEmployee {
  _id?: mongoose.Types.ObjectId;
  id: string;
  name: string;
  email: string;
  departmentId: string;
  active: boolean;
  createdAt: string;
}

async function createTestModelWithCollection<T>(
  name: string,
  schema: mongoose.Schema<T>,
  collection: string,
): Promise<mongoose.Model<T>> {
  if (mongoose.models[name]) {
    delete mongoose.models[name];
  }
  const model = mongoose.model<T>(name, schema, collection);
  await model.init();
  return model;
}

describe('aggregate (portable IR) — Phase 2B (joined-alias filters + plain-record forms)', () => {
  let DeptModel: mongoose.Model<IDepartment>;
  let EmpModel: mongoose.Model<IEmployee>;
  let employees: Repository<IEmployee>;

  beforeAll(async () => {
    await connectDB();
    // Use unique collection names so this suite doesn't share state
    // with `aggregate-with-lookups.test.ts` (which also uses generic
    // 'departments' / 'employees' names). Mongo collections persist
    // across model deletion in the same DB; collisions cause seed
    // data from sibling files to bleed in.
    DeptModel = await createTestModelWithCollection(
      'P2BDept',
      new mongoose.Schema<IDepartment>(
        {
          id: { type: String, required: true, unique: true },
          name: { type: String, required: true },
          code: { type: String, required: true, unique: true },
          active: { type: Boolean, default: true },
        },
        { timestamps: false },
      ),
      'p2b_departments',
    );
    EmpModel = await createTestModelWithCollection(
      'P2BEmp',
      new mongoose.Schema<IEmployee>(
        {
          id: { type: String, required: true, unique: true },
          name: { type: String, required: true },
          email: { type: String, required: true, unique: true },
          departmentId: { type: String, required: true },
          active: { type: Boolean, default: true },
          createdAt: { type: String, required: true },
        },
        { timestamps: false },
      ),
      'p2b_employees',
    );
  });

  afterAll(async () => {
    await EmpModel.deleteMany({});
    await DeptModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await EmpModel.deleteMany({});
    await DeptModel.deleteMany({});
    employees = new Repository<IEmployee>(EmpModel);
    const departments = new Repository<IDepartment>(DeptModel);

    await departments.createMany([
      { id: 'd1', name: 'Engineering', code: 'ENG', active: true },
      { id: 'd2', name: 'Sales', code: 'SAL', active: true },
      { id: 'd3', name: 'Marketing', code: 'MKT', active: true },
      { id: 'd4', name: 'Legacy', code: 'LEG', active: false },
    ]);
    await employees.createMany([
      { id: 'e1', name: 'Alice', email: 'a@x', departmentId: 'd1', active: true, createdAt: '2026-04-01' },
      { id: 'e2', name: 'Bob', email: 'b@x', departmentId: 'd1', active: true, createdAt: '2026-04-02' },
      { id: 'e3', name: 'Carol', email: 'c@x', departmentId: 'd1', active: false, createdAt: '2026-04-03' },
      { id: 'e4', name: 'Dan', email: 'd@x', departmentId: 'd2', active: true, createdAt: '2026-04-04' },
      { id: 'e5', name: 'Eve', email: 'e@x', departmentId: 'd2', active: true, createdAt: '2026-04-05' },
      { id: 'e6', name: 'Frank', email: 'f@x', departmentId: 'd3', active: true, createdAt: '2026-04-06' },
      { id: 'e7', name: 'Grace', email: 'g@x', departmentId: 'd3', active: true, createdAt: '2026-04-07' },
      { id: 'e8', name: 'Hank', email: 'h@x', departmentId: 'd4', active: true, createdAt: '2026-04-08' },
    ]);
  });

  describe('Filter IR on joined-alias paths', () => {
    it('eq(joined-path) — count active-dept employees (post-lookup $match)', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'p2b_departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        filter: eq('department.active', true), // joined-alias path → post-lookup $match
        measures: { count: { op: 'count' } },
      });

      expect(rows[0]?.count).toBe(7); // all except Hank (Legacy/inactive dept)
    });

    it('combined base + joined predicates — split into pre + post $match stages', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'p2b_departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        filter: and(
          eq('active', true), // base column → pre-lookup
          eq('department.active', true), // joined → post-lookup
          gt('createdAt', '2026-04-03'), // base → pre-lookup
        ),
        measures: { count: { op: 'count' } },
      });

      // Eligible: e4, e5 (Sales) + e6, e7 (Marketing) = 4
      expect(rows[0]?.count).toBe(4);
    });

    // Phase 3 cross-kit shape unification: groupBy on a dotted
    // joined-alias path produces NESTED output rows, identical to
    // sqlitekit's emit shape. Mongokit's pipeline assembler uses a
    // safe-key (`__`) inside `$group._id` to satisfy BSON's
    // no-dot-in-field-names rule, then `$project` rebuilds the
    // dotted-path key on the OUTPUT row, which Mongo nests
    // automatically.
    it('groupBy on joined-alias path — emits nested output (cross-kit shape parity)', async () => {
      const { rows } = await employees.aggregate<{
        department: { code: string };
        count: number;
      }>({
        lookups: [
          {
            from: 'p2b_departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        filter: eq('department.active', true),
        groupBy: 'department.code',
        measures: { count: { op: 'count' } },
        sort: { count: -1, 'department.code': 1 },
      });

      expect(rows).toEqual([
        { department: { code: 'ENG' }, count: 3 },
        { department: { code: 'MKT' }, count: 2 },
        { department: { code: 'SAL' }, count: 2 },
      ]);
    });

    it('in_ on joined-alias path narrows to specific dept codes', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'p2b_departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        filter: in_('department.code', ['ENG', 'SAL']),
        measures: { count: { op: 'count' } },
      });

      expect(rows[0]?.count).toBe(5); // ENG(3) + SAL(2)
    });
  });

  describe('Plain-record forms', () => {
    it('plain-record filter — `{ active: true, departmentId: "d1" }`', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        // biome-ignore lint/suspicious/noExplicitAny: testing record-shape input
        filter: { active: true, departmentId: 'd1' } as any,
        measures: { count: { op: 'count' } },
      });

      expect(rows[0]?.count).toBe(2); // e1, e2 (e3 inactive)
    });

    it('plain-record filter on joined-alias path — `{ "department.active": true }`', async () => {
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'p2b_departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        // biome-ignore lint/suspicious/noExplicitAny: testing record-shape input
        filter: { 'department.active': true } as any,
        measures: { count: { op: 'count' } },
      });

      expect(rows[0]?.count).toBe(7);
    });
  });

  describe('Cross-kit shape parity', () => {
    it('returns same row counts as the equivalent sqlitekit query', async () => {
      // This test pins the cross-kit invariant: identical AggRequest →
      // identical row counts. The exact wire shape (row keys/values)
      // is tested in groupBy tests above. Here we just check the
      // dashboard's aggregate count matches across both kits.
      const { rows } = await employees.aggregate<{ count: number }>({
        lookups: [
          {
            from: 'p2b_departments',
            localField: 'departmentId',
            foreignField: 'id',
            as: 'department',
            single: true,
          },
        ],
        filter: and(
          eq('active', true),
          eq('department.active', true),
          gt('createdAt', '2026-04-03'),
        ),
        measures: { count: { op: 'count' } },
      });
      // Same expected count as the sqlitekit equivalent test.
      expect(rows[0]?.count).toBe(4);
    });
  });
});
