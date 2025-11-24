import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import mongoose from 'mongoose';
import { Repository } from '../src/index.js';

// Test Schema (NO pagination plugins - we use built-in now)
const UserSchema = new mongoose.Schema({
  name: String,
  email: String,
  createdAt: { type: Date, default: Date.now },
  age: Number,
  status: String,
  score: Number
});

// CRITICAL: Create compound indexes for keyset pagination
UserSchema.index({ createdAt: -1, _id: -1 });
UserSchema.index({ score: -1, _id: -1 });
UserSchema.index({ age: 1, _id: 1 });

const UserModel = mongoose.model('UserV2', UserSchema);

class UserRepository extends Repository {
  constructor() {
    super(UserModel, [], {
      maxLimit: 100,
      defaultLimit: 10,
      maxPage: 1000
    });
  }
}

describe('Pagination v2 - Production Ready', () => {
  let repo;
  const testUsers = [];

  before(async () => {
    await mongoose.connect('mongodb://localhost:27017/mongokit-test');

    // Clean up any existing data from previous test runs
    await UserModel.deleteMany({});

    repo = new UserRepository();

    // Create test data with intentional ties for testing
    const users = [];
    const baseTime = new Date('2024-01-01T00:00:00Z');

    for (let i = 0; i < 50; i++) {
      users.push({
        name: `User ${i}`,
        email: `user${i}@test.com`,
        createdAt: new Date(baseTime.getTime() + Math.floor(i / 5) * 1000), // 5 users share same timestamp
        age: 20 + (i % 10),
        status: i % 3 === 0 ? 'active' : 'inactive',
        score: Math.floor(i / 10) * 100 // Ties every 10 users
      });
    }

    const created = await repo.createMany(users);
    testUsers.push(...created);
  });

  after(async () => {
    await UserModel.deleteMany({});
    await mongoose.disconnect();
  });

  // ============================================================
  // OFFSET PAGINATION TESTS
  // ============================================================

  describe('Offset Pagination (via getAll)', () => {
    it('should return correct discriminated type', async () => {
      const result = await repo.getAll({
        filters: {},
        page: 1,
        limit: 10
      });

      assert.strictEqual(result.method, 'offset');
      assert.ok(result.docs);
      assert.ok(typeof result.page === 'number');
      assert.ok(typeof result.total === 'number');
      assert.ok(typeof result.pages === 'number');
      assert.ok(typeof result.hasNext === 'boolean');
      assert.ok(typeof result.hasPrev === 'boolean');
    });

    it('should paginate correctly', async () => {
      const page1 = await repo.getAll({ page: 1, limit: 10 });
      const page2 = await repo.getAll({ page: 2, limit: 10 });

      assert.strictEqual(page1.docs.length, 10);
      assert.strictEqual(page2.docs.length, 10);
      assert.strictEqual(page1.page, 1);
      assert.strictEqual(page2.page, 2);
      assert.strictEqual(page1.total, 50);
      assert.notStrictEqual(page1.docs[0]._id.toString(), page2.docs[0]._id.toString());
    });

    it('should respect filters', async () => {
      const result = await repo.getAll({
        filters: { status: 'active' },
        limit: 50
      });

      assert.ok(result.docs.every(u => u.status === 'active'));
    });

    it('should respect sort', async () => {
      const result = await repo.getAll({
        sort: { age: 1 },
        limit: 5,
        page: 1
      });

      for (let i = 1; i < result.docs.length; i++) {
        assert.ok(result.docs[i].age >= result.docs[i - 1].age);
      }
    });

    it('should warn on deep pagination', async () => {
      const result = await repo.getAll({ page: 101, limit: 1 });
      assert.ok(result.warning);
      assert.ok(result.warning.includes('getAll'));
    });

    it('should cap limit at maxLimit', async () => {
      const result = await repo.getAll({ page: 1, limit: 9999 });
      assert.strictEqual(result.limit, 100); // maxLimit from config
    });

    it('should enforce maxPage', async () => {
      await assert.rejects(
        () => repo.getAll({ page: 10001 }),
        (err) => {
          assert.ok(err.message.includes('exceeds max'));
          return true;
        }
      );
    });
  });

  // ============================================================
  // KEYSET PAGINATION TESTS
  // ============================================================

  describe('Keyset Pagination (via getAll)', () => {
    it('should return correct discriminated type', async () => {
      const result = await repo.getAll({
        after: null, // Explicit keyset mode
        sort: { createdAt: -1 },
        limit: 10
      });

      assert.strictEqual(result.method, 'keyset');
      assert.ok(result.docs);
      assert.ok(typeof result.limit === 'number');
      assert.ok(typeof result.hasMore === 'boolean');
      assert.ok(typeof result.next === 'string' || result.next === null);
    });

    it('should use default sort when not specified', async () => {
      // getAll() provides a default sort of '-createdAt' so keyset mode works without explicit sort
      const result = await repo.getAll({ after: null, limit: 10 });
      assert.strictEqual(result.method, 'keyset');
      assert.ok(result.docs);
      // Should be sorted by createdAt descending (default)
      for (let i = 1; i < result.docs.length; i++) {
        assert.ok(result.docs[i - 1].createdAt >= result.docs[i].createdAt);
      }
    });

    it('should reject multi-field sort (more than primary + _id)', async () => {
      await assert.rejects(
        () => repo.getAll({ after: null, sort: { age: 1, name: 1 }, limit: 10 }),
        (err) => {
          assert.ok(err.message.includes('requires _id'));
          return true;
        }
      );
    });

    it('should accept multi-field sort with _id', async () => {
      const result = await repo.getAll({
        after: null,
        sort: { age: 1, _id: 1 },
        limit: 10
      });

      assert.strictEqual(result.method, 'keyset');
      assert.ok(result.docs.length > 0);
    });

    it('should handle forward pagination with ties', async () => {
      // First page
      const page1 = await repo.getAll({
        after: null,
        sort: { createdAt: -1 },
        limit: 10
      });

      assert.strictEqual(page1.docs.length, 10);
      assert.ok(page1.hasMore);
      assert.ok(page1.next);

      // Second page using cursor
      const page2 = await repo.getAll({
        after: page1.next,
        sort: { createdAt: -1 },
        limit: 10
      });

      assert.strictEqual(page2.docs.length, 10);

      // Ensure no duplicates
      const page1Ids = page1.docs.map(d => d._id.toString());
      const page2Ids = page2.docs.map(d => d._id.toString());
      const intersection = page1Ids.filter(id => page2Ids.includes(id));
      assert.strictEqual(intersection.length, 0, 'No duplicate documents across pages');
    });

    it('should handle ties correctly with _id tie-breaker', async () => {
      // Users with same score (ties)
      const allWithTies = await repo.getAll({
        after: null,
        sort: { score: -1 },
        limit: 50
      });

      const page1 = await repo.getAll({
        after: null,
        sort: { score: -1 },
        limit: 15
      });

      const page2 = await repo.getAll({
        after: page1.next,
        sort: { score: -1 },
        limit: 15
      });

      const page3 = await repo.getAll({
        after: page2.next,
        sort: { score: -1 },
        limit: 15
      });

      // Combine paginated results
      const paginated = [...page1.docs, ...page2.docs, ...page3.docs];

      // Should have all unique IDs
      const uniqueIds = new Set(paginated.map(d => d._id.toString()));
      assert.strictEqual(uniqueIds.size, paginated.length, 'All documents should be unique');

      // Should have same total count
      assert.strictEqual(paginated.length, Math.min(45, allWithTies.docs.length));
    });

    it('should handle ascending sort correctly', async () => {
      const page1 = await repo.getAll({
        after: null,
        sort: { age: 1 },
        limit: 10
      });

      const page2 = await repo.getAll({
        after: page1.next,
        sort: { age: 1 },
        limit: 10
      });

      // Check ascending order
      for (let i = 1; i < page1.docs.length; i++) {
        assert.ok(page1.docs[i].age >= page1.docs[i - 1].age);
      }

      // Ensure page 2 continues from page 1
      const lastAge1 = page1.docs[page1.docs.length - 1].age;
      const firstAge2 = page2.docs[0].age;
      assert.ok(firstAge2 >= lastAge1);
    });

    it('should handle descending sort correctly', async () => {
      const page1 = await repo.getAll({
        after: null,
        sort: { age: -1 },
        limit: 10
      });

      const page2 = await repo.getAll({
        after: page1.next,
        sort: { age: -1 },
        limit: 10
      });

      // Check descending order
      for (let i = 1; i < page1.docs.length; i++) {
        assert.ok(page1.docs[i].age <= page1.docs[i - 1].age);
      }

      // Ensure page 2 continues from page 1
      const lastAge1 = page1.docs[page1.docs.length - 1].age;
      const firstAge2 = page2.docs[0].age;
      assert.ok(firstAge2 <= lastAge1);
    });

    it('should handle cursor with Date fields', async () => {
      const page1 = await repo.getAll({
        after: null,
        sort: { createdAt: -1 },
        limit: 10
      });

      const page2 = await repo.getAll({
        after: page1.next,
        sort: { createdAt: -1 },
        limit: 10
      });

      assert.ok(page2.docs.length > 0);
      assert.ok(page2.docs[0].createdAt instanceof Date || typeof page2.docs[0].createdAt === 'string');
    });

    it('should reject invalid cursor token', async () => {
      await assert.rejects(
        () => repo.getAll({ after: 'invalid-cursor', sort: { createdAt: -1 }, limit: 10 }),
        (err) => {
          assert.ok(err.message.includes('Invalid cursor'));
          return true;
        }
      );
    });

    it('should handle filters with keyset pagination', async () => {
      const result = await repo.getAll({
        after: null,
        filters: { status: 'active' },
        sort: { createdAt: -1 },
        limit: 20
      });

      assert.ok(result.docs.every(u => u.status === 'active'));
      assert.ok(result.docs.length > 0);
    });

    it('should indicate hasMore correctly', async () => {
      const page1 = await repo.getAll({
        after: null,
        sort: { createdAt: -1 },
        limit: 10
      });
      assert.strictEqual(page1.hasMore, true);

      const lastPage = await repo.getAll({
        after: null,
        sort: { createdAt: -1 },
        limit: 100 // Larger than total
      });
      assert.strictEqual(lastPage.hasMore, false);
    });
  });

  // ============================================================
  // AGGREGATE PAGINATION TESTS
  // ============================================================

  describe('aggregatePaginate() - Aggregate Pipeline', () => {
    it('should return correct discriminated type', async () => {
      const result = await repo.aggregatePaginate({
        pipeline: [{ $match: { status: 'active' } }],
        page: 1,
        limit: 10
      });

      assert.strictEqual(result.method, 'aggregate');
      assert.ok(result.docs);
      assert.ok(typeof result.page === 'number');
      assert.ok(typeof result.total === 'number');
    });

    it('should paginate aggregation results', async () => {
      const pipeline = [
        { $match: { status: 'active' } },
        { $project: { name: 1, age: 1 } }
      ];

      const page1 = await repo.aggregatePaginate({ pipeline, page: 1, limit: 5 });
      const page2 = await repo.aggregatePaginate({ pipeline, page: 2, limit: 5 });

      assert.ok(page1.docs.length > 0);
      assert.ok(page2.docs.length > 0);
      assert.notStrictEqual(page1.docs[0]._id.toString(), page2.docs[0]._id.toString());
    });

    it('should handle grouping in pipeline', async () => {
      const pipeline = [
        { $group: { _id: '$status', count: { $sum: 1 }, avgAge: { $avg: '$age' } } },
        { $sort: { count: -1 } }
      ];

      const result = await repo.aggregatePaginate({ pipeline, page: 1, limit: 10 });

      assert.ok(result.docs.length > 0);
      assert.ok(result.docs[0].count);
      assert.ok(result.docs[0].avgAge);
    });

    it('should handle empty results', async () => {
      const pipeline = [
        { $match: { status: 'nonexistent' } }
      ];

      const result = await repo.aggregatePaginate({ pipeline, page: 1, limit: 10 });

      assert.strictEqual(result.docs.length, 0);
      assert.strictEqual(result.total, 0);
      assert.strictEqual(result.pages, 0);
    });

    it.skip('should handle session correctly (requires replica set)', async () => {
      // This test requires MongoDB replica set for transactions
      // Skip in local development
      const session = await mongoose.startSession();
      await session.startTransaction();

      try {
        const result = await repo.aggregatePaginate({
          pipeline: [{ $match: {} }],
          page: 1,
          limit: 10,
          session
        });

        assert.ok(result.docs.length > 0);
        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        throw err;
      } finally {
        session.endSession();
      }
    });

    it('should warn on deep pagination', async () => {
      const result = await repo.aggregatePaginate({
        pipeline: [{ $match: {} }],
        page: 101,
        limit: 1
      });

      assert.ok(result.warning);
      assert.ok(result.warning.includes('Deep pagination'));
    });
  });

  // ============================================================
  // BACKWARD COMPATIBILITY TESTS
  // ============================================================

  describe('getAll() - Unified Pagination API', () => {
    describe('Offset Mode (Page-based)', () => {
      it('should detect offset mode with page param', async () => {
        const result = await repo.getAll({
          page: 1,
          limit: 10
        });

        assert.strictEqual(result.method, 'offset');
        assert.ok(result.docs);
        assert.ok(typeof result.total === 'number');
        assert.ok(typeof result.pages === 'number');
        assert.ok(typeof result.hasNext === 'boolean');
        assert.ok(typeof result.hasPrev === 'boolean');
      });

      it('should detect offset mode with pagination param', async () => {
        const result = await repo.getAll({
          pagination: { page: 2, limit: 10 }
        });

        assert.strictEqual(result.method, 'offset');
        assert.strictEqual(result.page, 2);
        assert.strictEqual(result.limit, 10);
      });

      it('should default to offset mode (page 1)', async () => {
        const result = await repo.getAll({
          filters: { status: 'active' },
          limit: 10
        });

        assert.strictEqual(result.method, 'offset');
        assert.strictEqual(result.page, 1);
        assert.ok(result.docs.every(u => u.status === 'active'));
      });

      it('should handle sort in offset mode', async () => {
        const result = await repo.getAll({
          page: 1,
          limit: 10,
          sort: { age: 1 }
        });

        assert.strictEqual(result.method, 'offset');
        // Verify ascending sort
        for (let i = 1; i < result.docs.length; i++) {
          assert.ok(result.docs[i].age >= result.docs[i - 1].age);
        }
      });
    });

    describe('Keyset Mode (Cursor-based)', () => {
      it('should detect keyset mode with cursor param', async () => {
        // Get first page with keyset pagination
        const page1 = await repo.getAll({
          after: null,
          sort: { createdAt: -1 },
          limit: 5
        });

        if (page1.next) {
          const result = await repo.getAll({
            cursor: page1.next,
            limit: 5,
            sort: { createdAt: -1 }
          });

          assert.strictEqual(result.method, 'keyset');
          assert.ok(result.docs);
          assert.ok(typeof result.hasMore === 'boolean');
          assert.ok(result.next === null || typeof result.next === 'string');
          // Should not have offset-specific fields
          assert.strictEqual(result.total, undefined);
          assert.strictEqual(result.pages, undefined);
        }
      });

      it('should detect keyset mode with after param', async () => {
        const page1 = await repo.getAll({
          after: null,
          sort: { createdAt: -1 },
          limit: 5
        });

        if (page1.next) {
          const result = await repo.getAll({
            after: page1.next,
            limit: 5,
            sort: { createdAt: -1 }
          });

          assert.strictEqual(result.method, 'keyset');
          assert.ok(result.docs);
        }
      });

      it('should handle filters in keyset mode', async () => {
        const page1 = await repo.getAll({
          after: null,
          sort: { createdAt: -1 },
          limit: 5
        });

        if (page1.next) {
          const result = await repo.getAll({
            after: page1.next,
            filters: { status: 'active' },
            sort: { createdAt: -1 },
            limit: 5
          });

          assert.strictEqual(result.method, 'keyset');
          assert.ok(result.docs.every(u => u.status === 'active'));
        }
      });
    });

    describe('Backward Compatibility', () => {
      it('should maintain backward compatibility with old pagination param', async () => {
        const result = await repo.getAll({
          pagination: { page: 1, limit: 10 }
        });

        assert.strictEqual(result.method, 'offset');
        assert.ok(result.docs);
      });

      it('should handle old-style filters and search', async () => {
        const result = await repo.getAll({
          filters: { status: 'active' },
          pagination: { page: 1, limit: 10 }
        });

        assert.strictEqual(result.method, 'offset');
        assert.ok(result.docs.every(u => u.status === 'active'));
      });
    });

    describe('Type Discrimination', () => {
      it('offset result should have correct fields', async () => {
        const result = await repo.getAll({ page: 1, limit: 10 });

        // Offset-specific fields should exist
        assert.ok('method' in result);
        assert.ok('docs' in result);
        assert.ok('page' in result);
        assert.ok('limit' in result);
        assert.ok('total' in result);
        assert.ok('pages' in result);
        assert.ok('hasNext' in result);
        assert.ok('hasPrev' in result);

        // Keyset-specific fields should not exist
        assert.strictEqual('hasMore' in result, false);
      });

      it('keyset result should have correct fields', async () => {
        const page1 = await repo.getAll({
          after: null,
          sort: { createdAt: -1 },
          limit: 5
        });

        if (page1.next) {
          const result = await repo.getAll({
            cursor: page1.next,
            sort: { createdAt: -1 },
            limit: 5
          });

          // Keyset-specific fields should exist
          assert.ok('method' in result);
          assert.ok('docs' in result);
          assert.ok('limit' in result);
          assert.ok('hasMore' in result);
          assert.ok('next' in result);

          // Offset-specific fields should not exist
          assert.strictEqual('total' in result, false);
          assert.strictEqual('pages' in result, false);
          assert.strictEqual('page' in result, false);
        }
      });
    });
  });
});
