/**
 * Large Dataset E2E — Pagination, deleteMany, updateMany at scale
 *
 * Uses deterministic seed data (no external faker dependency) to test:
 * - Keyset + offset traversal on 500+ docs
 * - deleteMany / updateMany correctness
 * - Lookup joins at scale
 * - Cleanup after test (no data leak)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose, { Schema, type Types } from 'mongoose';
import { Repository } from '../src/index.js';
import {
  methodRegistryPlugin,
  batchOperationsPlugin,
} from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';

// ── Lean schemas ──

interface IItem {
  _id: Types.ObjectId;
  name: string;
  price: number;
  category: string;
  status: 'active' | 'draft' | 'archived';
  batch: number;
}

const ItemSchema = new Schema<IItem>({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, required: true },
  status: { type: String, enum: ['active', 'draft', 'archived'], default: 'active' },
  batch: { type: Number, required: true },
});
ItemSchema.index({ price: -1, _id: -1 });
ItemSchema.index({ category: 1, price: -1, _id: -1 });
ItemSchema.index({ status: 1, _id: 1 });

interface ILabel {
  _id: Types.ObjectId;
  name: string;
  slug: string;
}

const LabelSchema = new Schema<ILabel>({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
});

// ── Deterministic seed (no faker) ──

const CATEGORIES = ['electronics', 'clothing', 'books', 'sports', 'home'];
const STATUSES: IItem['status'][] = ['active', 'active', 'active', 'draft', 'archived'];
const TOTAL = 500;

function generateItems(count: number): Omit<IItem, '_id'>[] {
  const items: Omit<IItem, '_id'>[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      name: `item-${String(i).padStart(4, '0')}`,
      price: 10 + (i * 7) % 990,   // 10–999, deterministic spread
      category: CATEGORIES[i % CATEGORIES.length],
      status: STATUSES[i % STATUSES.length],
      batch: Math.floor(i / 100),   // 0–4
    });
  }
  return items;
}

// ── Test suite ──

describe('Large dataset E2E', () => {
  let ItemModel: mongoose.Model<IItem>;
  let LabelModel: mongoose.Model<ILabel>;
  let repo: Repository<IItem>;
  let batchRepo: Repository<IItem>;

  beforeAll(async () => {
    await connectDB();

    for (const n of ['LdItem', 'LdLabel']) {
      if (mongoose.models[n]) delete mongoose.models[n];
    }

    ItemModel = mongoose.model<IItem>('LdItem', ItemSchema);
    LabelModel = mongoose.model<ILabel>('LdLabel', LabelSchema);
    await ItemModel.init();
    await LabelModel.init();

    repo = new Repository(ItemModel);
    batchRepo = new Repository(ItemModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ]);

    // Seed once
    await ItemModel.deleteMany({});
    await LabelModel.deleteMany({});

    const items = generateItems(TOTAL);
    // insertMany in chunks of 100 for speed
    for (let i = 0; i < items.length; i += 100) {
      await ItemModel.insertMany(items.slice(i, i + 100));
    }

    await LabelModel.create(
      CATEGORIES.map((c) => ({ name: c.charAt(0).toUpperCase() + c.slice(1), slug: c })),
    );
  });

  afterAll(async () => {
    // Cleanup — no data leak to other tests
    await ItemModel.deleteMany({});
    await LabelModel.deleteMany({});
    await disconnectDB();
  });

  describe('seed sanity', () => {
    it('has correct total', async () => {
      expect(await ItemModel.countDocuments()).toBe(TOTAL);
    });

    it('has expected category distribution', async () => {
      for (const cat of CATEGORIES) {
        const count = await ItemModel.countDocuments({ category: cat });
        expect(count).toBe(TOTAL / CATEGORIES.length); // 100 each
      }
    });

    it('has expected status distribution', async () => {
      const active = await ItemModel.countDocuments({ status: 'active' });
      const draft = await ItemModel.countDocuments({ status: 'draft' });
      const archived = await ItemModel.countDocuments({ status: 'archived' });
      // pattern: active, active, active, draft, archived (60/20/20)
      expect(active).toBe(300);
      expect(draft).toBe(100);
      expect(archived).toBe(100);
    });
  });

  describe('offset pagination at scale', () => {
    it('traverses all 500 docs page-by-page without duplicates', async () => {
      const seenIds = new Set<string>();
      const pageSize = 50;
      const expectedPages = Math.ceil(TOTAL / pageSize);

      for (let page = 1; page <= expectedPages; page++) {
        const result = await repo.getAll({
          sort: { _id: 1 },
          page,
          limit: pageSize,
        });

        if (result.method === 'offset') {
          expect(result.total).toBe(TOTAL);
          for (const doc of result.docs) {
            const id = (doc as any)._id.toString();
            expect(seenIds.has(id)).toBe(false);
            seenIds.add(id);
          }
        }
      }

      expect(seenIds.size).toBe(TOTAL);
    });

    it('filtered pagination returns correct total', async () => {
      const result = await repo.getAll({
        filters: { category: 'electronics' },
        sort: { price: -1 },
        page: 1,
        limit: 20,
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(100);
        expect(result.docs).toHaveLength(20);
      }
    });
  });

  describe('keyset pagination at scale', () => {
    it('traverses all 500 docs via cursor without duplicates', async () => {
      const seenIds = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;

      while (pages < 100) {
        const result = await repo.getAll({
          sort: { price: -1, _id: -1 },
          ...(cursor ? { after: cursor } : {}),
          limit: 50,
        });

        if (result.method === 'keyset') {
          for (const doc of result.docs) {
            const id = (doc as any)._id.toString();
            expect(seenIds.has(id)).toBe(false);
            seenIds.add(id);
          }
          if (!result.hasMore) break;
          cursor = result.next;
        }
        pages++;
      }

      expect(seenIds.size).toBe(TOTAL);
    });

    it('filtered keyset returns only matching docs', async () => {
      const seenIds = new Set<string>();
      let cursor: string | null = null;

      for (let i = 0; i < 20; i++) {
        const result = await repo.getAll({
          filters: { status: 'active' },
          sort: { _id: 1 },
          ...(cursor ? { after: cursor } : {}),
          limit: 50,
        });

        if (result.method === 'keyset') {
          for (const doc of result.docs) {
            expect((doc as any).status).toBe('active');
            seenIds.add((doc as any)._id.toString());
          }
          if (!result.hasMore) break;
          cursor = result.next;
        }
      }

      expect(seenIds.size).toBe(300); // 60% active
    });
  });

  describe('keyset + lookup at scale', () => {
    it('joins labels on every doc across pages', async () => {
      const seenIds = new Set<string>();
      let cursor: string | null = null;

      for (let i = 0; i < 20; i++) {
        const result = await repo.getAll({
          sort: { _id: 1 },
          ...(cursor ? { after: cursor } : {}),
          limit: 50,
          lookups: [{
            from: 'ldlabels',
            localField: 'category',
            foreignField: 'slug',
            as: 'label',
            single: true,
          }],
        });

        if (result.method === 'keyset') {
          for (const doc of result.docs) {
            const d = doc as any;
            seenIds.add(d._id.toString());
            expect(d.label).toBeDefined();
            expect(d.label.name).toBeDefined();
          }
          if (!result.hasMore) break;
          cursor = result.next;
        }
      }

      expect(seenIds.size).toBe(TOTAL);
    });
  });

  describe('select + lookup + pagination combined', () => {
    it('select=name,price with lookup at scale', async () => {
      const result = await repo.getAll({
        select: 'name,price',
        sort: { price: -1 },
        page: 1,
        limit: 10,
        lookups: [{
          from: 'ldlabels',
          localField: 'category',
          foreignField: 'slug',
          as: 'label',
          single: true,
          select: 'name',
        }],
      });

      if (result.method === 'offset') {
        expect(result.total).toBe(TOTAL);
        for (const doc of result.docs) {
          const d = doc as any;
          expect(d.name).toBeDefined();
          expect(d.price).toBeDefined();
          expect(d.label).toBeDefined();
          expect(d.label.name).toBeDefined();
          expect(d.label.slug).toBeUndefined(); // excluded by lookup select
          expect(d.status).toBeUndefined();       // excluded by root select
        }
      }
    });
  });

  describe('batch operations at scale', () => {
    it('updateMany updates correct count', async () => {
      const result = await (batchRepo as any).updateMany(
        { batch: 0, status: 'active' },
        { $set: { status: 'draft' } },
      );

      // batch=0 has 100 items, 60% active = 60
      expect(result.modifiedCount).toBe(60);

      // Verify
      const drafts = await ItemModel.countDocuments({ batch: 0, status: 'draft' });
      expect(drafts).toBeGreaterThanOrEqual(60);

      // Restore for other tests
      await ItemModel.updateMany(
        { batch: 0, status: 'draft' },
        { $set: { status: 'active' } },
      );
    });

    it('deleteMany removes correct count', async () => {
      // Delete archived items in batch 4
      const archivedCount = await ItemModel.countDocuments({ batch: 4, status: 'archived' });
      const beforeTotal = await ItemModel.countDocuments();

      await (batchRepo as any).deleteMany({ batch: 4, status: 'archived' });

      const afterTotal = await ItemModel.countDocuments();
      expect(afterTotal).toBe(beforeTotal - archivedCount);

      // Re-seed deleted items for cleanup integrity
      const items = generateItems(TOTAL).filter(
        (item) => item.batch === 4 && item.status === 'archived',
      );
      if (items.length > 0) {
        await ItemModel.insertMany(items);
      }
    });
  });

  describe('cleanup verification', () => {
    it('data is cleaned up in afterAll', async () => {
      // This runs before afterAll — just verify count is still correct
      const count = await ItemModel.countDocuments();
      expect(count).toBe(TOTAL);
    });
  });
});
