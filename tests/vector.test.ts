/**
 * Vector Search Plugin Tests
 *
 * Tests vector plugin initialization, embedding generation, pipeline
 * construction, auto-embed hooks, and error handling.
 *
 * Because $vectorSearch is Atlas-only and unavailable in mongodb-memory-server,
 * actual search execution is tested via mocked Model.aggregate while all other
 * behaviour uses real MongoDB.
 */

import type mongoose from 'mongoose';
import mongooseRuntime, { type PipelineStage, Schema, type Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingInput, VectorFieldConfig } from '../src/ai/types.js';
import {
  buildVectorSearchPipeline,
  type VectorMethods,
  vectorPlugin,
} from '../src/ai/vector.plugin.js';
import { methodRegistryPlugin, multiTenantPlugin, Repository } from '../src/index.js';
import type { MultiTenantOptions } from '../src/plugins/multi-tenant.plugin.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

// ============================================================================
// Helpers
// ============================================================================

/** Produces a deterministic fake embedding of the given dimensions */
function fakeEmbedding(dimensions: number, seed = 0): number[] {
  return Array.from({ length: dimensions }, (_, i) => Math.round(Math.sin(i + seed) * 1000) / 1000);
}

const DIMS = 4; // small dimension count keeps tests fast and readable

const defaultField: VectorFieldConfig = {
  path: 'embedding',
  index: 'vec_test_idx',
  dimensions: DIMS,
  similarity: 'cosine',
  sourceFields: ['title', 'description'],
};

// ============================================================================
// Schema
// ============================================================================

interface IVectorDoc {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  embedding?: number[];
}

const VectorSchema = new Schema<IVectorDoc>({
  title: String,
  description: String,
  embedding: [Number],
});

// ============================================================================
// Tests
// ============================================================================

