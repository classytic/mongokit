# @classytic/mongokit

[![npm version](https://badge.fury.io/js/@classytic%2Fmongokit.svg)](https://www.npmjs.com/package/@classytic/mongokit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Production-grade MongoDB repository pattern with zero external dependencies

**Works with:** Express, Fastify, NestJS, Next.js, Koa, Hapi, Serverless

## Features

- **Zero dependencies** - Only Mongoose as peer dependency
- **Smart pagination** - Auto-detects offset vs cursor-based
- **Event-driven** - Pre/post hooks for all operations
- **12 built-in plugins** - Caching, soft delete, validation, audit logs, and more
- **TypeScript first** - Full type safety with discriminated unions
- **194 passing tests** - Battle-tested and production-ready

## Installation

```bash
npm install @classytic/mongokit mongoose
```

> Supports Mongoose `^8.0.0` and `^9.0.0`

## Quick Start

```javascript
import { Repository } from '@classytic/mongokit';
import UserModel from './models/User.js';

const userRepo = new Repository(UserModel);

// Create
const user = await userRepo.create({ name: 'John', email: 'john@example.com' });

// Read with auto-detected pagination
const users = await userRepo.getAll({ page: 1, limit: 20 });

// Update
await userRepo.update(user._id, { name: 'Jane' });

// Delete
await userRepo.delete(user._id);
```

## Pagination

`getAll()` automatically detects pagination mode based on parameters:

```javascript
// Offset pagination (page-based) - for dashboards
const result = await repo.getAll({
  page: 1,
  limit: 20,
  filters: { status: 'active' },
  sort: { createdAt: -1 }
});
// → { method: 'offset', docs, total, pages, hasNext, hasPrev }

// Keyset pagination (cursor-based) - for infinite scroll
const stream = await repo.getAll({
  sort: { createdAt: -1 },
  limit: 20
});
// → { method: 'keyset', docs, hasMore, next: 'eyJ2IjoxLC...' }

// Next page with cursor
const next = await repo.getAll({
  after: stream.next,
  sort: { createdAt: -1 },
  limit: 20
});
```

**Auto-detection rules:**
- `page` parameter → offset mode
- `after`/`cursor` parameter → keyset mode
- `sort` without `page` → keyset mode (first page)
- Default → offset mode (page 1)

### Required Indexes

```javascript
// For keyset pagination: sort field + _id
PostSchema.index({ createdAt: -1, _id: -1 });

// For multi-tenant: tenant + sort field + _id
UserSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
```

## API Reference

### CRUD Operations

| Method | Description |
|--------|-------------|
| `create(data, opts)` | Create single document |
| `createMany(data[], opts)` | Create multiple documents |
| `getById(id, opts)` | Find by ID |
| `getByQuery(query, opts)` | Find one by query |
| `getAll(params, opts)` | Paginated list (auto-detects mode) |
| `getOrCreate(query, data, opts)` | Find or create |
| `update(id, data, opts)` | Update document |
| `delete(id, opts)` | Delete document |
| `count(query, opts)` | Count documents |
| `exists(query, opts)` | Check existence |

### Aggregation

```javascript
// Basic aggregation
const result = await repo.aggregate([
  { $match: { status: 'active' } },
  { $group: { _id: '$category', total: { $sum: 1 } } }
]);

// Paginated aggregation
const result = await repo.aggregatePaginate({
  pipeline: [...],
  page: 1,
  limit: 20
});

// Distinct values
const categories = await repo.distinct('category', { status: 'active' });
```

### Transactions

```javascript
await repo.withTransaction(async (session) => {
  await repo.create({ name: 'User 1' }, { session });
  await repo.create({ name: 'User 2' }, { session });
  // Auto-commits on success, auto-rollbacks on error
});
```

## Configuration

```javascript
const repo = new Repository(UserModel, plugins, {
  defaultLimit: 20,           // Default docs per page
  maxLimit: 100,              // Maximum allowed limit
  maxPage: 10000,             // Maximum page number
  deepPageThreshold: 100,     // Warn when page exceeds this
  useEstimatedCount: false,   // Use fast estimated counts
  cursorVersion: 1            // Cursor format version
});
```

## Plugins

### Using Plugins

```javascript
import {
  Repository,
  timestampPlugin,
  softDeletePlugin,
  cachePlugin,
  createMemoryCache
} from '@classytic/mongokit';

const repo = new Repository(UserModel, [
  timestampPlugin(),
  softDeletePlugin(),
  cachePlugin({ adapter: createMemoryCache(), ttl: 60 })
]);
```

### Available Plugins

| Plugin | Description |
|--------|-------------|
| `timestampPlugin()` | Auto-manage `createdAt`/`updatedAt` |
| `softDeletePlugin(opts)` | Mark as deleted instead of removing |
| `auditLogPlugin(logger)` | Log all CUD operations |
| `cachePlugin(opts)` | Redis/Memcached/memory caching with auto-invalidation |
| `validationChainPlugin(validators)` | Custom validation rules |
| `fieldFilterPlugin(preset)` | Role-based field visibility |
| `cascadePlugin(opts)` | Auto-delete related documents |
| `methodRegistryPlugin()` | Dynamic method registration (required by plugins below) |
| `mongoOperationsPlugin()` | Adds `increment`, `pushToArray`, `upsert`, etc. |
| `batchOperationsPlugin()` | Adds `updateMany`, `deleteMany` |
| `aggregateHelpersPlugin()` | Adds `groupBy`, `sum`, `average`, etc. |
| `subdocumentPlugin()` | Manage subdocument arrays |

### Soft Delete

```javascript
const repo = new Repository(UserModel, [
  softDeletePlugin({ deletedField: 'deletedAt' })
]);

await repo.delete(id);  // Marks as deleted
await repo.getAll();    // Excludes deleted
await repo.getAll({ includeDeleted: true });  // Includes deleted
```

### Caching

```javascript
import { cachePlugin, createMemoryCache } from '@classytic/mongokit';

const repo = new Repository(UserModel, [
  cachePlugin({
    adapter: createMemoryCache(),  // or Redis adapter
    ttl: 60,        // Default TTL (seconds)
    byIdTtl: 300,   // TTL for getById
    queryTtl: 30,   // TTL for lists
  })
]);

// Reads are cached automatically
const user = await repo.getById(id);

// Skip cache for fresh data
const fresh = await repo.getById(id, { skipCache: true });

// Mutations auto-invalidate cache
await repo.update(id, { name: 'New' });

// Manual invalidation
await repo.invalidateCache(id);
await repo.invalidateAllCache();
```

**Redis adapter example:**
```javascript
const redisAdapter = {
  async get(key) { return JSON.parse(await redis.get(key) || 'null'); },
  async set(key, value, ttl) { await redis.setex(key, ttl, JSON.stringify(value)); },
  async del(key) { await redis.del(key); },
  async clear(pattern) { /* optional bulk delete */ }
};
```

### Validation Chain

```javascript
import {
  validationChainPlugin,
  requireField,
  uniqueField,
  immutableField,
  blockIf,
  autoInject
} from '@classytic/mongokit';

const repo = new Repository(UserModel, [
  validationChainPlugin([
    requireField('email', ['create']),
    uniqueField('email', 'Email already exists'),
    immutableField('userId'),
    blockIf('noAdminDelete', ['delete'],
      (ctx) => ctx.data?.role === 'admin',
      'Cannot delete admin users'),
    autoInject('slug', (ctx) => slugify(ctx.data?.name), ['create'])
  ])
]);
```

### Cascade Delete

```javascript
import { cascadePlugin, softDeletePlugin } from '@classytic/mongokit';

const repo = new Repository(ProductModel, [
  softDeletePlugin(),
  cascadePlugin({
    relations: [
      { model: 'StockEntry', foreignKey: 'product' },
      { model: 'Review', foreignKey: 'product', softDelete: false }
    ],
    parallel: true,
    logger: console
  })
]);

// Deleting product also deletes related StockEntry and Review docs
await repo.delete(productId);
```

### Field Filtering (RBAC)

```javascript
import { fieldFilterPlugin } from '@classytic/mongokit';

const repo = new Repository(UserModel, [
  fieldFilterPlugin({
    public: ['id', 'name', 'avatar'],
    authenticated: ['email', 'phone'],
    admin: ['createdAt', 'internalNotes']
  })
]);
```

## Event System

```javascript
repo.on('before:create', async (context) => {
  context.data.processedAt = new Date();
});

repo.on('after:create', ({ context, result }) => {
  console.log('Created:', result);
});

repo.on('error:create', ({ context, error }) => {
  console.error('Failed:', error);
});
```

**Events:** `before:*`, `after:*`, `error:*` for `create`, `createMany`, `update`, `delete`, `getById`, `getByQuery`, `getAll`, `aggregatePaginate`

## HTTP Utilities

### Query Parser

```javascript
import { QueryParser } from '@classytic/mongokit';

const queryParser = new QueryParser();

app.get('/users', async (req, res) => {
  const { filters, limit, page, sort } = queryParser.parse(req.query);
  const result = await userRepo.getAll({ filters, limit, page, sort });
  res.json(result);
});
```

**Supported query patterns:**
```bash
GET /users?email=john@example.com&role=admin
GET /users?age[gte]=18&age[lte]=65
GET /users?role[in]=admin,user
GET /users?sort=-createdAt,name&page=2&limit=50
```

### Schema Generator (Fastify/OpenAPI)

```javascript
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

const { crudSchemas } = buildCrudSchemasFromModel(UserModel, {
  fieldRules: {
    organizationId: { immutable: true },
    status: { systemManaged: true }
  }
});

fastify.post('/users', { schema: crudSchemas.create }, handler);
fastify.get('/users', { schema: crudSchemas.list }, handler);
```

## TypeScript

```typescript
import { Repository, OffsetPaginationResult, KeysetPaginationResult } from '@classytic/mongokit';

interface IUser extends Document {
  name: string;
  email: string;
}

const repo = new Repository<IUser>(UserModel);

const result = await repo.getAll({ page: 1, limit: 20 });

// Discriminated union - TypeScript knows the type
if (result.method === 'offset') {
  console.log(result.total, result.pages);  // Available
}
if (result.method === 'keyset') {
  console.log(result.next, result.hasMore); // Available
}
```

## Extending Repository

Create custom repository classes with domain-specific methods:

```typescript
import { Repository, softDeletePlugin, timestampPlugin } from '@classytic/mongokit';
import UserModel, { IUser } from './models/User.js';

class UserRepository extends Repository<IUser> {
  constructor() {
    super(UserModel, [
      timestampPlugin(),
      softDeletePlugin()
    ], {
      defaultLimit: 20
    });
  }

  // Custom domain methods
  async findByEmail(email: string) {
    return this.getByQuery({ email });
  }

  async findActiveUsers() {
    return this.getAll({
      filters: { status: 'active' },
      sort: { createdAt: -1 }
    });
  }

  async deactivate(id: string) {
    return this.update(id, { status: 'inactive', deactivatedAt: new Date() });
  }
}

// Usage
const userRepo = new UserRepository();
const user = await userRepo.findByEmail('john@example.com');
```

### Overriding Methods

```typescript
class AuditedUserRepository extends Repository<IUser> {
  constructor() {
    super(UserModel);
  }

  // Override create to add audit trail
  async create(data: Partial<IUser>, options = {}) {
    const result = await super.create({
      ...data,
      createdBy: getCurrentUserId()
    }, options);

    await auditLog('user.created', result._id);
    return result;
  }
}
```

## Factory Function

For simple cases without custom methods:

```javascript
import { createRepository, timestampPlugin } from '@classytic/mongokit';

const userRepo = createRepository(UserModel, [timestampPlugin()], {
  defaultLimit: 20
});
```

## No Breaking Changes

Extending Repository works exactly the same with Mongoose 8 and 9. The package:

- Uses its own event system (not Mongoose middleware)
- Defines its own `FilterQuery` type (unaffected by Mongoose 9 rename)
- Properly gates update pipelines (safe for Mongoose 9's stricter defaults)
- All 194 tests pass on both Mongoose 8 and 9

## License

MIT
