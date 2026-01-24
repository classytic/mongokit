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

### MongoDB Operations Plugin

The `mongoOperationsPlugin` adds MongoDB-specific atomic operations like `increment`, `upsert`, `pushToArray`, etc.

#### Basic Usage (No TypeScript Autocomplete)

```javascript
import { Repository, methodRegistryPlugin, mongoOperationsPlugin } from '@classytic/mongokit';

const repo = new Repository(ProductModel, [
  methodRegistryPlugin(),  // Required first
  mongoOperationsPlugin()
]);

// Works at runtime but TypeScript doesn't provide autocomplete
await repo.increment(productId, 'views', 1);
await repo.upsert({ sku: 'ABC' }, { name: 'Product', price: 99 });
```

#### With TypeScript Type Safety (Recommended)

For full TypeScript autocomplete and type checking, use the `MongoOperationsMethods` type:

```typescript
import { Repository, methodRegistryPlugin, mongoOperationsPlugin } from '@classytic/mongokit';
import type { MongoOperationsMethods } from '@classytic/mongokit';

// 1. Create your repository class
class ProductRepo extends Repository<IProduct> {
  // Add custom methods here
  async findBySku(sku: string) {
    return this.getByQuery({ sku });
  }
}

// 2. Create type helper for autocomplete
type ProductRepoWithPlugins = ProductRepo & MongoOperationsMethods<IProduct>;

// 3. Instantiate with type assertion
const repo = new ProductRepo(ProductModel, [
  methodRegistryPlugin(),
  mongoOperationsPlugin()
]) as ProductRepoWithPlugins;

// 4. Now TypeScript provides full autocomplete and type checking!
await repo.increment(productId, 'views', 1);           // ✅ Autocomplete works
await repo.upsert({ sku: 'ABC' }, { name: 'Product' }); // ✅ Type-safe
await repo.pushToArray(productId, 'tags', 'featured'); // ✅ Validated
await repo.findBySku('ABC');                           // ✅ Custom methods too
```

**Available operations:**
- `upsert(query, data, opts)` - Create or find document
- `increment(id, field, value, opts)` - Atomically increment field
- `decrement(id, field, value, opts)` - Atomically decrement field
- `pushToArray(id, field, value, opts)` - Add to array
- `pullFromArray(id, field, value, opts)` - Remove from array
- `addToSet(id, field, value, opts)` - Add unique value to array
- `setField(id, field, value, opts)` - Set field value
- `unsetField(id, fields, opts)` - Remove field(s)
- `renameField(id, oldName, newName, opts)` - Rename field
- `multiplyField(id, field, multiplier, opts)` - Multiply numeric field
- `setMin(id, field, value, opts)` - Set to min (if current > value)
- `setMax(id, field, value, opts)` - Set to max (if current < value)

### Plugin Type Safety

Plugin methods are added at runtime. Use `WithPlugins<TDoc, TRepo>` for TypeScript autocomplete:

```typescript
import type { WithPlugins } from '@classytic/mongokit';

class UserRepo extends Repository<IUser> {}

const repo = new UserRepo(Model, [
  methodRegistryPlugin(),
  mongoOperationsPlugin(),
  // ... other plugins
]) as WithPlugins<IUser, UserRepo>;

// Full TypeScript autocomplete!
await repo.increment(id, 'views', 1);
await repo.restore(id);
await repo.invalidateCache(id);
```

**Individual plugin types:** `MongoOperationsMethods<T>`, `BatchOperationsMethods`, `AggregateHelpersMethods`, `SubdocumentMethods<T>`, `SoftDeleteMethods<T>`, `CacheMethods`

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

## Building REST APIs

MongoKit provides a complete toolkit for building REST APIs: QueryParser for request handling, JSON Schema generation for validation/docs, and IController interface for framework-agnostic controllers.

### IController Interface

Framework-agnostic controller contract that works with Express, Fastify, Next.js, etc:

```typescript
import type { IController, IRequestContext, IControllerResponse } from '@classytic/mongokit';

// IRequestContext - what your controller receives
interface IRequestContext {
  query: Record<string, unknown>;   // URL query params
  body: Record<string, unknown>;    // Request body
  params: Record<string, string>;   // Route params (:id)
  user?: { id: string; role?: string };  // Auth user
  context?: Record<string, unknown>;     // Tenant ID, etc.
}

// IControllerResponse - what your controller returns
interface IControllerResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  status: number;
}

// IController - implement this interface
interface IController<TDoc> {
  list(ctx: IRequestContext): Promise<IControllerResponse<PaginationResult<TDoc>>>;
  get(ctx: IRequestContext): Promise<IControllerResponse<TDoc>>;
  create(ctx: IRequestContext): Promise<IControllerResponse<TDoc>>;
  update(ctx: IRequestContext): Promise<IControllerResponse<TDoc>>;
  delete(ctx: IRequestContext): Promise<IControllerResponse<{ message: string }>>;
}
```