describe('vectorPlugin', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  // ==========================================================================
  // 1. Plugin initialisation validation
  // ==========================================================================

  describe('initialization validation', () => {
    it('should throw when fields array is empty', () => {
      expect(() => vectorPlugin({ fields: [] })).toThrow(/requires at least one field config/);
    });

    it('should throw when fields is undefined', () => {
      expect(() => vectorPlugin({ fields: undefined as any })).toThrow(
        /requires at least one field config/,
      );
    });

    it('should throw when methodRegistryPlugin is not applied', async () => {
      const Model = await createTestModel('VecNoMethodReg', VectorSchema);

      expect(() => new Repository(Model, [vectorPlugin({ fields: [defaultField] })])).toThrow(
        /requires methodRegistryPlugin/,
      );

      await Model.deleteMany({});
    });
  });

  // ==========================================================================
  // 2. searchSimilar - dimension mismatch
  // ==========================================================================

  describe('searchSimilar', () => {
    let VecModel: mongoose.Model<IVectorDoc>;
    let repo: Repository<IVectorDoc> & Record<string, any>;

    beforeAll(async () => {
      VecModel = await createTestModel('VecSearchTest', VectorSchema);
      repo = new Repository(VecModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn: async ({ text }: EmbeddingInput) => fakeEmbedding(DIMS, (text ?? '').length),
        }),
      ]) as typeof repo;
    });

    beforeEach(async () => {
      await VecModel.deleteMany({});
    });

    afterAll(async () => {
      await VecModel.deleteMany({});
    });

    it('should throw on dimension mismatch', async () => {
      const wrongDimsVector = fakeEmbedding(DIMS + 2);

      await expect(repo.searchSimilar({ query: wrongDimsVector, limit: 5 })).rejects.toThrow(
        /dimensions/,
      );
    });

    // ------------------------------------------------------------------------
    // 3. searchSimilar throws when text query used without embedFn
    // ------------------------------------------------------------------------

    it('should throw when text query is used without embedFn', async () => {
      const Model = await createTestModel('VecNoEmbFn', VectorSchema);
      const repoNoFn = new Repository(Model, [
        methodRegistryPlugin(),
        vectorPlugin({ fields: [defaultField] }),
      ]) as typeof repo;

      await expect(repoNoFn.searchSimilar({ query: 'some text', limit: 5 })).rejects.toThrow(
        /require embedFn/,
      );

      await Model.deleteMany({});
    });
  });

  // ==========================================================================
  // 4. embed method
  // ==========================================================================

  describe('embed', () => {
    it('should call the provided embedFn and return the vector', async () => {
      const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
        fakeEmbedding(DIMS, (text ?? '').length),
      );

      const Model = await createTestModel('VecEmbed', VectorSchema);
      const repo = new Repository(Model, [
        methodRegistryPlugin(),
        vectorPlugin({ fields: [defaultField], embedFn }),
      ]) as Repository<IVectorDoc> & Record<string, any>;

      const vector = await repo.embed('hello world');

      expect(embedFn).toHaveBeenCalledWith({ text: 'hello world' });
      expect(vector).toHaveLength(DIMS);
      expect(vector).toEqual(fakeEmbedding(DIMS, 'hello world'.length));

      await Model.deleteMany({});
    });

    it('should accept EmbeddingInput directly', async () => {
      const embedFn = vi.fn(async ({ text, image }: EmbeddingInput) =>
        fakeEmbedding(DIMS, (text ?? '').length),
      );

      const Model = await createTestModel('VecEmbedInput', VectorSchema);
      const repo = new Repository(Model, [
        methodRegistryPlugin(),
        vectorPlugin({ fields: [defaultField], embedFn }),
      ]) as Repository<IVectorDoc> & Record<string, any>;

      const input: EmbeddingInput = { text: 'red shoes', image: 'https://example.com/shoe.jpg' };
      await repo.embed(input);

      expect(embedFn).toHaveBeenCalledWith(input);

      await Model.deleteMany({});
    });
  });

  // ==========================================================================
  // 5. buildVectorSearchPipeline produces correct pipeline structure
  // ==========================================================================

  describe('buildVectorSearchPipeline', () => {
    it('should produce a $vectorSearch stage as the first element', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 5,
      });

      expect(pipeline.length).toBeGreaterThanOrEqual(2); // $vectorSearch + $addFields
      const first = pipeline[0] as any;
      expect(first.$vectorSearch).toBeDefined();
      expect(first.$vectorSearch.index).toBe(defaultField.index);
      expect(first.$vectorSearch.path).toBe(defaultField.path);
      expect(first.$vectorSearch.queryVector).toEqual(queryVector);
      expect(first.$vectorSearch.limit).toBe(5);
    });

    it('should add $addFields for score by default', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 3,
      });

      const addFieldsStage = pipeline.find((s: any) => s.$addFields) as any;
      expect(addFieldsStage).toBeDefined();
      expect(addFieldsStage.$addFields._score).toEqual({ $meta: 'vectorSearchScore' });
    });

    it('should omit score stage when includeScore is false', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 3,
        includeScore: false,
      });

      const addFieldsStage = pipeline.find((s: any) => s.$addFields);
      expect(addFieldsStage).toBeUndefined();
    });

    it('should include $match for minScore when provided', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 10,
        minScore: 0.8,
      });

      const matchStage = pipeline.find((s: any) => s.$match) as any;
      expect(matchStage).toBeDefined();
      expect(matchStage.$match._score.$gte).toBe(0.8);
    });

    it('should include $project stage when project is provided', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 5,
        project: { title: 1 },
      });

      const projectStage = pipeline.find((s: any) => s.$project) as any;
      expect(projectStage).toBeDefined();
      expect(projectStage.$project.title).toBe(1);
      expect(projectStage.$project._score).toBe(1); // score always included
    });

    it('should append postPipeline stages', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 5,
        postPipeline: [{ $sort: { _score: -1 } }],
      });

      const last = pipeline[pipeline.length - 1] as any;
      expect(last.$sort).toEqual({ _score: -1 });
    });

    it('should add filter to $vectorSearch when filter is provided', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 5,
        filter: { status: 'active' },
      });

      const first = pipeline[0] as any;
      expect(first.$vectorSearch.filter).toEqual({ status: 'active' });
    });

    it('should use default numCandidates when not specified', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 5,
      });

      const first = pipeline[0] as any;
      // Default: Math.max(limit * 10, 100) = Math.max(50, 100) = 100
      expect(first.$vectorSearch.numCandidates).toBe(100);
    });
  });

  // ==========================================================================
  // 6. Auto-embed on create
  // ==========================================================================

  describe('auto-embed on create', () => {
    let AutoModel: mongoose.Model<IVectorDoc>;
    const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
      fakeEmbedding(DIMS, (text ?? '').length),
    );

    beforeAll(async () => {
      AutoModel = await createTestModel('VecAutoEmbed', VectorSchema);
    });

    beforeEach(async () => {
      await AutoModel.deleteMany({});
      embedFn.mockClear();
    });

    afterAll(async () => {
      await AutoModel.deleteMany({});
    });

    it('should auto-embed from sourceFields on create', async () => {
      const repo = new Repository(AutoModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn,
          autoEmbed: true,
        }),
      ]);

      const doc = await repo.create({ title: 'Running shoes', description: 'Lightweight' });

      expect(embedFn).toHaveBeenCalledTimes(1);
      // The embedding function receives EmbeddingInput with concatenated source fields
      expect(embedFn).toHaveBeenCalledWith({ text: 'Running shoes Lightweight' });
      // The resulting doc should have an embedding array
      expect(doc.embedding).toBeDefined();
      expect(doc.embedding).toHaveLength(DIMS);
    });

    // -----------------------------------------------------------------------
    // 7. Auto-embed skips when vector already provided
    // -----------------------------------------------------------------------

    it('should skip auto-embed when vector is already provided', async () => {
      const repo = new Repository(AutoModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn,
          autoEmbed: true,
        }),
      ]);

      const precomputed = fakeEmbedding(DIMS, 42);
      const doc = await repo.create({
        title: 'Pre-embedded',
        embedding: precomputed,
      });

      expect(embedFn).not.toHaveBeenCalled();
      expect(doc.embedding).toEqual(precomputed);
    });
  });

  // ==========================================================================
  // 8. Auto-embed on update only when source fields change
  // ==========================================================================

  describe('auto-embed on update', () => {
    let UpdateModel: mongoose.Model<IVectorDoc>;
    const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
      fakeEmbedding(DIMS, (text ?? '').length),
    );

    beforeAll(async () => {
      UpdateModel = await createTestModel('VecAutoUpdate', VectorSchema);
    });

    beforeEach(async () => {
      await UpdateModel.deleteMany({});
      embedFn.mockClear();
    });

    afterAll(async () => {
      await UpdateModel.deleteMany({});
    });

    it('should re-embed when a source field changes', async () => {
      const repo = new Repository(UpdateModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn,
          autoEmbed: true,
        }),
      ]);

      const doc = await repo.create({ title: 'Original', description: 'Desc' });
      embedFn.mockClear(); // reset after create

      const updated = await repo.update(doc._id.toString(), { title: 'Changed title' });

      // embedFn should be called again because 'title' is a sourceField
      expect(embedFn).toHaveBeenCalledTimes(1);
      expect(updated.embedding).toBeDefined();
      expect(updated.embedding).toHaveLength(DIMS);
    });

    it('should NOT re-embed when non-source fields change', async () => {
      // Add a schema with an extra non-source field
      const ExtraSchema = new Schema({
        title: String,
        description: String,
        embedding: [Number],
        status: String,
      });

      const ExtraModel = await createTestModel('VecAutoUpdateExtra', ExtraSchema);
      const repo = new Repository(ExtraModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn,
          autoEmbed: true,
        }),
      ]);

      const doc = await repo.create({ title: 'Keep', description: 'Same', status: 'draft' });
      embedFn.mockClear();

      // Update a field that is NOT in sourceFields
      await repo.update(doc._id.toString(), { status: 'published' });

      // embedFn should NOT have been called
      expect(embedFn).not.toHaveBeenCalled();

      await ExtraModel.deleteMany({});
    });
  });

  // ==========================================================================
  // 9. Batch embedding uses batchEmbedFn when available
  // ==========================================================================

  describe('batch embedding', () => {
    let BatchModel: mongoose.Model<IVectorDoc>;

    beforeAll(async () => {
      BatchModel = await createTestModel('VecBatch', VectorSchema);
    });

    beforeEach(async () => {
      await BatchModel.deleteMany({});
    });

    afterAll(async () => {
      await BatchModel.deleteMany({});
    });

    it('should use batchEmbedFn for createMany', async () => {
      const batchEmbedFn = vi.fn(async (inputs: EmbeddingInput[]) =>
        inputs.map((_, i) => fakeEmbedding(DIMS, i)),
      );
      const singleEmbedFn = vi.fn(async ({ text }: EmbeddingInput) =>
        fakeEmbedding(DIMS, (text ?? '').length),
      );

      const repo = new Repository(BatchModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn: singleEmbedFn,
          batchEmbedFn,
          autoEmbed: true,
        }),
      ]);

      const data = await repo.createMany([
        { title: 'Batch A', description: 'First' },
        { title: 'Batch B', description: 'Second' },
        { title: 'Batch C', description: 'Third' },
      ]);

      // batchEmbedFn should have been called once with all inputs
      expect(batchEmbedFn).toHaveBeenCalledTimes(1);
      expect(batchEmbedFn).toHaveBeenCalledWith([
        { text: 'Batch A First' },
        { text: 'Batch B Second' },
        { text: 'Batch C Third' },
      ]);

      // singleEmbedFn should NOT have been called (batch takes priority)
      expect(singleEmbedFn).not.toHaveBeenCalled();

      // All docs should have embeddings
      for (const doc of data) {
        expect((doc as any).embedding).toBeDefined();
        expect((doc as any).embedding).toHaveLength(DIMS);
      }
    });

    it('should fall back to sequential embedFn when batchEmbedFn is not provided', async () => {
      const singleEmbedFn = vi.fn(async ({ text }: EmbeddingInput) =>
        fakeEmbedding(DIMS, (text ?? '').length),
      );

      const repo = new Repository(BatchModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn: singleEmbedFn,
          autoEmbed: true,
        }),
      ]);

      await repo.createMany([
        { title: 'SeqA', description: 'One' },
        { title: 'SeqB', description: 'Two' },
      ]);

      // Without batchEmbedFn, embedFn is called once per document
      expect(singleEmbedFn).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // 10. Auto-embed on update uses full document (not just partial update data)
  // ==========================================================================

  describe('auto-embed update uses full document', () => {
    let FullDocModel: mongoose.Model<IVectorDoc>;
    const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
      fakeEmbedding(DIMS, (text ?? '').length),
    );

    beforeAll(async () => {
      FullDocModel = await createTestModel('VecFullDocUpdate', VectorSchema);
    });

    beforeEach(async () => {
      await FullDocModel.deleteMany({});
      embedFn.mockClear();
    });

    afterAll(async () => {
      await FullDocModel.deleteMany({});
    });

    it('should embed from ALL source fields on partial update, not just changed fields', async () => {
      const repo = new Repository(FullDocModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn,
          autoEmbed: true,
        }),
      ]);

      // Create with both source fields
      await repo.create({ title: 'Running shoes', description: 'Lightweight and fast' });
      embedFn.mockClear();

      // Update only title — embedding should still use title + description
      const doc = await repo.update((await FullDocModel.findOne({}).lean())!._id.toString(), {
        title: 'Trail shoes',
      });

      expect(embedFn).toHaveBeenCalledTimes(1);
      // Must contain BOTH the new title AND the existing description
      expect(embedFn).toHaveBeenCalledWith({ text: 'Trail shoes Lightweight and fast' });
      expect(doc.embedding).toHaveLength(DIMS);
    });
  });

  // ==========================================================================
  // 11. onEmbedError callback
  // ==========================================================================

  describe('onEmbedError', () => {
    let ErrorModel: mongoose.Model<IVectorDoc>;

    beforeAll(async () => {
      ErrorModel = await createTestModel('VecEmbedError', VectorSchema);
    });

    beforeEach(async () => {
      await ErrorModel.deleteMany({});
    });

    afterAll(async () => {
      await ErrorModel.deleteMany({});
    });

    it('should call onEmbedError and continue write when embedFn throws', async () => {
      const onEmbedError = vi.fn();
      const failingEmbedFn = vi.fn(async () => {
        throw new Error('API down');
      });

      const repo = new Repository(ErrorModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn: failingEmbedFn,
          autoEmbed: true,
          onEmbedError,
        }),
      ]);

      // Should NOT throw — onEmbedError handles the error
      const doc = await repo.create({ title: 'Test', description: 'Data' });

      expect(onEmbedError).toHaveBeenCalledTimes(1);
      expect(onEmbedError.mock.calls[0][0].message).toBe('API down');
      expect(doc.title).toBe('Test');
      // No embedding generated — field is either undefined or empty array (Mongoose [Number] default)
      expect(doc.embedding?.length ?? 0).toBe(0);
    });

    it('should throw when embedFn fails and onEmbedError is NOT provided', async () => {
      const failingEmbedFn = vi.fn(async () => {
        throw new Error('API down');
      });

      const repo = new Repository(ErrorModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [defaultField],
          embedFn: failingEmbedFn,
          autoEmbed: true,
        }),
      ]);

      await expect(repo.create({ title: 'Test', description: 'Data' })).rejects.toThrow('API down');
    });
  });

  // ==========================================================================
  // 12. numCandidates clamping
  // ==========================================================================

  describe('numCandidates bounds', () => {
    it('should clamp numCandidates to 10,000 max', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 2000, // default = max(20000, 100) → would exceed 10k
      });

      const first = pipeline[0] as any;
      expect(first.$vectorSearch.numCandidates).toBe(10_000);
    });

    it('should enforce numCandidates >= limit', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 50,
        numCandidates: 5, // less than limit — should be clamped up
      });

      const first = pipeline[0] as any;
      expect(first.$vectorSearch.numCandidates).toBe(50);
    });

    it('should use 10x multiplier with floor of 100 by default', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 20,
      });

      const first = pipeline[0] as any;
      // max(20*10, 100) = 200, clamped to min(200, 10000) = 200
      expect(first.$vectorSearch.numCandidates).toBe(200);
    });
  });

  // ==========================================================================
  // 13. includeScore:false + minScore auto-enables score
  // ==========================================================================

  describe('includeScore + minScore interaction', () => {
    it('should add $addFields for score when minScore is set even with includeScore:false', () => {
      const queryVector = fakeEmbedding(DIMS);
      const pipeline = buildVectorSearchPipeline(defaultField, queryVector, {
        query: queryVector,
        limit: 5,
        includeScore: false,
        minScore: 0.8,
      });

      // $addFields for _score MUST be present so $match can filter
      const addFieldsStage = pipeline.find((s: any) => s.$addFields);
      expect(addFieldsStage).toBeDefined();

      const matchStage = pipeline.find((s: any) => s.$match) as any;
      expect(matchStage).toBeDefined();
      expect(matchStage.$match._score.$gte).toBe(0.8);
    });
  });

  // ==========================================================================
  // 14. Dot-path sourceFields
  // ==========================================================================

  describe('dot-path sourceFields', () => {
    it('should resolve nested source fields for embedding', async () => {
      const NestedSchema = new Schema({
        metadata: { title: String, description: String },
        embedding: [Number],
      });

      const NestedModel = await createTestModel('VecNested', NestedSchema);
      const embedFn = vi.fn(async ({ text }: EmbeddingInput) =>
        fakeEmbedding(DIMS, (text ?? '').length),
      );

      const nestedField: VectorFieldConfig = {
        path: 'embedding',
        index: 'vec_nested_idx',
        dimensions: DIMS,
        sourceFields: ['metadata.title', 'metadata.description'],
      };

      const repo = new Repository(NestedModel, [
        methodRegistryPlugin(),
        vectorPlugin({
          fields: [nestedField],
          embedFn,
          autoEmbed: true,
        }),
      ]);

      await repo.create({ metadata: { title: 'Nested', description: 'Works' } });

      expect(embedFn).toHaveBeenCalledWith({ text: 'Nested Works' });

      await NestedModel.deleteMany({});
    });
  });

  // ==========================================================================
  // 15. multiTenantPlugin scopes searchSimilar — tenant goes INTO
  //     $vectorSearch.filter (pre-filter), never a post-$match. $vectorSearch
  //     is Atlas-only, so the generated pipeline is captured at Model.aggregate.
  // ==========================================================================

  describe('multi-tenant scoping', () => {
    interface ITenantVecDoc {
      _id: Types.ObjectId;
      organizationId: string;
      title: string;
      embedding?: number[];
    }
    const TenantVecSchema = new Schema<ITenantVecDoc>({
      organizationId: String,
      title: String,
      embedding: [Number],
    });

    let TenantModel: mongoose.Model<ITenantVecDoc>;
    let captured: PipelineStage[][];

    beforeAll(async () => {
      TenantModel = await createTestModel('VecTenantScope', TenantVecSchema);
    });

    beforeEach(() => {
      captured = [];
      vi.spyOn(TenantModel, 'aggregate').mockImplementation(((pipeline: PipelineStage[]) => {
        captured.push(pipeline);
        interface FakeAgg {
          session(): FakeAgg;
          exec(): Promise<unknown[]>;
        }
        const agg: FakeAgg = { session: () => agg, exec: async () => [] };
        return agg;
      }) as unknown as typeof TenantModel.aggregate);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    type SearchRepo = Repository<ITenantVecDoc> & VectorMethods;
    const embedFn = vi.fn(async () => fakeEmbedding(DIMS));
    const makeRepo = (tenantOptions: MultiTenantOptions = {}): SearchRepo =>
      new Repository(TenantModel, [
        methodRegistryPlugin(),
        multiTenantPlugin({ tenantField: 'organizationId', ...tenantOptions }),
        vectorPlugin({ fields: [defaultField], embedFn }),
      ]) as SearchRepo;

    const vectorSearchStage = (pipeline: PipelineStage[]): Record<string, unknown> =>
      (pipeline[0] as unknown as { $vectorSearch: Record<string, unknown> }).$vectorSearch;

    it('injects the tenant into $vectorSearch.filter (pre-filter), not a post-$match', async () => {
      const repo = makeRepo();
      await repo.searchSimilar({ query: fakeEmbedding(DIMS), limit: 5, organizationId: 'org-a' });

      expect(captured).toHaveLength(1);
      const pipeline = captured[0];
      expect(vectorSearchStage(pipeline).filter).toEqual({ organizationId: 'org-a' });
      // No stage after $vectorSearch narrows on the tenant field.
      const postMatches = pipeline
        .slice(1)
        .filter((s) => '$match' in s)
        .map((s) => (s as { $match: Record<string, unknown> }).$match);
      for (const m of postMatches) expect(m).not.toHaveProperty('organizationId');
    });

    it('merges the tenant clause with the caller filter', async () => {
      const repo = makeRepo();
      await repo.searchSimilar({
        query: fakeEmbedding(DIMS),
        filter: { scope: { $in: ['public', 'team'] } },
        organizationId: 'org-a',
      });
      expect(vectorSearchStage(captured[0]).filter).toEqual({
        scope: { $in: ['public', 'team'] },
        organizationId: 'org-a',
      });
    });

    it('casts the tenant to ObjectId when fieldType is objectId', async () => {
      const repo = makeRepo({ fieldType: 'objectId' });
      const orgId = new mongooseRuntime.Types.ObjectId().toString();
      await repo.searchSimilar({ query: fakeEmbedding(DIMS), organizationId: orgId });
      const filter = vectorSearchStage(captured[0]).filter as Record<string, unknown>;
      expect(filter.organizationId).toBeInstanceOf(mongooseRuntime.Types.ObjectId);
      expect(String(filter.organizationId)).toBe(orgId);
    });

    it('throws on a missing required tenant — like other reads — before embedding', async () => {
      const repo = makeRepo();
      embedFn.mockClear();
      await expect(repo.searchSimilar({ query: 'free text', limit: 5 })).rejects.toThrow(
        /Missing 'organizationId' in context for 'searchSimilar'/,
      );
      await expect(repo.getAll({}, {})).rejects.toThrow(/Missing 'organizationId'/);
      expect(embedFn).not.toHaveBeenCalled();
      expect(captured).toHaveLength(0);
    });

    it('rejects a caller filter naming a different tenant (onMismatch: throw)', async () => {
      const repo = makeRepo();
      await expect(
        repo.searchSimilar({
          query: fakeEmbedding(DIMS),
          filter: { organizationId: 'org-b' },
          organizationId: 'org-a',
        }),
      ).rejects.toThrow(/does not match the resolved tenant scope/);
      expect(captured).toHaveLength(0);
    });

    it('resolves the tenant from resolveContext when not passed per call', async () => {
      const repo = makeRepo({ resolveContext: () => 'org-als' });
      await repo.searchSimilar({ query: fakeEmbedding(DIMS) });
      expect(vectorSearchStage(captured[0]).filter).toEqual({ organizationId: 'org-als' });
    });

    it('trusts a caller-stamped tenant filter only with allowDataInjection', async () => {
      const repo = makeRepo({ allowDataInjection: true });
      await repo.searchSimilar({ query: fakeEmbedding(DIMS), filter: { organizationId: 'org-a' } });
      expect(vectorSearchStage(captured[0]).filter).toEqual({ organizationId: 'org-a' });
    });

    it('bypassTenant skips scoping and emits after:tenant-bypass', async () => {
      const repo = makeRepo();
      const bypassed = vi.fn();
      repo.on('after:tenant-bypass', bypassed);
      await repo.searchSimilar({ query: fakeEmbedding(DIMS), bypassTenant: true });
      expect(vectorSearchStage(captured[0])).not.toHaveProperty('filter');
      expect(bypassed).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'searchSimilar', reason: 'option' }),
      );
    });

    it('skipWhen and skipOperations opt searchSimilar out', async () => {
      await makeRepo({ skipWhen: (ctx) => ctx.role === 'superadmin' }).searchSimilar({
        query: fakeEmbedding(DIMS),
        role: 'superadmin',
      });
      await makeRepo({ skipOperations: ['searchSimilar'] }).searchSimilar({
        query: fakeEmbedding(DIMS),
      });
      expect(captured).toHaveLength(2);
      for (const p of captured) expect(vectorSearchStage(p)).not.toHaveProperty('filter');
    });

    it('optional tenant (required: false) leaves an unscoped call unfiltered', async () => {
      const repo = makeRepo({ required: false });
      await repo.searchSimilar({ query: fakeEmbedding(DIMS) });
      expect(vectorSearchStage(captured[0])).not.toHaveProperty('filter');
    });
  });
});
