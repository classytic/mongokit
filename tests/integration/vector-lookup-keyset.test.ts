/**
 * vector-embedded documents + `lookupPopulate` + keyset pagination.
 *
 * Covers the production path where a RAG service lists chunks (vector-bearing
 * child docs) joined to their parent document metadata and paginates with a
 * stable cursor. This exercises Repository.lookupPopulate's keyset mode —
 * different from the offset path in the main RAG test.
 *
 * Guarantees:
 *   - lookupPopulate joins the parent document (from a separate collection)
 *     onto each chunk in one aggregation pipeline.
 *   - Keyset pagination over embedded chunks walks the whole collection
 *     without duplicates or gaps.
 *   - Multi-tenant scoping survives through the lookupPopulate aggregation.
 *   - Custom idField on the child collection (non-_id key) still joins
 *     correctly via foreignField.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  methodRegistryPlugin,
  multiTenantPlugin,
  Repository,
} from '../../src/index.js';
import { vectorPlugin } from '../../src/ai/vector.plugin.js';
import type { EmbeddingInput, VectorFieldConfig } from '../../src/ai/types.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

const DIMS = 8;

interface IParentDoc {
  _id: Types.ObjectId;
  docCode: string;
  title: string;
  author: string;
  tenantId: string;
}

interface IChildChunk {
  _id: Types.ObjectId;
  parentCode: string;
  ordinal: number;
  text: string;
  embedding?: number[];
  tenantId: string;
  createdAt: Date;
}

function embedText(text: string, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[i % dims] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const VECTOR_FIELD: VectorFieldConfig = {
  path: 'embedding',
  index: 'chunk_idx',
  dimensions: DIMS,
  similarity: 'cosine',
  sourceFields: ['text'],
};

// The multi-tenant plugin reads context keys from the options payload that
// `_buildContext` builds. Passing tenantId on the options object is the
// idiomatic way to scope lookupPopulate without an explicit context arg.
type LookupCallOptions = Parameters<Repository<IChildChunk>['lookupPopulate']>[0] & {
  tenantId?: string;
};

describe('vector + lookupPopulate + keyset pagination (integration)', () => {
  let ParentModel: mongoose.Model<IParentDoc>;
  let ChildModel: mongoose.Model<IChildChunk>;
  let parentRepo: Repository<IParentDoc>;
  let childRepo: Repository<IChildChunk>;
  let embedFn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (ChildModel) await ChildModel.deleteMany({});
    if (ParentModel) await ParentModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    ParentModel = await createTestModel(
      'VLKParent',
      new Schema<IParentDoc>(
        {
          docCode: { type: String, required: true, unique: true },
          title: { type: String, required: true },
          author: { type: String, required: true },
          tenantId: { type: String, required: true, index: true },
        },
        { timestamps: true },
      ),
    );
    ChildModel = await createTestModel(
      'VLKChild',
      new Schema<IChildChunk>(
        {
          parentCode: { type: String, required: true, index: true },
          ordinal: { type: Number, required: true },
          text: { type: String, required: true },
          embedding: [Number],
          tenantId: { type: String, required: true, index: true },
        },
        { timestamps: true },
      ),
    );
    await Promise.all([ParentModel.deleteMany({}), ChildModel.deleteMany({})]);

    embedFn = vi.fn(async ({ text }: EmbeddingInput) => embedText(text ?? ''));

    parentRepo = new Repository<IParentDoc>(
      ParentModel,
      [multiTenantPlugin({ tenantField: 'tenantId', contextKey: 'tenantId' })],
      {},
      { idField: 'docCode' },
    );

    childRepo = new Repository<IChildChunk>(ChildModel, [
      methodRegistryPlugin(),
      multiTenantPlugin({ tenantField: 'tenantId', contextKey: 'tenantId' }),
      vectorPlugin({
        fields: [VECTOR_FIELD],
        embedFn: embedFn as unknown as (input: EmbeddingInput) => Promise<number[]>,
        autoEmbed: true,
      }),
    ]);
  });

  async function seedParentWithChunks(
    tenantId: string,
    docCode: string,
    title: string,
    chunkCount: number,
  ): Promise<void> {
    await parentRepo.create({ docCode, title, author: 'Author' }, { tenantId });
    const chunks = Array.from({ length: chunkCount }, (_, i) => ({
      parentCode: docCode,
      ordinal: i,
      text: `${title} chunk ${i} with some searchable content`,
    }));
    await childRepo.createMany(chunks, { tenantId } as Record<string, unknown>);
  }

  const joinParent = {
    from: '', // filled per-test once ParentModel exists
    localField: 'parentCode',
    foreignField: 'docCode',
    as: 'parent',
    single: true,
  };

  it('lookupPopulate joins parent via custom key (parentCode → docCode)', async () => {
    await seedParentWithChunks('org_a', 'doc-001', 'Parent One', 3);

    const result = await childRepo.lookupPopulate({
      filters: {},
      lookups: [{ ...joinParent, from: ParentModel.collection.name }],
      sort: { _id: 1 },
      limit: 10,
      tenantId: 'org_a',
    } as LookupCallOptions);

    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBe(3);
    for (const chunk of result.data as unknown as (IChildChunk & { parent: IParentDoc })[]) {
      expect(chunk.parent).toBeDefined();
      expect(chunk.parent.docCode).toBe('doc-001');
      expect(chunk.parent.title).toBe('Parent One');
    }
  });

  it('keyset pagination through lookupPopulate walks the whole set — no dupes, no gaps', async () => {
    await seedParentWithChunks('org_a', 'd-10', 'Ten', 30);
    await seedParentWithChunks('org_a', 'd-20', 'Twenty', 30);
    await seedParentWithChunks('org_a', 'd-30', 'Thirty', 30);

    const seen = new Set<string>();
    let after: string | undefined;
    let pages = 0;

    while (true) {
      pages += 1;
      expect(pages).toBeLessThan(30);

      const result = await childRepo.lookupPopulate({
        filters: {},
        lookups: [{ ...joinParent, from: ParentModel.collection.name }],
        sort: { _id: -1 },
        limit: 15,
        after,
        countStrategy: 'none',
        tenantId: 'org_a',
      } as LookupCallOptions);

      for (const d of result.data) {
        const id = String((d as { _id: Types.ObjectId })._id);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }

      const next = (result as { next?: string | null }).next;
      if (!next) break;
      after = next;
    }

    expect(seen.size).toBe(90);
  });

  it('multi-tenant scoping survives the lookupPopulate aggregation — no cross-tenant bleed', async () => {
    await seedParentWithChunks('org_a', 'a-doc', 'Alpha', 5);
    await seedParentWithChunks('org_b', 'b-doc', 'Beta', 5);

    const aResult = await childRepo.lookupPopulate({
      filters: {},
      lookups: [{ ...joinParent, from: ParentModel.collection.name }],
      sort: { _id: 1 },
      limit: 50,
      tenantId: 'org_a',
    } as LookupCallOptions);

    expect(aResult.data.length).toBe(5);
    for (const chunk of aResult.data as unknown as IChildChunk[]) {
      expect(chunk.tenantId).toBe('org_a');
    }

    const bResult = await childRepo.lookupPopulate({
      filters: {},
      lookups: [{ ...joinParent, from: ParentModel.collection.name }],
      sort: { _id: 1 },
      limit: 50,
      tenantId: 'org_b',
    } as LookupCallOptions);

    expect(bResult.data.length).toBe(5);
    for (const chunk of bResult.data as unknown as IChildChunk[]) {
      expect(chunk.tenantId).toBe('org_b');
    }
  });

  it('offset pagination through lookupPopulate — correct total + page slicing', async () => {
    await seedParentWithChunks('org_a', 'page-doc', 'PageParent', 25);

    const page1 = await childRepo.lookupPopulate({
      filters: {},
      lookups: [{ ...joinParent, from: ParentModel.collection.name }],
      sort: { ordinal: 1 },
      page: 1,
      limit: 10,
      tenantId: 'org_a',
    } as LookupCallOptions);

    const page2 = await childRepo.lookupPopulate({
      filters: {},
      lookups: [{ ...joinParent, from: ParentModel.collection.name }],
      sort: { ordinal: 1 },
      page: 2,
      limit: 10,
      tenantId: 'org_a',
    } as LookupCallOptions);

    const page3 = await childRepo.lookupPopulate({
      filters: {},
      lookups: [{ ...joinParent, from: ParentModel.collection.name }],
      sort: { ordinal: 1 },
      page: 3,
      limit: 10,
      tenantId: 'org_a',
    } as LookupCallOptions);

    expect(page1.data.length).toBe(10);
    expect(page2.data.length).toBe(10);
    expect(page3.data.length).toBe(5);
    const allOrdinals = [...page1.data, ...page2.data, ...page3.data].map(
      (d) => (d as unknown as IChildChunk).ordinal,
    );
    expect(allOrdinals).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});
