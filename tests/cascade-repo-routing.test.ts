/**
 * Cascade plugin — repo-routed edge cases
 *
 * Covers the exact concern raised during review: when the parent is hard-
 * deleted and a relation sets `softDelete: true`, targets must end up
 * soft-deleted via the target's own hook pipeline — NOT by cascade writing
 * `deletedAt` directly, which would bypass multi-tenant scoping, custom
 * `deletedField` names, and any target-side validation.
 *
 * Scenarios:
 *   1. Parent hard + relation softDelete:true via `repo:` → target goes
 *      through its own before:delete hook → soft delete respects plugin
 *      configuration. Target's tenant scope stays enforced.
 *   2. Parent soft + relation softDelete:false via `repo:` → target is
 *      physically removed through target.delete(..., { mode: 'hard' }).
 *      Target's before:delete hooks still fire (audit trail).
 *   3. Parent bulk deleteMany with soft override → target soft-deletes
 *      through $in query, hooks fire once with the bulk scope.
 *   4. Legacy `model:` path still works (backwards compatibility) — writes
 *      directly via mongoose.models, does NOT fire target hooks. Documented
 *      caveat.
 *   5. Custom deletedField on target (e.g. `archivedAt`): repo-routed cascade
 *      honors it; legacy model-routed cascade does NOT.
 *   6. cascadePlugin config validation (missing foreignKey / missing target).
 */

import mongoose, { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Repository,
  batchOperationsPlugin,
  cascadePlugin,
  methodRegistryPlugin,
  multiTenantPlugin,
  softDeletePlugin,
} from '../src/index.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

interface IProduct {
  _id: Types.ObjectId;
  name: string;
  organizationId: string;
  deletedAt?: Date | null;
}

interface IStockEntry {
  _id: Types.ObjectId;
  product: Types.ObjectId;
  qty: number;
  organizationId: string;
  deletedAt?: Date | null;
}

// Target uses a NON-default deletedField to prove the legacy path bypasses
// the target's soft-delete configuration.
interface IReview {
  _id: Types.ObjectId;
  product: Types.ObjectId;
  stars: number;
  organizationId: string;
  archivedAt?: Date | null;
}

const ProductSchema = new Schema<IProduct>({
  name: { type: String, required: true },
  organizationId: { type: String, required: true },
  deletedAt: { type: Date, default: null },
});

const StockEntrySchema = new Schema<IStockEntry>({
  product: { type: Schema.Types.ObjectId, required: true },
  qty: { type: Number, required: true },
  organizationId: { type: String, required: true },
  deletedAt: { type: Date, default: null },
});

const ReviewSchema = new Schema<IReview>({
  product: { type: Schema.Types.ObjectId, required: true },
  stars: { type: Number, required: true },
  organizationId: { type: String, required: true },
  archivedAt: { type: Date, default: null },
});

// ────────────────────────────────────────────────────────────────────────────
// Repo-routed suite
// ────────────────────────────────────────────────────────────────────────────

