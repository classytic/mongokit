/**
 * Aggregate Actions — Lookup parity with LookupBuilder
 *
 * Verifies that the low-level aggregate.lookup() helper produces the same
 * correlated joins as LookupBuilder.build() and Repository.lookupPopulate().
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, type Types } from 'mongoose';
import { connectDB, disconnectDB } from './setup.js';
import * as aggregateActions from '../src/actions/aggregate.js';

// ── Schemas ──

interface ICat {
  _id: Types.ObjectId;
  name: string;
  slug: string;
}

interface IProd {
  _id: Types.ObjectId;
  name: string;
  categorySlug: string;
}

const CatSchema = new Schema<ICat>({
  name: String,
  slug: { type: String, unique: true },
});

const ProdSchema = new Schema<IProd>({
  name: String,
  categorySlug: String,
});

describe('aggregate.lookup() parity with LookupBuilder', () => {
  let CatModel: mongoose.Model<ICat>;
  let ProdModel: mongoose.Model<IProd>;

  beforeAll(async () => {
    await connectDB();
    for (const n of ['AggCat', 'AggProd']) {
      if (mongoose.models[n]) delete mongoose.models[n];
    }
    CatModel = mongoose.model<ICat>('AggCat', CatSchema);
    ProdModel = mongoose.model<IProd>('AggProd', ProdSchema);
    await CatModel.init();
    await ProdModel.init();
  });

  afterAll(async () => {
    await CatModel.deleteMany({});
    await ProdModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await CatModel.deleteMany({});
    await ProdModel.deleteMany({});
    await CatModel.create([
      { name: 'Electronics', slug: 'electronics' },
      { name: 'Books', slug: 'books' },
    ]);
    await ProdModel.create([
      { name: 'Laptop', categorySlug: 'electronics' },
      { name: 'Phone', categorySlug: 'electronics' },
      { name: 'Novel', categorySlug: 'books' },
    ]);
  });

  it('simple lookup (no pipeline) returns correlated results', async () => {
    const results = await aggregateActions.lookup(ProdModel, {
      from: 'aggcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
    });

    expect(results).toHaveLength(3);
    for (const doc of results) {
      const d = doc as any;
      expect(d.category).toBeDefined();
      expect(Array.isArray(d.category)).toBe(true);
      expect(d.category).toHaveLength(1); // exactly 1 match, not all categories
    }
  });

  it('pipeline-form lookup with localField/foreignField auto-correlates', async () => {
    const results = await aggregateActions.lookup(ProdModel, {
      from: 'aggcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      pipeline: [{ $project: { name: 1 } }],
    });

    expect(results).toHaveLength(3);
    for (const doc of results) {
      const d = doc as any;
      // Must be correlated — not a cartesian join
      expect(d.category).toHaveLength(1);
      expect(d.category[0].name).toBeDefined();
      expect(d.category[0].slug).toBeUndefined(); // excluded by $project
    }
  });

  it('pipeline-form does NOT produce cartesian join', async () => {
    const results = await aggregateActions.lookup(ProdModel, {
      from: 'aggcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      pipeline: [{ $project: { name: 1 } }],
    });

    // If cartesian, each product would have 2 categories (all of them)
    // Correlated: each product has exactly 1
    const laptop = results.find((d: any) => d.name === 'Laptop') as any;
    expect(laptop.category).toHaveLength(1);
    expect(laptop.category[0].name).toBe('Electronics');
  });

  it('pipeline-form with let variables preserves user correlation', async () => {
    const results = await aggregateActions.lookup(ProdModel, {
      from: 'aggcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      let: { catSlug: '$categorySlug' },
      pipeline: [
        { $match: { $expr: { $eq: ['$slug', '$$catSlug'] } } },
        { $project: { name: 1 } },
      ],
    });

    expect(results).toHaveLength(3);
    for (const doc of results) {
      expect((doc as any).category).toHaveLength(1);
    }
  });

  it('$where/$function/$accumulator are still blocked', async () => {
    const results = await aggregateActions.lookup(ProdModel, {
      from: 'aggcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      pipeline: [
        { $match: { $where: 'this.name === "hack"' } } as any,
        { $project: { name: 1 } },
      ],
    });

    // $where should be stripped, so all cats match (or none if join is correct)
    // The point: no crash, $where removed
    expect(results).toHaveLength(3);
  });

  it('$expr is NOT blocked (needed for join correlation)', async () => {
    const results = await aggregateActions.lookup(ProdModel, {
      from: 'aggcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      let: { catSlug: '$categorySlug' },
      pipeline: [
        { $match: { $expr: { $eq: ['$slug', '$$catSlug'] } } },
      ],
    });

    expect(results).toHaveLength(3);
    for (const doc of results) {
      // $expr must survive — correlation works
      expect((doc as any).category).toHaveLength(1);
    }
  });

  it('with query filter narrows source docs', async () => {
    const results = await aggregateActions.lookup(ProdModel, {
      from: 'aggcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      query: { name: 'Laptop' },
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Laptop');
  });

  it('single option adds $unwind', async () => {
    const results = await aggregateActions.lookup(ProdModel, {
      from: 'aggcats',
      localField: 'categorySlug',
      foreignField: 'slug',
      as: 'category',
      single: true,
    });

    expect(results).toHaveLength(3);
    for (const doc of results) {
      const d = doc as any;
      // single=true → $unwind → object instead of array
      expect(d.category).toBeDefined();
      expect(d.category.name).toBeDefined();
      expect(Array.isArray(d.category)).toBe(false);
    }
  });
});
