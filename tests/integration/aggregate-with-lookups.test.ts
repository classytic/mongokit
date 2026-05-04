/**
 * Integration tests for aggregate-with-lookups on mongokit.
 *
 * Mirrors sqlitekit/tests/integration/aggregate-with-lookups.test.ts —
 * same `AggRequest` shape, same expected row results. Cross-kit
 * portability is the point: a dashboard query written against one kit
 * runs unchanged against the other.
 */

import { eq, gte } from '@classytic/repo-core/filter';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, disconnectDB } from '../setup.js';

/**
 * Local helper that pins the collection name. Mongokit's
 * `aggregate()` resolves `LookupSpec.from` against the active
 * connection's collection registry, so tests need predictable
 * collection names (`'departments'` / `'employees'`) — not the
 * mongoose-pluralized derived names.
 */
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

function makeDepartmentSchema() {
  return new mongoose.Schema<IDepartment>(
    {
      id: { type: String, required: true, unique: true },
      name: { type: String, required: true },
      code: { type: String, required: true, unique: true },
      active: { type: Boolean, default: true },
    },
    { timestamps: false },
  );
}

function makeEmployeeSchema() {
  return new mongoose.Schema<IEmployee>(
    {
      id: { type: String, required: true, unique: true },
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      departmentId: { type: String, required: true },
      active: { type: Boolean, default: true },
      createdAt: { type: String, required: true },
    },
    { timestamps: false },
  );
}

describe('aggregate (portable IR) — with lookups', () => {
  let DeptModel: mongoose.Model<IDepartment>;
  let EmpModel: mongoose.Model<IEmployee>;
  let employees: Repository<IEmployee>;

  beforeAll(async () => {
    await connectDB();
    DeptModel = await createTestModelWithCollection(
      'LookupAggDept',
      makeDepartmentSchema(),
      'departments',
    );
    EmpModel = await createTestModelWithCollection(
      'LookupAggEmp',
      makeEmployeeSchema(),
      'employees',
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
      { id: 'd3', name: 'Legacy', code: 'LEG', active: false },
    ]);
    await employees.createMany([
      { id: 'e1', name: 'Alice', email: 'a@x', departmentId: 'd1', active: true, createdAt: '2026-01-01' },
      { id: 'e2', name: 'Bob', email: 'b@x', departmentId: 'd1', active: true, createdAt: '2026-01-02' },
      { id: 'e3', name: 'Carol', email: 'c@x', departmentId: 'd1', active: true, createdAt: '2026-01-03' },
      { id: 'e4', name: 'Dan', email: 'd@x', departmentId: 'd2', active: true, createdAt: '2026-01-04' },
      { id: 'e5', name: 'Eve', email: 'e@x', departmentId: 'd2', active: true, createdAt: '2026-01-05' },
      { id: 'e6', name: 'Frank', email: 'f@x', departmentId: 'd3', active: true, createdAt: '2026-01-06' },
    ]);
  });

  it('lookup contributes joined fields — count grouped by base column with lookup attached', async () => {
    // The join attaches `department` to each row. Even without
    // referencing it in groupBy/measures, the lookup runs and
    // doesn't break the aggregate pipeline. Regression guard for
    // "lookup + base groupBy" composing safely.
    const { rows } = await employees.aggregate<Record<string, unknown>>({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
          where: eq('active', true),
        },
      ],
      groupBy: 'active',
      measures: { count: { op: 'count' } },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(6); // all employees, base-grouped
  });

  it('having + sort on measure alias still works with lookups', async () => {
    const { rows } = await employees.aggregate<Record<string, unknown>>({
      lookups: [
        {
          from: 'departments',
          localField: 'departmentId',
          foreignField: 'id',
          as: 'department',
          single: true,
        },
      ],
      groupBy: 'departmentId',
      measures: { staffSize: { op: 'count' } },
      having: gte('staffSize', 2), // exclude Legacy (1 employee)
      sort: { staffSize: -1 },
    });

    expect(rows).toEqual([
      { departmentId: 'd1', staffSize: 3 },
      { departmentId: 'd2', staffSize: 2 },
    ]);
  });

  it('aggregate without lookups still works (regression guard)', async () => {
    const { rows } = await employees.aggregate<Record<string, unknown>>({
      groupBy: 'departmentId',
      measures: { count: { op: 'count' } },
      sort: { departmentId: 1 },
    });

    expect(rows).toEqual([
      { departmentId: 'd1', count: 3 },
      { departmentId: 'd2', count: 2 },
      { departmentId: 'd3', count: 1 },
    ]);
  });
});