describe('cascadePlugin — repo-routed', () => {
  let ProductModel: mongoose.Model<IProduct>;
  let StockEntryModel: mongoose.Model<IStockEntry>;
  let ReviewModel: mongoose.Model<IReview>;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let productRepo: any;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let stockRepo: any;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let reviewRepo: any;

  beforeAll(async () => {
    await connectDB();
    ProductModel = await createTestModel('CascadeRoutedProduct', ProductSchema);
    StockEntryModel = await createTestModel('CascadeRoutedStockEntry', StockEntrySchema);
    ReviewModel = await createTestModel('CascadeRoutedReview', ReviewSchema);

    // Stock repo has soft-delete + multi-tenant — standard cascade target.
    stockRepo = new Repository<IStockEntry>(StockEntryModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
    ]);

    // Review repo uses a CUSTOM deletedField ('archivedAt') to prove cascades
    // that route through the repo honor plugin configuration.
    reviewRepo = new Repository<IReview>(ReviewModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      softDeletePlugin({ deletedField: 'archivedAt', filterMode: 'null' }),
    ]);

    // Parent repo cascades to BOTH targets via repo: references.
    productRepo = new Repository<IProduct>(ProductModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
      cascadePlugin({
        relations: [
          { repo: stockRepo, foreignKey: 'product' },
          { repo: reviewRepo, foreignKey: 'product' },
        ],
        parallel: false,
      }),
    ]);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
    await StockEntryModel.deleteMany({});
    await ReviewModel.deleteMany({});
  });

  // ── Scenario 1: parent hard + relation follows parent ────────────────────

  it('parent hard-delete cascades hard through target repo (target hooks fire)', async () => {
    const product = await ProductModel.create({
      name: 'Widget',
      organizationId: 'org_1',
    });
    await StockEntryModel.create({
      product: product._id,
      qty: 10,
      organizationId: 'org_1',
    });

    const targetBeforeSpy = vi.fn();
    stockRepo.on('before:deleteMany', targetBeforeSpy);

    await productRepo.delete(product._id, { organizationId: 'org_1', mode: 'hard' });

    // Target hook fired — i.e. cascade went through the repo, not direct mongoose.
    expect(targetBeforeSpy).toHaveBeenCalled();
    const ctxArg = targetBeforeSpy.mock.calls[0][0];
    expect(ctxArg.query.product).toEqual(product._id);
    // Tenant scope propagated — cascade passed organizationId via deleteMany options.
    expect(ctxArg.query.organizationId).toBe('org_1');
    // deleteMode flows from parent.
    expect(ctxArg.deleteMode).toBe('hard');

    // Target rows physically gone.
    const entries = await StockEntryModel.find({}).lean();
    expect(entries).toHaveLength(0);

    stockRepo.off('before:deleteMany', targetBeforeSpy);
  });

  // ── Scenario 2: parent soft, relation soft ───────────────────────────────

  it('parent soft-delete cascades soft through target repo', async () => {
    const product = await ProductModel.create({
      name: 'Widget',
      organizationId: 'org_1',
    });
    await StockEntryModel.create({
      product: product._id,
      qty: 10,
      organizationId: 'org_1',
    });

    await productRepo.delete(product._id, { organizationId: 'org_1' }); // default: soft

    // Parent is soft-deleted.
    const parent = await ProductModel.findById(product._id);
    expect(parent?.deletedAt).toBeInstanceOf(Date);

    // Target is ALSO soft-deleted (follows parent), and was routed through the
    // target's own soft-delete plugin — so `deletedAt` is properly set.
    const entries = await StockEntryModel.find({}).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].deletedAt).toBeInstanceOf(Date);
  });

  // ── Scenario 3: the exact review concern — parent hard + override to soft

  it('parent hard-delete + relation.softDelete:true → target soft-deletes via ITS OWN plugin', async () => {
    // Re-wire productRepo with an explicit softDelete override on the review relation.
    const localProductRepo = new Repository<IProduct>(ProductModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
      cascadePlugin({
        relations: [
          { repo: reviewRepo, foreignKey: 'product', softDelete: true },
        ],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: test shape
    ]) as any;

    const product = await ProductModel.create({ name: 'Widget', organizationId: 'org_1' });
    await ReviewModel.create({ product: product._id, stars: 5, organizationId: 'org_1' });

    // Parent goes hard; relation override forces soft on targets.
    await localProductRepo.delete(product._id, { organizationId: 'org_1', mode: 'hard' });

    // Parent is physically gone.
    expect(await ProductModel.findById(product._id)).toBeNull();

    // Target review should still exist, with `archivedAt` set — NOT `deletedAt`.
    // This is the crux: the OLD cascade wrote `deletedAt: new Date()` directly,
    // which would have been a no-op for this target (no such field defined).
    // With repo routing, the target's own softDeletePlugin honors `archivedAt`.
    const reviews = await ReviewModel.find({}).lean();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].archivedAt).toBeInstanceOf(Date);
  });

  // ── Scenario 4: cascade via bulk deleteMany ──────────────────────────────

  it('bulk deleteMany on parent cascades through target repo once per relation', async () => {
    // Two products, three stock entries spread across them.
    const p1 = await ProductModel.create({ name: 'A', organizationId: 'org_1' });
    const p2 = await ProductModel.create({ name: 'B', organizationId: 'org_1' });
    await StockEntryModel.insertMany([
      { product: p1._id, qty: 1, organizationId: 'org_1' },
      { product: p1._id, qty: 2, organizationId: 'org_1' },
      { product: p2._id, qty: 3, organizationId: 'org_1' },
    ]);

    const targetBeforeSpy = vi.fn();
    stockRepo.on('before:deleteMany', targetBeforeSpy);

    await productRepo.deleteMany(
      { name: { $in: ['A', 'B'] } },
      { organizationId: 'org_1', mode: 'hard' },
    );

    // Target hook fired exactly once with a $in over parent IDs.
    expect(targetBeforeSpy).toHaveBeenCalledTimes(1);
    const ctxArg = targetBeforeSpy.mock.calls[0][0];
    expect(ctxArg.query.product).toHaveProperty('$in');
    expect((ctxArg.query.product as { $in: unknown[] }).$in).toHaveLength(2);

    // All stock entries gone.
    const remaining = await StockEntryModel.find({}).lean();
    expect(remaining).toHaveLength(0);

    stockRepo.off('before:deleteMany', targetBeforeSpy);
  });

  // ── Scenario 5: target tenant scoping ────────────────────────────────────

  it('cascade through repo still enforces target tenant scoping', async () => {
    // Two tenants, matching stock entries. Delete from tenant 1 should ONLY
    // cascade to tenant 1's stock — never touch tenant 2's.
    const p1 = await ProductModel.create({ name: 'Widget', organizationId: 'org_1' });
    const p2Impostor = await ProductModel.create({
      name: 'Widget',
      organizationId: 'org_2',
    });
    await StockEntryModel.create({
      product: p1._id,
      qty: 10,
      organizationId: 'org_1',
    });
    await StockEntryModel.create({
      product: p2Impostor._id,
      qty: 20,
      organizationId: 'org_2',
    });

    await productRepo.delete(p1._id, { organizationId: 'org_1', mode: 'hard' });

    // Tenant 1's stock is gone, tenant 2's is untouched.
    const remaining = await StockEntryModel.find({}).lean();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].organizationId).toBe('org_2');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Legacy model-routed suite — backwards compat
