import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Repository } from '../src/Repository.js';

// =============================================================================
// Multi-Tenancy Pagination Tests
// Tests organizationId scoping patterns for enterprise systems
// =============================================================================

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/test-mongokit-multitenancy';

// Multi-tenant User schema
const TenantUserSchema = new mongoose.Schema({
  name: String,
  email: String,
  organizationId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
});

// Compound indexes for multi-tenant keyset pagination
TenantUserSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
TenantUserSchema.index({ organizationId: 1, email: 1, _id: 1 });

const TenantUserModel = mongoose.model('TenantUser', TenantUserSchema);
const repo = new Repository(TenantUserModel);

describe('Multi-Tenancy Pagination', () => {
  let org1Id, org2Id, org3Id;

  before(async () => {
    await mongoose.connect(mongoUri);
    await TenantUserModel.deleteMany({});

    // Create test organizations
    org1Id = new mongoose.Types.ObjectId();
    org2Id = new mongoose.Types.ObjectId();
    org3Id = new mongoose.Types.ObjectId();

    // Insert users for 3 organizations
    const users = [];

    // Org1: 30 users
    for (let i = 1; i <= 30; i++) {
      users.push({
        name: `Org1 User ${i}`,
        email: `org1.user${i}@example.com`,
        organizationId: org1Id,
        createdAt: new Date(Date.now() - i * 1000 * 60) // 1 min apart
      });
    }

    // Org2: 20 users
    for (let i = 1; i <= 20; i++) {
      users.push({
        name: `Org2 User ${i}`,
        email: `org2.user${i}@example.com`,
        organizationId: org2Id,
        createdAt: new Date(Date.now() - i * 1000 * 60)
      });
    }

    // Org3: 5 users
    for (let i = 1; i <= 5; i++) {
      users.push({
        name: `Org3 User ${i}`,
        email: `org3.user${i}@example.com`,
        organizationId: org3Id,
        createdAt: new Date(Date.now() - i * 1000 * 60)
      });
    }

    await TenantUserModel.insertMany(users);
  });

  after(async () => {
    await mongoose.connection.close();
  });

  // ===========================================================================
  // OFFSET PAGINATION WITH ORGANIZATION SCOPING
  // ===========================================================================

  describe('paginate() with organizationId filters', () => {
    it('should only return users from org1', async () => {
      const result = await repo.getAll({
        filters: { organizationId: org1Id },
        page: 1,
        limit: 10,
        sort: { createdAt: -1 }
      });

      assert.strictEqual(result.method, 'offset');
      assert.strictEqual(result.docs.length, 10);
      assert.strictEqual(result.total, 30);
      assert.strictEqual(result.pages, 3);

      // Verify all returned docs belong to org1
      result.docs.forEach(doc => {
        assert.strictEqual(doc.organizationId.toString(), org1Id.toString());
      });
    });

    it('should paginate correctly across org1 pages', async () => {
      const page1 = await repo.getAll({
        filters: { organizationId: org1Id },
        page: 1,
        limit: 10,
        sort: { createdAt: -1 }
      });

      const page2 = await repo.getAll({
        filters: { organizationId: org1Id },
        page: 2,
        limit: 10,
        sort: { createdAt: -1 }
      });

      assert.strictEqual(page1.docs.length, 10);
      assert.strictEqual(page2.docs.length, 10);

      // Ensure no overlap
      const page1Ids = page1.docs.map(d => d._id.toString());
      const page2Ids = page2.docs.map(d => d._id.toString());
      const overlap = page1Ids.filter(id => page2Ids.includes(id));

      assert.strictEqual(overlap.length, 0, 'Pages should not overlap');
    });

    it('should handle small organization (org3)', async () => {
      const result = await repo.getAll({
        filters: { organizationId: org3Id },
        page: 1,
        limit: 10,
        sort: { createdAt: -1 }
      });

      assert.strictEqual(result.docs.length, 5);
      assert.strictEqual(result.total, 5);
      assert.strictEqual(result.hasNext, false);
    });

    it('should isolate organizations - no data leakage', async () => {
      const org1Result = await repo.getAll({
        filters: { organizationId: org1Id },
        page: 1,
        limit: 100
      });

      const org2Result = await repo.getAll({
        filters: { organizationId: org2Id },
        page: 1,
        limit: 100
      });

      assert.strictEqual(org1Result.total, 30);
      assert.strictEqual(org2Result.total, 20);

      // Verify no cross-organization data
      org1Result.docs.forEach(doc => {
        assert.strictEqual(doc.organizationId.toString(), org1Id.toString());
      });

      org2Result.docs.forEach(doc => {
        assert.strictEqual(doc.organizationId.toString(), org2Id.toString());
      });
    });
  });

  // ===========================================================================
  // KEYSET PAGINATION WITH ORGANIZATION SCOPING
  // ===========================================================================

  describe('Keyset pagination (via getAll) with organizationId filters', () => {
    it('should stream org1 users with cursors', async () => {
      const page1 = await repo.getAll({
        after: null, // Explicit keyset mode
        filters: { organizationId: org1Id },
        sort: { createdAt: -1 },
        limit: 10
      });

      assert.strictEqual(page1.method, 'keyset');
      assert.strictEqual(page1.docs.length, 10);
      assert.strictEqual(page1.hasMore, true);
      assert.ok(page1.next);

      // Verify all belong to org1
      page1.docs.forEach(doc => {
        assert.strictEqual(doc.organizationId.toString(), org1Id.toString());
      });

      // Get next page
      const page2 = await repo.getAll({
        filters: { organizationId: org1Id },
        sort: { createdAt: -1 },
        after: page1.next,
        limit: 10
      });

      assert.strictEqual(page2.docs.length, 10);

      // Ensure no overlap
      const page1Ids = page1.docs.map(d => d._id.toString());
      const page2Ids = page2.docs.map(d => d._id.toString());
      const overlap = page1Ids.filter(id => page2Ids.includes(id));

      assert.strictEqual(overlap.length, 0, 'Keyset pages should not overlap');
    });

    it('should paginate through multiple pages for org1', async () => {
      const page1 = await repo.getAll({
        after: null,
        filters: { organizationId: org1Id },
        sort: { createdAt: -1 },
        limit: 10
      });

      const page2 = await repo.getAll({
        filters: { organizationId: org1Id },
        sort: { createdAt: -1 },
        after: page1.next,
        limit: 10
      });

      const page3 = await repo.getAll({
        filters: { organizationId: org1Id },
        sort: { createdAt: -1 },
        after: page2.next,
        limit: 10
      });

      assert.strictEqual(page1.docs.length, 10);
      assert.strictEqual(page2.docs.length, 10);
      assert.strictEqual(page3.docs.length, 10);

      // All should belong to org1
      [...page1.docs, ...page2.docs, ...page3.docs].forEach(doc => {
        assert.strictEqual(doc.organizationId.toString(), org1Id.toString());
      });
    });

    it('should respect compound index (orgId + createdAt + _id)', async () => {
      // This test verifies cursor works with compound index
      const result = await repo.getAll({
        after: null,
        filters: { organizationId: org2Id },
        sort: { createdAt: -1 },
        limit: 5
      });

      assert.strictEqual(result.docs.length, 5);
      result.docs.forEach(doc => {
        assert.strictEqual(doc.organizationId.toString(), org2Id.toString());
      });

      // Verify sorting
      for (let i = 0; i < result.docs.length - 1; i++) {
        const current = result.docs[i].createdAt;
        const next = result.docs[i + 1].createdAt;
        assert.ok(current >= next, 'Should be sorted by createdAt desc');
      }
    });

    it('should handle cursor across large org1 dataset', async () => {
      // Stream through all 30 users in org1
      let allUsers = [];
      let cursor = null;
      let iterations = 0;
      const maxIterations = 10; // Safety limit

      while (iterations < maxIterations) {
        const result = await repo.getAll({
          filters: { organizationId: org1Id },
          sort: { createdAt: -1 },
          after: cursor,
          limit: 10
        });

        allUsers.push(...result.docs);

        if (!result.hasMore || !result.next) break;
        cursor = result.next;
        iterations++;
      }

      assert.strictEqual(allUsers.length, 30, 'Should retrieve all 30 org1 users');

      // Verify no duplicates
      const uniqueIds = new Set(allUsers.map(u => u._id.toString()));
      assert.strictEqual(uniqueIds.size, 30, 'Should have no duplicates');
    });

    it('should not leak data between organizations via cursors', async () => {
      // Get cursor from org1
      const org1Page = await repo.getAll({
        after: null,
        filters: { organizationId: org1Id },
        sort: { createdAt: -1 },
        limit: 5
      });

      // Try to use org1 cursor with org2 filter - should return org2 data only
      const org2Page = await repo.getAll({
        filters: { organizationId: org2Id },
        sort: { createdAt: -1 },
        after: org1Page.next, // Using org1 cursor
        limit: 5
      });

      // Should still only return org2 data (cursor is just a position marker)
      org2Page.docs.forEach(doc => {
        assert.strictEqual(doc.organizationId.toString(), org2Id.toString());
      });
    });
  });

  // ===========================================================================
  // AGGREGATE PAGINATION WITH ORGANIZATION SCOPING
  // ===========================================================================

  describe('aggregatePaginate() with organizationId', () => {
    it('should aggregate with org filter', async () => {
      const pipeline = [
        { $match: { organizationId: org1Id } },
        { $sort: { createdAt: -1 } }
      ];

      const result = await repo.aggregatePaginate({
        pipeline,
        page: 1,
        limit: 10
      });

      assert.strictEqual(result.method, 'aggregate');
      assert.strictEqual(result.docs.length, 10);
      assert.strictEqual(result.total, 30);

      result.docs.forEach(doc => {
        assert.strictEqual(doc.organizationId.toString(), org1Id.toString());
      });
    });

    it('should group by organization', async () => {
      const pipeline = [
        {
          $group: {
            _id: '$organizationId',
            count: { $sum: 1 },
            users: { $push: '$name' }
          }
        },
        { $sort: { count: -1 } }
      ];

      const result = await repo.aggregatePaginate({
        pipeline,
        page: 1,
        limit: 10
      });

      assert.strictEqual(result.docs.length, 3); // 3 organizations

      // Find org1 result
      const org1Result = result.docs.find(d => d._id.toString() === org1Id.toString());
      assert.strictEqual(org1Result.count, 30);

      // Find org2 result
      const org2Result = result.docs.find(d => d._id.toString() === org2Id.toString());
      assert.strictEqual(org2Result.count, 20);
    });
  });

  // ===========================================================================
  // PERFORMANCE: COMPOUND INDEXES
  // ===========================================================================

  describe('Performance with compound indexes', () => {
    it('should use compound index for multi-tenant queries', async () => {
      // Query with organizationId + sort field should use compound index
      // This is a functional test - index usage verified via explain() would be ideal
      const result = await repo.getAll({
        after: null,
        filters: { organizationId: org1Id },
        sort: { createdAt: -1 },
        limit: 20
      });

      assert.strictEqual(result.docs.length, 20);

      // Verify results are properly sorted
      for (let i = 0; i < result.docs.length - 1; i++) {
        const current = result.docs[i].createdAt;
        const next = result.docs[i + 1].createdAt;
        assert.ok(current >= next);
      }
    });

    it('should handle email sorting with org scoping', async () => {
      const result = await repo.getAll({
        after: null,
        filters: { organizationId: org2Id },
        sort: { email: 1 }, // Will auto-add _id tie-breaker
        limit: 10
      });

      assert.strictEqual(result.docs.length, 10);

      // Verify email sorting
      for (let i = 0; i < result.docs.length - 1; i++) {
        const current = result.docs[i].email;
        const next = result.docs[i + 1].email;
        assert.ok(current <= next, 'Should be sorted by email asc');
      }
    });
  });
});
