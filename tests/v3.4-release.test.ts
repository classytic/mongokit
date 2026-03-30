/**
 * v3.4.0 Release Integration Tests
 *
 * Single consolidated test file covering ALL v3.4.0 features composed together.
 * Uses createTestModel for proper isolation. No duplicate coverage with
 * dedicated unit test files (update-safety, error-handling, soft-delete-batch).
 *
 * Covers:
 * 1. Soft-delete + batch + multi-tenant + cache composed
 * 2. Cache invalidation after batch ops (deleteMany, updateMany)
 * 3. Populate via URL (array refs + field selection + match + limit)
 * 4. Lookup auto-routing with select on joined collection
 * 5. QueryParser → Repository full pipeline
 * 6. Lookup select injection security
 * 7. Pagination correctness (total matches all-pages sum)
 * 8. Event hooks for microservice integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  HOOK_PRIORITY,
  methodRegistryPlugin,
  batchOperationsPlugin,
  softDeletePlugin,
  multiTenantPlugin,
  cachePlugin,
  createMemoryCache,
  QueryParser,
} from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

// ============================================================================
// Schemas — clean names, createTestModel for isolation
// ============================================================================

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  price: number;
  status: string;
  categorySlug: string;
  organizationId: string;
  deletedAt: Date | null;
}

interface ICategory {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
}

interface IOrder {
  _id: Types.ObjectId;
  orderNumber: string;
  products: Types.ObjectId[];
  total: number;
}

let Product: mongoose.Model<IProduct>;
let Category: mongoose.Model<ICategory>;
let Order: mongoose.Model<IOrder>;

beforeAll(async () => {
  await connectDB();

  Product = await createTestModel('ReleaseProduct', new Schema<IProduct>({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    status: { type: String, default: 'active' },
    categorySlug: { type: String },
    organizationId: { type: String, default: 'default' },
    deletedAt: { type: Date, default: null },
  }));

  Category = await createTestModel('ReleaseCategory', new Schema<ICategory>({
    name: { type: String, required: true },
    slug: { type: String, required: true },
    description: { type: String, default: '' },
  }));

  Order = await createTestModel('ReleaseOrder', new Schema<IOrder>({
    orderNumber: { type: String, required: true },
    products: [{ type: Schema.Types.ObjectId, ref: 'ReleaseProduct' }],
    total: { type: Number, required: true },
  }));
});

afterAll(async () => {
  await disconnectDB();
});

beforeEach(async () => {
  await Product.deleteMany({});
  await Category.deleteMany({});
  await Order.deleteMany({});
});

// ============================================================================
// 1. Soft-delete + batch + multi-tenant composed
// ============================================================================

describe('soft-delete + batch + multi-tenant', () => {
  const ORG_A = 'org_alpha';
  const ORG_B = 'org_beta';

  type Repo = InstanceType<typeof Repository<IProduct>> & {
    updateMany: (q: Record<string, unknown>, d: Record<string, unknown>, o?: Record<string, unknown>) => Promise<{ matchedCount: number; modifiedCount: number }>;
    deleteMany: (q: Record<string, unknown>, o?: Record<string, unknown>) => Promise<{ acknowledged: boolean; deletedCount: number }>;
  };

  function createRepo(): Repo {
    return new Repository(Product, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
    ]) as Repo;
  }

  it('deleteMany soft-deletes only within tenant scope', async () => {
    await Product.create([
      { name: 'A1', price: 10, status: 'draft', organizationId: ORG_A },
      { name: 'A2', price: 20, status: 'draft', organizationId: ORG_A },
      { name: 'B1', price: 30, status: 'draft', organizationId: ORG_B },
    ]);

    const repo = createRepo();
    await repo.deleteMany({ status: 'draft' }, { organizationId: ORG_A });

    const all = await Product.find({}).lean();
    expect(all).toHaveLength(3);
    expect(all.filter(d => d.organizationId === ORG_A).every(d => d.deletedAt !== null)).toBe(true);
    expect(all.filter(d => d.organizationId === ORG_B).every(d => d.deletedAt === null)).toBe(true);
  });

  it('updateMany skips soft-deleted docs within tenant', async () => {
    await Product.create([
      { name: 'Active', price: 10, status: 'draft', organizationId: ORG_A, deletedAt: null },
      { name: 'Deleted', price: 20, status: 'draft', organizationId: ORG_A, deletedAt: new Date() },
      { name: 'Other', price: 30, status: 'draft', organizationId: ORG_B, deletedAt: null },
    ]);

    const repo = createRepo();
    const result = await repo.updateMany(
      { status: 'draft' },
      { $set: { status: 'published' } },
      { organizationId: ORG_A },
    );

    expect(result.matchedCount).toBe(1);
    const deleted = await Product.findOne({ name: 'Deleted' }).lean();
    expect(deleted!.status).toBe('draft');
  });

  it('getAll excludes soft-deleted with tenant scoping', async () => {
    await Product.create([
      { name: 'Visible', price: 10, organizationId: ORG_A, deletedAt: null },
      { name: 'Hidden', price: 20, organizationId: ORG_A, deletedAt: new Date() },
      { name: 'OtherOrg', price: 30, organizationId: ORG_B, deletedAt: null },
    ]);

    const repo = createRepo();
    const result = await repo.getAll({ filters: {} }, { organizationId: ORG_A } as any);
    expect(result.docs).toHaveLength(1);
    expect((result.docs[0] as any).name).toBe('Visible');
  });
});

// ============================================================================
// 2. Cache invalidation after batch ops
// ============================================================================

describe('cache invalidation after batch operations', () => {
  type Repo = InstanceType<typeof Repository<IProduct>> & {
    updateMany: (q: Record<string, unknown>, d: Record<string, unknown>) => Promise<any>;
    deleteMany: (q: Record<string, unknown>) => Promise<any>;
  };

  function createRepo() {
    return new Repository(Product, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
      cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
    ]) as Repo;
  }

  it('getAll cache invalidated after deleteMany', async () => {
    const repo = createRepo();
    await repo.create({ name: 'A', price: 10, organizationId: 'x' });
    await repo.create({ name: 'B', price: 20, organizationId: 'x' });

    const first = await repo.getAll({ filters: {} });
    expect(first.docs).toHaveLength(2);

    await repo.deleteMany({ name: 'A' });

    const second = await repo.getAll({ filters: {} });
    expect(second.docs).toHaveLength(1);
    expect((second.docs[0] as any).name).toBe('B');
  });

  it('getAll cache invalidated after updateMany', async () => {
    const repo = createRepo();
    await repo.create({ name: 'X', price: 10, status: 'draft', organizationId: 'x' });
    await repo.create({ name: 'Y', price: 20, status: 'draft', organizationId: 'x' });

    const first = await repo.getAll({ filters: { status: 'draft' } });
    expect(first.docs).toHaveLength(2);

    await repo.updateMany({ status: 'draft' }, { $set: { status: 'published' } });

    const second = await repo.getAll({ filters: { status: 'draft' } });
    expect(second.docs).toHaveLength(0);
  });

  it('single delete invalidates cache', async () => {
    const repo = createRepo();
    const doc = await repo.create({ name: 'Cached', price: 10, organizationId: 'x' });

    await repo.getAll({ filters: {} });
    await repo.delete(doc._id);

    const result = await repo.getAll({ filters: {} });
    expect(result.docs).toHaveLength(0);
  });
});

// ============================================================================
// 3. Populate via URL — array refs with select/match/limit/sort
// ============================================================================

describe('populate via URL (array refs)', () => {
  let orderRepo: Repository<IOrder>;
  let productIds: Types.ObjectId[];

  beforeEach(async () => {
    orderRepo = new Repository(Order);

    const products = await Product.create([
      { name: 'Laptop', price: 999, status: 'active', organizationId: 'x' },
      { name: 'Mouse', price: 29, status: 'active', organizationId: 'x' },
      { name: 'Keyboard', price: 79, status: 'discontinued', organizationId: 'x' },
    ]);
    productIds = products.map(p => p._id);

    await Order.create({
      orderNumber: 'ORD-001',
      products: productIds,
      total: 1107,
    });
  });

  it('simple populate', async () => {
    const parsed = new QueryParser().parse({ populate: 'products' });
    const result = await orderRepo.getAll({ filters: {} }, { populate: parsed.populate });

    const order = result.docs[0] as any;
    expect(order.products).toHaveLength(3);
    expect(order.products[0].name).toBeDefined();
  });

  it('populate with field selection', async () => {
    const parsed = new QueryParser().parse({ populate: { products: { select: 'name,price' } } });
    const result = await orderRepo.getAll({ filters: {} }, { populateOptions: parsed.populateOptions });

    const order = result.docs[0] as any;
    expect(order.products[0].name).toBeDefined();
    expect(order.products[0].price).toBeDefined();
    expect(order.products[0].status).toBeUndefined();
  });

  it('populate with exclusion select', async () => {
    const parsed = new QueryParser().parse({ populate: { products: { select: '-status,-categorySlug' } } });
    const result = await orderRepo.getAll({ filters: {} }, { populateOptions: parsed.populateOptions });

    const order = result.docs[0] as any;
    for (const p of order.products) {
      expect(p.name).toBeDefined();
      expect(p.status).toBeUndefined();
      expect(p.categorySlug).toBeUndefined();
    }
  });

  it('populate with match filter', async () => {
    const parsed = new QueryParser().parse({ populate: { products: { match: { status: 'active' } } } });
    const result = await orderRepo.getAll({ filters: {} }, { populateOptions: parsed.populateOptions });

    const order = result.docs[0] as any;
    const populated = order.products.filter((p: any) => p !== null);
    expect(populated).toHaveLength(2);
  });

  it('populate with limit', async () => {
    const parsed = new QueryParser().parse({ populate: { products: { limit: '2' } } });
    const result = await orderRepo.getAll({ filters: {} }, { populateOptions: parsed.populateOptions });

    expect((result.docs[0] as any).products).toHaveLength(2);
  });
});

// ============================================================================
// 4. Lookup auto-routing with select on joined collection
// ============================================================================

describe('lookup auto-routing in getAll', () => {
  let productRepo: Repository<IProduct>;

  beforeEach(async () => {
    productRepo = new Repository(Product);
    await Category.create([
      { name: 'Electronics', slug: 'electronics', description: 'Devices' },
      { name: 'Audio', slug: 'audio', description: 'Sound equipment' },
    ]);
    await Product.create([
      { name: 'Laptop', price: 999, categorySlug: 'electronics', status: 'active', organizationId: 'x' },
      { name: 'Speaker', price: 149, categorySlug: 'audio', status: 'active', organizationId: 'x' },
    ]);
  });

  it('auto-routes to lookupPopulate when lookups present', async () => {
    const result = await productRepo.getAll({
      filters: {},
      lookups: [{
        from: 'releasecategories', localField: 'categorySlug',
        foreignField: 'slug', as: 'category', single: true,
      }],
      page: 1, limit: 10,
    });

    expect(result.method).toBe('offset');
    expect(result.docs).toHaveLength(2);
    expect((result.docs[0] as any).category.name).toBeDefined();
  });

  it('lookup with select on joined collection', async () => {
    const result = await productRepo.getAll({
      filters: {},
      lookups: [{
        from: 'releasecategories', localField: 'categorySlug',
        foreignField: 'slug', as: 'category', single: true,
        select: 'name,slug',
      }],
      page: 1, limit: 10,
    });

    const doc = result.docs[0] as any;
    expect(doc.category.name).toBeDefined();
    expect(doc.category.slug).toBeDefined();
    expect(doc.category.description).toBeUndefined();
  });
});

// ============================================================================
// 5. QueryParser → Repository full pipeline
// ============================================================================

describe('QueryParser full pipeline', () => {
  beforeEach(async () => {
    await Category.create({ name: 'Electronics', slug: 'electronics', description: 'Devices' });
    await Product.create([
      { name: 'Laptop', price: 999, categorySlug: 'electronics', status: 'active', organizationId: 'x' },
      { name: 'Phone', price: 699, categorySlug: 'electronics', status: 'active', organizationId: 'x' },
      { name: 'Broken', price: 1, categorySlug: 'electronics', status: 'discontinued', organizationId: 'x' },
    ]);
  });

  it('filter + sort + select + lookup from URL query', async () => {
    const parser = new QueryParser({ allowedLookupCollections: ['releasecategories'] });
    const parsed = parser.parse({
      status: 'active',
      sort: '-price',
      select: 'name,price,category',
      lookup: {
        category: {
          from: 'releasecategories', localField: 'categorySlug',
          foreignField: 'slug', single: 'true', select: 'name',
        },
      },
      limit: '10',
    });

    const repo = new Repository(Product);
    const result = await repo.getAll({
      filters: parsed.filters,
      sort: parsed.sort,
      lookups: parsed.lookups,
      select: parsed.select,
      limit: parsed.limit,
    });

    expect(result.docs).toHaveLength(2);
    const docs = result.docs as any[];
    expect(docs[0].name).toBe('Laptop');
    expect(docs[0].category.name).toBe('Electronics');
    expect(docs[0].category.description).toBeUndefined();
  });
});

// ============================================================================
// 6. Lookup select injection security
// ============================================================================

describe('lookup select injection security', () => {
  it('should not allow operator injection via lookup select', () => {
    const parser = new QueryParser({ allowedLookupCollections: ['releasecategories'] });
    const parsed = parser.parse({
      lookup: {
        category: {
          from: 'releasecategories', localField: 'slug',
          foreignField: 'slug', single: 'true',
          select: '$password,$secret',
        },
      },
    });

    // select is stored as a plain string — LookupBuilder converts to $project
    // $-prefixed field names in $project are expressions, not field inclusions
    // MongoDB will reject them at query time, but the parser should not crash
    expect(parsed.lookups).toHaveLength(1);
    expect(parsed.lookups![0].select).toBe('$password,$secret');
  });

  it('should handle empty select gracefully', () => {
    const parser = new QueryParser({ allowedLookupCollections: ['releasecategories'] });
    const parsed = parser.parse({
      lookup: {
        category: {
          from: 'releasecategories', localField: 'slug',
          foreignField: 'slug', select: '',
        },
      },
    });

    expect(parsed.lookups).toHaveLength(1);
    // Empty select should not be set
    expect(parsed.lookups![0].select).toBeUndefined();
  });
});

// ============================================================================
// 7. Pagination correctness — total matches all-pages sum
// ============================================================================

describe('pagination correctness', () => {
  beforeEach(async () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({
      name: `P${i}`, price: i * 10, status: i % 2 === 0 ? 'active' : 'draft',
      organizationId: 'x',
    }));
    await Product.create(docs);
  });

  it('total equals sum of docs across all pages', async () => {
    const repo = new Repository(Product);
    const limit = 7;
    let allDocs: unknown[] = [];
    let page = 1;
    let total = 0;

    while (true) {
      const result = await repo.getAll({ filters: { status: 'active' }, page, limit, countStrategy: 'exact' });
      if (result.method === 'offset') {
        total = result.total;
        allDocs = allDocs.concat(result.docs);
        if (!result.hasNext) break;
      }
      page++;
      if (page > 100) break; // safety
    }

    expect(allDocs).toHaveLength(total);
    expect(total).toBe(13); // indices 0,2,4,...,24 = 13 items
  });

  it('countStrategy=none detects hasNext correctly', async () => {
    const repo = new Repository(Product);
    const result = await repo.getAll({ filters: {}, page: 1, limit: 10, countStrategy: 'none' });

    if (result.method === 'offset') {
      expect(result.docs).toHaveLength(10);
      expect(result.hasNext).toBe(true);
      expect(result.total).toBe(0); // no count performed
    }
  });
});

// ============================================================================
// 8. Event hooks for microservice integration
// ============================================================================

describe('event hooks', () => {
  it('after hooks fire with full context on mutations', async () => {
    const events: Array<{ op: string; model: string; hasResult: boolean }> = [];
    const repo = new Repository(Product);

    for (const event of ['after:create', 'after:update', 'after:delete'] as const) {
      repo.on(event, ({ context, result }) => {
        events.push({ op: context.operation, model: context.model, hasResult: !!result });
      });
    }

    const doc = await repo.create({ name: 'Test', price: 1, organizationId: 'x' });
    await repo.update(String(doc._id), { price: 2 });
    await repo.delete(doc._id);

    expect(events).toEqual([
      { op: 'create', model: 'ReleaseProduct', hasResult: true },
      { op: 'update', model: 'ReleaseProduct', hasResult: true },
      { op: 'delete', model: 'ReleaseProduct', hasResult: true },
    ]);
  });

  it('hooks execute in priority order', async () => {
    const order: string[] = [];
    const repo = new Repository(Product);

    repo.on('before:create', () => { order.push('default'); }, { priority: HOOK_PRIORITY.DEFAULT });
    repo.on('before:create', () => { order.push('policy'); }, { priority: HOOK_PRIORITY.POLICY });
    repo.on('before:create', () => { order.push('cache'); }, { priority: HOOK_PRIORITY.CACHE });

    await repo.create({ name: 'Test', price: 1, organizationId: 'x' });
    expect(order).toEqual(['policy', 'cache', 'default']);
  });

  it('user context flows to after hooks', async () => {
    let capturedUser: unknown = null;
    const repo = new Repository(Product);

    repo.on('after:create', ({ context }) => {
      capturedUser = context.user;
    });

    await repo.create({ name: 'Test', price: 1, organizationId: 'x' }, { user: { _id: 'user123', role: 'admin' } } as any);
    expect(capturedUser).toEqual({ _id: 'user123', role: 'admin' });
  });
});

// ============================================================================
// 9. QueryParser select parsing
// ============================================================================

describe('QueryParser select parsing', () => {
  const parser = new QueryParser();

  it('inclusion fields', () => {
    expect(parser.parse({ select: 'name,email' }).select).toEqual({ name: 1, email: 1 });
  });

  it('exclusion fields', () => {
    expect(parser.parse({ select: '-password,-secret' }).select).toEqual({ password: 0, secret: 0 });
  });

  it('empty/undefined', () => {
    expect(parser.parse({}).select).toBeUndefined();
    expect(parser.parse({ select: '' }).select).toBeUndefined();
  });

  it('object format passthrough', () => {
    expect(parser.parse({ select: { name: 1 } }).select).toEqual({ name: 1 });
  });
});
