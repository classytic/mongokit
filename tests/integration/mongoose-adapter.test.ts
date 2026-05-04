/**
 * Integration tests for `MongooseAdapter` / `createMongooseAdapter`.
 *
 * Pre-3.12.x the adapter shipped with three documented gaps:
 *
 *  1. `extractRelations` always tagged every ref as `'one-to-one'`,
 *     even when the path was declared as `[{ type: ObjectId, ref }]`
 *     (one-to-many). Hosts trusting the metadata for OpenAPI / docs got
 *     wrong relation cardinality.
 *  2. `generateSchemas` swallowed every generator error with a bare
 *     `catch {}`. A broken `schemaGenerator` callback (typo, missing
 *     property, throw) silently returned `null` — host's OpenAPI just
 *     missed the resource with no diagnostic.
 *  3. Zero direct tests covered any of the contract methods. The only
 *     reference was the conformance test's typecheck probe.
 *
 * This file fills all three with executable assertions.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongooseAdapter, MongooseAdapter } from '../../src/adapter/index.js';
import { Repository } from '../../src/index.js';
import { configureLogger } from '../../src/utils/logger.js';
import { connectDB, disconnectDB } from '../setup.js';

interface IAuthor {
  _id: Types.ObjectId;
  name: string;
}
interface IPost {
  _id: Types.ObjectId;
  title: string;
  views: number;
  published: boolean;
  publishedAt?: Date;
  authorId: Types.ObjectId;
  // Array of refs — `extractRelations` should detect this as one-to-many.
  contributors: Types.ObjectId[];
}

describe('MongooseAdapter', () => {
  let AuthorModel: mongoose.Model<IAuthor>;
  let PostModel: mongoose.Model<IPost>;

  beforeAll(async () => {
    await connectDB();
    for (const n of ['AdapterAuthor', 'AdapterPost']) {
      if (mongoose.models[n]) delete mongoose.models[n];
    }
    AuthorModel = mongoose.model<IAuthor>(
      'AdapterAuthor',
      new Schema<IAuthor>({ name: { type: String, required: true } }),
    );
    PostModel = mongoose.model<IPost>(
      'AdapterPost',
      new Schema<IPost>({
        title: { type: String, required: true },
        views: { type: Number, required: true },
        published: { type: Boolean },
        publishedAt: { type: Date },
        authorId: { type: Schema.Types.ObjectId, ref: 'AdapterAuthor', required: true },
        contributors: [{ type: Schema.Types.ObjectId, ref: 'AdapterAuthor' }],
      }),
    );
    await AuthorModel.init();
    await PostModel.init();
  });

  afterAll(async () => {
    await PostModel.deleteMany({});
    await AuthorModel.deleteMany({});
    await disconnectDB();
  });

  // ─── Construction & shape ─────────────────────────────────────────

  describe('construction', () => {
    it('object form returns a `DataAdapter` with type/name/repository', () => {
      const adapter = createMongooseAdapter({
        model: PostModel,
        repository: new Repository<IPost>(PostModel),
      });
      expect(adapter.type).toBe('mongoose');
      expect(adapter.name).toBe('MongooseAdapter<AdapterPost>');
      expect(adapter.repository).toBeDefined();
    });

    it('2-arg shorthand form works identically', () => {
      const adapter = createMongooseAdapter(PostModel, new Repository<IPost>(PostModel));
      expect(adapter.type).toBe('mongoose');
      expect(adapter.name).toBe('MongooseAdapter<AdapterPost>');
    });

    it('throws on a non-Mongoose model', () => {
      expect(() =>
        createMongooseAdapter({
          model: { not: 'a model' } as never,
          repository: new Repository<IPost>(PostModel) as never,
        }),
      ).toThrow(/Invalid model/i);
    });

    it('throws on a non-Repository value', () => {
      expect(() =>
        createMongooseAdapter({
          model: PostModel,
          repository: { not: 'a repo' } as never,
        }),
      ).toThrow(/Invalid repository/i);
    });

    it('2-arg shorthand throws when repository is missing', () => {
      expect(() =>
        (createMongooseAdapter as unknown as (model: unknown) => unknown)(PostModel),
      ).toThrow(/repository is required/i);
    });
  });

  // ─── hasFieldPath ─────────────────────────────────────────────────

  describe('hasFieldPath', () => {
    let adapter: MongooseAdapter<IPost>;
    beforeAll(() => {
      adapter = new MongooseAdapter<IPost>({
        model: PostModel,
        repository: new Repository<IPost>(PostModel),
      });
    });

    it('returns true for declared paths', () => {
      expect(adapter.hasFieldPath('title')).toBe(true);
      expect(adapter.hasFieldPath('authorId')).toBe(true);
      expect(adapter.hasFieldPath('contributors')).toBe(true);
    });

    it('returns false for undeclared paths', () => {
      expect(adapter.hasFieldPath('nonExistent')).toBe(false);
      expect(adapter.hasFieldPath('organizationId')).toBe(false);
    });
  });

  // ─── getSchemaMetadata ─────────────────────────────────────────────

  describe('getSchemaMetadata', () => {
    let adapter: MongooseAdapter<IPost>;
    beforeAll(() => {
      adapter = new MongooseAdapter<IPost>({
        model: PostModel,
        repository: new Repository<IPost>(PostModel),
      });
    });

    it('returns the model name', () => {
      expect(adapter.getSchemaMetadata().name).toBe('AdapterPost');
    });

    it('maps mongoose types to portable field types', () => {
      const fields = adapter.getSchemaMetadata().fields;
      expect(fields.title?.type).toBe('string');
      expect(fields.views?.type).toBe('number');
      expect(fields.published?.type).toBe('boolean');
      expect(fields.publishedAt?.type).toBe('date');
      expect(fields.authorId?.type).toBe('objectId');
      expect(fields.title?.required).toBe(true);
      expect(fields.published?.required).toBe(false);
    });

    it('preserves `ref` for ObjectId fields', () => {
      expect(adapter.getSchemaMetadata().fields.authorId?.ref).toBe('AdapterAuthor');
    });

    // ─── BUG: extractRelations always returned 'one-to-one' ──────────

    it('reports a single ref as one-to-one', () => {
      const relations = adapter.getSchemaMetadata().relations;
      expect(relations?.authorId).toMatchObject({
        type: 'one-to-one',
        target: 'AdapterAuthor',
        foreignKey: 'authorId',
      });
    });

    it('reports an array-of-refs as one-to-many (regression — was always one-to-one)', () => {
      const relations = adapter.getSchemaMetadata().relations;
      expect(relations?.contributors).toMatchObject({
        type: 'one-to-many',
        target: 'AdapterAuthor',
        foreignKey: 'contributors',
      });
    });

    it('returns undefined relations when no refs are declared', () => {
      const PlainSchema = new Schema({ name: String });
      if (mongoose.models.AdapterPlain) delete mongoose.models.AdapterPlain;
      const PlainModel = mongoose.model('AdapterPlain', PlainSchema);
      const plainAdapter = new MongooseAdapter({
        model: PlainModel,
        repository: new Repository(PlainModel),
      });
      expect(plainAdapter.getSchemaMetadata().relations).toBeUndefined();
    });
  });

  // ─── generateSchemas ───────────────────────────────────────────────

  describe('generateSchemas', () => {
    it('returns null when no schemaGenerator is configured', () => {
      const adapter = new MongooseAdapter<IPost>({
        model: PostModel,
        repository: new Repository<IPost>(PostModel),
      });
      expect(adapter.generateSchemas()).toBeNull();
    });

    it('delegates to the configured schemaGenerator', () => {
      const generator = vi.fn().mockReturnValue({
        params: { type: 'object' },
        createBody: { type: 'object' },
        updateBody: { type: 'object' },
        listQuery: { type: 'object' },
      });
      const adapter = new MongooseAdapter<IPost>({
        model: PostModel,
        repository: new Repository<IPost>(PostModel),
        schemaGenerator: generator,
      });
      const result = adapter.generateSchemas();
      expect(generator).toHaveBeenCalledTimes(1);
      expect(generator).toHaveBeenCalledWith(PostModel, undefined, undefined);
      expect(result).toMatchObject({ params: { type: 'object' } });
    });

    it('forwards options + context to the generator', () => {
      const generator = vi.fn().mockReturnValue({});
      const adapter = new MongooseAdapter<IPost>({
        model: PostModel,
        repository: new Repository<IPost>(PostModel),
        schemaGenerator: generator,
      });
      adapter.generateSchemas({ idField: '_id' }, { name: 'post' });
      expect(generator).toHaveBeenCalledWith(
        PostModel,
        { idField: '_id' },
        { name: 'post' },
      );
    });

    // ─── BUG: silent catch swallowed every generator error ─────────────

    it('logs a diagnostic and returns null when the generator throws (regression — was a silent catch)', () => {
      const warnSpy = vi.fn();
      configureLogger({ warn: warnSpy });
      try {
        const generator = vi.fn().mockImplementation(() => {
          throw new Error('boom — generator broke');
        });
        const adapter = new MongooseAdapter<IPost>({
          model: PostModel,
          repository: new Repository<IPost>(PostModel),
          schemaGenerator: generator,
        });
        const result = adapter.generateSchemas();
        expect(result).toBeNull();
        // The warn must fire — pre-fix the catch was bare so nothing
        // surfaced and consumers had no signal a resource was missing.
        expect(warnSpy).toHaveBeenCalled();
        const message = (warnSpy.mock.calls[0]?.[0] as string) ?? '';
        expect(message).toMatch(/MongooseAdapter|schemaGenerator/i);
        expect(message).toMatch(/boom/);
      } finally {
        // Restore the default logger so other test files aren't affected.
        configureLogger({ warn: console.warn.bind(console) });
      }
    });
  });

  // ─── validate (default no-op) ──────────────────────────────────────

  describe('validate (default no-op)', () => {
    it('returns valid: true (mongoose enforces validation at save)', () => {
      const adapter = new MongooseAdapter<IPost>({
        model: PostModel,
        repository: new Repository<IPost>(PostModel),
      });
      expect(adapter.validate({ anything: 'goes' })).toEqual({ valid: true });
    });
  });

  // ─── End-to-end: adapter wires repo into the contract ──────────────

  describe('repository round-trip', () => {
    let adapter: MongooseAdapter<IPost>;
    beforeEach(async () => {
      await PostModel.deleteMany({});
      await AuthorModel.deleteMany({});
      adapter = new MongooseAdapter<IPost>({
        model: PostModel,
        repository: new Repository<IPost>(PostModel),
      });
    });
    afterEach(async () => {
      await PostModel.deleteMany({});
    });

    it('exposes the repository for hosts to call CRUD through', async () => {
      const author = await AuthorModel.create({ name: 'A' });
      const created = (await adapter.repository.create!({
        title: 'Hello',
        views: 0,
        published: false,
        authorId: author._id,
        contributors: [],
      } as Partial<IPost>)) as IPost;
      expect(created.title).toBe('Hello');
      const found = (await adapter.repository.getById!(String(created._id))) as IPost | null;
      expect(found?.title).toBe('Hello');
    });
  });
});
