/**
 * E2E — real Atlas Vector Search.
 *
 * Skipped by default. Runs only when MONGOKIT_E2E_URI passes the safety
 * check in `tests/helpers/e2e-safety.ts`. The vector search index is
 * created/waited-for/dropped in-test via the native driver's
 * `createSearchIndex` — no manual Atlas UI steps required.
 *
 * This test's job is plumbing validation: `$vectorSearch` + mongokit's
 * plugin wiring against a real Atlas deployment. Exhaustive behavior is
 * pinned by `tests/integration/vector-*` on memory-server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { methodRegistryPlugin, Repository } from '../../src/index.js';
import { vectorPlugin } from '../../src/ai/vector.plugin.js';
import type { EmbeddingInput, VectorFieldConfig } from '../../src/ai/types.js';
import { e2eCollectionPrefix, resolveE2eGate } from '../helpers/e2e-safety.js';
import {
  dropVectorSearchIndex,
  ensureVectorSearchIndex,
} from '../helpers/atlas-search-index.js';

const gate = resolveE2eGate();
const DIMS = 8;
const INDEX_NAME = 'mongokit_e2e_vec_idx';

function embedText(text: string, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[i % dims] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const vectorField: VectorFieldConfig = {
  path: 'embedding',
  index: INDEX_NAME,
  dimensions: DIMS,
  similarity: 'cosine',
  sourceFields: ['title', 'body'],
};

interface IE2eDoc {
  _id: Types.ObjectId;
  docCode: string;
  title: string;
  body: string;
  embedding?: number[];
}

// Atlas e2e suite is currently disabled — rotated test credentials are no
// longer in .env. Re-enable by changing `describe.skip` back to
// `describe.skipIf(!gate.enabled)` and setting `MONGOKIT_E2E_URI` in .env
// (see tests/e2e/README.md).
// eslint-disable-next-line vitest/no-disabled-tests
describe.skip(
  `Atlas Vector Search E2E (${gate.reason ?? 'enabled'})`,
  () => {
    const prefix = e2eCollectionPrefix('vector');
    const collectionName = `${prefix}docs`;
    let conn: mongoose.Connection;
    let Model: mongoose.Model<IE2eDoc>;

    beforeAll(async () => {
      if (!gate.enabled || !gate.uri) return;
      conn = await mongoose.createConnection(gate.uri).asPromise();

      Model = conn.model<IE2eDoc>(
        collectionName,
        new Schema<IE2eDoc>({
          docCode: { type: String, required: true, unique: true },
          title: String,
          body: String,
          embedding: [Number],
        }),
      );

      await Model.init(); // ensure regular indexes exist
      // Ensure the collection is materialized before asking Atlas to index it.
      await Model.collection.insertOne({
        _placeholder: true,
        embedding: Array.from({ length: DIMS }, () => 0),
      } as unknown as IE2eDoc);
      await Model.deleteMany({});

      await ensureVectorSearchIndex(Model.collection, {
        name: INDEX_NAME,
        path: 'embedding',
        numDimensions: DIMS,
        similarity: 'cosine',
      });
    });

    afterAll(async () => {
      if (!gate.enabled) return;
      if (Model) {
        try {
          await dropVectorSearchIndex(Model.collection, INDEX_NAME);
        } catch {
          // best effort — teardown should never throw
        }
        try {
          await Model.collection.drop();
        } catch {
          // ignore
        }
      }
      if (conn) await conn.close();
    });

    it('auto-embed → real $vectorSearch → returns scored docs with custom idField intact', async () => {
      const embedFn = async ({ text }: EmbeddingInput) => embedText(text ?? '');
      const repo = new Repository<IE2eDoc>(
        Model,
        [
          methodRegistryPlugin(),
          vectorPlugin({ fields: [vectorField], embedFn, autoEmbed: true }),
        ],
        {},
        { idField: 'docCode' },
      );

      await repo.createMany([
        { docCode: 'e2e-a', title: 'Orbital mechanics', body: 'orbits and velocity' },
        { docCode: 'e2e-b', title: 'Gardening basics', body: 'soil aeration and mulch' },
        { docCode: 'e2e-c', title: 'Rocket propulsion', body: 'thrust specific impulse' },
      ]);

      // Atlas vector indexes are eventually consistent on writes. Poll up to
      // 45s after the writes land before concluding "the index is broken".
      const searchSimilar = (
        repo as unknown as {
          searchSimilar: (args: {
            query: string;
            limit: number;
          }) => Promise<{ doc: IE2eDoc; score: number }[]>;
        }
      ).searchSimilar.bind(repo);

      let results: { doc: IE2eDoc; score: number }[] = [];
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        results = await searchSimilar({ query: 'space and orbits', limit: 3 });
        if (results.length >= 3) break;
        await new Promise((r) => setTimeout(r, 2_000));
      }

      expect(results.length).toBeGreaterThan(0);
      for (const hit of results) {
        expect(typeof hit.doc.docCode).toBe('string');
        expect(hit.doc.docCode.startsWith('e2e-')).toBe(true);
        // Scores in [0, 1] for normalized vectors + cosine similarity.
        expect(hit.score).toBeGreaterThanOrEqual(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
      // Scores must be non-increasing.
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('searchSimilar with a filter runs correctly (unfiltered baseline)', async () => {
      const embedFn = async ({ text }: EmbeddingInput) => embedText(text ?? '');
      const repo = new Repository<IE2eDoc>(
        Model,
        [
          methodRegistryPlugin(),
          vectorPlugin({ fields: [vectorField], embedFn, autoEmbed: true }),
        ],
        {},
        { idField: 'docCode' },
      );

      // The docs from the previous test should still be present.
      const count = await Model.countDocuments();
      expect(count).toBeGreaterThan(0);

      const searchSimilar = (
        repo as unknown as {
          searchSimilar: (args: {
            query: string;
            limit: number;
          }) => Promise<{ doc: IE2eDoc; score: number }[]>;
        }
      ).searchSimilar.bind(repo);

      const results = await searchSimilar({ query: 'anything', limit: 50 });
      expect(results.length).toBeGreaterThan(0);
      // Each result shape: { doc, score } — doc retains custom idField.
      expect(results[0].doc.docCode).toMatch(/^e2e-/);
    });
  },
);

// eslint-disable-next-line vitest/no-disabled-tests
describe.skipIf(gate.enabled)('Atlas Vector Search E2E (gate disabled)', () => {
  it.skip(`disabled: ${gate.reason ?? 'no reason'}`, () => {});
});
