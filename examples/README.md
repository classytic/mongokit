# MongoKit Examples

Simple, copy-paste ready examples for different frameworks and use cases.

## Quick Start

- [getting-started.js](./getting-started.js) - Basic CRUD, pagination, and common patterns

## Framework Examples

- [express-basic.js](./express-basic.js) - Express REST API with offset pagination
- [nestjs-example.ts](./nestjs-example.ts) - NestJS integration with dependency injection
- [nextjs-api-route.js](./nextjs-api-route.js) - Next.js API routes

## Use Case Examples

- [infinite-scroll.js](./infinite-scroll.js) - Cursor pagination for feeds and streams
- [caching-redis.ts](./caching-redis.ts) - Add caching with Redis or in-memory

## Running Examples

### Express Example

```bash
# Install dependencies
npm install express mongoose @classytic/mongokit

# Start MongoDB (if not running)
mongod

# Run the example
node examples/express-basic.js

# Test the API
curl http://localhost:3000/users?page=1&limit=10
```

### NestJS Example

```bash
# Create NestJS project
npm i -g @nestjs/cli
nest new my-project

# Install dependencies
npm install @nestjs/mongoose mongoose @classytic/mongokit

# Copy the example code to your project
# Then run:
npm run start:dev
```

### Next.js Example

```bash
# Create Next.js project
npx create-next-app my-app

# Install dependencies
npm install mongoose @classytic/mongokit

# Copy example to pages/api/users.js
# Then run:
npm run dev
```

## Key Patterns

### Offset Pagination (Page-based)

Best for: Admin dashboards, page numbers, showing total counts

```javascript
const result = await repo.getAll({
  page: 1,
  limit: 20,
  filters: { status: 'active' }
});

console.log(result.total); // Total count
console.log(result.pages); // Total pages
console.log(result.hasNext); // Has next page?
```

### Keyset Pagination (Cursor-based)

Best for: Infinite scroll, real-time feeds, large datasets

```javascript
// First page
const page1 = await repo.getAll({
  sort: { createdAt: -1 },
  limit: 20
});

// Next page
const page2 = await repo.getAll({
  after: page1.next,
  sort: { createdAt: -1 },
  limit: 20
});
```

### Caching (Redis or In-Memory)

```javascript
import { cachePlugin, createMemoryCache } from '@classytic/mongokit';

const repo = new Repository(UserModel, [
  cachePlugin({
    adapter: createMemoryCache(), // or your Redis adapter
    ttl: 60,      // 60 seconds default
    byIdTtl: 300, // 5 min for getById
    queryTtl: 30, // 30s for lists
  })
]);

// Reads are cached automatically
const user = await repo.getById(id); // cached

// Skip cache when needed
const fresh = await repo.getById(id, { skipCache: true });

// Mutations auto-invalidate cache
await repo.update(id, { name: 'New' });

// Manual invalidation (for microservices)
await repo.invalidateCache(id);
await repo.invalidateAllCache();
```

### Custom Repository

```javascript
class UserRepository extends Repository {
  constructor() {
    super(UserModel, [], {
      defaultLimit: 20,
      maxLimit: 100
    });
  }

  async findActiveUsers() {
    return this.getAll({
      filters: { status: 'active' }
    });
  }
}
```

## Need Help?

- [Main Documentation](../README.md)
- [GitHub Issues](https://github.com/classytic/mongokit/issues)
- [npm Package](https://www.npmjs.com/package/@classytic/mongokit)
