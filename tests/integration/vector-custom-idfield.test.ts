/**
 * vector plugin composed with non-_id primary keys.
 *
 * Real-world repositories often key documents by a domain slug/code rather
 * than a generated ObjectId — `Repository({ idField: 'docId' })`. This
 * suite pins:
 *   - auto-embed still fires on create/update/createMany when idField != _id
 *   - getById / update / delete resolve through the custom field
 *   - searchSimilar returns scored docs that retain the custom id
 *   - keyset pagination over the underlying collection plays nicely
 *     alongside vector plugin mutations
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
  Repository,
} from '../../src/index.js';
import { vectorPlugin } from '../../src/ai/vector.plugin.js';
import type { EmbeddingInput, VectorFieldConfig } from '../../src/ai/types.js';
import type { KeysetPaginationResult } from '../../src/types.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRagDoc {
  docId: string;
  title: string;
  body: string;
  embedding?: number[];
  createdAt?: Date;
}

const DIMS = 8;
const VECTOR_FIELD: VectorFieldConfig = {
  path: 'embedding',
  index: 'rag_idx',
  dimensions: DIMS,
  similarity: 'cosine',
  sourceFields: ['title', 'body'],
};

/** Text → deterministic vector. Same text → same vector. */
function embedFromText(text: string, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % dims] += text.charCodeAt(i);
  }
  // L2-normalize so cosine similarity works cleanly.
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => Number((x / norm).toFixed(6)));
}

