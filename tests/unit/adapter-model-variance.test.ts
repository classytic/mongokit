/**
 * The adapter boundary pairs a schema-inferred model with a LEAN repository, and
 * still refuses a model that belongs to a different collection.
 *
 * `Model<T>` is invariant in `T`. While `model` was `Model<TDoc>`, a kernel whose
 * repository speaks lean entities (string ids) could not hand over its own
 * hydrated model — the two describe one collection and never unify — so four
 * downstream packages carried an `asEntityModel` cast.
 *
 * Decoupling the document types removes a STATIC cross-check, so the constructor
 * restores it at RUNTIME against `Repository.Model`. That is strictly stronger:
 * two different collections sharing a shape were always statically identical.
 */
import type { AdapterRepositoryInput } from '@classytic/repo-core/adapter';
import mongoose, { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { createMongooseAdapter, MongooseAdapter } from '../../src/adapter/index.js';

/** The LEAN entity a kernel repository speaks — string ids. */
interface Product {
  _id: string;
  name: string;
}

const productSchema = new Schema({ name: String });
const orderSchema = new Schema({ total: Number });

const ProductModel =
  mongoose.models.VarianceProduct ?? mongoose.model('VarianceProduct', productSchema);
const OrderModel = mongoose.models.VarianceOrder ?? mongoose.model('VarianceOrder', orderSchema);

/** A kit-native repository exposes the model it was built on. */
type FakeRepo = AdapterRepositoryInput<Product> & { Model?: unknown };

const repoFor = (model: unknown): FakeRepo => ({
  Model: model,
  getAll: async () => [] as Product[],
  getById: async () => null,
  create: async (d: Partial<Product>) => d as Product,
  update: async (_id: string, d: Partial<Product>) => d as Product,
  delete: async () => null,
});

describe('adapter model variance', () => {
  it('accepts a schema-inferred model beside a LEAN repository — no cast', () => {
    // The pairing that used to be TS2345 and forced `asEntityModel`.
    const adapter = createMongooseAdapter<Product>(ProductModel, repoFor(ProductModel));
    expect(adapter.type).toBe('mongoose');
  });

  it('REFUSES a model bound to a different collection than the repository', () => {
    expect(() => createMongooseAdapter<Product>(OrderModel, repoFor(ProductModel))).toThrow(
      /model\/repository mismatch/,
    );
  });

  it('names both collections in the error, so the fix is obvious', () => {
    try {
      createMongooseAdapter<Product>(OrderModel, repoFor(ProductModel));
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('VarianceOrder');
      expect(message).toContain('VarianceProduct');
    }
  });

  it('stays silent for a repository that exposes no model (BYO / mock)', () => {
    // Absence of an answer is not a negative answer — refusing here would break
    // every legitimate custom repository.
    const { Model: _omitted, ...noModel } = repoFor(ProductModel);
    const adapter = createMongooseAdapter<Product>(ProductModel, noModel);
    expect(adapter.type).toBe('mongoose');
  });

  it('a Schema passed instead of a Model is refused at runtime', () => {
    // `isMongooseModel` requires a constructor function; a Schema is not one.
    expect(() =>
      createMongooseAdapter<Product>(
        productSchema as unknown as typeof ProductModel,
        repoFor(ProductModel),
      ),
    ).toThrow(/invalid `model`/);
  });

  it('the options form carries the same guarantees as the positional form', () => {
    expect(
      () =>
        new MongooseAdapter<Product>({
          model: OrderModel,
          repository: repoFor(ProductModel),
        }),
    ).toThrow(/model\/repository mismatch/);
  });

  it('exposes the model without claiming its document type is the entity', () => {
    const adapter = createMongooseAdapter<Product>(ProductModel, repoFor(ProductModel));
    // `adapter.model` is `Model<unknown>` — read metadata, not documents.
    expect((adapter as MongooseAdapter<Product>).model.modelName).toBe('VarianceProduct');
  });
});
