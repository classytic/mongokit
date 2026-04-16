/**
 * E2E — real Atlas RAG pipeline.
 *
 * Creates its own vector-search index programmatically (with a `tenantId`
 * filter field so multi-tenant $vectorSearch works). Drops it on teardown.
 *
 * Validates end-to-end:
 *   ingest parent docs → chunk + auto-embed →
 *   $vectorSearch top-K (tenant-scoped) → $lookup parent → verify isolation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  methodRegistryPlugin,
  multiTenantPlugin,
  Repository,
} from '../../src/index.js';
import { vectorPlugin } from '../../src/ai/vector.plugin.js';
import type { EmbeddingInput, VectorFieldConfig } from '../../src/ai/types.js';
import { e2eCollectionPrefix, resolveE2eGate } from '../helpers/e2e-safety.js';
import {
  dropVectorSearchIndex,
  ensureVectorSearchIndex,
} from '../helpers/atlas-search-index.js';

const gate = resolveE2eGate();
const DIMS = 8;
const CHUNK_INDEX = 'mongokit_e2e_rag_idx';

function embedText(text: string, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[i % dims] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const chunkVectorField: VectorFieldConfig = {
  path: 'embedding',
  index: CHUNK_INDEX,
  dimensions: DIMS,
  similarity: 'cosine',
  sourceFields: ['text'],
};

interface IRagParent {
  _id: Types.ObjectId;
  title: string;
  tenantId: string;
}

interface IRagChunk {
  _id: Types.ObjectId;
  parentId: Types.ObjectId;
  ordinal: number;
  text: string;
  embedding?: number[];
  tenantId: string;
}

// Atlas e2e suite is currently disabled — rotated test credentials are no
// longer in .env. Re-enable by changing `describe.skip` back to
// `describe.skipIf(!gate.enabled)` and setting `MONGOKIT_E2E_URI` in .env
// (see tests/e2e/README.md).
// eslint-disable-next-line vitest/no-disabled-tests
describe.skip(
  `Atlas RAG pipeline E2E (${gate.reason ?? 'enabled'})`,
  () => {
    const prefix = e2eCollectionPrefix('rag');
    const parentCollection = `${prefix}parents`;
    const chunkCollection = `${prefix}chunks`;
    let conn: mongoose.Connection;
    let ParentModel: mongoose.Model<IRagParent>;
    let ChunkModel: mongoose.Model<IRagChunk>;

    beforeAll(async () => {
      if (!gate.enabled || !gate.uri) return;
      conn = await mongoose.createConnection(gate.uri).asPromise();

      ParentModel = conn.model<IRagParent>(
        parentCollection,
        new Schema<IRagParent>(
          {
            title: { type: String, required: true },
            tenantId: { type: String, required: true, index: true },
          },
          { timestamps: true },
        ),
      );
      ChunkModel = conn.model<IRagChunk>(
        chunkCollection,
        new Schema<IRagChunk>(
          {
            parentId: { type: Schema.Types.ObjectId, required: true, index: true },
            ordinal: { type: Number, required: true },
            text: { type: String, required: true },
            embedding: [Number],
            tenantId: { type: String, required: true, index: true },
          },
          { timestamps: true },
        ),
      );

      await Promise.all([ParentModel.init(), ChunkModel.init()]);

      // Materialize the chunks collection so createSearchIndex has a target.
      await ChunkModel.collection.insertOne({
        _placeholder: true,
        tenantId: 'init',
        embedding: Array.from({ length: DIMS }, () => 0),
      } as unknown as IRagChunk);
      await ChunkModel.deleteMany({});

      await ensureVectorSearchIndex(ChunkModel.collection, {
        name: CHUNK_INDEX,
        path: 'embedding',
        numDimensions: DIMS,
        similarity: 'cosine',
        // tenantId must be declared as a filter field so $vectorSearch can
        // pass `filter: { tenantId: '...' }` through.
        filterPaths: ['tenantId'],
      });
    });

    afterAll(async () => {
      if (!gate.enabled) return;
      if (ChunkModel) {
        try {
          await dropVectorSearchIndex(ChunkModel.collection, CHUNK_INDEX);
        } catch {
          // best effort
        }
      }
      for (const m of [ChunkModel, ParentModel]) {
        if (!m) continue;
        try {
          await m.collection.drop();
        } catch {
          // ignore
        }
      }
      if (conn) await conn.close();
    });

    it('ingest → tenant-scoped $vectorSearch → $lookup parent → isolation holds', async () => {
      const embedFn = async ({ text }: EmbeddingInput) => embedText(text ?? '');

      const parentRepo = new Repository<IRagParent>(ParentModel, [
        multiTenantPlugin({ tenantField: 'tenantId', contextKey: 'tenantId' }),
      ]);
      const chunkRepo = new Repository<IRagChunk>(ChunkModel, [
        methodRegistryPlugin(),
        multiTenantPlugin({ tenantField: 'tenantId', contextKey: 'tenantId' }),
        vectorPlugin({ fields: [chunkVectorField], embedFn, autoEmbed: true }),
      ]);

      const alphaParent = (await parentRepo.create(
        { title: 'Alpha orbital mechanics primer' },
        { tenantId: 'org_alpha' },
      )) as IRagParent;
      const betaParent = (await parentRepo.create(
        { title: 'Beta gardening handbook' },
        { tenantId: 'org_beta' },
      )) as IRagParent;

      await chunkRepo.createMany(
        Array.from({ length: 3 }, (_, i) => ({
          parentId: alphaParent._id,
          ordinal: i,
          text: `orbit velocity chapter ${i}`,
        })),
        { tenantId: 'org_alpha' } as Record<string, unknown>,
      );
      await chunkRepo.createMany(
        Array.from({ length: 3 }, (_, i) => ({
          parentId: betaParent._id,
          ordinal: i,
          text: `soil mulch chapter ${i}`,
        })),
        { tenantId: 'org_beta' } as Record<string, unknown>,
      );

      const searchSimilar = (
        chunkRepo as unknown as {
          searchSimilar: (args: {
            query: string;
            limit: number;
            filter?: Record<string, unknown>;
          }) => Promise<{ doc: IRagChunk; score: number }[]>;
        }
      ).searchSimilar.bind(chunkRepo);

      // Poll until the vector index has ingested the writes.
      let topK: { doc: IRagChunk; score: number }[] = [];
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        topK = await searchSimilar({
          query: 'orbital velocity',
          limit: 10,
          filter: { tenantId: 'org_alpha' },
        });
        if (topK.length >= 3) break;
        await new Promise((r) => setTimeout(r, 2_000));
      }

      expect(topK.length).toBeGreaterThan(0);
      // Tenant isolation: only alpha's chunks.
      for (const hit of topK) {
        expect(hit.doc.tenantId).toBe('org_alpha');
      }

      // $lookup parent — one round-trip aggregation.
      const ids = topK.map((h) => h.doc._id);
      const enriched = await ChunkModel.aggregate<
        IRagChunk & { parent: IRagParent }
      >([
        { $match: { _id: { $in: ids } } },
        {
          $lookup: {
            from: ParentModel.collection.name,
            localField: 'parentId',
            foreignField: '_id',
            as: 'parent',
          },
        },
        { $unwind: '$parent' },
      ]).exec();

      expect(enriched.length).toBe(topK.length);
      for (const row of enriched) {
        expect(row.parent.tenantId).toBe('org_alpha');
        expect(row.parent.title).toBe('Alpha orbital mechanics primer');
      }

      // Explicit cross-tenant check: query with filter={org_beta} returns only beta.
      const betaResults = await searchSimilar({
        query: 'chapter',
        limit: 10,
        filter: { tenantId: 'org_beta' },
      });
      for (const hit of betaResults) {
        expect(hit.doc.tenantId).toBe('org_beta');
      }
    });
  },
);

// eslint-disable-next-line vitest/no-disabled-tests
describe.skipIf(gate.enabled)('Atlas RAG pipeline E2E (gate disabled)', () => {
  it.skip(`disabled: ${gate.reason ?? 'no reason'}`, () => {});
});