describe('vector plugin + custom idField (integration)', () => {
  let Model: mongoose.Model<IRagDoc>;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    Model = await createTestModel(
      'RagCustomIdDoc',
      new Schema<IRagDoc>(
        {
          docId: { type: String, required: true, unique: true },
          title: { type: String, required: true },
          body: { type: String, required: true },
          embedding: [Number],
        },
        { timestamps: true },
      ),
    );
    await Model.deleteMany({});
  });

  it('autoEmbed fires on create; getById resolves through custom idField', async () => {
    const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
      embedFromText(text ?? ''),
    );

    const repo = new Repository<IRagDoc>(
      Model,
      [methodRegistryPlugin(), vectorPlugin({ fields: [VECTOR_FIELD], embedFn, autoEmbed: true })],
      {},
      { idField: 'docId' },
    );

    const created = await repo.create({
      docId: 'handbook#intro',
      title: 'Intro',
      body: 'welcome to the handbook',
    });
    expect((created as IRagDoc).embedding).toHaveLength(DIMS);
    expect(embedFn).toHaveBeenCalledTimes(1);

    // idField resolution: getById queries { docId: 'handbook#intro' }, not _id.
    const fetched = (await repo.getById('handbook#intro')) as IRagDoc;
    expect(fetched.docId).toBe('handbook#intro');
    expect(fetched.embedding).toHaveLength(DIMS);
  });

  it('update via custom idField re-embeds when a source field changes', async () => {
    const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
      embedFromText(text ?? ''),
    );

    const repo = new Repository<IRagDoc>(
      Model,
      [methodRegistryPlugin(), vectorPlugin({ fields: [VECTOR_FIELD], embedFn, autoEmbed: true })],
      {},
      { idField: 'docId' },
    );

    await repo.create({ docId: 'abc', title: 'Old', body: 'same body' });
    embedFn.mockClear();

    await repo.update('abc', { title: 'New title' });
    // title is a sourceField → must re-embed once.
    expect(embedFn).toHaveBeenCalledTimes(1);

    const fresh = (await repo.getById('abc')) as IRagDoc;
    expect(fresh.title).toBe('New title');
    expect(fresh.embedding).toHaveLength(DIMS);
  });

  it('createMany auto-embeds every doc and preserves custom idField uniqueness', async () => {
    const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
      embedFromText(text ?? ''),
    );

    const repo = new Repository<IRagDoc>(
      Model,
      [methodRegistryPlugin(), vectorPlugin({ fields: [VECTOR_FIELD], embedFn, autoEmbed: true })],
      {},
      { idField: 'docId' },
    );

    const docs = await repo.createMany([
      { docId: 'doc-a', title: 'A', body: 'alpha text' },
      { docId: 'doc-b', title: 'B', body: 'beta text' },
      { docId: 'doc-c', title: 'C', body: 'gamma text' },
    ]);

    for (const d of docs) {
      expect((d as IRagDoc).embedding).toHaveLength(DIMS);
    }
    expect(embedFn).toHaveBeenCalledTimes(3);

    // Spot-check: identical source text must produce identical embedding.
    const [a] = await repo.createMany([
      { docId: 'doc-d', title: 'A', body: 'alpha text' }, // same as doc-a
    ]);
    expect((a as IRagDoc).embedding).toEqual((docs[0] as IRagDoc).embedding);
  });

  it('searchSimilar returns docs with their custom idField intact', async () => {
    const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
      embedFromText(text ?? ''),
    );

    const repo = new Repository<IRagDoc>(
      Model,
      [methodRegistryPlugin(), vectorPlugin({ fields: [VECTOR_FIELD], embedFn, autoEmbed: true })],
      {},
      { idField: 'docId' },
    );

    const seeded = await repo.createMany([
      { docId: 'rag-1', title: 'Rocket science', body: 'propulsion and orbital dynamics' },
      { docId: 'rag-2', title: 'Garden care', body: 'watering and pruning houseplants' },
    ]);

    // createMany returns hydrated Mongoose docs; normalize to plain POJOs so
    // the spread in the plugin (const { _score, ...rest } = doc) works.
    const plain = seeded.map((d) =>
      typeof (d as { toObject?: () => unknown }).toObject === 'function'
        ? ((d as unknown as { toObject: () => Record<string, unknown> }).toObject() as Record<string, unknown>)
        : (d as unknown as Record<string, unknown>),
    );

    // $vectorSearch is Atlas-only. Stub Model.aggregate to return a scored
    // shape identical to what the plugin expects, preserving the docId.
    const scored = plain.map((d, i) => ({ ...d, _score: 1 - i * 0.1 }));
    const aggregateSpy = vi
      .spyOn(repo.Model, 'aggregate')
      .mockImplementation(
        () =>
          ({
            session: () => ({ exec: async () => scored }),
            exec: async () => scored,
          }) as unknown as ReturnType<typeof repo.Model.aggregate>,
      );

    const results = await (repo as unknown as {
      searchSimilar: (args: {
        query: string;
        limit: number;
      }) => Promise<{ doc: IRagDoc; score: number }[]>;
    }).searchSimilar({ query: 'space exploration', limit: 5 });

    expect(results.length).toBe(2);
    expect(results[0].doc.docId).toBe('rag-1');
    expect(results[0].score).toBeGreaterThan(results[1].score);
    aggregateSpy.mockRestore();
  });

  it('keyset pagination over the vector-embedded collection is stable and complete', async () => {
    const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
      embedFromText(text ?? ''),
    );

    const repo = new Repository<IRagDoc>(
      Model,
      [methodRegistryPlugin(), vectorPlugin({ fields: [VECTOR_FIELD], embedFn, autoEmbed: true })],
      {},
      { idField: 'docId' },
    );

    // 120 docs with slightly-offset createdAt to exercise tiebreaker behavior.
    const batch = Array.from({ length: 120 }, (_, i) => ({
      docId: `kp-${i.toString().padStart(3, '0')}`,
      title: `T${i}`,
      body: `body ${i}`,
    }));
    await repo.createMany(batch);

    const seen = new Set<string>();
    let after: string | undefined;
    let pages = 0;

    while (true) {
      pages += 1;
      expect(pages).toBeLessThan(30);

      const result = (await repo.getAll({
        sort: { _id: -1 },
        limit: 20,
        after,
      })) as KeysetPaginationResult<IRagDoc & { _id: Types.ObjectId }>;

      for (const d of result.docs) seen.add(d.docId);
      if (!result.hasMore) break;
      after = result.next ?? undefined;
    }

    expect(seen.size).toBe(120);
  });
});
