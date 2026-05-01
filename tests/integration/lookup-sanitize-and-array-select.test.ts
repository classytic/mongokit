/**
 * Two regressions introduced by the recent `where`-support patch:
 *
 *  1. **High** — `LookupBuilder.multiple()` now wires every pipeline-form
 *     lookup through `builder.sanitize(false)`, so caller-supplied
 *     `lookup.pipeline` stages bypass the dangerous-stage / dangerous-
 *     operator filter. Pre-patch, the pipeline-only branch reached
 *     `build()` with the default `sanitize: true`, which dropped `$out`,
 *     `$merge`, `$where`, `$function`, `$accumulator`. We need to
 *     restore that protection while keeping the auto-generated
 *     `$expr` join correlation and `$match` for `where` trusted.
 *
 *  2. **Medium** — repo-core's `LookupSpec.select` accepts
 *     `readonly string[]`. mongokit only handles `string` (CSV) and
 *     `Record<string, 0|1>`. Arrays fall through into the Record branch
 *     and get emitted as `$project: ['name']`, which Mongo rejects.
 *     A cross-kit caller doing `select: ['name']` works on sqlitekit
 *     and breaks here.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import type { PipelineStage } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { LookupBuilder } from '../../src/query/LookupBuilder.js';
import { connectDB, disconnectDB } from '../setup.js';

interface ICategory {
  _id: Types.ObjectId;
  slug: string;
  name: string;
  status: string;
}
interface IProduct {
  _id: Types.ObjectId;
  name: string;
  categorySlug: string;
}

describe('LookupBuilder regressions — sanitization + array select', () => {
  let CatModel: mongoose.Model<ICategory>;
  let ProdModel: mongoose.Model<IProduct>;
  let prodRepo: Repository<IProduct>;

  beforeAll(async () => {
    await connectDB();
    for (const n of ['LookupRegCat', 'LookupRegProd']) {
      if (mongoose.models[n]) delete mongoose.models[n];
    }
    CatModel = mongoose.model<ICategory>(
      'LookupRegCat',
      new Schema<ICategory>({
        slug: { type: String, unique: true },
        name: String,
        status: String,
      }),
    );
    ProdModel = mongoose.model<IProduct>(
      'LookupRegProd',
      new Schema<IProduct>({ name: String, categorySlug: String }),
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

  // ─── HIGH: sanitization regression ──────────────────────────────────

  it('drops $out from caller-supplied lookup pipeline (sanitization restored)', () => {
    const stages = LookupBuilder.multiple([
      {
        from: 'lookupregcats',
        localField: 'categorySlug',
        foreignField: 'slug',
        as: 'category',
        pipeline: [
          { $match: { status: 'active' } } as PipelineStage,
          { $out: 'evil_collection' } as unknown as PipelineStage,
        ],
      },
    ]);

    const lookupStage = stages.find((s) => '$lookup' in s) as PipelineStage.Lookup;
    const inner = (lookupStage.$lookup as { pipeline?: PipelineStage[] }).pipeline ?? [];
    const innerOps = inner.map((s) => Object.keys(s)[0]);

    expect(innerOps).not.toContain('$out');
    expect(innerOps).toContain('$match'); // benign stages survive
  });

  it('drops $where / $function from caller pipeline (operator-level sanitization)', () => {
    const stages = LookupBuilder.multiple([
      {
        from: 'lookupregcats',
        localField: 'categorySlug',
        foreignField: 'slug',
        as: 'category',
        pipeline: [
          {
            $match: {
              status: 'active',
              $where: 'function() { return true; }',
            },
          } as unknown as PipelineStage,
        ],
      },
    ]);

    const lookupStage = stages.find((s) => '$lookup' in s) as PipelineStage.Lookup;
    const inner = (lookupStage.$lookup as { pipeline?: PipelineStage[] }).pipeline ?? [];

    // Find the $match the caller supplied — its body must have lost $where.
    const callerMatch = inner.find((s) => {
      const match = (s as { $match?: Record<string, unknown> }).$match;
      return match && 'status' in match;
    });
    const matchBody = (callerMatch as { $match: Record<string, unknown> }).$match;
    expect(matchBody.status).toBe('active');
    expect(matchBody).not.toHaveProperty('$where');
  });

  it('end-to-end: lookupPopulate with caller pipeline still joins (sanitization is non-breaking for benign stages)', async () => {
    const result = await prodRepo.lookupPopulate({
      lookups: [
        {
          from: 'lookupregcats',
          localField: 'categorySlug',
          foreignField: 'slug',
          as: 'category',
          pipeline: [{ $match: { status: 'active' } } as PipelineStage],
        },
      ],
      sort: { name: 1 },
      page: 1,
    });

    if (result.method !== 'offset') throw new Error('expected offset envelope');

    const laptop = result.docs.find((d) => d.name === 'Laptop');
    const novel = result.docs.find((d) => d.name === 'Novel');
    expect((laptop?.category as unknown[]).length).toBe(1);
    // Novel's category is `archived` → filtered out by caller pipeline.
    expect((novel?.category as unknown[]).length).toBe(0);
  });

  // ─── MEDIUM: array-form select ─────────────────────────────────────

  it('compiles array-form select to a valid $project (cross-kit parity)', () => {
    const stages = LookupBuilder.multiple([
      {
        from: 'lookupregcats',
        localField: 'categorySlug',
        foreignField: 'slug',
        as: 'category',
        // repo-core's LookupSpec.select accepts readonly string[].
        select: ['name'] as readonly string[],
      } as never,
    ]);

    const lookupStage = stages.find((s) => '$lookup' in s) as PipelineStage.Lookup;
    const inner = (lookupStage.$lookup as { pipeline?: PipelineStage[] }).pipeline ?? [];
    const projectStage = inner.find((s) => '$project' in s) as { $project: unknown } | undefined;

    expect(projectStage).toBeDefined();
    // Must be an inclusion map { name: 1 }, NOT an array.
    expect(Array.isArray(projectStage?.$project)).toBe(false);
    expect(projectStage?.$project).toMatchObject({ name: 1 });
  });

  it('end-to-end: array-form select narrows joined-side fields', async () => {
    const result = await prodRepo.lookupPopulate({
      lookups: [
        {
          from: 'lookupregcats',
          localField: 'categorySlug',
          foreignField: 'slug',
          as: 'category',
          single: true,
          select: ['name'] as readonly string[],
        } as never,
      ],
      sort: { name: 1 },
      page: 1,
    });

    if (result.method !== 'offset') throw new Error('expected offset envelope');

    const laptop = result.docs.find((d) => d.name === 'Laptop');
    const cat = laptop?.category as Record<string, unknown> | null;
    expect(cat).toMatchObject({ name: 'Electronics' });
    // `slug` and `status` should be omitted by the projection.
    expect(cat).not.toHaveProperty('slug');
    expect(cat).not.toHaveProperty('status');
  });

  it('array select with a leading "-" excludes the field', () => {
    const stages = LookupBuilder.multiple([
      {
        from: 'lookupregcats',
        localField: 'categorySlug',
        foreignField: 'slug',
        as: 'category',
        select: ['-status'] as readonly string[],
      } as never,
    ]);

    const lookupStage = stages.find((s) => '$lookup' in s) as PipelineStage.Lookup;
    const inner = (lookupStage.$lookup as { pipeline?: PipelineStage[] }).pipeline ?? [];
    const projectStage = inner.find((s) => '$project' in s) as { $project: unknown } | undefined;

    expect(projectStage?.$project).toMatchObject({ status: 0 });
  });
});
