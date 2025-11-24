/**
 * Infinite Scroll Example (Cursor Pagination)
 *
 * Perfect for: social feeds, news feeds, real-time data streams
 * Performance: O(1) regardless of scroll position
 */

import express from 'express';
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';

// Post Model
const PostSchema = new mongoose.Schema({
  title: String,
  content: String,
  author: String,
  publishedAt: { type: Date, default: Date.now },
  views: { type: Number, default: 0 }
});

// IMPORTANT: Create compound index for keyset pagination
PostSchema.index({ publishedAt: -1, _id: -1 });

const Post = mongoose.model('Post', PostSchema);

// Repository
const postRepo = new Repository(Post, [], {
  defaultLimit: 20,
  maxLimit: 50
});

const app = express();
app.use(express.json());

/**
 * GET /feed - Infinite scroll feed
 *
 * First page: GET /feed?limit=20
 * Next pages: GET /feed?cursor=eyJ2IjoxLC...&limit=20
 */
app.get('/feed', async (req, res) => {
  try {
    const { cursor, limit = 20 } = req.query;

    const result = await postRepo.getAll({
      ...(cursor && { after: cursor }), // Auto-detects keyset mode when cursor present
      sort: { publishedAt: -1 },
      limit: parseInt(limit)
    });

    // Response format
    res.json({
      posts: result.docs,
      hasMore: result.hasMore,
      nextCursor: result.next, // Use this for next page
      method: result.method // 'keyset'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /feed/search - Search with infinite scroll
 *
 * Requires text index: PostSchema.index({ title: 'text', content: 'text' })
 */
PostSchema.index({ title: 'text', content: 'text' });

app.get('/feed/search', async (req, res) => {
  try {
    const { q, cursor, limit = 20 } = req.query;

    const result = await postRepo.getAll({
      search: q,
      ...(cursor && { after: cursor }),
      sort: { publishedAt: -1 },
      limit: parseInt(limit)
    });

    res.json({
      posts: result.docs,
      hasMore: result.hasMore,
      nextCursor: result.next,
      query: q
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Frontend Integration Example (React)
 */
const FrontendExample = `
// React Infinite Scroll Component
import { useState, useEffect } from 'react';

function Feed() {
  const [posts, setPosts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const loadMore = async () => {
    if (loading || !hasMore) return;

    setLoading(true);

    const url = cursor
      ? \`/feed?cursor=\${cursor}&limit=20\`
      : '/feed?limit=20';

    const res = await fetch(url);
    const data = await res.json();

    setPosts(prev => [...prev, ...data.posts]);
    setCursor(data.nextCursor);
    setHasMore(data.hasMore);
    setLoading(false);
  };

  useEffect(() => {
    loadMore();
  }, []);

  return (
    <div>
      {posts.map(post => (
        <div key={post._id}>{post.title}</div>
      ))}

      {hasMore && (
        <button onClick={loadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load More'}
        </button>
      )}
    </div>
  );
}
`;

// Start
mongoose.connect('mongodb://localhost:27017/feed-app')
  .then(() => {
    app.listen(3000, () => {
      console.log('Feed API: http://localhost:3000/feed');
      console.log('Search: http://localhost:3000/feed/search?q=javascript');
    });
  });

/**
 * KEY BENEFITS:
 *
 * 1. O(1) Performance - Fast at any scroll position
 * 2. Real-time Safe - New posts don't break pagination
 * 3. No Duplicate Posts - Cursor ensures continuity
 * 4. No Skipped Posts - Unlike offset pagination
 *
 * INDEXING STRATEGY:
 *
 * // For sort by publishedAt
 * PostSchema.index({ publishedAt: -1, _id: -1 });
 *
 * // For multi-tenant feeds
 * PostSchema.index({ userId: 1, publishedAt: -1, _id: -1 });
 *
 * // For filtered feeds
 * PostSchema.index({ category: 1, publishedAt: -1, _id: -1 });
 */
