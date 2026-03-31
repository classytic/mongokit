/**
 * Lookup + Select + Populate Integration Tests
 *
 * Comprehensive regression tests for bugs #1-#5 and edge cases.
 * Tests all combinations: select, populate, lookup, lookup[select], project,
 * pagination, filters, sort — the full URL→MongoDB pipeline.
 *
 * 43 test files, this file covers the critical composite scenarios
 * that individual unit tests miss.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository, QueryParser } from '../src/index.js';
import { LookupBuilder } from '../src/query/LookupBuilder.js';
import { connectDB, disconnectDB } from './setup.js';

// ── Schemas ──

interface IDepartment {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  budget: number;
  region: string;
}

const DepartmentSchema = new Schema<IDepartment>({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  budget: { type: Number, default: 0 },
  region: { type: String, default: 'US' },
});

interface IManager {
  _id: Types.ObjectId;
  name: string;
  code: string;
  level: number;
}

const ManagerSchema = new Schema<IManager>({
  name: { type: String, required: true },
  code: { type: String, required: true, unique: true },
  level: { type: Number, default: 1 },
});

interface IEmployee {
  _id: Types.ObjectId;
  name: string;
  email: string;
  salary: number;
  departmentSlug: string;
  managerCode: string;
  department?: Types.ObjectId;
  role: string;
  status: string;
  createdAt: Date;
}

const EmployeeSchema = new Schema<IEmployee>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  salary: { type: Number, required: true },
  departmentSlug: { type: String, required: true },
  managerCode: { type: String, default: '' },
  department: { type: Schema.Types.ObjectId, ref: 'LsiDept' },
  role: { type: String, default: 'engineer' },
  status: { type: String, default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

// ── Test Suite ──

describe('Lookup + Select + Populate — Full Integration', () => {
  let DeptModel: mongoose.Model<IDepartment>;
  let MgrModel: mongoose.Model<IManager>;
  let EmpModel: mongoose.Model<IEmployee>;
  let empRepo: Repository<IEmployee>;
  let deptEng: IDepartment;
  let deptSales: IDepartment;
  let deptHr: IDepartment;
  let mgrAlpha: IManager;
  let mgrBeta: IManager;

  beforeAll(async () => {
    await connectDB();

    for (const name of ['LsiDept', 'LsiMgr', 'LsiEmp']) {
      if (mongoose.models[name]) delete mongoose.models[name];
    }

    DeptModel = mongoose.model<IDepartment>('LsiDept', DepartmentSchema);
    MgrModel = mongoose.model<IManager>('LsiMgr', ManagerSchema);
    EmpModel = mongoose.model<IEmployee>('LsiEmp', EmployeeSchema);

    await DeptModel.init();
    await MgrModel.init();
    await EmpModel.init();
    empRepo = new Repository(EmpModel);
  });

  afterAll(async () => {
    await DeptModel.deleteMany({});
    await MgrModel.deleteMany({});
    await EmpModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await DeptModel.deleteMany({});
    await MgrModel.deleteMany({});
    await EmpModel.deleteMany({});

    deptEng = await DeptModel.create({ name: 'Engineering', slug: 'eng', budget: 500000, region: 'US' });
    deptSales = await DeptModel.create({ name: 'Sales', slug: 'sales', budget: 200000, region: 'EU' });
    deptHr = await DeptModel.create({ name: 'HR', slug: 'hr', budget: 100000, region: 'US' });

    mgrAlpha = await MgrModel.create({ name: 'Manager Alpha', code: 'MGR-A', level: 3 });
    mgrBeta = await MgrModel.create({ name: 'Manager Beta', code: 'MGR-B', level: 2 });

    await EmpModel.create([
      { name: 'Alice', email: 'alice@co.com', salary: 120000, departmentSlug: 'eng', managerCode: 'MGR-A', department: deptEng._id, role: 'lead', status: 'active' },
      { name: 'Bob', email: 'bob@co.com', salary: 95000, departmentSlug: 'eng', managerCode: 'MGR-A', department: deptEng._id, role: 'engineer', status: 'active' },
      { name: 'Carol', email: 'carol@co.com', salary: 110000, departmentSlug: 'sales', managerCode: 'MGR-B', department: deptSales._id, role: 'manager', status: 'active' },
      { name: 'Dave', email: 'dave@co.com', salary: 85000, departmentSlug: 'sales', managerCode: 'MGR-B', department: deptSales._id, role: 'rep', status: 'inactive' },
      { name: 'Eve', email: 'eve@co.com', salary: 75000, departmentSlug: 'hr', managerCode: 'MGR-A', department: deptHr._id, role: 'coordinator', status: 'active' },
      { name: 'Frank', email: 'frank@co.com', salary: 130000, departmentSlug: 'eng', managerCode: 'MGR-A', department: deptEng._id, role: 'architect', status: 'active' },
    ]);
  });

  // helper
  const deptLookup = (opts: Partial<import('../src/query/LookupBuilder.js').LookupOptions> = {}) => ({
    from: 'lsidepts',
    localField: 'departmentSlug',
    foreignField: 'slug',
    as: 'dept',
    single: true,
    ...opts,
  });

  const mgrLookup = (opts: Partial<import('../src/query/LookupBuilder.js').LookupOptions> = {}) => ({
    from: 'lsimgrs',
    localField: 'managerCode',
    foreignField: 'code',
    as: 'manager',
    single: true,
    ...opts,
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug #1: Simple populate format consistency
  // ═══════════════════════════════════════════════════════════════

  describe('Bug #1: populate format consistency', () => {
    it('simple ?populate=department returns populateOptions array', () => {
      const parser = new QueryParser();
      const result = parser.parse({ populate: 'department' });

      expect(result.populateOptions).toEqual([{ path: 'department' }]);
      expect(result.populate).toBe('department');
    });

    it('simple multi-populate normalizes each path', () => {
      const parser = new QueryParser();
      const result = parser.parse({ populate: 'department,manager' });

      expect(result.populateOptions).toEqual([
        { path: 'department' },
        { path: 'manager' },
      ]);
    });

    it('advanced populate still works as before', () => {
      const parser = new QueryParser();
      const result = parser.parse({
        populate: { department: { select: 'name,slug' } },
      });

      expect(result.populateOptions).toEqual([
        { path: 'department', select: 'name slug' },
      ]);
      expect(result.populate).toBeUndefined();
    });

    it('empty populate string returns empty', () => {
      const parser = new QueryParser();
      const result = parser.parse({ populate: '' });
      expect(result.populateOptions).toBeUndefined();
      expect(result.populate).toBeUndefined();
    });

    it('whitespace-only populate items are filtered', () => {
      const parser = new QueryParser();
      const result = parser.parse({ populate: 'author, , category' });
      expect(result.populateOptions).toEqual([
        { path: 'author' },
        { path: 'category' },
      ]);
    });

    it('populate with actual ref works via repository', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        populate: 'department',
      });
      expect(result.docs).toHaveLength(1);
      const alice = result.docs[0] as any;
      expect(alice.department).toBeDefined();
      expect(alice.department.name).toBe('Engineering');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug #2: single lookup with no match returns null
  // ═══════════════════════════════════════════════════════════════

  describe('Bug #2: single lookup no-match → null', () => {
    it('returns null (not undefined) when lookup has no match', async () => {
      await EmpModel.create({
        name: 'Ghost', email: 'ghost@co.com', salary: 50000,
        departmentSlug: 'nonexistent', role: 'ghost', status: 'active',
      });

      const result = await empRepo.getAll({
        filters: { name: 'Ghost' },
        lookups: [deptLookup()],
      });

      expect(result.docs).toHaveLength(1);
      const ghost = result.docs[0] as any;
      expect(ghost).toHaveProperty('dept');
      expect(ghost.dept).toBeNull();
    });

    it('returns the document when lookup matches', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [deptLookup()],
      });

      expect(result.docs).toHaveLength(1);
      const alice = result.docs[0] as any;
      expect(alice.dept).toBeDefined();
      expect(alice.dept.name).toBe('Engineering');
    });

    it('null for no-match alongside valid matches in same page', async () => {
      await EmpModel.create({
        name: 'Orphan', email: 'orphan@co.com', salary: 40000,
        departmentSlug: 'deleted-dept', role: 'orphan', status: 'active',
      });

      const result = await empRepo.getAll({
        lookups: [deptLookup()],
        sort: { name: 1 },
      });

      const docs = result.docs as any[];
      const orphan = docs.find((d) => d.name === 'Orphan');
      const alice = docs.find((d) => d.name === 'Alice');

      expect(orphan.dept).toBeNull();
      expect(alice.dept).not.toBeNull();
      expect(alice.dept.name).toBe('Engineering');
    });

    it('array lookup returns empty array (not null) for no-match', async () => {
      await EmpModel.create({
        name: 'Loner', email: 'loner@co.com', salary: 40000,
        departmentSlug: 'nowhere', role: 'loner', status: 'active',
      });

      const result = await empRepo.getAll({
        filters: { name: 'Loner' },
        lookups: [deptLookup({ single: false, as: 'depts' })],
      });

      const loner = result.docs[0] as any;
      expect(Array.isArray(loner.depts)).toBe(true);
      expect(loner.depts).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug #3: Root select + lookup preserves lookup alias
  // ═══════════════════════════════════════════════════════════════

  describe('Bug #3: select does not strip lookup fields', () => {
    it('inclusion select preserves lookup as field', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        select: 'name,salary',
        lookups: [deptLookup()],
      });

      const alice = result.docs[0] as any;
      expect(alice.name).toBe('Alice');
      expect(alice.salary).toBe(120000);
      expect(alice.dept).toBeDefined();
      expect(alice.dept.name).toBe('Engineering');
      expect(alice.email).toBeUndefined();
    });

    it('exclusion select does not strip lookup', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Bob' },
        select: '-email,-role',
        lookups: [deptLookup()],
      });

      const bob = result.docs[0] as any;
      expect(bob.name).toBe('Bob');
      expect(bob.email).toBeUndefined();
      expect(bob.role).toBeUndefined();
      expect(bob.dept).toBeDefined();
    });

    it('select with multiple lookups includes all aliases', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        select: 'name',
        lookups: [deptLookup(), mgrLookup()],
      });

      const alice = result.docs[0] as any;
      expect(alice.name).toBe('Alice');
      expect(alice.dept).toBeDefined();
      expect(alice.dept.name).toBe('Engineering');
      expect(alice.manager).toBeDefined();
      expect(alice.manager.name).toBe('Manager Alpha');
      expect(alice.email).toBeUndefined();
    });

    it('select already includes lookup alias explicitly — no duplication', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Carol' },
        select: 'name,dept',
        lookups: [deptLookup()],
      });

      const carol = result.docs[0] as any;
      expect(carol.name).toBe('Carol');
      expect(carol.dept).toBeDefined();
      expect(carol.dept.name).toBe('Sales');
    });

    it('select as array works with lookups', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Eve' },
        select: ['name', 'salary'] as any,
        lookups: [deptLookup()],
      });

      const eve = result.docs[0] as any;
      expect(eve.name).toBe('Eve');
      expect(eve.salary).toBe(75000);
      expect(eve.dept).toBeDefined();
    });

    it('select as object works with lookups', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Frank' },
        select: { name: 1, role: 1 } as any,
        lookups: [deptLookup()],
      });

      const frank = result.docs[0] as any;
      expect(frank.name).toBe('Frank');
      expect(frank.role).toBe('architect');
      expect(frank.dept).toBeDefined();
      expect(frank.email).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug #4: Keyset cursor accepts plain ObjectId
  // ═══════════════════════════════════════════════════════════════

  describe('Bug #4: keyset cursor accepts plain ObjectId', () => {
    it('accepts a raw 24-char hex ObjectId as after cursor', async () => {
      const first = await empRepo.getAll({ sort: { _id: 1 }, limit: 2 });
      expect(first.docs).toHaveLength(2);

      const lastId = (first.docs[1] as any)._id.toString();
      expect(lastId).toMatch(/^[a-f0-9]{24}$/i);

      const second = await empRepo.getAll({
        sort: { _id: 1 },
        after: lastId,
        limit: 2,
      });

      expect(second.docs.length).toBeGreaterThan(0);
      for (const doc of second.docs) {
        expect((doc as any)._id.toString() > lastId).toBe(true);
      }
    });

    it('still works with proper base64 cursor tokens', async () => {
      const first = await empRepo.getAll({
        sort: { createdAt: -1, _id: -1 },
        limit: 2,
      });

      expect(first.method).toBe('keyset');
      if (first.method === 'keyset' && first.next) {
        const second = await empRepo.getAll({
          sort: { createdAt: -1, _id: -1 },
          after: first.next,
          limit: 2,
        });
        expect(second.docs.length).toBeGreaterThan(0);
      }
    });

    it('ObjectId cursor with descending sort paginates correctly', async () => {
      const all = await empRepo.getAll({ sort: { _id: -1 }, limit: 100 });
      const allIds = all.docs.map((d: any) => d._id.toString());

      const first = await empRepo.getAll({ sort: { _id: -1 }, limit: 3 });
      const lastId = (first.docs[2] as any)._id.toString();

      const second = await empRepo.getAll({
        sort: { _id: -1 },
        after: lastId,
        limit: 3,
      });

      // second page docs should come after page 1 docs in desc order
      for (const doc of second.docs) {
        expect((doc as any)._id.toString() < lastId).toBe(true);
      }
    });

    it('ObjectId cursor with filters still works', async () => {
      const first = await empRepo.getAll({
        filters: { status: 'active' },
        sort: { _id: 1 },
        limit: 2,
      });

      const lastId = (first.docs[1] as any)._id.toString();

      const second = await empRepo.getAll({
        filters: { status: 'active' },
        sort: { _id: 1 },
        after: lastId,
        limit: 10,
      });

      // All returned docs should be active
      for (const doc of second.docs) {
        expect((doc as any).status).toBe('active');
      }
    });

    it('rejects invalid cursor string gracefully', async () => {
      await expect(
        empRepo.getAll({ sort: { _id: 1 }, after: 'not-a-valid-cursor!!!' }),
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bug #5: Lookup does not inflate total count
  // ═══════════════════════════════════════════════════════════════

  describe('Bug #5: lookup does not inflate total count', () => {
    it('total = source doc count with single lookup', async () => {
      const result = await empRepo.getAll({ lookups: [deptLookup()] });
      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(6);
      }
    });

    it('total correct with lookup[select]', async () => {
      const result = await empRepo.getAll({
        lookups: [deptLookup({ select: 'name' })],
      });
      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(6);
        const doc = result.docs[0] as any;
        expect(doc.dept.name).toBeDefined();
        expect(doc.dept.budget).toBeUndefined();
      }
    });

    it('total correct with filters + lookup', async () => {
      const result = await empRepo.getAll({
        filters: { role: 'engineer' },
        lookups: [deptLookup()],
      });
      if (result.method === 'offset') {
        expect(result.total).toBe(1); // Only Bob
        expect(result.docs).toHaveLength(1);
      }
    });

    it('total correct with array lookup (no single)', async () => {
      const result = await empRepo.getAll({
        lookups: [deptLookup({ single: false, as: 'depts' })],
      });
      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        const doc = result.docs[0] as any;
        expect(Array.isArray(doc.depts)).toBe(true);
      }
    });

    it('total correct across multiple pages', async () => {
      const p1 = await empRepo.getAll({
        lookups: [deptLookup()],
        sort: { _id: 1 },
        page: 1, limit: 3,
      });
      const p2 = await empRepo.getAll({
        lookups: [deptLookup()],
        sort: { _id: 1 },
        page: 2, limit: 3,
      });

      if (p1.method === 'offset' && p2.method === 'offset') {
        expect(p1.total).toBe(6);
        expect(p2.total).toBe(6);
        expect(p1.docs).toHaveLength(3);
        expect(p2.docs).toHaveLength(3);

        // No duplicates across pages
        const ids1 = p1.docs.map((d: any) => d._id.toString());
        const ids2 = p2.docs.map((d: any) => d._id.toString());
        const overlap = ids1.filter((id: string) => ids2.includes(id));
        expect(overlap).toHaveLength(0);
      }
    });

    it('total correct with multiple lookups', async () => {
      const result = await empRepo.getAll({
        lookups: [deptLookup(), mgrLookup()],
      });
      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(6);
      }
    });

    it('total correct with lookup + select + sort + filters combined', async () => {
      const result = await empRepo.getAll({
        filters: { status: 'active' },
        select: 'name,salary',
        sort: { salary: -1 },
        lookups: [deptLookup({ select: 'name' })],
      });
      if (result.method === 'offset') {
        // 5 active employees
        expect(result.total).toBe(5);
        expect(result.docs).toHaveLength(5);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // LookupBuilder.multiple() — select cartesian join fix
  // ═══════════════════════════════════════════════════════════════

  describe('LookupBuilder.multiple() with select', () => {
    it('generates correct join condition when select is used', () => {
      const stages = LookupBuilder.multiple([{
        from: 'departments',
        localField: 'deptSlug',
        foreignField: 'slug',
        as: 'dept',
        select: 'name',
      }]);

      // Should have $lookup with let + pipeline (not cartesian)
      const lookupStage = stages[0] as any;
      expect(lookupStage.$lookup).toBeDefined();
      expect(lookupStage.$lookup.let).toBeDefined();
      expect(lookupStage.$lookup.let.lookupJoinVal).toBe('$deptSlug');
      expect(lookupStage.$lookup.pipeline).toBeDefined();
      // First stage should be $match with $expr for join
      expect(lookupStage.$lookup.pipeline[0].$match.$expr).toBeDefined();
      // Last stage should be $project
      const lastStage = lookupStage.$lookup.pipeline[lookupStage.$lookup.pipeline.length - 1];
      expect(lastStage.$project).toEqual({ name: 1 });
    });

    it('select + single generates correct join + unwind', () => {
      const stages = LookupBuilder.multiple([{
        from: 'departments',
        localField: 'deptSlug',
        foreignField: 'slug',
        as: 'dept',
        single: true,
        select: 'name,budget',
      }]);

      expect(stages).toHaveLength(2); // $lookup + $unwind
      expect((stages[1] as any).$unwind.path).toBe('$dept');
    });

    it('select with exclusion fields works', () => {
      const stages = LookupBuilder.multiple([{
        from: 'departments',
        localField: 'deptSlug',
        foreignField: 'slug',
        as: 'dept',
        select: '-budget,-region',
      }]);

      const lookupStage = stages[0] as any;
      const projectStage = lookupStage.$lookup.pipeline[lookupStage.$lookup.pipeline.length - 1];
      expect(projectStage.$project).toEqual({ budget: 0, region: 0 });
    });

    it('without select uses simple form (no pipeline)', () => {
      const stages = LookupBuilder.multiple([{
        from: 'departments',
        localField: 'deptSlug',
        foreignField: 'slug',
        as: 'dept',
      }]);

      const lookupStage = stages[0] as any;
      expect(lookupStage.$lookup.localField).toBe('deptSlug');
      expect(lookupStage.$lookup.foreignField).toBe('slug');
      expect(lookupStage.$lookup.pipeline).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Combined: all params together
  // ═══════════════════════════════════════════════════════════════

  describe('Combined: select + lookup + sort + pagination', () => {
    it('select + lookup + sort + page=1 works end-to-end', async () => {
      const result = await empRepo.getAll({
        select: 'name,salary',
        sort: { salary: -1 },
        page: 1, limit: 2,
        lookups: [deptLookup({ select: 'name' })],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(2);

        const first = result.docs[0] as any;
        expect(first.name).toBe('Frank'); // 130k
        expect(first.salary).toBe(130000);
        expect(first.dept).toBeDefined();
        expect(first.dept.name).toBe('Engineering');
        expect(first.dept.budget).toBeUndefined();
        expect(first.email).toBeUndefined();
      }
    });

    it('page 2 returns next set with correct sort order', async () => {
      const result = await empRepo.getAll({
        select: 'name,salary',
        sort: { salary: -1 },
        page: 2, limit: 2,
        lookups: [deptLookup()],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(2);
        // Page 2 sorted by salary desc: Carol (110k), Bob (95k)
        expect((result.docs[0] as any).name).toBe('Carol');
        expect((result.docs[1] as any).name).toBe('Bob');
      }
    });

    it('page 3 (last page) returns remainder', async () => {
      const result = await empRepo.getAll({
        sort: { salary: -1 },
        page: 3, limit: 2,
        lookups: [deptLookup()],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(2);
        // Page 3: Dave (85k), Eve (75k)
        expect((result.docs[0] as any).name).toBe('Dave');
        expect((result.docs[1] as any).name).toBe('Eve');
      }
    });

    it('beyond last page returns empty docs', async () => {
      const result = await empRepo.getAll({
        sort: { salary: -1 },
        page: 10, limit: 2,
        lookups: [deptLookup()],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(0);
      }
    });

    it('filters + select + lookup all work together', async () => {
      const result = await empRepo.getAll({
        filters: { departmentSlug: 'eng' },
        select: 'name,role',
        lookups: [deptLookup({ select: 'name,slug' })],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(3); // Alice, Bob, Frank
        for (const doc of result.docs) {
          const d = doc as any;
          expect(d.name).toBeDefined();
          expect(d.role).toBeDefined();
          expect(d.dept.name).toBe('Engineering');
          expect(d.dept.slug).toBe('eng');
          expect(d.dept.budget).toBeUndefined();
          expect(d.email).toBeUndefined();
          expect(d.salary).toBeUndefined();
        }
      }
    });

    it('multiple lookups + select + filters + sort', async () => {
      const result = await empRepo.getAll({
        filters: { status: 'active' },
        select: 'name',
        sort: { name: 1 },
        lookups: [
          deptLookup({ select: 'name' }),
          mgrLookup({ select: 'name,level' }),
        ],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(5);
        const docs = result.docs as any[];
        // Sorted by name asc
        expect(docs[0].name).toBe('Alice');
        expect(docs[0].dept.name).toBe('Engineering');
        expect(docs[0].manager.name).toBe('Manager Alpha');
        expect(docs[0].manager.level).toBe(3);
        expect(docs[0].email).toBeUndefined();
      }
    });

    it('lookup without select returns all foreign fields', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [deptLookup()],
      });

      const alice = result.docs[0] as any;
      expect(alice.dept.name).toBe('Engineering');
      expect(alice.dept.slug).toBe('eng');
      expect(alice.dept.budget).toBe(500000);
      expect(alice.dept.region).toBe('US');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // QueryParser end-to-end
  // ═══════════════════════════════════════════════════════════════

  describe('QueryParser → Repository end-to-end', () => {
    it('parses full URL params and produces correct results', async () => {
      const parser = new QueryParser();
      const parsed = parser.parse({
        role: 'engineer',
        select: 'name,salary',
        sort: '-salary',
        page: '1',
        limit: '10',
        lookup: {
          dept: {
            from: 'lsidepts',
            localField: 'departmentSlug',
            foreignField: 'slug',
            single: 'true',
            select: 'name',
          },
        },
      });

      expect(parsed.filters).toEqual({ role: 'engineer' });
      expect(parsed.lookups).toHaveLength(1);

      const result = await empRepo.getAll({
        filters: parsed.filters,
        select: parsed.select as any,
        sort: parsed.sort,
        page: parsed.page,
        limit: parsed.limit,
        lookups: parsed.lookups,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(1);
        const bob = result.docs[0] as any;
        expect(bob.name).toBe('Bob');
        expect(bob.salary).toBe(95000);
        expect(bob.dept.name).toBe('Engineering');
        expect(bob.email).toBeUndefined();
      }
    });

    it('parses multiple lookups from URL', async () => {
      const parser = new QueryParser();
      const parsed = parser.parse({
        status: 'active',
        select: 'name',
        lookup: {
          dept: {
            from: 'lsidepts',
            localField: 'departmentSlug',
            foreignField: 'slug',
            single: 'true',
          },
          mgr: {
            from: 'lsimgrs',
            localField: 'managerCode',
            foreignField: 'code',
            single: 'true',
            select: 'name',
          },
        },
      });

      expect(parsed.lookups).toHaveLength(2);

      const result = await empRepo.getAll({
        filters: parsed.filters,
        select: parsed.select as any,
        lookups: parsed.lookups,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(5);
        const doc = result.docs[0] as any;
        expect(doc.dept).toBeDefined();
        expect(doc.mgr).toBeDefined();
        expect(doc.mgr.name).toBeDefined();
        expect(doc.mgr.level).toBeUndefined(); // excluded by lookup select
      }
    });

    it('handles no results gracefully', async () => {
      const parser = new QueryParser();
      const parsed = parser.parse({
        role: 'ceo',
        lookup: {
          dept: {
            from: 'lsidepts',
            localField: 'departmentSlug',
            foreignField: 'slug',
            single: 'true',
          },
        },
      });

      const result = await empRepo.getAll({
        filters: parsed.filters,
        lookups: parsed.lookups,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(0);
        expect(result.docs).toHaveLength(0);
      }
    });

    it('select field from QueryParser parse result works', async () => {
      const parser = new QueryParser();
      const parsed = parser.parse({
        select: 'name,email',
        sort: 'name',
      });

      expect(parsed.select).toBeDefined();

      const result = await empRepo.getAll({
        select: parsed.select as any,
        sort: parsed.sort,
        page: 1, limit: 3,
      });

      if (result.method === 'offset') {
        const doc = result.docs[0] as any;
        expect(doc.name).toBeDefined();
        expect(doc.email).toBeDefined();
        expect(doc.salary).toBeUndefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Edge cases: empty collections, missing data, large datasets
  // ═══════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('lookup against empty foreign collection returns null/[]', async () => {
      await DeptModel.deleteMany({});

      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [deptLookup()],
      });

      const alice = result.docs[0] as any;
      expect(alice.dept).toBeNull(); // single=true → null
    });

    it('lookup from empty source collection returns empty', async () => {
      await EmpModel.deleteMany({});

      const result = await empRepo.getAll({
        lookups: [deptLookup()],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(0);
        expect(result.docs).toHaveLength(0);
      }
    });

    it('select fields that do not exist returns docs without them', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        select: 'name,nonExistentField',
        lookups: [deptLookup()],
      });

      const alice = result.docs[0] as any;
      expect(alice.name).toBe('Alice');
      expect(alice.dept).toBeDefined();
      // nonExistentField won't appear but shouldn't cause an error
    });

    it('lookup with limit=1 returns only 1 doc', async () => {
      const result = await empRepo.getAll({
        lookups: [deptLookup()],
        page: 1, limit: 1,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(1);
        expect((result.docs[0] as any).dept).toBeDefined();
      }
    });

    it('lookup with sort on local field works correctly', async () => {
      const result = await empRepo.getAll({
        sort: { salary: 1 },
        lookups: [deptLookup()],
        page: 1, limit: 2,
      });

      if (result.method === 'offset') {
        // Lowest salaries: Eve (75k), Dave (85k)
        expect((result.docs[0] as any).name).toBe('Eve');
        expect((result.docs[0] as any).dept.name).toBe('HR');
        expect((result.docs[1] as any).name).toBe('Dave');
        expect((result.docs[1] as any).dept.name).toBe('Sales');
      }
    });

    it('multiple employees share same department — no inflation', async () => {
      // eng has 3 employees: Alice, Bob, Frank
      const result = await empRepo.getAll({
        filters: { departmentSlug: 'eng' },
        lookups: [deptLookup()],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(3);
        expect(result.docs).toHaveLength(3);
        // All should have same dept
        for (const doc of result.docs) {
          expect((doc as any).dept.name).toBe('Engineering');
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Populate + Lookup in same query (ref-based + field-based join)
  // ═══════════════════════════════════════════════════════════════

  describe('Populate and Lookup coexistence', () => {
    it('populate via ref works without lookups', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        populate: 'department',
      });

      const alice = result.docs[0] as any;
      expect(alice.department).toBeDefined();
      expect(alice.department.name).toBe('Engineering');
    });

    it('lookup works independently of populate', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [deptLookup()],
      });

      const alice = result.docs[0] as any;
      // lookup result
      expect(alice.dept).toBeDefined();
      expect(alice.dept.name).toBe('Engineering');
      // original ref field is just ObjectId (not populated)
      expect(alice.department).toBeDefined();
      expect(typeof alice.department === 'object' && alice.department.name).toBeFalsy();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Lookup select variations
  // ═══════════════════════════════════════════════════════════════

  describe('Lookup select variations', () => {
    it('lookup select as string includes only specified fields', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [deptLookup({ select: 'name' })],
      });

      const dept = (result.docs[0] as any).dept;
      expect(dept.name).toBe('Engineering');
      expect(dept.slug).toBeUndefined();
      expect(dept.budget).toBeUndefined();
    });

    it('lookup select multiple fields', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [deptLookup({ select: 'name,region' })],
      });

      const dept = (result.docs[0] as any).dept;
      expect(dept.name).toBe('Engineering');
      expect(dept.region).toBe('US');
      expect(dept.budget).toBeUndefined();
      expect(dept.slug).toBeUndefined();
    });

    it('lookup select as object', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [deptLookup({ select: { name: 1, budget: 1 } })],
      });

      const dept = (result.docs[0] as any).dept;
      expect(dept.name).toBe('Engineering');
      expect(dept.budget).toBe(500000);
      expect(dept.slug).toBeUndefined();
    });

    it('two lookups with different selects', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [
          deptLookup({ select: 'name' }),
          mgrLookup({ select: 'name' }),
        ],
      });

      const alice = result.docs[0] as any;
      expect(alice.dept.name).toBe('Engineering');
      expect(alice.dept.budget).toBeUndefined();
      expect(alice.manager.name).toBe('Manager Alpha');
      expect(alice.manager.level).toBeUndefined();
    });

    it('one lookup with select, one without', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [
          deptLookup({ select: 'name' }),
          mgrLookup(), // no select — returns all fields
        ],
      });

      const alice = result.docs[0] as any;
      expect(alice.dept.name).toBe('Engineering');
      expect(alice.dept.budget).toBeUndefined();
      expect(alice.manager.name).toBe('Manager Alpha');
      expect(alice.manager.level).toBe(3); // all fields present
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Pagination data integrity with lookups
  // ═══════════════════════════════════════════════════════════════

  describe('Pagination integrity with lookups', () => {
    it('all docs appear exactly once across all pages', async () => {
      const allIds = new Set<string>();

      for (let page = 1; page <= 3; page++) {
        const result = await empRepo.getAll({
          lookups: [deptLookup()],
          sort: { _id: 1 },
          page,
          limit: 2,
        });

        if (result.method === 'offset') {
          for (const doc of result.docs) {
            const id = (doc as any)._id.toString();
            expect(allIds.has(id)).toBe(false); // no duplicate
            allIds.add(id);
          }
        }
      }

      expect(allIds.size).toBe(6);
    });

    it('pagination metadata is consistent', async () => {
      const result = await empRepo.getAll({
        lookups: [deptLookup()],
        page: 1, limit: 4,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.page).toBe(1);
        expect(result.limit).toBe(4);
        expect(result.pages).toBe(2);
        expect(result.hasNext).toBe(true);
        expect(result.hasPrev).toBe(false);
      }
    });

    it('last page metadata is correct', async () => {
      const result = await empRepo.getAll({
        lookups: [deptLookup()],
        page: 2, limit: 4,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.page).toBe(2);
        expect(result.hasNext).toBe(false);
        expect(result.hasPrev).toBe(true);
        expect(result.docs).toHaveLength(2);
      }
    });

    it('filtered pagination with lookup has correct total', async () => {
      const result = await empRepo.getAll({
        filters: { departmentSlug: 'eng' },
        lookups: [deptLookup()],
        page: 1, limit: 2,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(3); // Alice, Bob, Frank
        expect(result.docs).toHaveLength(2);
        expect(result.pages).toBe(2);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Sort correctness with lookups
  // ═══════════════════════════════════════════════════════════════

  describe('Sort correctness with lookups', () => {
    it('ascending sort order preserved', async () => {
      const result = await empRepo.getAll({
        sort: { salary: 1 },
        lookups: [deptLookup()],
      });

      const salaries = result.docs.map((d: any) => d.salary);
      for (let i = 1; i < salaries.length; i++) {
        expect(salaries[i]).toBeGreaterThanOrEqual(salaries[i - 1]);
      }
    });

    it('descending sort order preserved', async () => {
      const result = await empRepo.getAll({
        sort: { salary: -1 },
        lookups: [deptLookup()],
      });

      const salaries = result.docs.map((d: any) => d.salary);
      for (let i = 1; i < salaries.length; i++) {
        expect(salaries[i]).toBeLessThanOrEqual(salaries[i - 1]);
      }
    });

    it('sort by string field with lookup', async () => {
      const result = await empRepo.getAll({
        sort: { name: 1 },
        lookups: [deptLookup()],
      });

      const names = result.docs.map((d: any) => d.name);
      expect(names).toEqual([...names].sort());
    });

    it('sort preserved across paginated pages', async () => {
      const p1 = await empRepo.getAll({
        sort: { salary: -1 },
        lookups: [deptLookup()],
        page: 1, limit: 3,
      });
      const p2 = await empRepo.getAll({
        sort: { salary: -1 },
        lookups: [deptLookup()],
        page: 2, limit: 3,
      });

      if (p1.method === 'offset' && p2.method === 'offset') {
        const lastP1 = (p1.docs[p1.docs.length - 1] as any).salary;
        const firstP2 = (p2.docs[0] as any).salary;
        expect(lastP1).toBeGreaterThanOrEqual(firstP2);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Error handling
  // ═══════════════════════════════════════════════════════════════

  describe('Error handling', () => {
    it('lookup with invalid collection name does not crash', async () => {
      // MongoDB just returns empty results for nonexistent collections
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [{
          from: 'nonexistent_collection_xyz',
          localField: 'departmentSlug',
          foreignField: 'slug',
          as: 'something',
          single: true,
        }],
      });

      expect(result.docs).toHaveLength(1);
      const alice = result.docs[0] as any;
      expect(alice.something).toBeNull();
    });

    it('lookup with mismatched field types returns no match', async () => {
      // departmentSlug is string, _id is ObjectId — mismatch
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [{
          from: 'lsidepts',
          localField: 'departmentSlug',
          foreignField: '_id',
          as: 'dept',
          single: true,
        }],
      });

      const alice = result.docs[0] as any;
      expect(alice.dept).toBeNull();
    });

    it('empty lookups array is handled gracefully', async () => {
      const result = await empRepo.getAll({
        filters: { name: 'Alice' },
        lookups: [],
      });

      // Should fallback to normal pagination, not lookup path
      expect(result.docs).toHaveLength(1);
    });
  });
});
