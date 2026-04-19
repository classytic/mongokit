/**
 * QueryParser → Repository End-to-End Tests
 *
 * Validates that QueryParser output feeds correctly into all Repository methods
 * and all pagination modes. Covers the full URL → MongoDB → Response pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository, QueryParser } from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';

// ── Schemas ──

interface ICategory {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  priority: number;
}

const CategorySchema = new Schema<ICategory>({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  priority: { type: Number, default: 0 },
});

interface IProduct {
  _id: Types.ObjectId;
  title: string;
  sku: string;
  price: number;
  categorySlug: string;
  category?: Types.ObjectId;
  status: 'active' | 'draft' | 'archived';
  tags: string[];
  stock: number;
  createdAt: Date;
}

const ProductSchema = new Schema<IProduct>({
  title: { type: String, required: true },
  sku: { type: String, required: true, unique: true },
  price: { type: Number, required: true },
  categorySlug: { type: String, required: true },
  category: { type: Schema.Types.ObjectId, ref: 'QpeCat' },
  status: { type: String, enum: ['active', 'draft', 'archived'], default: 'active' },
  tags: [{ type: String }],
  stock: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});
ProductSchema.index({ createdAt: -1, _id: -1 });
ProductSchema.index({ price: -1, _id: -1 });

// ── Test Suite ──

describe('QueryParser → Repository E2E', () => {
  let CatModel: mongoose.Model<ICategory>;
  let ProdModel: mongoose.Model<IProduct>;
  let prodRepo: Repository<IProduct>;
  let parser: QueryParser;
  let catElectronics: ICategory;
  let catClothing: ICategory;
  let catBooks: ICategory;

  beforeAll(async () => {
    await connectDB();
    for (const n of ['QpeCat', 'QpeProd']) {
      if (mongoose.models[n]) delete mongoose.models[n];
    }
    CatModel = mongoose.model<ICategory>('QpeCat', CategorySchema);
    ProdModel = mongoose.model<IProduct>('QpeProd', ProductSchema);
    await CatModel.init();
    await ProdModel.init();

    prodRepo = new Repository(ProdModel);
    parser = new QueryParser({ maxLimit: 100 });
  });

  afterAll(async () => {
    await CatModel.deleteMany({});
    await ProdModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await CatModel.deleteMany({});
    await ProdModel.deleteMany({});

    catElectronics = await CatModel.create({ name: 'Electronics', slug: 'electronics', priority: 10 });
    catClothing = await CatModel.create({ name: 'Clothing', slug: 'clothing', priority: 5 });
    catBooks = await CatModel.create({ name: 'Books', slug: 'books', priority: 8 });

    await ProdModel.create([
      { title: 'Laptop', sku: 'LAP-001', price: 999, categorySlug: 'electronics', category: catElectronics._id, status: 'active', tags: ['tech', 'portable'], stock: 50 },
      { title: 'Phone', sku: 'PHN-001', price: 699, categorySlug: 'electronics', category: catElectronics._id, status: 'active', tags: ['tech', 'mobile'], stock: 200 },
      { title: 'Tablet', sku: 'TAB-001', price: 499, categorySlug: 'electronics', category: catElectronics._id, status: 'draft', tags: ['tech'], stock: 0 },
      { title: 'T-Shirt', sku: 'TSH-001', price: 29, categorySlug: 'clothing', category: catClothing._id, status: 'active', tags: ['casual'], stock: 500 },
      { title: 'Jacket', sku: 'JKT-001', price: 149, categorySlug: 'clothing', category: catClothing._id, status: 'active', tags: ['outerwear'], stock: 75 },
      { title: 'Novel', sku: 'NOV-001', price: 15, categorySlug: 'books', category: catBooks._id, status: 'active', tags: ['fiction'], stock: 300 },
      { title: 'Textbook', sku: 'TXT-001', price: 89, categorySlug: 'books', category: catBooks._id, status: 'archived', tags: ['education'], stock: 20 },
      { title: 'Headphones', sku: 'HPH-001', price: 199, categorySlug: 'electronics', category: catElectronics._id, status: 'active', tags: ['tech', 'audio'], stock: 120 },
    ]);
  });

  // ═══════════════════════════════════════════════════════════════
  // getAll — offset pagination with QueryParser
  // ═══════════════════════════════════════════════════════════════

  describe('getAll + offset pagination', () => {
    it('basic: page + limit + sort', async () => {
      const parsed = parser.parse({ page: '1', limit: '3', sort: '-price' });
      const result = await prodRepo.getAll({
        sort: parsed.sort,
        page: parsed.page,
        limit: parsed.limit,
      });

      expect(result.method).toBe('offset');
      if (result.method === 'offset') {
        expect(result.total).toBe(8);
        expect(result.docs).toHaveLength(3);
        expect(result.pages).toBe(3);
        expect((result.docs[0] as any).price).toBe(999); // highest
      }
    });

    it('filters + select + sort + page', async () => {
      const parsed = parser.parse({
        status: 'active',
        select: 'title,price',
        sort: 'price',
        page: '1',
        limit: '3',
      });

      const result = await prodRepo.getAll({
        filters: parsed.filters,
        select: parsed.select as any,
        sort: parsed.sort,
        page: parsed.page,
        limit: parsed.limit,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6); // 6 active
        expect(result.docs).toHaveLength(3);
        const doc = result.docs[0] as any;
        expect(doc.title).toBeDefined();
        expect(doc.price).toBeDefined();
        expect(doc.sku).toBeUndefined(); // excluded by select
      }
    });

    it('filters + lookup + page across pages', async () => {
      const parsed = parser.parse({
        status: 'active',
        sort: '-price',
        page: '1',
        limit: '2',
        lookup: {
          cat: {
            from: 'qpecats',
            localField: 'categorySlug',
            foreignField: 'slug',
            single: 'true',
            select: 'name',
          },
        },
      });

      const p1 = await prodRepo.getAll({
        filters: parsed.filters,
        sort: parsed.sort,
        page: 1,
        limit: parsed.limit,
        lookups: parsed.lookups,
      });

      const p2 = await prodRepo.getAll({
        filters: parsed.filters,
        sort: parsed.sort,
        page: 2,
        limit: parsed.limit,
        lookups: parsed.lookups,
      });

      if (p1.method === 'offset' && p2.method === 'offset') {
        expect(p1.total).toBe(6);
        expect(p2.total).toBe(6);
        expect(p1.docs).toHaveLength(2);
        expect(p2.docs).toHaveLength(2);

        // No overlap
        const ids1 = new Set(p1.docs.map((d: any) => d._id.toString()));
        for (const d of p2.docs) {
          expect(ids1.has((d as any)._id.toString())).toBe(false);
        }

        // Lookup data present on both pages
        expect((p1.docs[0] as any).cat.name).toBeDefined();
        expect((p2.docs[0] as any).cat.name).toBeDefined();
      }
    });

    it('select + lookup + select on lookup', async () => {
      const parsed = parser.parse({
        select: 'title,price',
        lookup: {
          cat: {
            from: 'qpecats',
            localField: 'categorySlug',
            foreignField: 'slug',
            single: 'true',
            select: 'name',
          },
        },
      });

      const result = await prodRepo.getAll({
        select: parsed.select as any,
        lookups: parsed.lookups,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(8);
        for (const doc of result.docs) {
          const d = doc as any;
          expect(d.title).toBeDefined();
          expect(d.price).toBeDefined();
          expect(d.cat).toBeDefined();
          expect(d.cat.name).toBeDefined();
          expect(d.cat.priority).toBeUndefined(); // excluded by lookup select
          expect(d.sku).toBeUndefined(); // excluded by root select
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getAll — keyset pagination with QueryParser
  // ═══════════════════════════════════════════════════════════════

  describe('getAll + keyset pagination', () => {
    it('keyset with sort triggers cursor mode', async () => {
      const parsed = parser.parse({ sort: '-price', limit: '3' });
      const result = await prodRepo.getAll({
        sort: parsed.sort,
        limit: parsed.limit,
      });

      expect(result.method).toBe('keyset');
      if (result.method === 'keyset') {
        expect(result.docs).toHaveLength(3);
        expect(result.hasMore).toBe(true);
        expect(result.next).toBeTruthy();
      }
    });

    it('keyset forward pagination with cursor', async () => {
      const p1 = await prodRepo.getAll({
        sort: { price: -1, _id: -1 },
        limit: 3,
      });

      expect(p1.method).toBe('keyset');
      if (p1.method === 'keyset' && p1.next) {
        const p2 = await prodRepo.getAll({
          sort: { price: -1, _id: -1 },
          after: p1.next,
          limit: 3,
        });

        if (p2.method === 'keyset') {
          expect(p2.docs).toHaveLength(3); // 8 - 3 = 5 remaining, limit 3
          // Prices should be lower than page 1's last
          const lastP1Price = (p1.docs[p1.docs.length - 1] as any).price;
          for (const d of p2.docs) {
            expect((d as any).price).toBeLessThanOrEqual(lastP1Price);
          }
        }
      }
    });

    it('keyset with filters', async () => {
      const parsed = parser.parse({
        status: 'active',
        sort: '-price',
        limit: '2',
      });

      const p1 = await prodRepo.getAll({
        filters: parsed.filters,
        sort: parsed.sort,
        limit: parsed.limit,
      });

      if (p1.method === 'keyset') {
        expect(p1.docs).toHaveLength(2);
        expect(p1.hasMore).toBe(true);

        if (p1.next) {
          const p2 = await prodRepo.getAll({
            filters: parsed.filters,
            sort: parsed.sort,
            after: p1.next,
            limit: parsed.limit,
          });

          if (p2.method === 'keyset') {
            // All should be active
            for (const d of p2.docs) {
              expect((d as any).status).toBe('active');
            }
          }
        }
      }
    });

    it('keyset with plain ObjectId cursor', async () => {
      const p1 = await prodRepo.getAll({ sort: { _id: 1 }, limit: 3 });

      if (p1.method === 'keyset') {
        const rawId = (p1.docs[2] as any)._id.toString();

        const p2 = await prodRepo.getAll({
          sort: { _id: 1 },
          after: rawId,
          limit: 3,
        });

        if (p2.method === 'keyset') {
          expect(p2.docs.length).toBeGreaterThan(0);
          for (const d of p2.docs) {
            expect((d as any)._id.toString() > rawId).toBe(true);
          }
        }
      }
    });

    it('keyset exhausts all results without duplicates', async () => {
      const allIds = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;

      while (pages < 10) { // safety limit
        const result = await prodRepo.getAll({
          sort: { price: -1, _id: -1 },
          ...(cursor ? { after: cursor } : {}),
          limit: 3,
        });

        if (result.method === 'keyset') {
          for (const d of result.docs) {
            const id = (d as any)._id.toString();
            expect(allIds.has(id)).toBe(false);
            allIds.add(id);
          }

          if (!result.hasMore) break;
          cursor = result.next;
        }
        pages++;
      }

      expect(allIds.size).toBe(8);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getById with QueryParser populate
  // ═══════════════════════════════════════════════════════════════

  describe('getById with parsed populate', () => {
    it('getById with simple populate', async () => {
      const products = await ProdModel.find({ sku: 'LAP-001' });
      const laptop = products[0];

      const result = await prodRepo.getById(laptop._id.toString(), {
        populate: 'category',
      });

      expect(result).not.toBeNull();
      expect((result as any).category.name).toBe('Electronics');
    });

    it('getById with populateOptions (advanced)', async () => {
      const products = await ProdModel.find({ sku: 'LAP-001' });
      const laptop = products[0];

      const result = await prodRepo.getById(laptop._id.toString(), {
        populateOptions: [{ path: 'category', select: 'name slug' }],
      });

      expect(result).not.toBeNull();
      const cat = (result as any).category;
      expect(cat.name).toBe('Electronics');
      expect(cat.slug).toBe('electronics');
      expect(cat.priority).toBeUndefined();
    });

    it('getById with select', async () => {
      const products = await ProdModel.find({ sku: 'PHN-001' });
      const phone = products[0];

      const result = await prodRepo.getById(phone._id.toString(), {
        select: 'title price',
      });

      expect(result).not.toBeNull();
      expect((result as any).title).toBe('Phone');
      expect((result as any).price).toBe(699);
      expect((result as any).sku).toBeUndefined();
    });

    it('getById with select + populate', async () => {
      const products = await ProdModel.find({ sku: 'LAP-001' });
      const laptop = products[0];

      const result = await prodRepo.getById(laptop._id.toString(), {
        select: 'title category',
        populate: 'category',
      });

      expect(result).not.toBeNull();
      expect((result as any).title).toBe('Laptop');
      expect((result as any).category.name).toBe('Electronics');
      expect((result as any).price).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getByQuery with QueryParser output
  // ═══════════════════════════════════════════════════════════════

  describe('getByQuery with parsed params', () => {
    it('getByQuery with filters', async () => {
      const parsed = parser.parse({ sku: 'LAP-001' });
      const result = await prodRepo.getByQuery(parsed.filters);

      expect(result).not.toBeNull();
      expect((result as any).title).toBe('Laptop');
    });

    it('getByQuery with populate', async () => {
      const result = await prodRepo.getByQuery(
        { sku: 'LAP-001' },
        { populate: 'category' },
      );

      expect(result).not.toBeNull();
      expect((result as any).category.name).toBe('Electronics');
    });

    it('getByQuery with populateOptions + select', async () => {
      const result = await prodRepo.getByQuery(
        { sku: 'JKT-001' },
        {
          populateOptions: [{ path: 'category', select: 'name' }],
          select: 'title category',
        },
      );

      expect(result).not.toBeNull();
      expect((result as any).title).toBe('Jacket');
      expect((result as any).category.name).toBe('Clothing');
      expect((result as any).price).toBeUndefined();
    });

    it('getByQuery returns null for no match (MinimalRepo contract)', async () => {
      const result = await prodRepo.getByQuery({ sku: 'NONEXISTENT' });
      expect(result).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Full pipeline: URL string → parse → getAll → response
  // ═══════════════════════════════════════════════════════════════

  describe('Full URL pipeline simulation', () => {
    it('GET /products?status=active&sort=-price&page=1&limit=3&select=title,price', async () => {
      const parsed = parser.parse({
        status: 'active',
        sort: '-price',
        page: '1',
        limit: '3',
        select: 'title,price',
      });

      const result = await prodRepo.getAll({
        filters: parsed.filters,
        sort: parsed.sort,
        page: parsed.page,
        limit: parsed.limit,
        select: parsed.select as any,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        expect(result.docs).toHaveLength(3);
        const doc = result.docs[0] as any;
        expect(doc.title).toBe('Laptop');
        expect(doc.price).toBe(999);
        expect(doc.sku).toBeUndefined();
      }
    });

    it('GET /products?select=title&lookup[cat]=...&lookup[cat][select]=name', async () => {
      const parsed = parser.parse({
        select: 'title',
        lookup: {
          cat: {
            from: 'qpecats',
            localField: 'categorySlug',
            foreignField: 'slug',
            single: 'true',
            select: 'name',
          },
        },
      });

      const result = await prodRepo.getAll({
        select: parsed.select as any,
        lookups: parsed.lookups,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(8);
        for (const doc of result.docs) {
          const d = doc as any;
          expect(d.title).toBeDefined();
          expect(d.cat).toBeDefined();
          expect(d.cat.name).toBeDefined();
          expect(d.cat.priority).toBeUndefined();
          expect(d.price).toBeUndefined();
        }
      }
    });

    it('GET /products?sort=-price&limit=3 (keyset auto-detect)', async () => {
      const parsed = parser.parse({ sort: '-price', limit: '3' });

      const result = await prodRepo.getAll({
        sort: parsed.sort,
        limit: parsed.limit,
      });

      expect(result.method).toBe('keyset');
      if (result.method === 'keyset') {
        expect(result.docs).toHaveLength(3);
        expect(result.hasMore).toBe(true);
      }
    });

    it('GET /products?populate=category&page=1&limit=5', async () => {
      const parsed = parser.parse({
        populate: 'category',
        page: '1',
        limit: '5',
      });

      const result = await prodRepo.getAll({
        page: parsed.page,
        limit: parsed.limit,
        populate: parsed.populateOptions as any,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(8);
        expect(result.docs).toHaveLength(5);
        const doc = result.docs[0] as any;
        expect(doc.category).toBeDefined();
        expect(doc.category.name).toBeDefined();
      }
    });

    it('GET /products?populate[category][select]=name&status=active', async () => {
      const parsed = parser.parse({
        status: 'active',
        populate: { category: { select: 'name' } },
      });

      const result = await prodRepo.getAll({
        filters: parsed.filters,
        populate: parsed.populateOptions as any,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(6);
        for (const doc of result.docs) {
          const d = doc as any;
          expect(d.category.name).toBeDefined();
          expect(d.category.priority).toBeUndefined();
        }
      }
    });

    it('complex: filter + sort + select + lookup + page', async () => {
      const parsed = parser.parse({
        status: 'active',
        'price[gte]': '100',
        sort: '-price',
        select: 'title,price,sku',
        page: '1',
        limit: '2',
        lookup: {
          cat: {
            from: 'qpecats',
            localField: 'categorySlug',
            foreignField: 'slug',
            single: 'true',
            select: 'name,priority',
          },
        },
      });

      const result = await prodRepo.getAll({
        filters: parsed.filters,
        sort: parsed.sort,
        select: parsed.select as any,
        page: parsed.page,
        limit: parsed.limit,
        lookups: parsed.lookups,
      });

      if (result.method === 'offset') {
        // active + price >= 100: Laptop(999), Phone(699), Headphones(199), Jacket(149)
        expect(result.total).toBe(4);
        expect(result.docs).toHaveLength(2);

        const doc = result.docs[0] as any;
        expect(doc.title).toBe('Laptop');
        expect(doc.price).toBe(999);
        expect(doc.sku).toBe('LAP-001');
        expect(doc.cat.name).toBe('Electronics');
        expect(doc.cat.priority).toBe(10);
        expect(doc.stock).toBeUndefined(); // excluded by select
        expect(doc.tags).toBeUndefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('empty filters returns all docs', async () => {
      const parsed = parser.parse({});
      const result = await prodRepo.getAll({
        filters: parsed.filters,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(8);
      }
    });

    it('non-matching filter returns empty with correct total=0', async () => {
      const parsed = parser.parse({ status: 'discontinued' });
      const result = await prodRepo.getAll({ filters: parsed.filters });

      if (result.method === 'offset') {
        expect(result.total).toBe(0);
        expect(result.docs).toHaveLength(0);
      }
    });

    it('limit exceeding total returns all docs', async () => {
      const result = await prodRepo.getAll({ page: 1, limit: 100 });

      if (result.method === 'offset') {
        expect(result.total).toBe(8);
        expect(result.docs).toHaveLength(8);
        expect(result.pages).toBe(1);
      }
    });

    it('page beyond total returns empty docs but correct total', async () => {
      const result = await prodRepo.getAll({ page: 99, limit: 5 });

      if (result.method === 'offset') {
        expect(result.total).toBe(8);
        expect(result.docs).toHaveLength(0);
      }
    });

    it('keyset with no more results returns hasMore=false', async () => {
      const result = await prodRepo.getAll({
        sort: { _id: 1 },
        limit: 100,
      });

      if (result.method === 'keyset') {
        expect(result.hasMore).toBe(false);
        expect(result.next).toBeNull();
      }
    });

    it('QueryParser maxLimit is respected', async () => {
      const strictParser = new QueryParser({ maxLimit: 5 });
      const parsed = strictParser.parse({ limit: '999' });
      expect(parsed.limit).toBe(5);
    });
  });
});
