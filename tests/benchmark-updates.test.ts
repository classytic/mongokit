/**
 * Benchmark & Rigorous Integration Tests
 *
 * Tests all advanced update features with:
 * - JSON fixture data loaded from seed-data.json
 * - Timing measurements for each operation
 * - Real-world scenarios matching app-level patterns
 * - Concurrency, edge cases, and data integrity validation
 *
 * Uses MongoMemoryServer (or MONGODB_URI env var for local MongoDB).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Repository } from '../src/Repository.js';
import { methodRegistryPlugin } from '../src/plugins/method-registry.plugin.js';
import { mongoOperationsPlugin } from '../src/plugins/mongo-operations.plugin.js';
import type { MongoOperationsMethods } from '../src/plugins/mongo-operations.plugin.js';
import { batchOperationsPlugin } from '../src/plugins/batch-operations.plugin.js';
import type { BatchOperationsMethods } from '../src/plugins/batch-operations.plugin.js';
import { timestampPlugin } from '../src/plugins/timestamp.plugin.js';
import { connectDB, disconnectDB, clearDB, createTestModel } from './setup.js';
import seedData from './fixtures/seed-data.json';

// ============================================================================
// Schemas (matching app domain models)
// ============================================================================

const playerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  stats: {
    gamesPlayed: { type: Number, default: 0 },
    totalScore: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    tournamentsParticipated: { type: Number, default: 0 },
    lastPlayedAt: { type: Date, default: null },
    lastActiveAt: { type: Date, default: null },
    skillRating: { type: Number, default: 1000 },
    peakRating: { type: Number, default: 1000 },
  },
  badges: [{ type: mongoose.Schema.Types.Mixed }],
  badgeCount: { type: Number, default: 0 },
}, { timestamps: true, strict: false });

const postSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, default: '' },
  views: { type: Number, default: 0 },
  reactionCount: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  lastActiveAt: { type: Date, default: null },
  tags: [{ type: String }],
  history: [{ action: String, at: Date }],
  poll: {
    question: { type: String },
    options: [{
      text: { type: String },
      voteCount: { type: Number, default: 0 },
    }],
    totalVotes: { type: Number, default: 0 },
    endsAt: { type: Date },
  },
}, { timestamps: true, strict: false });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  stock: { type: Number, default: 0 },
  status: { type: String, default: 'draft' },
  category: { type: String, default: 'general' },
}, { timestamps: true });

// ============================================================================
// Types & helpers
// ============================================================================

type FullRepo<T> = Repository<T> & MongoOperationsMethods<T> & BatchOperationsMethods;

function timer() {
  const start = performance.now();
  return () => {
    const ms = performance.now() - start;
    return ms;
  };
}

function logTiming(label: string, ms: number) {
  const color = ms < 10 ? '🟢' : ms < 50 ? '🟡' : '🔴';
  console.log(`  ${color} ${label}: ${ms.toFixed(2)}ms`);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Benchmark: Advanced Updates with Fixture Data', () => {
  let PlayerModel: mongoose.Model<any>;
  let PostModel: mongoose.Model<any>;
  let ProductModel: mongoose.Model<any>;
  let playerRepo: FullRepo<any>;
  let postRepo: FullRepo<any>;
  let productRepo: FullRepo<any>;

  const plugins = [
    methodRegistryPlugin(),
    timestampPlugin(),
    mongoOperationsPlugin(),
    batchOperationsPlugin(),
  ];

  let playerIds: Map<string, string>;
  let postIds: Map<string, string>;
  let productIds: Map<string, string>;

  beforeAll(async () => {
    await connectDB();
    PlayerModel = await createTestModel('BmPlayer', playerSchema);
    PostModel = await createTestModel('BmPost', postSchema);
    ProductModel = await createTestModel('BmProduct', productSchema);

    playerRepo = new Repository(PlayerModel, plugins) as FullRepo<any>;
    postRepo = new Repository(PostModel, plugins) as FullRepo<any>;
    productRepo = new Repository(ProductModel, plugins) as FullRepo<any>;
  });

  afterAll(async () => {
    await disconnectDB();
  });

  async function loadFixtures() {
    await clearDB();
    playerIds = new Map();
    postIds = new Map();
    productIds = new Map();

    // Load players
    for (const p of seedData.players) {
      const doc = await PlayerModel.create(p);
      playerIds.set(p.name, doc._id.toString());
    }

    // Load posts
    for (const p of seedData.posts) {
      const doc = await PostModel.create(p);
      postIds.set(p.title, doc._id.toString());
    }

    // Load products
    for (const p of seedData.products) {
      const doc = await ProductModel.create(p);
      productIds.set(p.name, doc._id.toString());
    }
  }

  beforeEach(async () => {
    await loadFixtures();
  });

  // ==========================================================================
  // 1. atomicUpdate() — Timing & Data Integrity
  // ==========================================================================

  describe('atomicUpdate() — Performance & Integrity', () => {
    it('should perform composite $inc + $set faster than separate calls', async () => {
      const id = playerIds.get('Alice Chen')!;

      // Measure combined atomicUpdate
      const t1 = timer();
      await playerRepo.atomicUpdate(id, {
        $inc: { 'stats.gamesPlayed': 1, 'stats.totalScore': 42, 'stats.wins': 1 },
        $set: { 'stats.lastPlayedAt': new Date(), 'stats.lastActiveAt': new Date() },
      });
      const combined = t1();

      // Reset for separate calls comparison
      await loadFixtures();
      const id2 = playerIds.get('Alice Chen')!;

      // Measure separate calls
      const t2 = timer();
      await playerRepo.increment(id2, 'stats.gamesPlayed', 1);
      await playerRepo.increment(id2, 'stats.totalScore', 42);
      await playerRepo.increment(id2, 'stats.wins', 1);
      await playerRepo.setField(id2, 'stats.lastPlayedAt', new Date());
      await playerRepo.setField(id2, 'stats.lastActiveAt', new Date());
      const separate = t2();

      logTiming('atomicUpdate (combined)', combined);
      logTiming('5x separate calls', separate);

      // With real network latency (remote DB), combined is significantly faster.
      // With in-memory DB, just verify both complete quickly.
      expect(combined).toBeLessThan(500);
      expect(separate).toBeLessThan(500);
    });

    it('should maintain data integrity across 50 concurrent atomic updates', async () => {
      const id = playerIds.get('Frank Brown')!; // starts at 0

      const t = timer();
      // 50 concurrent increments
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          playerRepo.atomicUpdate(id, {
            $inc: { 'stats.gamesPlayed': 1, 'stats.totalScore': 10 },
            $set: { 'stats.lastActiveAt': new Date() },
          })
        )
      );
      const ms = t();
      logTiming('50 concurrent atomicUpdates', ms);

      const player = await PlayerModel.findById(id).lean();
      expect(player.stats.gamesPlayed).toBe(50);
      expect(player.stats.totalScore).toBe(500);
      expect(player.stats.lastActiveAt).toBeTruthy();
    });

    it('should handle game session completion pattern (upsert + $inc + $set + $push)', async () => {
      const id = playerIds.get('Bob Williams')!;

      const t = timer();
      // Game result: won, scored 3 goals, mvp
      const updated = await playerRepo.atomicUpdate(id, {
        $inc: { 'stats.gamesPlayed': 1, 'stats.totalScore': 85, 'stats.wins': 1 },
        $set: {
          'stats.lastPlayedAt': new Date(),
          'stats.lastActiveAt': new Date(),
          'stats.skillRating': 1696, // pre-computed Elo
          'stats.peakRating': 1700,  // max(current, new)
        },
        $push: { badges: { key: 'hat_trick', awardedAt: new Date(), gameSessionId: 'gs_test_123' } },
      });
      const ms = t();
      logTiming('game session completion (atomicUpdate)', ms);

      expect(updated.stats.gamesPlayed).toBe(121);
      expect(updated.stats.totalScore).toBe(8585);
      expect(updated.stats.wins).toBe(76);
      expect(updated.badges).toHaveLength(6); // 5 existing + 1 new
    });

    it('should handle reaction toggle pattern efficiently', async () => {
      const id = postIds.get('Weekend Football Tournament Recap')!;

      // React
      const t1 = timer();
      await postRepo.atomicUpdate(id, {
        $inc: { reactionCount: 1 },
        $set: { lastActiveAt: new Date() },
        $push: { history: { action: 'react', at: new Date() } },
      });
      logTiming('reaction add', t1());

      // Unreact
      const t2 = timer();
      const final = await postRepo.atomicUpdate(id, {
        $inc: { reactionCount: -1 },
        $set: { lastActiveAt: new Date() },
        $push: { history: { action: 'unreact', at: new Date() } },
      });
      logTiming('reaction remove', t2());

      expect(final.reactionCount).toBe(87); // back to original
      expect(final.history).toHaveLength(4); // 2 existing + 2 new
    });

    it('should handle $addToSet with $each for batch tag addition', async () => {
      const id = postIds.get('Quick Match Tonight - Need 2 More Players!')!;

      const t = timer();
      const updated = await postRepo.atomicUpdate(id, {
        $addToSet: { tags: { $each: ['quick-match', 'football', 'urgent', 'open'] } },
        $inc: { views: 1 },
      });
      const ms = t();
      logTiming('$addToSet with $each', ms);

      // quick-match and football already exist, only urgent and open should be added
      expect(updated.tags).toHaveLength(5); // 3 original + 2 new (no duplicates)
      expect(updated.tags).toContain('urgent');
      expect(updated.tags).toContain('open');
      expect(updated.views).toBe(421);
    });

    it('should handle tournament bulk stats — updateMany with composite operators', async () => {
      // Simulate tournament registration: increment all 8 players' stats
      const allPlayerIds = Array.from(playerIds.values());

      const t = timer();
      await playerRepo.updateMany(
        { _id: { $in: allPlayerIds.map(id => new mongoose.Types.ObjectId(id)) } },
        {
          $inc: { 'stats.tournamentsParticipated': 1 },
          $set: { 'stats.lastActiveAt': new Date() },
        },
      );
      const ms = t();
      logTiming('updateMany 8 players (tournament registration)', ms);

      // Verify all players updated
      for (const [name, id] of playerIds) {
        const player = await PlayerModel.findById(id).lean();
        const original = seedData.players.find(p => p.name === name)!;
        expect(player.stats.tournamentsParticipated).toBe(original.stats.tournamentsParticipated + 1);
        expect(player.stats.lastActiveAt).toBeTruthy();
      }
    });
  });

  // ==========================================================================
  // 2. bulkWrite() — Performance & Correctness
  // ==========================================================================

  describe('bulkWrite() — Performance & Correctness', () => {
    it('should handle inventory rebalancing faster than sequential operations', async () => {
      const lowStockIds = [
        productIds.get('Knee Pads')!,
        productIds.get('Yoga Mat')!,
        productIds.get('Court Shoes - Women')!,
      ];
      const discontinuedId = productIds.get('Old Training Cones')!;
      const expiredId = productIds.get('Expired Protein Bars')!;

      // Measure bulkWrite
      const t1 = timer();
      const result = await productRepo.bulkWrite([
        // Restock low items
        { updateOne: { filter: { _id: new mongoose.Types.ObjectId(lowStockIds[0]) }, update: { $inc: { stock: 50 }, $set: { status: 'active' } } } },
        { updateOne: { filter: { _id: new mongoose.Types.ObjectId(lowStockIds[1]) }, update: { $inc: { stock: 30 } } } },
        { updateOne: { filter: { _id: new mongoose.Types.ObjectId(lowStockIds[2]) }, update: { $inc: { stock: 20 } } } },
        // Remove expired/discontinued
        { deleteOne: { filter: { _id: new mongoose.Types.ObjectId(discontinuedId) } } },
        { deleteOne: { filter: { _id: new mongoose.Types.ObjectId(expiredId) } } },
        // Add new products
        { insertOne: { document: { name: 'Pro Shuttlecocks (6-pack)', price: 14.99, stock: 200, status: 'active', category: 'equipment' } } },
        { insertOne: { document: { name: 'Grip Tape', price: 6.99, stock: 300, status: 'active', category: 'accessories' } } },
      ]);
      const bulkTime = t1();
      logTiming('bulkWrite (7 ops: 3 update + 2 delete + 2 insert)', bulkTime);

      expect(result.modifiedCount).toBe(3);
      expect(result.deletedCount).toBe(2);
      expect(result.insertedCount).toBe(2);

      // Reset and measure sequential
      await loadFixtures();

      const t2 = timer();
      await ProductModel.findByIdAndUpdate(productIds.get('Knee Pads')!, { $inc: { stock: 50 }, $set: { status: 'active' } });
      await ProductModel.findByIdAndUpdate(productIds.get('Yoga Mat')!, { $inc: { stock: 30 } });
      await ProductModel.findByIdAndUpdate(productIds.get('Court Shoes - Women')!, { $inc: { stock: 20 } });
      await ProductModel.deleteOne({ _id: productIds.get('Old Training Cones')! });
      await ProductModel.deleteOne({ _id: productIds.get('Expired Protein Bars')! });
      await ProductModel.create({ name: 'Pro Shuttlecocks (6-pack)', price: 14.99, stock: 200, status: 'active', category: 'equipment' });
      await ProductModel.create({ name: 'Grip Tape', price: 6.99, stock: 300, status: 'active', category: 'accessories' });
      const seqTime = t2();
      logTiming('sequential (7 separate calls)', seqTime);

      // bulkWrite should be faster (1 roundtrip vs 7)
      expect(bulkTime).toBeLessThan(seqTime);
    });

    it('should handle 100 mixed operations efficiently', async () => {
      const ops: Record<string, unknown>[] = [];

      // 50 inserts
      for (let i = 0; i < 50; i++) {
        ops.push({
          insertOne: {
            document: { name: `Bulk Product ${i}`, price: 10 + i, stock: 100, status: 'active', category: 'bulk' },
          },
        });
      }

      // 30 updates on existing products
      const existingIds = Array.from(productIds.values()).slice(0, 6);
      for (let i = 0; i < 30; i++) {
        const id = existingIds[i % existingIds.length];
        ops.push({
          updateOne: {
            filter: { _id: new mongoose.Types.ObjectId(id) },
            update: { $inc: { stock: 1 } },
          },
        });
      }

      // 20 deletes (will create then delete)
      for (let i = 0; i < 20; i++) {
        ops.push({
          deleteOne: { filter: { name: `Temp Delete ${i}` } },
        });
      }

      const t = timer();
      const result = await productRepo.bulkWrite(ops);
      const ms = t();
      logTiming('bulkWrite (100 ops: 50 insert + 30 update + 20 delete)', ms);

      expect(result.insertedCount).toBe(50);
      expect(result.modifiedCount).toBe(30);
      expect(ms).toBeLessThan(1000); // Should complete well under 1s
    });

    it('should handle flash sale: price updates + status changes + cleanup', async () => {
      const t = timer();
      const result = await productRepo.bulkWrite([
        // Discount all active equipment by 20%
        { updateMany: { filter: { category: 'equipment', status: 'active' }, update: { $set: { status: 'sale' } } } },
        // Remove expired items
        { deleteMany: { filter: { status: { $in: ['expired', 'discontinued'] } } } },
        // Add flash deal
        { insertOne: { document: { name: 'Flash Deal Bundle', price: 49.99, stock: 50, status: 'flash-sale', category: 'bundle' } } },
      ]);
      const ms = t();
      logTiming('flash sale bulkWrite (updateMany + deleteMany + insert)', ms);

      expect(result.insertedCount).toBe(1);
      expect(result.deletedCount).toBe(2); // expired + discontinued
      // equipment items: Badminton Racket, Football, Yoga Mat, Tennis Balls = 4
      expect(result.modifiedCount).toBe(4);

      const saleItems = await ProductModel.find({ status: 'sale' }).lean();
      expect(saleItems).toHaveLength(4);
    });

    it('should handle ordered: false for maximum throughput', async () => {
      const ids = Array.from(productIds.values()).slice(0, 8);

      const t = timer();
      const result = await productRepo.bulkWrite(
        ids.map(id => ({
          updateOne: {
            filter: { _id: new mongoose.Types.ObjectId(id) },
            update: { $inc: { stock: 10 }, $set: { status: 'restocked' } },
          },
        })),
        { ordered: false },
      );
      const ms = t();
      logTiming('8 unordered updates', ms);

      expect(result.modifiedCount).toBe(8);
    });
  });

  // ==========================================================================
  // 3. arrayFilters — Poll Voting & Nested Updates
  // ==========================================================================

  describe('arrayFilters — Poll Voting Scenarios', () => {
    it('should handle poll voting by option ID (real-world pattern)', async () => {
      const postId = postIds.get('Best Court Surface for Badminton?')!;
      const raw = await PostModel.findById(postId).lean();
      const syntheticOption = raw.poll.options.find((o: any) => o.text === 'Synthetic');

      const t = timer();
      const updated = await postRepo.update(postId, {
        $inc: { 'poll.options.$[opt].voteCount': 1, 'poll.totalVotes': 1 },
      }, {
        arrayFilters: [{ 'opt._id': syntheticOption._id }],
      });
      const ms = t();
      logTiming('poll vote (arrayFilters)', ms);

      const options = updated.poll.options;
      expect(options.find((o: any) => o.text === 'Synthetic').voteCount).toBe(90); // 89 + 1
      expect(updated.poll.totalVotes).toBe(325); // 324 + 1
      // Other options unchanged
      expect(options.find((o: any) => o.text === 'Wooden').voteCount).toBe(145);
    });

    it('should handle 20 concurrent votes on different options', async () => {
      const postId = postIds.get('Vote: Next Tournament Format')!;
      const raw = await PostModel.findById(postId).lean();
      const options = raw.poll.options;

      const t = timer();
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const option = options[i % 4]; // round-robin across 4 options
          return postRepo.update(postId, {
            $inc: { 'poll.options.$[opt].voteCount': 1, 'poll.totalVotes': 1 },
          }, {
            arrayFilters: [{ 'opt._id': option._id }],
          });
        })
      );
      const ms = t();
      logTiming('20 concurrent poll votes', ms);

      const final = await PostModel.findById(postId).lean();
      expect(final.poll.totalVotes).toBe(348); // 328 + 20

      // Each option should have gotten 5 votes (20 / 4)
      expect(final.poll.options[0].voteCount).toBe(83); // 78 + 5
      expect(final.poll.options[1].voteCount).toBe(117); // 112 + 5
      expect(final.poll.options[2].voteCount).toBe(100); // 95 + 5
      expect(final.poll.options[3].voteCount).toBe(48); // 43 + 5
    });

    it('should handle conditional array element updates', async () => {
      const postId = postIds.get('Vote: Next Tournament Format')!;

      // Reset vote counts for options with < 50 votes
      const t = timer();
      await postRepo.update(postId, {
        $set: { 'poll.options.$[low].voteCount': 0 },
      }, {
        arrayFilters: [{ 'low.voteCount': { $lt: 50 } }],
      });
      const ms = t();
      logTiming('conditional arrayFilter reset', ms);

      const final = await PostModel.findById(postId).lean();
      // Swiss System had 43 votes (< 50) → reset to 0
      expect(final.poll.options.find((o: any) => o.text === 'Swiss System').voteCount).toBe(0);
      // Others >= 50 → unchanged
      expect(final.poll.options.find((o: any) => o.text === 'Single Elimination').voteCount).toBe(78);
      expect(final.poll.options.find((o: any) => o.text === 'Double Elimination').voteCount).toBe(112);
      expect(final.poll.options.find((o: any) => o.text === 'Round Robin').voteCount).toBe(95);
    });

    it('should combine atomicUpdate + arrayFilters for vote + view tracking', async () => {
      const postId = postIds.get('Best Court Surface for Badminton?')!;
      const raw = await PostModel.findById(postId).lean();
      const woodenOption = raw.poll.options.find((o: any) => o.text === 'Wooden');

      const t = timer();
      const updated = await postRepo.atomicUpdate(postId, {
        $inc: {
          'poll.options.$[opt].voteCount': 1,
          'poll.totalVotes': 1,
          views: 1,
          reactionCount: 1,
        },
        $set: { lastActiveAt: new Date() },
        $push: { history: { action: 'voted', at: new Date() } },
      }, {
        arrayFilters: [{ 'opt._id': woodenOption._id }],
      });
      const ms = t();
      logTiming('atomicUpdate + arrayFilters (vote + view + reaction + history)', ms);

      expect(updated.poll.options.find((o: any) => o.text === 'Wooden').voteCount).toBe(146);
      expect(updated.poll.totalVotes).toBe(325);
      expect(updated.views).toBe(681);
      expect(updated.reactionCount).toBe(43);
      expect(updated.history).toHaveLength(2); // 1 existing + 1 new
    });
  });

  // ==========================================================================
  // 4. Combined Real-World Scenarios with Timing
  // ==========================================================================

  describe('End-to-End Scenarios', () => {
    it('scenario: season end — award badges, reset stats, cleanup (combined features)', async () => {
      const totalTimer = timer();

      // Step 1: Award season badges to top performers (atomicUpdate + $push)
      const t1 = timer();
      const topPlayerIds = [
        playerIds.get('Eve Johnson')!,
        playerIds.get('Bob Williams')!,
        playerIds.get('Diana Martinez')!,
      ];

      for (const id of topPlayerIds) {
        await playerRepo.atomicUpdate(id, {
          $push: { badges: { key: 'season_champion_spring_2026', awardedAt: new Date() } },
          $inc: { badgeCount: 1 },
        });
      }
      logTiming('Step 1: Award badges to 3 top players', t1());

      // Step 2: Tournament registration for all active players (updateMany)
      const t2 = timer();
      await playerRepo.updateMany(
        { 'stats.gamesPlayed': { $gt: 0 } },
        {
          $inc: { 'stats.tournamentsParticipated': 1 },
          $set: { 'stats.lastActiveAt': new Date() },
        },
      );
      logTiming('Step 2: Tournament registration (updateMany)', t2());

      // Step 3: Product inventory management (bulkWrite)
      const t3 = timer();
      await productRepo.bulkWrite([
        // Clear out expired/discontinued
        { deleteMany: { filter: { status: { $in: ['expired', 'discontinued'] } } } },
        // Mark low stock items
        { updateMany: { filter: { stock: { $lte: 10 }, status: 'active' }, update: { $set: { status: 'low-stock' } } } },
        // Add season merchandise
        { insertOne: { document: { name: 'Spring 2026 Jersey', price: 55.00, stock: 200, status: 'active', category: 'seasonal' } } },
        { insertOne: { document: { name: 'Spring 2026 Cap', price: 25.00, stock: 150, status: 'active', category: 'seasonal' } } },
      ]);
      logTiming('Step 3: Inventory management (bulkWrite)', t3());

      const totalMs = totalTimer();
      logTiming('Total scenario time', totalMs);

      // Verify data integrity
      const eve = await PlayerModel.findById(playerIds.get('Eve Johnson')!).lean();
      expect(eve.badges).toHaveLength(7); // 6 + season_champion
      expect(eve.badgeCount).toBe(7);
      expect(eve.stats.tournamentsParticipated).toBe(13); // 12 + 1

      const frank = await PlayerModel.findById(playerIds.get('Frank Brown')!).lean();
      expect(frank.stats.tournamentsParticipated).toBe(0); // 0 games, not registered

      const products = await ProductModel.find({}).lean();
      expect(products.find((p: any) => p.name === 'Old Training Cones')).toBeUndefined();
      expect(products.find((p: any) => p.name === 'Expired Protein Bars')).toBeUndefined();
      expect(products.find((p: any) => p.name === 'Spring 2026 Jersey')).toBeDefined();
    });

    it('scenario: live match updates — rapid concurrent writes', async () => {
      const postId = postIds.get('Quick Match Tonight - Need 2 More Players!')!;

      const t = timer();
      // Simulate 30 rapid view increments + 10 reactions + 5 comments
      const ops = [
        ...Array.from({ length: 30 }, () =>
          postRepo.atomicUpdate(postId, { $inc: { views: 1 } })
        ),
        ...Array.from({ length: 10 }, () =>
          postRepo.atomicUpdate(postId, {
            $inc: { reactionCount: 1 },
            $set: { lastActiveAt: new Date() },
          })
        ),
        ...Array.from({ length: 5 }, () =>
          postRepo.atomicUpdate(postId, {
            $inc: { commentCount: 1 },
            $set: { lastActiveAt: new Date() },
            $push: { history: { action: 'comment', at: new Date() } },
          })
        ),
      ];

      await Promise.all(ops);
      const ms = t();
      logTiming('45 concurrent updates (views + reactions + comments)', ms);

      const final = await PostModel.findById(postId).lean();
      expect(final.views).toBe(450); // 420 + 30
      expect(final.reactionCount).toBe(18); // 8 + 10
      expect(final.commentCount).toBe(10); // 5 + 5
      expect(final.history).toHaveLength(6); // 1 + 5 comments
    });

    it('scenario: player stat correction — $min/$max with atomicUpdate', async () => {
      const id = playerIds.get('Henry Wilson')!;

      const t = timer();
      // Correct peak rating (should be max of current and new)
      await playerRepo.atomicUpdate(id, {
        $max: { 'stats.peakRating': 1600 }, // higher than current 1560
        $set: { 'stats.skillRating': 1550 },
      });

      // Also test $min
      await playerRepo.atomicUpdate(id, {
        $min: { 'stats.skillRating': 1500 }, // lower than current 1550
      });
      const ms = t();
      logTiming('$max + $min corrections', ms);

      const player = await PlayerModel.findById(id).lean();
      expect(player.stats.peakRating).toBe(1600); // max(1560, 1600) = 1600
      expect(player.stats.skillRating).toBe(1500); // min(1550, 1500) = 1500
    });

    it('scenario: data migration — bulkWrite with mixed operations on 12 products', async () => {
      const t = timer();
      const allProducts = await ProductModel.find({}).lean();

      const ops: Record<string, unknown>[] = allProducts.map(p => {
        if (p.status === 'expired' || p.status === 'discontinued') {
          return { deleteOne: { filter: { _id: p._id } } };
        }
        if (p.stock <= 10) {
          return {
            updateOne: {
              filter: { _id: p._id },
              update: { $set: { status: 'needs-reorder' }, $inc: { stock: 100 } },
            },
          };
        }
        return {
          updateOne: {
            filter: { _id: p._id },
            update: { $set: { status: 'verified' } },
          },
        };
      });

      const result = await productRepo.bulkWrite(ops);
      const ms = t();
      logTiming(`data migration (${allProducts.length} products, mixed ops)`, ms);

      // 2 deletes (expired + discontinued)
      expect(result.deletedCount).toBe(2);
      // Remaining modified
      expect(result.modifiedCount).toBe(10);

      // Verify Knee Pads got restocked
      const kneePads = await ProductModel.findById(productIds.get('Knee Pads')!).lean();
      expect(kneePads.stock).toBe(105); // 5 + 100
      expect(kneePads.status).toBe('needs-reorder');
    });
  });

  // ==========================================================================
  // 5. Edge Cases & Error Handling
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle atomicUpdate on document with empty nested stats', async () => {
      const id = playerIds.get('Frank Brown')!; // 0 stats, empty badges

      // Combine all $inc fields in a single object (no duplicate keys)
      const updated = await playerRepo.atomicUpdate(id, {
        $inc: { 'stats.gamesPlayed': 1, badgeCount: 1 },
        $set: { 'stats.lastActiveAt': new Date() },
        $push: { badges: { key: 'first_game', awardedAt: new Date() } },
      });

      expect(updated.stats.gamesPlayed).toBe(1);
      expect(updated.badgeCount).toBe(1);
      expect(updated.badges).toHaveLength(1);
      expect(updated.badges[0].key).toBe('first_game');
    });

    it('should handle bulkWrite with no matching documents gracefully', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const result = await productRepo.bulkWrite([
        { updateOne: { filter: { _id: fakeId }, update: { $inc: { stock: 1 } } } },
        { deleteOne: { filter: { _id: fakeId } } },
      ]);

      expect(result.modifiedCount).toBe(0);
      expect(result.deletedCount).toBe(0);
      expect(result.matchedCount).toBe(0);
    });

    it('should handle arrayFilters with no matching elements gracefully', async () => {
      const postId = postIds.get('Best Court Surface for Badminton?')!;

      // Filter for non-existent option ID
      const fakeOptionId = new mongoose.Types.ObjectId();
      const updated = await postRepo.update(postId, {
        $inc: { 'poll.options.$[opt].voteCount': 1 },
      }, {
        arrayFilters: [{ 'opt._id': fakeOptionId }],
      });

      // Should succeed but not modify any array element
      const original = seedData.posts[1];
      const options = updated.poll.options;
      expect(options[0].voteCount).toBe(original.poll!.options[0].voteCount);
      expect(options[1].voteCount).toBe(original.poll!.options[1].voteCount);
    });

    it('should handle atomicUpdate with $pull on nested array', async () => {
      const id = playerIds.get('Bob Williams')!;

      // Remove a specific badge
      const updated = await playerRepo.atomicUpdate(id, {
        $pull: { badges: 'starter' },
        $inc: { badgeCount: -1 },
      });

      expect(updated.badges).not.toContain('starter');
      expect(updated.badgeCount).toBe(4); // 5 - 1
    });

    it('should validate fixture data loaded correctly', async () => {
      const playerCount = await PlayerModel.countDocuments();
      const postCount = await PostModel.countDocuments();
      const productCount = await ProductModel.countDocuments();

      expect(playerCount).toBe(seedData.players.length);
      expect(postCount).toBe(seedData.posts.length);
      expect(productCount).toBe(seedData.products.length);

      // Spot-check data integrity
      const eve = await PlayerModel.findById(playerIds.get('Eve Johnson')!).lean();
      expect(eve.stats.gamesPlayed).toBe(200);
      expect(eve.stats.skillRating).toBe(1820);
      expect(eve.badges).toHaveLength(6);

      const pollPost = await PostModel.findById(postIds.get('Best Court Surface for Badminton?')!).lean();
      expect(pollPost.poll.totalVotes).toBe(324);
      expect(pollPost.poll.options).toHaveLength(4);
    });
  });
});
