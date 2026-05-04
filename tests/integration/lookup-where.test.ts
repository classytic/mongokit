/**
 * Regression: `LookupSpec.where` was declared on the cross-kit contract
 * (`@classytic/repo-core/lookup`) and honored by sqlitekit, but mongokit's
 * `LookupBuilder` had no `where` field and `lookupPopulate` silently
 * dropped it. Cross-kit code like
 *
 *     repo.lookupPopulate({ lookups: [{ from, localField, foreignField,
 *       where: eq('status', 'active') }] })
 *
 * filtered the joined side on sqlitekit and returned it unfiltered on
 * mongokit. Same contract, different rows — exactly the kind of silent
 * cross-kit drift the conformance suite exists to prevent.
 *
 * The fix: thread `where` through `LookupOptions` and into the lookup
 * pipeline as a `$match` stage on the joined side (after the auto-
 * generated `$expr` join correlation, before any caller-supplied
 * pipeline / projection).
 */

import { eq } from '@classytic/repo-core/filter';
import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, disconnectDB } from '../setup.js';

interface ICategory {
  _id: Types.ObjectId;
  slug: string;
  name: string;
  status: 'active' | 'archived';
}

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  categorySlug: string;
}

describe('lookupPopulate honors LookupSpec.where (cross-kit parity)', () => {
  let CatModel: mongoose.Model<ICategory>;
  let ProdModel: mongoose.Model<IProduct>;
  let prodRepo: Repository<IProduct>;

  beforeAll(async () => {
    await connectDB();
    for (const n of ['LookupWhereCat', 'LookupWhereProd']) {
      if (mongoose.models[n]) delete mongoose.models[n];
    }
    CatModel = mongoose.model<ICategory>(
      'LookupWhereCat',
      new Schema<ICategory>({
        slug: { type: String, unique: true },
        name: String,
        status: String,
      }),
    );
    ProdModel = mongoose.model<IProduct>(
      'LookupWhereProd',
      new Schema<IProduct>({
        name: String,
        categorySlug: String,
      }),
    );
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
      { slug: 'electronics', name: 'Electronics', status: 'active' },
      { slug: 'books', name: 'Books', status: 'archived' },
    ]);
    await ProdModel.create([
      { name: 'Laptop', categorySlug: 'electronics' },
      { name: 'Novel', categorySlug: 'books' },
    ]);
    prodRepo = new Repository<IProduct>(ProdModel);
  });

  it('mongo-shape `where` filters joined-side rows (one-to-many)', async () => {
    const result = await prodRepo.lookupPopulate({
      lookups: [
        {
          from: 'lookupwherecats',
          localField: 'categorySlug',
          foreignField: 'slug',
          as: 'category',
          where: { status: 'active' },
        },
      ],
      sort: { name: 1 },
      page: 1,
    });

    if (result.method !== 'offset') throw new Error('expected offset envelope');

    const laptop = result.data.find((d) => d.name === 'Laptop');
    const novel = result.data.find((d) => d.name === 'Novel');
    // Laptop's category is active → still joined.
    expect(laptop?.category).toEqual([expect.objectContaining({ slug: 'electronics' })]);
    // Novel's category is archived → filtered out by `where`, leaving [].
    expect(novel?.category).toEqual([]);
  });

  it('IR-shape `where` filters joined-side rows (single)', async () => {
    const result = await prodRepo.lookupPopulate({
      lookups: [
        {
          from: 'lookupwherecats',
          localField: 'categorySlug',
          foreignField: 'slug',
          as: 'category',
          single: true,
          where: eq('status', 'active'),
        },
      ],
      sort: { name: 1 },
      page: 1,
    });

    if (result.method !== 'offset') throw new Error('expected offset envelope');

    const laptop = result.data.find((d) => d.name === 'Laptop');
    const novel = result.data.find((d) => d.name === 'Novel');
    expect(laptop?.category).toMatchObject({ slug: 'electronics' });
    // single + no match (filtered out) → null, not an undefined key.
    expect(novel?.category).toBeNull();
  });

  it('omitting `where` returns every joined row (no behavior change)', async () => {
    const result = await prodRepo.lookupPopulate({
      lookups: [
        {
          from: 'lookupwherecats',
          localField: 'categorySlug',
          foreignField: 'slug',
          as: 'category',
        },
      ],
      sort: { name: 1 },
      page: 1,
    });

    if (result.method !== 'offset') throw new Error('expected offset envelope');
    for (const doc of result.data) {
      expect((doc.category as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
