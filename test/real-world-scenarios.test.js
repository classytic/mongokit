import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import mongoose from 'mongoose';
import { Repository } from '../src/index.js';

// Real-world scenario: Blog posts with text search and infinite scroll
const PostSchema = new mongoose.Schema({
  title: String,
  content: String,
  author: String,
  tags: [String],
  publishedAt: { type: Date, default: Date.now },
  views: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'published' }
});

// Text index for full-text search
PostSchema.index({ title: 'text', content: 'text', author: 'text' });

// Compound index for cursor pagination with publishedAt
PostSchema.index({ publishedAt: -1, _id: -1 });

const PostModel = mongoose.model('Post', PostSchema);

class PostRepository extends Repository {
  constructor() {
    super(PostModel, [], {
      maxLimit: 100,
      defaultLimit: 20,
      maxPage: 1000
    });
  }
}

describe('Real-World Scenarios', () => {
  let repo;
  const posts = [];

  before(async () => {
    await mongoose.connect('mongodb://localhost:27017/mongokit-test');
    await PostModel.deleteMany({});

    repo = new PostRepository();

    // Create 50 blog posts with varied content
    const baseTime = new Date('2024-01-01T00:00:00Z');
    const testPosts = [];

    // Posts about JavaScript
    for (let i = 0; i < 15; i++) {
      testPosts.push({
        title: `JavaScript Tutorial Part ${i + 1}`,
        content: `Learn modern JavaScript features including async/await, promises, and ES6+ syntax. This is post number ${i + 1}.`,
        author: 'John Doe',
        tags: ['javascript', 'tutorial', 'webdev'],
        publishedAt: new Date(baseTime.getTime() + i * 3600000),
        views: Math.floor(Math.random() * 1000),
        status: 'published'
      });
    }

    // Posts about MongoDB
    for (let i = 0; i < 15; i++) {
      testPosts.push({
        title: `MongoDB Guide ${i + 1}: Database Basics`,
        content: `Understanding MongoDB collections, documents, and queries. MongoDB is a NoSQL database. Part ${i + 1}.`,
        author: 'Jane Smith',
        tags: ['mongodb', 'database', 'nosql'],
        publishedAt: new Date(baseTime.getTime() + (i + 15) * 3600000),
        views: Math.floor(Math.random() * 1000),
        status: 'published'
      });
    }

    // Posts about React
    for (let i = 0; i < 10; i++) {
      testPosts.push({
        title: `React Hooks Tutorial ${i + 1}`,
        content: `Learn React hooks like useState, useEffect, and custom hooks. Build modern React applications.`,
        author: 'Bob Johnson',
        tags: ['react', 'javascript', 'frontend'],
        publishedAt: new Date(baseTime.getTime() + (i + 30) * 3600000),
        views: Math.floor(Math.random() * 1000),
        status: 'published'
      });
    }

    // Mixed posts
    for (let i = 0; i < 10; i++) {
      testPosts.push({
        title: `Web Development Best Practices ${i + 1}`,
        content: `General web development tips covering JavaScript, databases, and frontend frameworks.`,
        author: 'Alice Williams',
        tags: ['webdev', 'bestpractices'],
        publishedAt: new Date(baseTime.getTime() + (i + 40) * 3600000),
        views: Math.floor(Math.random() * 1000),
        status: 'published'
      });
    }

    const created = await PostModel.insertMany(testPosts);
    posts.push(...created);

    // Wait for text index to be ready
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  after(async () => {
    await PostModel.deleteMany({});
    await mongoose.disconnect();
  });

  describe('Text Search + Infinite Scroll (Keyset Pagination)', () => {
    it('should search and paginate through results with cursor', async () => {
      // Search for "JavaScript" posts with infinite scroll
      const page1 = await repo.getAll({
        after: null, // Keyset mode
        search: 'JavaScript',
        sort: { publishedAt: -1 },
        limit: 5
      });

      assert.strictEqual(page1.method, 'keyset');
      assert.ok(page1.docs.length > 0, 'Should find JavaScript posts');
      assert.ok(page1.docs.length <= 5, 'Should respect limit');

      // Verify all results contain "JavaScript"
      page1.docs.forEach(post => {
        const searchableText = `${post.title} ${post.content} ${post.author}`.toLowerCase();
        assert.ok(
          searchableText.includes('javascript'),
          `Post should match search term: ${post.title}`
        );
      });

      // Get next page using cursor
      if (page1.next) {
        const page2 = await repo.getAll({
          after: page1.next,
          search: 'JavaScript',
          sort: { publishedAt: -1 },
          limit: 5
        });

        assert.strictEqual(page2.method, 'keyset');
        assert.ok(page2.docs.length > 0, 'Should have more results');

        // Verify no duplicates between pages
        const page1Ids = new Set(page1.docs.map(d => d._id.toString()));
        const page2Ids = page2.docs.map(d => d._id.toString());

        page2Ids.forEach(id => {
          assert.ok(!page1Ids.has(id), 'Should not have duplicate posts across pages');
        });

        // Verify chronological order (publishedAt descending)
        const lastPage1Date = page1.docs[page1.docs.length - 1].publishedAt;
        const firstPage2Date = page2.docs[0].publishedAt;
        assert.ok(lastPage1Date >= firstPage2Date, 'Should maintain chronological order');
      }
    });

    it('should handle infinite scroll through all search results', async () => {
      // Paginate through all MongoDB posts
      const allPosts = [];
      let cursor = null;
      let iterations = 0;
      const maxIterations = 10;

      while (iterations < maxIterations) {
        const result = await repo.getAll({
          after: cursor,
          search: 'MongoDB',
          sort: { publishedAt: -1 },
          limit: 5
        });

        assert.strictEqual(result.method, 'keyset');
        allPosts.push(...result.docs);

        if (!result.hasMore || !result.next) break;
        cursor = result.next;
        iterations++;
      }

      assert.ok(allPosts.length > 0, 'Should find MongoDB posts');
      assert.ok(allPosts.length >= 15, 'Should find at least 15 MongoDB posts');

      // Verify all are unique
      const uniqueIds = new Set(allPosts.map(p => p._id.toString()));
      assert.strictEqual(uniqueIds.size, allPosts.length, 'All posts should be unique');

      // Verify all match search term
      allPosts.forEach(post => {
        const searchableText = `${post.title} ${post.content}`.toLowerCase();
        assert.ok(searchableText.includes('mongodb'), 'Should match search term');
      });

      // Verify chronological order
      for (let i = 1; i < allPosts.length; i++) {
        assert.ok(
          allPosts[i - 1].publishedAt >= allPosts[i].publishedAt,
          'Should be in descending chronological order'
        );
      }
    });

    it('should handle empty search results gracefully', async () => {
      const result = await repo.getAll({
        after: null,
        search: 'NonexistentTerm12345',
        sort: { publishedAt: -1 },
        limit: 10
      });

      assert.strictEqual(result.method, 'keyset');
      assert.strictEqual(result.docs.length, 0);
      assert.strictEqual(result.hasMore, false);
      assert.strictEqual(result.next, null);
    });

    it('should combine search + filters + infinite scroll', async () => {
      // Search for "React" posts by specific author with cursor pagination
      const page1 = await repo.getAll({
        after: null,
        search: 'React',
        filters: { author: 'Bob Johnson' },
        sort: { publishedAt: -1 },
        limit: 5
      });

      assert.strictEqual(page1.method, 'keyset');
      assert.ok(page1.docs.length > 0, 'Should find React posts by Bob Johnson');

      // Verify filters are applied
      page1.docs.forEach(post => {
        assert.strictEqual(post.author, 'Bob Johnson');
        const searchableText = `${post.title} ${post.content}`.toLowerCase();
        assert.ok(searchableText.includes('react'));
      });
    });
  });

  describe('Offset Pagination for Admin/Dashboard', () => {
    it('should use offset pagination for admin list with page numbers', async () => {
      // Admin wants page numbers, total count
      const page1 = await repo.getAll({
        page: 1,
        limit: 10,
        sort: { publishedAt: -1 }
      });

      assert.strictEqual(page1.method, 'offset');
      assert.ok(page1.total > 0, 'Should have total count');
      assert.ok(page1.pages > 0, 'Should have page count');
      assert.strictEqual(page1.page, 1);
      assert.strictEqual(page1.limit, 10);

      // Get page 2
      const page2 = await repo.getAll({
        page: 2,
        limit: 10,
        sort: { publishedAt: -1 }
      });

      assert.strictEqual(page2.method, 'offset');
      assert.strictEqual(page2.page, 2);

      // Verify different results
      const page1Ids = page1.docs.map(d => d._id.toString());
      const page2Ids = page2.docs.map(d => d._id.toString());
      const overlap = page1Ids.filter(id => page2Ids.includes(id));
      assert.strictEqual(overlap.length, 0, 'Pages should not overlap');
    });

    it('should use offset pagination for filtered admin views', async () => {
      const result = await repo.getAll({
        page: 1,
        limit: 20,
        filters: { status: 'published', author: 'Jane Smith' },
        sort: { views: -1 }
      });

      assert.strictEqual(result.method, 'offset');
      assert.ok(result.total > 0);

      // Verify all are by Jane Smith
      result.docs.forEach(post => {
        assert.strictEqual(post.author, 'Jane Smith');
        assert.strictEqual(post.status, 'published');
      });

      // Verify sorted by views descending
      for (let i = 1; i < result.docs.length; i++) {
        assert.ok(result.docs[i - 1].views >= result.docs[i].views);
      }
    });
  });

  describe('Mixed Scenarios', () => {
    it('should switch between offset and keyset seamlessly', async () => {
      // User starts on admin page (offset)
      const adminView = await repo.getAll({
        page: 1,
        limit: 10,
        sort: { publishedAt: -1 }
      });

      assert.strictEqual(adminView.method, 'offset');
      assert.ok(adminView.total > 0);

      // User switches to public feed (keyset for infinite scroll)
      const feedView = await repo.getAll({
        after: null,
        limit: 10,
        sort: { publishedAt: -1 }
      });

      assert.strictEqual(feedView.method, 'keyset');
      assert.ok(feedView.next !== undefined);

      // Both should return same first 10 posts (same sort)
      assert.strictEqual(adminView.docs.length, feedView.docs.length);
      for (let i = 0; i < Math.min(adminView.docs.length, feedView.docs.length); i++) {
        assert.strictEqual(
          adminView.docs[i]._id.toString(),
          feedView.docs[i]._id.toString(),
          'Same query should return same results regardless of pagination method'
        );
      }
    });

    it('should handle default pagination when no mode specified', async () => {
      // Just filters, no explicit pagination params
      const result = await repo.getAll({
        filters: { author: 'John Doe' }
      });

      // Should default to offset mode, page 1
      assert.strictEqual(result.method, 'offset');
      assert.strictEqual(result.page, 1);
      assert.ok(result.total > 0);

      result.docs.forEach(post => {
        assert.strictEqual(post.author, 'John Doe');
      });
    });
  });

  describe('Performance & Edge Cases', () => {
    it('should handle large limit in keyset mode', async () => {
      const result = await repo.getAll({
        after: null,
        sort: { publishedAt: -1 },
        limit: 50
      });

      assert.strictEqual(result.method, 'keyset');
      assert.ok(result.docs.length > 0);
      assert.ok(result.docs.length <= 50);
    });

    it('should handle cursor at end of results', async () => {
      // Get all posts in small batches
      let cursor = null;
      let lastPage;
      let iterations = 0;

      while (iterations < 20) {
        const result = await repo.getAll({
          after: cursor,
          sort: { publishedAt: -1 },
          limit: 10
        });

        lastPage = result;

        if (!result.hasMore || !result.next) break;
        cursor = result.next;
        iterations++;
      }

      // Last page should indicate no more results
      assert.strictEqual(lastPage.hasMore, false);
      assert.strictEqual(lastPage.next, null);
    });

    it('should maintain consistency with concurrent reads', async () => {
      // Simulate multiple users paginating at the same time
      const results = await Promise.all([
        repo.getAll({ after: null, sort: { publishedAt: -1 }, limit: 10 }),
        repo.getAll({ after: null, sort: { publishedAt: -1 }, limit: 10 }),
        repo.getAll({ after: null, sort: { publishedAt: -1 }, limit: 10 })
      ]);

      // All should return same results
      const firstIds = results[0].docs.map(d => d._id.toString()).join(',');

      results.forEach(result => {
        const ids = result.docs.map(d => d._id.toString()).join(',');
        assert.strictEqual(ids, firstIds, 'Concurrent reads should return identical results');
      });
    });
  });
});