### QueryParser

Converts HTTP query strings to MongoDB queries with built-in security:

```typescript
import { QueryParser } from '@classytic/mongokit';

const parser = new QueryParser({
  maxLimit: 100,           // Prevent excessive queries
  maxFilterDepth: 5,       // Prevent nested injection
  maxRegexLength: 100,     // ReDoS protection
});

// Parse request query
const { filters, limit, page, sort, search } = parser.parse(req.query);
```

**Supported query patterns:**
```bash
# Filtering
GET /users?status=active&role=admin
GET /users?age[gte]=18&age[lte]=65
GET /users?role[in]=admin,user
GET /users?email[contains]=@gmail.com
GET /users?name[regex]=^John

# Pagination
GET /users?page=2&limit=50
GET /users?after=eyJfaWQiOi...&limit=20  # Cursor-based

# Sorting
GET /users?sort=-createdAt,name

# Search (requires text index)
GET /users?search=john
```

**Security features:**
- Blocks `$where`, `$function`, `$accumulator`, `$expr` operators
- ReDoS protection for regex patterns
- Max filter depth enforcement
- Collection allowlists for lookups

### JSON Schema Generation

Auto-generate JSON schemas from Mongoose models for validation and OpenAPI docs:

```typescript
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

const { crudSchemas } = buildCrudSchemasFromModel(UserModel, {
  fieldRules: {
    organizationId: { immutable: true },    // Can't update after create
    role: { systemManaged: true },          // Users can't set this
    createdAt: { systemManaged: true },
  },
  strictAdditionalProperties: true,  // Reject unknown fields
});

// Generated schemas:
// crudSchemas.createBody  - POST body validation
// crudSchemas.updateBody  - PATCH body validation
// crudSchemas.params      - Route params (:id)
// crudSchemas.listQuery   - GET query validation
```

### Complete Controller Example

```typescript
import {
  Repository,
  QueryParser,
  buildCrudSchemasFromModel,
  type IController,
  type IRequestContext,
  type IControllerResponse,
} from '@classytic/mongokit';

class UserController implements IController<IUser> {
  private repo = new Repository(UserModel);
  private parser = new QueryParser({ maxLimit: 100 });

  async list(ctx: IRequestContext): Promise<IControllerResponse> {
    const { filters, limit, page, sort } = this.parser.parse(ctx.query);

    // Inject tenant filter
    if (ctx.context?.organizationId) {
      filters.organizationId = ctx.context.organizationId;
    }

    const result = await this.repo.getAll({ filters, limit, page, sort });
    return { success: true, data: result, status: 200 };
  }

  async get(ctx: IRequestContext): Promise<IControllerResponse> {
    const doc = await this.repo.getById(ctx.params.id);
    return { success: true, data: doc, status: 200 };
  }

  async create(ctx: IRequestContext): Promise<IControllerResponse> {
    const doc = await this.repo.create(ctx.body);
    return { success: true, data: doc, status: 201 };
  }

  async update(ctx: IRequestContext): Promise<IControllerResponse> {
    const doc = await this.repo.update(ctx.params.id, ctx.body);
    return { success: true, data: doc, status: 200 };
  }

  async delete(ctx: IRequestContext): Promise<IControllerResponse> {
    await this.repo.delete(ctx.params.id);
    return { success: true, data: { message: 'Deleted' }, status: 200 };
  }
}
```

### Fastify Integration

```typescript
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

const controller = new UserController();
const { crudSchemas } = buildCrudSchemasFromModel(UserModel);

// Routes with auto-validation and OpenAPI docs
fastify.get('/users', { schema: { querystring: crudSchemas.listQuery } }, async (req, reply) => {
  const ctx = { query: req.query, body: {}, params: {}, user: req.user };
  const response = await controller.list(ctx);
  return reply.status(response.status).send(response);
});

fastify.post('/users', { schema: { body: crudSchemas.createBody } }, async (req, reply) => {
  const ctx = { query: {}, body: req.body, params: {}, user: req.user };
  const response = await controller.create(ctx);
  return reply.status(response.status).send(response);
});

fastify.get('/users/:id', { schema: { params: crudSchemas.params } }, async (req, reply) => {
  const ctx = { query: {}, body: {}, params: req.params, user: req.user };
  const response = await controller.get(ctx);
  return reply.status(response.status).send(response);
});
```

### Express Integration

```typescript
const controller = new UserController();

app.get('/users', async (req, res) => {
  const ctx = { query: req.query, body: {}, params: {}, user: req.user };
  const response = await controller.list(ctx);
  res.status(response.status).json(response);
});

app.post('/users', async (req, res) => {
  const ctx = { query: {}, body: req.body, params: {}, user: req.user };
  const response = await controller.create(ctx);
  res.status(response.status).json(response);
});
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
