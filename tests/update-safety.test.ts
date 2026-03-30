/**
 * Update Safety Tests
 *
 * Verifies that update operations do NOT cause data loss:
 * - repo.update(id, plainObj) must not overwrite the entire document
 * - repo.update(id, { $set: ... }) must work correctly
 * - repo.updateMany(query, plainObj) must not overwrite documents
 * - Mixing plain fields with operators should be rejected
 *
 * Mongoose 9 applies implicit $set for plain objects in findOneAndUpdate
 * and updateMany, so these tests document and lock that behavior.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  methodRegistryPlugin,
  batchOperationsPlugin,
} from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  price: number;
  category: string;
  tags: string[];
  metadata: { color?: string; size?: string };
}

describe('Update Safety — no data loss', () => {
  let Model: mongoose.Model<IProduct>;
  let repo: InstanceType<typeof Repository<IProduct>> & {
    updateMany: (
      query: Record<string, unknown>,
      data: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<{ matchedCount: number; modifiedCount: number }>;
  };

  beforeAll(async () => {
    await connectDB();
    const ProductSchema = new Schema<IProduct>({
      name: { type: String, required: true },
      price: { type: Number, required: true },
      category: { type: String, default: 'general' },
      tags: [{ type: String }],
      metadata: {
        color: { type: String },
        size: { type: String },
      },
    });
    Model = await createTestModel('UpdateSafetyProduct', ProductSchema);
    repo = new Repository(Model, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ]) as typeof repo;
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  // ==========================================================================
  // repo.update (single document)
  // ==========================================================================

  describe('repo.update — single document', () => {
    it('should NOT wipe other fields when updating with a plain object (implicit $set)', async () => {
      const doc = await repo.create({
        name: 'Widget',
        price: 100,
        category: 'tools',
        tags: ['sale'],
        metadata: { color: 'red', size: 'M' },
      });

      // Update only price — plain object without $set
      const updated = await repo.update(String(doc._id), { price: 200 });

      // price should be updated
      expect((updated as Record<string, unknown>).price).toBe(200);

      // ALL other fields must survive
      expect((updated as Record<string, unknown>).name).toBe('Widget');
      expect((updated as Record<string, unknown>).category).toBe('tools');
      expect((updated as Record<string, unknown>).tags).toEqual(['sale']);
    });

    it('should work correctly with explicit $set operator', async () => {
      const doc = await repo.create({
        name: 'Gadget',
        price: 50,
        category: 'electronics',
        tags: ['new'],
        metadata: { color: 'blue' },
      });

      const updated = await repo.update(String(doc._id), {
        $set: { price: 75, category: 'premium' },
      });

      expect((updated as Record<string, unknown>).price).toBe(75);
      expect((updated as Record<string, unknown>).category).toBe('premium');
      // Untouched fields survive
      expect((updated as Record<string, unknown>).name).toBe('Gadget');
      expect((updated as Record<string, unknown>).tags).toEqual(['new']);
    });

    it('should support $inc without wiping other fields', async () => {
      const doc = await repo.create({
        name: 'Counter',
        price: 10,
        category: 'misc',
        tags: [],
        metadata: {},
      });

      const updated = await repo.update(String(doc._id), {
        $inc: { price: 5 },
      });

      expect((updated as Record<string, unknown>).price).toBe(15);
      expect((updated as Record<string, unknown>).name).toBe('Counter');
      expect((updated as Record<string, unknown>).category).toBe('misc');
    });

    it('should support $push without wiping other fields', async () => {
      const doc = await repo.create({
        name: 'Tagged',
        price: 20,
        category: 'misc',
        tags: ['a'],
        metadata: {},
      });

      const updated = await repo.update(String(doc._id), {
        $push: { tags: 'b' },
      });

      expect((updated as Record<string, unknown>).tags).toEqual(['a', 'b']);
      expect((updated as Record<string, unknown>).name).toBe('Tagged');
      expect((updated as Record<string, unknown>).price).toBe(20);
    });

    it('should support combined $set and $inc in a single update', async () => {
      const doc = await repo.create({
        name: 'Combo',
        price: 100,
        category: 'general',
        tags: [],
        metadata: {},
      });

      const updated = await repo.update(String(doc._id), {
        $set: { category: 'premium' },
        $inc: { price: 50 },
      });

      expect((updated as Record<string, unknown>).price).toBe(150);
      expect((updated as Record<string, unknown>).category).toBe('premium');
      expect((updated as Record<string, unknown>).name).toBe('Combo');
    });
  });

  // ==========================================================================
  // repo.updateMany (batch)
  // ==========================================================================

  describe('repo.updateMany — batch', () => {
    it('should NOT wipe other fields when updating with a plain object', async () => {
      await Model.create([
        { name: 'A', price: 10, category: 'tools', tags: ['x'] },
        { name: 'B', price: 20, category: 'tools', tags: ['y'] },
      ]);

      await repo.updateMany(
        { category: 'tools' },
        { price: 99 },
      );

      const docs = await Model.find({ category: 'tools' }).lean();
      expect(docs).toHaveLength(2);
      for (const doc of docs) {
        expect(doc.price).toBe(99);
        // name, category, tags must survive
        expect(doc.name).toBeDefined();
        expect(doc.category).toBe('tools');
        expect(doc.tags.length).toBeGreaterThan(0);
      }
    });

    it('should work correctly with explicit $set operator', async () => {
      await Model.create([
        { name: 'C', price: 30, category: 'electronics', tags: ['z'] },
        { name: 'D', price: 40, category: 'electronics', tags: ['w'] },
      ]);

      const result = await repo.updateMany(
        { category: 'electronics' },
        { $set: { price: 0 } },
      );

      expect(result.matchedCount).toBe(2);
      expect(result.modifiedCount).toBe(2);

      const docs = await Model.find({ category: 'electronics' }).lean();
      for (const doc of docs) {
        expect(doc.price).toBe(0);
        expect(doc.name).toBeDefined();
        expect(doc.tags.length).toBeGreaterThan(0);
      }
    });

    it('should support $inc in updateMany without wiping fields', async () => {
      await Model.create([
        { name: 'E', price: 100, category: 'sale', tags: [] },
        { name: 'F', price: 200, category: 'sale', tags: [] },
      ]);

      await repo.updateMany(
        { category: 'sale' },
        { $inc: { price: -10 } },
      );

      const docs = await Model.find({ category: 'sale' }).sort({ name: 1 }).lean();
      expect(docs[0].price).toBe(90);
      expect(docs[1].price).toBe(190);
      expect(docs[0].name).toBe('E');
      expect(docs[1].name).toBe('F');
    });
  });
});
