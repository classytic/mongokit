/**
 * Advanced Update Features Integration Tests
 *
 * Tests for:
 * 1. atomicUpdate() — composite MongoDB operators in a single call
 * 2. bulkWrite() — heterogeneous batch operations
 * 3. arrayFilters — positional operator updates on nested array elements
 *
 * Uses MongoMemoryServer for real MongoDB operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Repository } from '../src/Repository.js';
import { methodRegistryPlugin } from '../src/plugins/method-registry.plugin.js';
import { mongoOperationsPlugin } from '../src/plugins/mongo-operations.plugin.js';
import type { MongoOperationsMethods } from '../src/plugins/mongo-operations.plugin.js';
import { batchOperationsPlugin } from '../src/plugins/batch-operations.plugin.js';
import type { BatchOperationsMethods, BulkWriteResult } from '../src/plugins/batch-operations.plugin.js';
import { connectDB, disconnectDB, clearDB, createTestModel } from './setup.js';

// ============================================================================
// Test Schemas — realistic domain models
// ============================================================================

interface IPost {
  _id: mongoose.Types.ObjectId;
  title: string;
  body: string;
  views: number;
  reactionCount: number;
  lastActiveAt: Date | null;
  tags: string[];
  history: Array<{ action: string; at: Date }>;
  poll?: {
    question: string;
    options: Array<{
      _id: mongoose.Types.ObjectId;
      text: string;
      voteCount: number;
    }>;
    totalVotes: number;
  };
}

const postSchema = new mongoose.Schema<IPost>({
  title: { type: String, required: true },
  body: { type: String, default: '' },
  views: { type: Number, default: 0 },
  reactionCount: { type: Number, default: 0 },
  lastActiveAt: { type: Date, default: null },
  tags: [{ type: String }],
  history: [{
    action: { type: String },
    at: { type: Date },
  }],
  poll: {
    question: { type: String },
    options: [{
      text: { type: String },
      voteCount: { type: Number, default: 0 },
    }],
    totalVotes: { type: Number, default: 0 },
  },
}, { timestamps: true, strict: false });

interface IPlayer {
  _id: mongoose.Types.ObjectId;
  name: string;
  stats: {
    gamesPlayed: number;
    totalScore: number;
    wins: number;
    losses: number;
    lastPlayedAt: Date | null;
    tournamentsParticipated: number;
    lastActiveAt: Date | null;
  };
  badges: string[];
  badgeCount: number;
}

const playerSchema = new mongoose.Schema<IPlayer>({
  name: { type: String, required: true },
  stats: {
    gamesPlayed: { type: Number, default: 0 },
    totalScore: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    lastPlayedAt: { type: Date, default: null },
    tournamentsParticipated: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: null },
  },
  badges: [{ type: String }],
  badgeCount: { type: Number, default: 0 },
}, { timestamps: true, strict: false });

interface IProduct {
  _id: mongoose.Types.ObjectId;
  name: string;
  price: number;
  stock: number;
  status: string;
  category: string;
}

const productSchema = new mongoose.Schema<IProduct>({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  stock: { type: Number, default: 0 },
  status: { type: String, default: 'draft' },
  category: { type: String, default: 'general' },
}, { timestamps: true });

// ============================================================================
// Type helpers
// ============================================================================

type PostRepo = Repository<IPost> & MongoOperationsMethods<IPost> & BatchOperationsMethods;
type PlayerRepo = Repository<IPlayer> & MongoOperationsMethods<IPlayer> & BatchOperationsMethods;
type ProductRepo = Repository<IProduct> & MongoOperationsMethods<IProduct> & BatchOperationsMethods;

// ============================================================================
// Test Suite
// ============================================================================

describe('Advanced Update Features', () => {
  let PostModel: mongoose.Model<IPost>;
  let PlayerModel: mongoose.Model<IPlayer>;
  let ProductModel: mongoose.Model<IProduct>;
  let postRepo: PostRepo;
  let playerRepo: PlayerRepo;
  let productRepo: ProductRepo;

  const plugins = [
    methodRegistryPlugin(),
    mongoOperationsPlugin(),
    batchOperationsPlugin(),
  ];

  beforeAll(async () => {
    await connectDB();
    // Model names prefixed with this file's subject ('AdvUpd') so collections
    // don't collide with tests/repository.advanced.test.ts, which also uses
    // an 'Adv' prefix. Parallel forks share the same MongoMemoryServer URI,
    // so two files with the same mongoose model name end up writing to the
    // same collection and racing through each other's beforeEach resets.
    PostModel = await createTestModel<IPost>('AdvUpdPost', postSchema);
    PlayerModel = await createTestModel<IPlayer>('AdvUpdPlayer', playerSchema);
    ProductModel = await createTestModel<IProduct>('AdvUpdProduct', productSchema);

    postRepo = new Repository(PostModel, plugins) as PostRepo;
    playerRepo = new Repository(PlayerModel, plugins) as PlayerRepo;
    productRepo = new Repository(ProductModel, plugins) as ProductRepo;
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await clearDB();
  });

  // ==========================================================================
  // 1. atomicUpdate() — Composite MongoDB Operators
  // ==========================================================================

  describe('atomicUpdate() — Composite Operators', () => {
    it('should combine $inc and $set in a single atomic operation', async () => {
      const post = await postRepo.create({
        title: 'Test Post',
        views: 10,
        reactionCount: 5,
      } as Partial<IPost>);

      const now = new Date();
      const updated = await postRepo.atomicUpdate(post._id.toString(), {
        $inc: { views: 1, reactionCount: -1 },
        $set: { lastActiveAt: now },
      });

      expect(updated).toBeDefined();
      expect((updated as Record<string, unknown>).views).toBe(11);
      expect((updated as Record<string, unknown>).reactionCount).toBe(4);
      expect(new Date((updated as Record<string, unknown>).lastActiveAt as string).getTime()).toBe(now.getTime());
    });

    it('should handle $inc + $set + $push (reaction toggle pattern)', async () => {
      const post = await postRepo.create({
        title: 'Reaction Post',
        reactionCount: 3,
        history: [],
      } as Partial<IPost>);

      const updated = await postRepo.atomicUpdate(post._id.toString(), {
        $inc: { reactionCount: -1 },
        $set: { lastActiveAt: new Date() },
        $push: { history: { action: 'unreact', at: new Date() } },
      });

      expect((updated as Record<string, unknown>).reactionCount).toBe(2);
      expect((updated as Record<string, unknown>).lastActiveAt).toBeTruthy();
      const history = (updated as Record<string, unknown>).history as Array<Record<string, unknown>>;
      expect(history).toHaveLength(1);
      expect(history[0].action).toBe('unreact');
    });

    it('should handle player stats update pattern ($inc multiple nested fields + $set)', async () => {
      const player = await playerRepo.create({
        name: 'Player One',
        stats: {
          gamesPlayed: 10,
          totalScore: 500,
          wins: 7,
          losses: 3,
          lastPlayedAt: null,
          tournamentsParticipated: 0,
          lastActiveAt: null,
        },
        badges: [],
        badgeCount: 0,
      } as Partial<IPlayer>);

      const now = new Date();
      const updated = await playerRepo.atomicUpdate(player._id.toString(), {
        $inc: {
          'stats.gamesPlayed': 1,
          'stats.totalScore': 42,
          'stats.wins': 1,
        },
        $set: {
          'stats.lastPlayedAt': now,
          'stats.lastActiveAt': now,
        },
      });

      const stats = (updated as Record<string, unknown>).stats as Record<string, unknown>;
      expect(stats.gamesPlayed).toBe(11);
      expect(stats.totalScore).toBe(542);
      expect(stats.wins).toBe(8);
      expect(stats.losses).toBe(3); // unchanged
      expect(new Date(stats.lastPlayedAt as string).getTime()).toBe(now.getTime());
    });

    it('should handle $push with $each modifier for batch badge awards', async () => {
      const player = await playerRepo.create({
        name: 'Badge Collector',
        badges: ['starter'],
        badgeCount: 1,
      } as Partial<IPlayer>);

      const newBadges = ['gold', 'silver', 'mvp'];
      const updated = await playerRepo.atomicUpdate(player._id.toString(), {
        $push: { badges: { $each: newBadges } as unknown as Record<string, unknown> },
        $inc: { badgeCount: newBadges.length },
      });

      const badges = (updated as Record<string, unknown>).badges as string[];
      expect(badges).toHaveLength(4);
      expect(badges).toContain('starter');
      expect(badges).toContain('gold');
      expect(badges).toContain('silver');
      expect(badges).toContain('mvp');
      expect((updated as Record<string, unknown>).badgeCount).toBe(4);
    });

    it('should handle $addToSet to prevent duplicate tags', async () => {
      const post = await postRepo.create({
        title: 'Tagged Post',
        tags: ['sports', 'news'],
      } as Partial<IPost>);

      const updated = await postRepo.atomicUpdate(post._id.toString(), {
        $addToSet: { tags: 'sports' }, // already exists
        $inc: { views: 1 },
      });

      const tags = (updated as Record<string, unknown>).tags as string[];
      expect(tags).toHaveLength(2); // no duplicate
      expect((updated as Record<string, unknown>).views).toBe(1);
    });

    it('should handle $pull + $inc for removing and counting', async () => {
      const post = await postRepo.create({
        title: 'Tag Removal',
        tags: ['sports', 'news', 'featured'],
        reactionCount: 3,
      } as Partial<IPost>);

      const updated = await postRepo.atomicUpdate(post._id.toString(), {
        $pull: { tags: 'featured' },
        $inc: { reactionCount: -1 },
      });

      const tags = (updated as Record<string, unknown>).tags as string[];
      expect(tags).toHaveLength(2);
      expect(tags).not.toContain('featured');
      expect((updated as Record<string, unknown>).reactionCount).toBe(2);
    });

    it('should handle $unset to remove fields', async () => {
      const post = await postRepo.create({
        title: 'Unset Test',
        lastActiveAt: new Date(),
        views: 5,
      } as Partial<IPost>);

      const updated = await postRepo.atomicUpdate(post._id.toString(), {
        $unset: { lastActiveAt: '' as unknown as Record<string, unknown> },
        $inc: { views: 1 },
      }) as Record<string, unknown>;

      // $unset sets schema-defined fields to null (Mongoose behavior)
      expect(updated.lastActiveAt).toBeFalsy();
      expect(updated.views).toBe(6);
    });

    it('should handle $currentDate operator', async () => {
      const post = await postRepo.create({
        title: 'CurrentDate Test',
        views: 0,
      } as Partial<IPost>);

      const before = Date.now() - 1000; // 1s buffer for clock skew
      const updated = await postRepo.atomicUpdate(post._id.toString(), {
        $currentDate: { lastActiveAt: { $type: 'date' } as unknown as Record<string, unknown> },
        $inc: { views: 1 },
      }) as Record<string, unknown>;

      const lastActive = new Date(updated.lastActiveAt as string).getTime();
      expect(lastActive).toBeGreaterThanOrEqual(before);
      expect(lastActive).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('should reject empty operators object', async () => {
      const post = await postRepo.create({ title: 'Empty ops' } as Partial<IPost>);
      await expect(
        postRepo.atomicUpdate(post._id.toString(), {})
      ).rejects.toThrow('at least one operator');
    });

    it('should reject invalid operators', async () => {
      const post = await postRepo.create({ title: 'Bad ops' } as Partial<IPost>);
      await expect(
        postRepo.atomicUpdate(post._id.toString(), {
          $invalid: { field: 'value' },
        })
      ).rejects.toThrow('Invalid update operator');
    });

    it('returns null for non-existent document (MinimalRepo contract)', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const result = await postRepo.atomicUpdate(fakeId.toString(), {
        $inc: { views: 1 },
      });
      expect(result).toBeNull();
    });

    it('should handle tournament bulk stats update pattern', async () => {
      // Create multiple players
      const p1 = await playerRepo.create({
        name: 'Player 1',
        stats: { gamesPlayed: 0, totalScore: 0, wins: 0, losses: 0, lastPlayedAt: null, tournamentsParticipated: 0, lastActiveAt: null },
        badges: [], badgeCount: 0,
      } as Partial<IPlayer>);
      const p2 = await playerRepo.create({
        name: 'Player 2',
        stats: { gamesPlayed: 5, totalScore: 200, wins: 3, losses: 2, lastPlayedAt: null, tournamentsParticipated: 1, lastActiveAt: null },
        badges: ['starter'], badgeCount: 1,
      } as Partial<IPlayer>);

      // Update both with tournament participation
      const now = new Date();
      await playerRepo.updateMany(
        { _id: { $in: [p1._id, p2._id] } },
        {
          $inc: { 'stats.tournamentsParticipated': 1 },
          $set: { 'stats.lastActiveAt': now },
        },
      );

      const updated1 = await playerRepo.getById(p1._id.toString()) as Record<string, unknown>;
      const updated2 = await playerRepo.getById(p2._id.toString()) as Record<string, unknown>;

      expect((updated1.stats as Record<string, unknown>).tournamentsParticipated).toBe(1);
      expect((updated2.stats as Record<string, unknown>).tournamentsParticipated).toBe(2);
    });
  });

  // ==========================================================================
  // 2. bulkWrite() — Heterogeneous Batch Operations
  // ==========================================================================

  describe('bulkWrite() — Heterogeneous Batch Operations', () => {
    it('should execute mixed insertOne + updateOne + deleteOne', async () => {
      const existing = await productRepo.create({
        name: 'Existing Product',
        price: 50,
        stock: 10,
        status: 'active',
      } as Partial<IProduct>);

      const toDelete = await productRepo.create({
        name: 'Delete Me',
        price: 5,
        stock: 0,
        status: 'archived',
      } as Partial<IProduct>);

      const result = await productRepo.bulkWrite([
        { insertOne: { document: { name: 'New Product', price: 100, stock: 50, status: 'active', category: 'electronics' } } },
        { updateOne: { filter: { _id: existing._id }, update: { $inc: { stock: 5 }, $set: { status: 'restocked' } } } },
        { deleteOne: { filter: { _id: toDelete._id } } },
      ]);

      expect(result.insertedCount).toBe(1);
      expect(result.modifiedCount).toBe(1);
      expect(result.deletedCount).toBe(1);

      // Verify the insert
      const allProducts = await ProductModel.find({}).lean();
      expect(allProducts).toHaveLength(2); // existing (updated) + new

      // Verify the update
      const updatedExisting = await ProductModel.findById(existing._id).lean();
      expect(updatedExisting!.stock).toBe(15);
      expect(updatedExisting!.status).toBe('restocked');

      // Verify the delete
      const deleted = await ProductModel.findById(toDelete._id).lean();
      expect(deleted).toBeNull();
    });

    it('should handle updateMany within bulkWrite', async () => {
      await productRepo.create({ name: 'P1', price: 10, status: 'draft' } as Partial<IProduct>);
      await productRepo.create({ name: 'P2', price: 20, status: 'draft' } as Partial<IProduct>);
      await productRepo.create({ name: 'P3', price: 30, status: 'active' } as Partial<IProduct>);

      const result = await productRepo.bulkWrite([
        { updateMany: { filter: { status: 'draft' }, update: { $set: { status: 'published' } } } },
      ]);

      expect(result.modifiedCount).toBe(2);

      const published = await ProductModel.find({ status: 'published' }).lean();
      expect(published).toHaveLength(2);
    });

    it('should handle replaceOne within bulkWrite', async () => {
      const product = await productRepo.create({
        name: 'Old Product',
        price: 10,
        stock: 5,
        status: 'active',
      } as Partial<IProduct>);

      const result = await productRepo.bulkWrite([
        {
          replaceOne: {
            filter: { _id: product._id },
            replacement: { name: 'Replaced Product', price: 99, stock: 100, status: 'active', category: 'premium' },
          },
        },
      ]);

      expect(result.modifiedCount).toBe(1);

      const replaced = await ProductModel.findById(product._id).lean();
      expect(replaced!.name).toBe('Replaced Product');
      expect(replaced!.price).toBe(99);
      expect(replaced!.stock).toBe(100);
    });

    it('should handle multiple inserts efficiently', async () => {
      const result = await productRepo.bulkWrite([
        { insertOne: { document: { name: 'Bulk 1', price: 10, stock: 1 } } },
        { insertOne: { document: { name: 'Bulk 2', price: 20, stock: 2 } } },
        { insertOne: { document: { name: 'Bulk 3', price: 30, stock: 3 } } },
        { insertOne: { document: { name: 'Bulk 4', price: 40, stock: 4 } } },
        { insertOne: { document: { name: 'Bulk 5', price: 50, stock: 5 } } },
      ]);

      expect(result.insertedCount).toBe(5);
      expect(Object.keys(result.insertedIds)).toHaveLength(5);

      const count = await ProductModel.countDocuments();
      expect(count).toBe(5);
    });

    it('should handle ordered=false for parallel execution', async () => {
      const p1 = await productRepo.create({ name: 'P1', price: 10, stock: 10 } as Partial<IProduct>);
      const p2 = await productRepo.create({ name: 'P2', price: 20, stock: 20 } as Partial<IProduct>);

      const result = await productRepo.bulkWrite([
        { updateOne: { filter: { _id: p1._id }, update: { $inc: { stock: -3 } } } },
        { updateOne: { filter: { _id: p2._id }, update: { $inc: { stock: -5 } } } },
      ], { ordered: false });

      expect(result.modifiedCount).toBe(2);

      const updated1 = await ProductModel.findById(p1._id).lean();
      const updated2 = await ProductModel.findById(p2._id).lean();
      expect(updated1!.stock).toBe(7);
      expect(updated2!.stock).toBe(15);
    });

    it('should reject empty operations array', async () => {
      await expect(productRepo.bulkWrite([])).rejects.toThrow('at least one operation');
    });

    it('should handle deleteMany within bulkWrite', async () => {
      await productRepo.create({ name: 'Keep', price: 50, status: 'active' } as Partial<IProduct>);
      await productRepo.create({ name: 'Delete1', price: 5, status: 'archived' } as Partial<IProduct>);
      await productRepo.create({ name: 'Delete2', price: 3, status: 'archived' } as Partial<IProduct>);

      const result = await productRepo.bulkWrite([
        { deleteMany: { filter: { status: 'archived' } } },
      ]);

      expect(result.deletedCount).toBe(2);
      const remaining = await ProductModel.countDocuments();
      expect(remaining).toBe(1);
    });

    it('should handle complex real-world scenario: inventory rebalancing', async () => {
      // Simulate inventory rebalancing: restock some, mark others out-of-stock, add new items
      const low1 = await productRepo.create({ name: 'Low Stock 1', price: 10, stock: 2, status: 'active' } as Partial<IProduct>);
      const low2 = await productRepo.create({ name: 'Low Stock 2', price: 20, stock: 1, status: 'active' } as Partial<IProduct>);
      const empty = await productRepo.create({ name: 'Empty', price: 15, stock: 0, status: 'active' } as Partial<IProduct>);

      const result = await productRepo.bulkWrite([
        // Restock low items
        { updateOne: { filter: { _id: low1._id }, update: { $inc: { stock: 50 } } } },
        { updateOne: { filter: { _id: low2._id }, update: { $inc: { stock: 30 } } } },
        // Mark empty as out-of-stock
        { updateOne: { filter: { _id: empty._id }, update: { $set: { status: 'out-of-stock' } } } },
        // Add new products
        { insertOne: { document: { name: 'New Arrival 1', price: 99, stock: 100, status: 'active', category: 'electronics' } } },
        { insertOne: { document: { name: 'New Arrival 2', price: 149, stock: 75, status: 'active', category: 'electronics' } } },
      ]);

      expect(result.modifiedCount).toBe(3);
      expect(result.insertedCount).toBe(2);

      const updatedLow1 = await ProductModel.findById(low1._id).lean();
      expect(updatedLow1!.stock).toBe(52);

      const updatedEmpty = await ProductModel.findById(empty._id).lean();
      expect(updatedEmpty!.status).toBe('out-of-stock');

      const total = await ProductModel.countDocuments();
      expect(total).toBe(5);
    });

    it('should return correct result shape (BulkWriteResult)', async () => {
      const result = await productRepo.bulkWrite([
        { insertOne: { document: { name: 'Shape Test', price: 10 } } },
      ]);

      // Verify the result has the expected properties
      expect(result).toHaveProperty('ok');
      expect(result).toHaveProperty('insertedCount');
      expect(result).toHaveProperty('upsertedCount');
      expect(result).toHaveProperty('matchedCount');
      expect(result).toHaveProperty('modifiedCount');
      expect(result).toHaveProperty('deletedCount');
      expect(result).toHaveProperty('insertedIds');
      expect(result).toHaveProperty('upsertedIds');
    });
  });

  // ==========================================================================
  // 3. arrayFilters — Positional Operator Updates
  // ==========================================================================

  describe('arrayFilters — Positional Operator Updates', () => {
    it('should update specific array element by condition via Repository.update()', async () => {
      // Create a post with poll options
      const post = await postRepo.create({
        title: 'Poll Post',
        poll: {
          question: 'Favorite sport?',
          options: [
            { text: 'Football', voteCount: 0 },
            { text: 'Basketball', voteCount: 0 },
            { text: 'Tennis', voteCount: 0 },
          ],
          totalVotes: 0,
        },
      } as Partial<IPost>);

      // Get the option ID for "Basketball"
      const rawPost = await PostModel.findById(post._id).lean();
      const basketballOption = rawPost!.poll!.options.find(o => o.text === 'Basketball');
      const optionId = basketballOption!._id;

      // Update vote count for Basketball using arrayFilters
      const updated = await postRepo.update(post._id.toString(), {
        $set: { 'poll.options.$[opt].voteCount': 5 },
        $inc: { 'poll.totalVotes': 5 },
      }, {
        arrayFilters: [{ 'opt._id': optionId }],
      }) as Record<string, unknown>;

      const poll = updated.poll as Record<string, unknown>;
      const options = poll.options as Array<Record<string, unknown>>;
      const basketball = options.find(o => o.text === 'Basketball');
      expect(basketball!.voteCount).toBe(5);
      expect(poll.totalVotes).toBe(5);

      // Other options unchanged
      const football = options.find(o => o.text === 'Football');
      expect(football!.voteCount).toBe(0);
    });

    it('should update multiple array elements matching a condition', async () => {
      const post = await postRepo.create({
        title: 'Multi-filter Post',
        poll: {
          question: 'Skill level?',
          options: [
            { text: 'Beginner', voteCount: 10 },
            { text: 'Intermediate', voteCount: 3 },
            { text: 'Advanced', voteCount: 1 },
          ],
          totalVotes: 14,
        },
      } as Partial<IPost>);

      // Reset all options with voteCount < 5 to 0
      const updated = await postRepo.update(post._id.toString(), {
        $set: { 'poll.options.$[low].voteCount': 0 },
      }, {
        arrayFilters: [{ 'low.voteCount': { $lt: 5 } }],
      }) as Record<string, unknown>;

      const options = (updated.poll as Record<string, unknown>).options as Array<Record<string, unknown>>;
      const beginner = options.find(o => o.text === 'Beginner');
      const intermediate = options.find(o => o.text === 'Intermediate');
      const advanced = options.find(o => o.text === 'Advanced');

      expect(beginner!.voteCount).toBe(10); // >= 5, unchanged
      expect(intermediate!.voteCount).toBe(0); // was 3, reset
      expect(advanced!.voteCount).toBe(0); // was 1, reset
    });

    it('should work with atomicUpdate() + arrayFilters together', async () => {
      const post = await postRepo.create({
        title: 'Atomic ArrayFilter Post',
        views: 0,
        poll: {
          question: 'Best framework?',
          options: [
            { text: 'React', voteCount: 10 },
            { text: 'Vue', voteCount: 5 },
            { text: 'Angular', voteCount: 3 },
          ],
          totalVotes: 18,
        },
      } as Partial<IPost>);

      const rawPost = await PostModel.findById(post._id).lean();
      const reactOption = rawPost!.poll!.options.find(o => o.text === 'React');

      // atomicUpdate uses repo.update() internally, so arrayFilters flow through
      const updated = await postRepo.atomicUpdate(post._id.toString(), {
        $inc: { 'poll.options.$[opt].voteCount': 1, 'poll.totalVotes': 1, views: 1 },
        $set: { lastActiveAt: new Date() },
      }, {
        arrayFilters: [{ 'opt._id': reactOption!._id }],
      }) as Record<string, unknown>;

      const poll = updated.poll as Record<string, unknown>;
      const options = poll.options as Array<Record<string, unknown>>;
      const react = options.find(o => o.text === 'React');
      expect(react!.voteCount).toBe(11);
      expect(poll.totalVotes).toBe(19);
      expect(updated.views).toBe(1);
    });

    it('should work with the update action directly (low-level)', async () => {
      const post = await PostModel.create({
        title: 'Direct Action Test',
        poll: {
          question: 'Color?',
          options: [
            { text: 'Red', voteCount: 0 },
            { text: 'Blue', voteCount: 0 },
          ],
          totalVotes: 0,
        },
      });

      const blueOption = post.poll!.options.find(o => o.text === 'Blue');

      // Use the update action directly
      const { update } = await import('../src/actions/update.js');
      const updated = await update(PostModel, post._id, {
        $inc: { 'poll.options.$[opt].voteCount': 3 },
      }, {
        arrayFilters: [{ 'opt._id': blueOption!._id }],
      }) as Record<string, unknown>;

      const options = (updated.poll as Record<string, unknown>).options as Array<Record<string, unknown>>;
      const blue = options.find(o => o.text === 'Blue');
      expect(blue!.voteCount).toBe(3);
    });

    it('should handle nested array element updates with complex conditions', async () => {
      const post = await postRepo.create({
        title: 'Complex Filter Post',
        poll: {
          question: 'Rating?',
          options: [
            { text: '1 star', voteCount: 100 },
            { text: '2 stars', voteCount: 50 },
            { text: '3 stars', voteCount: 200 },
            { text: '4 stars', voteCount: 150 },
            { text: '5 stars', voteCount: 300 },
          ],
          totalVotes: 800,
        },
      } as Partial<IPost>);

      // Double the vote count for options with more than 100 votes
      // Use $mul isn't directly in arrayFilters, so instead use $set with computed value
      // More realistically: increment high-vote options by 10
      const updated = await postRepo.update(post._id.toString(), {
        $inc: { 'poll.options.$[popular].voteCount': 10 },
      }, {
        arrayFilters: [{ 'popular.voteCount': { $gte: 100 } }],
      }) as Record<string, unknown>;

      const options = (updated.poll as Record<string, unknown>).options as Array<Record<string, unknown>>;
      expect(options.find(o => o.text === '1 star')!.voteCount).toBe(110); // 100 + 10
      expect(options.find(o => o.text === '2 stars')!.voteCount).toBe(50); // unchanged (<100)
      expect(options.find(o => o.text === '3 stars')!.voteCount).toBe(210); // 200 + 10
      expect(options.find(o => o.text === '4 stars')!.voteCount).toBe(160); // 150 + 10
      expect(options.find(o => o.text === '5 stars')!.voteCount).toBe(310); // 300 + 10
    });
  });

  // ==========================================================================
  // 4. Real-World Scenario Tests
  // ==========================================================================

  describe('Real-World Scenarios', () => {
    it('scenario: social feed reaction toggle (atomicUpdate)', async () => {
      const post = await postRepo.create({
        title: 'Popular Post',
        reactionCount: 42,
        views: 1000,
        history: [],
      } as Partial<IPost>);

      // User adds reaction
      await postRepo.atomicUpdate(post._id.toString(), {
        $inc: { reactionCount: 1 },
        $set: { lastActiveAt: new Date() },
        $push: { history: { action: 'react', at: new Date() } },
      });

      // User removes reaction
      const final = await postRepo.atomicUpdate(post._id.toString(), {
        $inc: { reactionCount: -1 },
        $set: { lastActiveAt: new Date() },
        $push: { history: { action: 'unreact', at: new Date() } },
      }) as Record<string, unknown>;

      expect(final.reactionCount).toBe(42); // back to original
      const history = final.history as Array<Record<string, unknown>>;
      expect(history).toHaveLength(2);
      expect(history[0].action).toBe('react');
      expect(history[1].action).toBe('unreact');
    });

    it('scenario: e-commerce flash sale (bulkWrite)', async () => {
      // Create products
      const p1 = await productRepo.create({ name: 'Widget', price: 50, stock: 100, status: 'active' } as Partial<IProduct>);
      const p2 = await productRepo.create({ name: 'Gadget', price: 75, stock: 50, status: 'active' } as Partial<IProduct>);
      const p3 = await productRepo.create({ name: 'Doohickey', price: 25, stock: 200, status: 'active' } as Partial<IProduct>);

      // Flash sale: discount prices, add sale status, remove expired product
      const expiredId = new mongoose.Types.ObjectId();
      await ProductModel.create({ _id: expiredId, name: 'Expired', price: 10, stock: 0, status: 'expired' });

      const result = await productRepo.bulkWrite([
        { updateOne: { filter: { _id: p1._id }, update: { $set: { price: 40, status: 'sale' } } } },
        { updateOne: { filter: { _id: p2._id }, update: { $set: { price: 60, status: 'sale' } } } },
        { updateOne: { filter: { _id: p3._id }, update: { $set: { price: 20, status: 'sale' } } } },
        { deleteOne: { filter: { _id: expiredId } } },
        { insertOne: { document: { name: 'Flash Deal', price: 5, stock: 1000, status: 'sale', category: 'featured' } } },
      ]);

      expect(result.modifiedCount).toBe(3);
      expect(result.deletedCount).toBe(1);
      expect(result.insertedCount).toBe(1);

      const saleItems = await ProductModel.find({ status: 'sale' }).lean();
      expect(saleItems).toHaveLength(4);
    });

    it('scenario: poll voting with arrayFilters + atomicUpdate', async () => {
      const post = await postRepo.create({
        title: 'Weekly Poll',
        views: 0,
        poll: {
          question: 'Best programming language?',
          options: [
            { text: 'TypeScript', voteCount: 0 },
            { text: 'Rust', voteCount: 0 },
            { text: 'Go', voteCount: 0 },
            { text: 'Python', voteCount: 0 },
          ],
          totalVotes: 0,
        },
      } as Partial<IPost>);

      const raw = await PostModel.findById(post._id).lean();
      const tsOption = raw!.poll!.options.find(o => o.text === 'TypeScript');
      const rustOption = raw!.poll!.options.find(o => o.text === 'Rust');

      // 3 people vote TypeScript
      for (let i = 0; i < 3; i++) {
        await postRepo.atomicUpdate(post._id.toString(), {
          $inc: { 'poll.options.$[opt].voteCount': 1, 'poll.totalVotes': 1, views: 1 },
        }, {
          arrayFilters: [{ 'opt._id': tsOption!._id }],
        });
      }

      // 2 people vote Rust
      for (let i = 0; i < 2; i++) {
        await postRepo.atomicUpdate(post._id.toString(), {
          $inc: { 'poll.options.$[opt].voteCount': 1, 'poll.totalVotes': 1, views: 1 },
        }, {
          arrayFilters: [{ 'opt._id': rustOption!._id }],
        });
      }

      const final = await PostModel.findById(post._id).lean();
      expect(final!.poll!.totalVotes).toBe(5);
      expect(final!.poll!.options.find(o => o.text === 'TypeScript')!.voteCount).toBe(3);
      expect(final!.poll!.options.find(o => o.text === 'Rust')!.voteCount).toBe(2);
      expect(final!.poll!.options.find(o => o.text === 'Go')!.voteCount).toBe(0);
      expect(final!.views).toBe(5);
    });

    it('scenario: game season end — batch player stats reset + awards (bulkWrite + atomicUpdate)', async () => {
      // Create players with season stats
      const winner = await playerRepo.create({
        name: 'Season Winner',
        stats: { gamesPlayed: 50, totalScore: 5000, wins: 40, losses: 10, lastPlayedAt: new Date(), tournamentsParticipated: 5, lastActiveAt: new Date() },
        badges: ['participant'],
        badgeCount: 1,
      } as Partial<IPlayer>);

      const runner = await playerRepo.create({
        name: 'Runner Up',
        stats: { gamesPlayed: 45, totalScore: 4200, wins: 35, losses: 10, lastPlayedAt: new Date(), tournamentsParticipated: 4, lastActiveAt: new Date() },
        badges: ['participant'],
        badgeCount: 1,
      } as Partial<IPlayer>);

      // Award badges to winners
      await playerRepo.atomicUpdate(winner._id.toString(), {
        $push: { badges: { $each: ['champion', 'mvp'] } as unknown as Record<string, unknown> },
        $inc: { badgeCount: 2 },
      });

      await playerRepo.atomicUpdate(runner._id.toString(), {
        $push: { badges: 'runner-up' as unknown as Record<string, unknown> },
        $inc: { badgeCount: 1 },
      });

      // Verify awards
      const updatedWinner = await PlayerModel.findById(winner._id).lean();
      const updatedRunner = await PlayerModel.findById(runner._id).lean();

      expect(updatedWinner!.badges).toContain('champion');
      expect(updatedWinner!.badges).toContain('mvp');
      expect(updatedWinner!.badgeCount).toBe(3);

      expect(updatedRunner!.badges).toContain('runner-up');
      expect(updatedRunner!.badgeCount).toBe(2);
    });
  });
});
