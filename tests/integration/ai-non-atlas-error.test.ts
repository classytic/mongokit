/**
 * Calls `searchSimilar` against the real (non-Atlas) memory-server to
 * confirm the non-Atlas hint surfaces instead of a raw MongoDB error.
 *
 * This is the DX promise for developers trying mongokit on a local Mongo:
 * you get a pointed, actionable message, not a stack trace with
 * "Unrecognized pipeline stage name".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { methodRegistryPlugin, Repository } from '../../src/index.js';
import { vectorPlugin } from '../../src/ai/vector.plugin.js';
import type { VectorFieldConfig } from '../../src/ai/types.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface INonAtlasDoc {
  title: string;
  embedding?: number[];
}

const DIMS = 4;
const field: VectorFieldConfig = {
  path: 'embedding',
  index: 'some_idx',
  dimensions: DIMS,
  similarity: 'cosine',
  sourceFields: ['title'],
};

describe('vector plugin on non-Atlas Mongo — error hints (integration)', () => {
  let Model: mongoose.Model<INonAtlasDoc>;

  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    if (Model) await Model.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    Model = await createTestModel(
      'NonAtlasDoc',
      new Schema<INonAtlasDoc>({ title: String, embedding: [Number] }),
    );
    await Model.deleteMany({});
  });

  it('searchSimilar on memory-server throws a friendly "Atlas-only" error', async () => {
    const repo = new Repository<INonAtlasDoc>(Model, [
      methodRegistryPlugin(),
      vectorPlugin({
        fields: [field],
        embedFn: async ({ text }) => new Array(DIMS).fill((text ?? '').length),
      }),
    ]);

    await repo.create({ title: 'anything' });

    const searchSimilar = (
      repo as unknown as {
        searchSimilar: (args: { query: string; limit: number }) => Promise<unknown>;
      }
    ).searchSimilar.bind(repo);

    await expect(searchSimilar({ query: 'anything', limit: 5 })).rejects.toSatisfy(
      (err: Error & { code?: string; cause?: unknown }) => {
        // Friendly mongokit error, not the raw "Unrecognized pipeline stage" stack.
        expect(err.message).toMatch(/\[mongokit:vector\]/);
        expect(err.message).toMatch(/Atlas-only/);
        expect(err.code).toBe('NOT_ATLAS');
        // Original driver error preserved for debugging.
        expect(err.cause).toBeDefined();
        expect(String(err.cause)).toMatch(/\$vectorSearch/i);
        return true;
      },
    );
  });

  it('query-vector-dimension mismatch is caught client-side before hitting Mongo', async () => {
    const repo = new Repository<INonAtlasDoc>(Model, [
      methodRegistryPlugin(),
      vectorPlugin({
        fields: [field],
        embedFn: async () => new Array(DIMS + 1).fill(0), // wrong size!
      }),
    ]);

    const searchSimilar = (
      repo as unknown as {
        searchSimilar: (args: { query: string; limit: number }) => Promise<unknown>;
      }
    ).searchSimilar.bind(repo);

    await expect(searchSimilar({ query: 'foo', limit: 3 })).rejects.toThrow(
      /has \d+ dimensions, expected \d+/,
    );
  });

  it('vectorPlugin without methodRegistryPlugin gives a precise setup hint', () => {
    expect(() =>
      new Repository<INonAtlasDoc>(Model, [
        vectorPlugin({
          fields: [field],
          embedFn: async ({ text }) => new Array(DIMS).fill((text ?? '').length),
        }),
      ]),
    ).toThrow(/requires methodRegistryPlugin/);
  });
});