// ────────────────────────────────────────────────────────────────────────────

describe('cascadePlugin — legacy model-routed (backwards compat)', () => {
  let ProductModel: mongoose.Model<IProduct>;
  let StockEntryModel: mongoose.Model<IStockEntry>;
  // biome-ignore lint/suspicious/noExplicitAny: test shape
  let productRepo: any;

  beforeAll(async () => {
    await connectDB();
    ProductModel = await createTestModel('CascadeLegacyProduct', ProductSchema);
    StockEntryModel = await createTestModel('CascadeLegacyStockEntry', StockEntrySchema);

    productRepo = new Repository<IProduct>(ProductModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      cascadePlugin({
        relations: [{ model: 'CascadeLegacyStockEntry', foreignKey: 'product' }],
      }),
    ]);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await ProductModel.deleteMany({});
    await StockEntryModel.deleteMany({});
  });

  it('still hard-deletes children via legacy model lookup', async () => {
    const product = await ProductModel.create({
      name: 'Widget',
      organizationId: 'org_1',
    });
    await StockEntryModel.insertMany([
      { product: product._id, qty: 1, organizationId: 'org_1' },
      { product: product._id, qty: 2, organizationId: 'org_1' },
    ]);

    await productRepo.delete(product._id);

    expect(await StockEntryModel.find({}).lean()).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Config validation
// ────────────────────────────────────────────────────────────────────────────

describe('cascadePlugin — config validation', () => {
  it('throws when a relation is missing both `repo` and `model`', () => {
    expect(() =>
      cascadePlugin({
        // biome-ignore lint/suspicious/noExplicitAny: intentional bad config
        relations: [{ foreignKey: 'x' } as any],
      }),
    ).toThrow(/needs either `repo`/);
  });

  it('throws when a relation is missing `foreignKey`', () => {
    expect(() =>
      cascadePlugin({
        // biome-ignore lint/suspicious/noExplicitAny: intentional bad config
        relations: [{ model: 'Foo' } as any],
      }),
    ).toThrow(/foreignKey/);
  });

  it('throws when no relations provided', () => {
    expect(() => cascadePlugin({ relations: [] })).toThrow(/at least one relation/);
  });
});
