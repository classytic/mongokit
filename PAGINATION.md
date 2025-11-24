# Pagination

Simple, fast pagination for MongoDB.

## Quick Start

```javascript
import { Repository } from '@classytic/mongokit';

const repo = new Repository(UserModel);

// Numbered pages - perfect for admin interfaces
const page1 = await repo.paginate({ page: 1, limit: 20 });

// Infinite scroll - perfect for feeds
const feed = await repo.stream({ sort: { createdAt: -1 }, limit: 20 });
const nextPage = await repo.stream({ sort: { createdAt: -1 }, after: feed.next, limit: 20 });
```

## Three Methods

### `paginate()` - Numbered Pages

Best for: Admin tables, search results, small datasets

```javascript
const result = await repo.paginate({
  filters: { status: 'active' },
  sort: { createdAt: -1 },
  page: 2,
  limit: 20
});

// Result
{
  method: 'offset',
  docs: [...],
  page: 2,
  limit: 20,
  total: 150,
  pages: 8,
  hasNext: true,
  hasPrev: true
}
```

**Performance**: O(n) - gets slower for deep pages (page 100+)

### `stream()` - Infinite Scroll

Best for: Feeds, timelines, real-time data, large datasets

```javascript
const result = await repo.stream({
  filters: { organizationId: '...' },
  sort: { createdAt: -1 },
  limit: 20
});

// Result
{
  method: 'keyset',
  docs: [...],
  limit: 20,
  hasMore: true,
  next: 'eyJ2IjoiMjAyNC0w...' // cursor token
}

// Next page
const page2 = await repo.stream({
  filters: { organizationId: '...' },
  sort: { createdAt: -1 },
  after: result.next,
  limit: 20
});
```

**Performance**: O(1) - constant speed regardless of page depth

**Requirements**:
- Index: `{ sortField: 1, _id: 1 }` (ascending) or `{ sortField: -1, _id: -1 }` (descending)
- Single sort field only (+ automatic `_id` tie-breaker)

### `aggregatePaginate()` - Complex Queries

Best for: Reports, analytics, grouped data

```javascript
const result = await repo.aggregatePaginate({
  pipeline: [
    { $match: { status: 'active' } },
    { $group: { _id: '$department', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ],
  page: 1,
  limit: 10
});

// Result
{
  method: 'aggregate',
  docs: [...],
  page: 1,
  limit: 10,
  total: 25,
  pages: 3,
  hasNext: true,
  hasPrev: false
}
```

**Performance**: O(n) - uses `$skip` internally

## Options

### Common Options

```javascript
{
  filters: { status: 'active', organizationId: '...' },  // query filters
  limit: 20,                                              // items per page
  select: 'name email',                                   // fields to return
  populate: 'author',                                     // populate references
  lean: true,                                             // return plain objects
  session: mongooseSession                                // transaction session
}
```

### `paginate()` Specific

```javascript
{
  page: 1,                      // page number (default: 1)
  sort: { createdAt: -1 }       // any MongoDB sort
}
```

### `stream()` Specific

```javascript
{
  sort: { createdAt: -1 },      // REQUIRED: single field + _id (auto-added)
  after: 'eyJ2IjoiMjAyNC...'    // cursor from previous page
}
```

### `aggregatePaginate()` Specific

```javascript
{
  pipeline: [...],              // aggregation pipeline
  page: 1                       // page number (default: 1)
}
```

## Multi-Tenancy

### With `paginate()`

```javascript
const result = await repo.paginate({
  filters: { organizationId: orgId },
  page: 1,
  limit: 50
});
```

### With `stream()`

```javascript
// Create compound index first
UserSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });

// Then paginate
const result = await repo.stream({
  filters: { organizationId: orgId },
  sort: { createdAt: -1 },
  limit: 50
});
```

## Performance Tips

### 1. Use the Right Method

- **Small dataset** (<1000 docs): `paginate()`
- **Large dataset** (>1000 docs): `stream()`
- **Complex aggregation**: `aggregatePaginate()`

### 2. Index Your Sorts

```javascript
// For paginate()
UserSchema.index({ createdAt: -1 });

// For stream()
UserSchema.index({ createdAt: -1, _id: -1 });

// For multi-tenant stream()
UserSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
```

### 3. Use Lean Queries

```javascript
const result = await repo.stream({
  sort: { createdAt: -1 },
  lean: true  // 50% faster
});
```

### 4. Limit Fields

```javascript
const result = await repo.stream({
  sort: { createdAt: -1 },
  select: 'name email avatar'  // only fetch what you need
});
```

## Real-World Examples

### Admin User List

```javascript
const users = await repo.paginate({
  filters: { role: 'user' },
  sort: { createdAt: -1 },
  page: request.query.page || 1,
  limit: 50
});

response.json(users);
```

### Social Media Feed

```javascript
const feed = await repo.stream({
  filters: {
    userId: { $in: followingIds },
    visibility: 'public'
  },
  sort: { createdAt: -1 },
  after: request.query.cursor,
  limit: 20
});

response.json({
  posts: feed.docs,
  nextCursor: feed.next
});
```

### Analytics Dashboard

```javascript
const stats = await repo.aggregatePaginate({
  pipeline: [
    { $match: { createdAt: { $gte: startDate } } },
    { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 },
        revenue: { $sum: '$amount' }
      }
    },
    { $sort: { _id: -1 } }
  ],
  page: 1,
  limit: 30
});

response.json(stats);
```

## Type Safety

```typescript
import type {
  OffsetPaginationResult,
  KeysetPaginationResult
} from '@classytic/mongokit';

// Discriminated union
const result = await repo.paginate({ page: 1 });

if (result.method === 'offset') {
  console.log(result.pages);  // ✅ type-safe
}

if (result.method === 'keyset') {
  console.log(result.next);   // ✅ type-safe
}
```

## Warnings

Deep pagination warnings are returned for pages > 100:

```javascript
{
  method: 'offset',
  docs: [...],
  page: 150,
  warning: 'Deep pagination (page 150). Consider stream() for better performance.'
}
```

## Cursor Format

Cursors are opaque Base64 tokens containing:
- Last document's sort field value
- Last document's `_id`
- Sort configuration (validated on reuse)
- Version number

**Never**:
- Parse cursors client-side
- Store cursors long-term (use bookmarks instead)
- Mix cursors from different sorts

## Limits

Default limits are enforced via config:

```javascript
const repo = new Repository(UserModel, [], {
  defaultLimit: 10,      // default items per page
  maxLimit: 100,         // maximum allowed limit
  maxPage: 10000,        // maximum page number (paginate only)
  deepPageThreshold: 100 // when to show warnings
});
```

## Testing

```javascript
// Utility tests (40 tests) - pure functions
npm test test/utils/*.test.js

// Integration tests (47 tests) - with MongoDB
npm test
```

## Comparison

| Method | Speed | Use Case | Index Required |
|--------|-------|----------|----------------|
| `paginate()` | O(n) | Admin, small data | `{ field: ±1 }` |
| `stream()` | O(1) | Feeds, large data | `{ field: ±1, _id: ±1 }` |
| `aggregatePaginate()` | O(n) | Reports, analytics | Depends on pipeline |

---

**Simple**. **Fast**. **Production-ready**.
