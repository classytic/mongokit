# @classytic/mongokit

[![npm version](https://badge.fury.io/js/@classytic%2Fmongokit.svg)](https://www.npmjs.com/package/@classytic/mongokit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Production-grade MongoDB repository pattern with zero external dependencies

**Works with:** Express, Fastify, NestJS, Next.js, Koa, Hapi, Serverless

## Features

- **Zero dependencies** - Only Mongoose as peer dependency
- **Explicit + smart pagination** - Explicit `mode` control or auto-detection; offset, keyset, and aggregate
- **Event-driven** - Pre/post hooks for all operations (granular scalability hooks)
- **17 built-in plugins** - Caching, soft delete, audit trail, validation, multi-tenant, custom IDs, observability, Elasticsearch, and more
- **Distributed cache safety** - List cache versions stored in the adapter (Redis) for multi-pod correctness
- **Search governance** - Text index guard (throws `400` if no index), allowlisted sort/filter fields, ReDoS protection
- **Vector search** - MongoDB Atlas `$vectorSearch` with auto-embedding and multimodal support
- **TypeScript first** - Full type safety with discriminated unions, typed events, and field autocomplete
- **1130+ passing tests** - Battle-tested and production-ready

## Installation

```bash
npm install @classytic/mongokit mongoose
```

> Requires Mongoose `^9.0.0` | Node.js `>=22`

## Quick Start

```javascript
import { Repository } from "@classytic/mongokit";
import UserModel from "./models/User.js";

const userRepo = new Repository(UserModel);

// Create
const user = await userRepo.create({ name: "John", email: "john@example.com" });

// Read with auto-detected pagination
const users = await userRepo.getAll({ page: 1, limit: 20 });

// Update
await userRepo.update(user._id, { name: "Jane" });

// Delete
await userRepo.delete(user._id);
```

## Pagination

`getAll()` takes an **explicit `mode`** or auto-detects based on parameters:

```javascript
// EXPLICIT: Offset pagination (recommended for dashboards, admin panels)
const result = await repo.getAll({
  mode: "offset", // explicit — no ambiguity
  page: 1,
  limit: 20,
  filters: { status: "active" },
  sort: { createdAt: -1 },
  countStrategy: "exact", // 'exact' | 'estimated' | 'none'
  hint: { createdAt: -1 }, // index hint for query governance
  maxTimeMS: 2000, // kill slow queries
});
// → { method: 'offset', docs, total, pages, hasNext, hasPrev }

// EXPLICIT: Keyset pagination (recommended for feeds, infinite scroll)
const stream = await repo.getAll({
  mode: "keyset",
  sort: { createdAt: -1 },
  limit: 20,
});
// → { method: 'keyset', docs, hasMore, next: 'eyJ2IjoxLC...' }

// Next page with cursor
const next = await repo.getAll({
  after: stream.next,
  sort: { createdAt: -1 },
  limit: 20,
});

// AUTO-DETECTION (backwards compatible, no mode required)
// page parameter → offset mode
// after/cursor parameter → keyset mode
// sort without page → keyset mode (first page)
// nothing/filters only → offset mode (page 1)
```

**Auto-detection rules (when `mode` is omitted):**

- `page` present → **offset** mode
- `after` or `cursor` present → **keyset** mode
- Non-default `sort` provided without `page` → **keyset** mode
- Nothing / filters only → **offset** mode (page 1)

> ⚠️ **Recommended:** Always pass `mode` explicitly in new code to make intent clear and avoid surprising behavior when query params change.

### Performance Options

| Option          | Type                           | Description                                                         |
| --------------- | ------------------------------ | ------------------------------------------------------------------- |
| `hint`          | `string \| object`             | Force a specific index — prevents collection scans on large tables  |
| `maxTimeMS`     | `number`                       | Kill query if it takes longer than N ms (prevent runaway queries)   |
| `countStrategy` | `'exact'\|'estimated'\|'none'` | Control cost of total-count query — use `'estimated'` for 10M+ rows |

### Required Indexes

```javascript
// For keyset pagination: sort field + _id (compound)
PostSchema.index({ createdAt: -1, _id: -1 });

// For multi-tenant: tenant + sort field + _id
UserSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
```

## API Reference

### CRUD Operations

| Method                           | Options Type         | Description                        |
| -------------------------------- | -------------------- | ---------------------------------- |
| `create(data, opts)`             | `CreateOptions`      | Create single document             |
| `createMany(data[], opts)`       | `CreateOptions`      | Create multiple documents          |
| `getById(id, opts)`              | `CacheableOptions`   | Find by ID                         |
| `getByQuery(query, opts)`        | `CacheableOptions`   | Find one by query                  |
| `getAll(params, opts)`           | `CacheableOptions`   | Paginated list (auto-detects mode) |
| `getOrCreate(query, data, opts)` | `SessionOptions`     | Find or create                     |
| `update(id, data, opts)`         | `UpdateOptions`      | Update document                    |
| `delete(id, opts)`               | `SessionOptions`     | Delete document                    |
| `count(query, opts)`             | `ReadOptions`        | Count documents                    |
| `exists(query, opts)`            | `ReadOptions`        | Check existence                    |
| `aggregate(pipeline, opts)`      | `AggregateOptions`   | Run aggregation pipeline           |
| `distinct(field, query, opts)`   | `ReadOptions`        | Get distinct values                |

All option types inherit from a clean hierarchy — import only what you need:

```
SessionOptions          → { session }
└─ ReadOptions          → + readPreference
   ├─ OperationOptions  → + select, populate, populateOptions, lean, throwOnNotFound
   │  ├─ CacheableOptions → + skipCache, cacheTtl
   │  └─ UpdateOptions    → + updatePipeline, arrayFilters
   ├─ AggregateOptions  → + allowDiskUse, collation, maxTimeMS, maxPipelineStages
   └─ LookupPopulateOptions → + filters, lookups, sort, page, limit, collation
└─ CreateOptions        → + ordered
```

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
  await repo.create({ name: "User 1" }, { session });
  await repo.create({ name: "User 2" }, { session });
  // Auto-commits on success, auto-rollbacks on error
});
```

## Configuration

```javascript
const repo = new Repository(UserModel, plugins, {
  defaultLimit: 20, // Default docs per page
  maxLimit: 100, // Maximum allowed limit
  maxPage: 10000, // Maximum page number
  deepPageThreshold: 100, // Warn when page exceeds this
  useEstimatedCount: false, // Use fast estimated counts
  cursorVersion: 1, // Cursor format version
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
  createMemoryCache,
} from "@classytic/mongokit";

const repo = new Repository(UserModel, [
  timestampPlugin(),
  softDeletePlugin(),
  cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
]);
```

### Available Plugins

| Plugin                              | Description                                               |
| ----------------------------------- | --------------------------------------------------------- |
| `timestampPlugin()`                 | Auto-manage `createdAt`/`updatedAt`                       |
| `softDeletePlugin(opts)`            | Mark as deleted instead of removing                       |
| `auditLogPlugin(logger)`            | Log all CUD operations                                    |
| `cachePlugin(opts)`                 | Redis/Memcached/memory caching with auto-invalidation     |
| `validationChainPlugin(validators)` | Custom validation rules                                   |
| `fieldFilterPlugin(preset)`         | Role-based field visibility                               |
| `cascadePlugin(opts)`               | Auto-delete related documents                             |
| `methodRegistryPlugin()`            | Dynamic method registration (required by plugins below)   |
| `mongoOperationsPlugin()`           | Adds `increment`, `pushToArray`, `upsert`, etc.           |
| `batchOperationsPlugin()`           | Adds `updateMany`, `deleteMany`, `bulkWrite`              |
| `aggregateHelpersPlugin()`          | Adds `groupBy`, `sum`, `average`, etc.                    |
| `subdocumentPlugin()`               | Manage subdocument arrays                                 |
| `multiTenantPlugin(opts)`           | Auto-inject tenant isolation on all operations            |
| `customIdPlugin(opts)`              | Auto-generate sequential/random IDs with atomic counters  |
| `elasticSearchPlugin(opts)`         | Delegate text/semantic search to Elasticsearch/OpenSearch |
| `auditTrailPlugin(opts)`            | DB-persisted audit trail with change tracking and TTL     |
| `observabilityPlugin(opts)`         | Operation timing, metrics, slow query detection           |

### Soft Delete

```javascript
const repo = new Repository(UserModel, [
  methodRegistryPlugin(),
  batchOperationsPlugin(),
  softDeletePlugin({ deletedField: "deletedAt" }),
]);

await repo.delete(id); // Marks as deleted (sets deletedAt)
await repo.getAll(); // Excludes deleted
await repo.getAll({ includeDeleted: true }); // Includes deleted

// Batch operations respect soft-delete automatically
await repo.deleteMany({ status: "draft" }); // Soft-deletes matching docs
await repo.updateMany({ status: "active" }, { $set: { featured: true } }); // Skips soft-deleted
```

### Populate via URL (Array Refs + Field Selection)

Populate arrays of ObjectIds with field selection, filtering, and sorting — all from URL query params:

```bash
# Populate all products in an order
GET /orders?populate=products

# Only name and price from each product
GET /orders?populate[products][select]=name,price

# Exclude fields
GET /orders?populate[products][select]=-internalNotes,-cost

# Filter: only active products
GET /orders?populate[products][match][status]=active

# Limit + sort populated items
GET /orders?populate[products][limit]=5&populate[products][sort]=-price

# Combined
GET /orders?populate[products][select]=name,price&populate[products][match][status]=active&populate[products][limit]=10
```

```typescript
// Express route — 3 lines
const parsed = parser.parse(req.query);
const result = await orderRepo.getAll(
  { filters: parsed.filters, sort: parsed.sort, limit: parsed.limit },
  { populateOptions: parsed.populateOptions, populate: parsed.populate },
);
```

### Lookup Joins via URL (No Refs Needed)

Join collections by any field (slug, code, SKU) using `$lookup` — no `ref` in schema required. Faster than `populate` for non-ref joins.

```bash
# Join products with categories by slug
GET /products?lookup[category][from]=categories&lookup[category][localField]=categorySlug&lookup[category][foreignField]=slug&lookup[category][single]=true

# With field selection on joined collection (only bring name + slug)
GET /products?lookup[category][...same]&lookup[category][select]=name,slug

# Combined with filter + sort + root select
GET /products?status=active&sort=-price&select=name,price,category&lookup[category][...same]&lookup[category][select]=name
```

```typescript
// Express route — getAll auto-routes to $lookup when lookups are present
const parsed = parser.parse(req.query);
const result = await repo.getAll({
  filters: parsed.filters,
  sort: parsed.sort,
  lookups: parsed.lookups,   // auto-routes to lookupPopulate
  select: parsed.select,
  limit: parsed.limit,
});
```

> **Populate vs Lookup:** Use `populate` for `ref` fields (ObjectId arrays). Use `lookup` for joining by any field (slugs, codes, SKUs) — it runs a server-side `$lookup` aggregation, which is faster than client-side population for non-ref joins.

### Caching

```javascript
import { cachePlugin, createMemoryCache } from "@classytic/mongokit";

const repo = new Repository(UserModel, [
  cachePlugin({
    adapter: createMemoryCache(), // or Redis adapter
    ttl: 60, // Default TTL (seconds)
    byIdTtl: 300, // TTL for getById
    queryTtl: 30, // TTL for lists
  }),
]);

// Reads are cached automatically
const user = await repo.getById(id);

// Skip cache for fresh data
const fresh = await repo.getById(id, { skipCache: true });

// Mutations auto-invalidate cache
await repo.update(id, { name: "New" });

// Manual invalidation
await repo.invalidateCache(id);
await repo.invalidateAllCache();
```

**Redis adapter example:**

```javascript
const redisAdapter = {
  async get(key) {
    return JSON.parse((await redis.get(key)) || "null");
  },
  async set(key, value, ttl) {
    await redis.setex(key, ttl, JSON.stringify(value));
  },
  async del(key) {
    await redis.del(key);
  },
  async clear(pattern) {
    /* optional bulk delete */
  },
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
  autoInject,
} from "@classytic/mongokit";

const repo = new Repository(UserModel, [
  validationChainPlugin([
    requireField("email", ["create"]),
    uniqueField("email", "Email already exists"),
    immutableField("userId"),
    blockIf(
      "noAdminDelete",
      ["delete"],
      (ctx) => ctx.data?.role === "admin",
      "Cannot delete admin users",
    ),
    autoInject("slug", (ctx) => slugify(ctx.data?.name), ["create"]),
  ]),
]);
```

### Cascade Delete

```javascript
import { cascadePlugin, softDeletePlugin } from "@classytic/mongokit";

const repo = new Repository(ProductModel, [
  softDeletePlugin(),
  cascadePlugin({
    relations: [
      { model: "StockEntry", foreignKey: "product" },
      { model: "Review", foreignKey: "product", softDelete: false },
    ],
    parallel: true,
    logger: console,
  }),
]);

// Deleting product also deletes related StockEntry and Review docs
await repo.delete(productId);
```

### Field Filtering (RBAC)

```javascript
import { fieldFilterPlugin } from "@classytic/mongokit";

const repo = new Repository(UserModel, [
  fieldFilterPlugin({
    public: ["id", "name", "avatar"],
    authenticated: ["email", "phone"],
    admin: ["createdAt", "internalNotes"],
  }),
]);
```

### Multi-Tenant

```javascript
import { multiTenantPlugin } from "@classytic/mongokit";

const repo = new Repository(UserModel, [
  multiTenantPlugin({
    tenantField: "organizationId",
    contextKey: "organizationId", // reads from context
    required: true,
  }),
]);

// All operations are automatically scoped to the tenant
const users = await repo.getAll({ organizationId: "org_123" });
await repo.update(userId, { name: "New" }, { organizationId: "org_123" });
// Cross-tenant update/delete is blocked — returns "not found"
```

### Audit Trail (DB-Persisted)

The `auditTrailPlugin` persists operation audit entries to a shared MongoDB collection. Unlike `auditLogPlugin` (which logs to an external logger), this stores a queryable audit trail in the database with automatic TTL cleanup.

```typescript
import {
  Repository,
  methodRegistryPlugin,
  auditTrailPlugin,
} from "@classytic/mongokit";

const repo = new Repository(JobModel, [
  methodRegistryPlugin(),
  auditTrailPlugin({
    operations: ["create", "update", "delete"], // Which ops to track
    trackChanges: true, // Field-level before/after diff on updates
    trackDocument: false, // Full doc snapshot on create (heavy)
    ttlDays: 90, // Auto-purge after 90 days (MongoDB TTL index)
    excludeFields: ["password", "token"], // Redact sensitive fields
    metadata: (context) => ({
      // Custom metadata per entry
      ip: context.req?.ip,
      userAgent: context.req?.headers?.["user-agent"],
    }),
  }),
]);

// Query audit trail for a specific document (requires methodRegistryPlugin)
const trail = await repo.getAuditTrail(documentId, {
  page: 1,
  limit: 20,
  operation: "update", // Optional filter
});
// → { docs, page, limit, total, pages, hasNext, hasPrev }
```

**What gets stored:**

```javascript
{
  model: 'Job',
  operation: 'update',
  documentId: ObjectId('...'),
  userId: ObjectId('...'),
  orgId: ObjectId('...'),
  changes: {
    title: { from: 'Old Title', to: 'New Title' },
    salary: { from: 50000, to: 65000 },
  },
  metadata: { ip: '192.168.1.1' },
  timestamp: ISODate('2026-02-26T...'),
}
```

**Standalone queries** (admin dashboards, audit APIs — no repo needed):

```typescript
import { AuditTrailQuery } from "@classytic/mongokit";

const auditQuery = new AuditTrailQuery(); // 'audit_trails' collection

// All audits for an org
const orgAudits = await auditQuery.getOrgTrail(orgId);

// All actions by a user
const userAudits = await auditQuery.getUserTrail(userId);

// History of a specific document
const docHistory = await auditQuery.getDocumentTrail("Job", jobId);

// Custom query with date range
const recent = await auditQuery.query({
  orgId,
  operation: "delete",
  from: new Date("2025-01-01"),
  to: new Date(),
  page: 1,
  limit: 50,
});

// Direct model access for anything custom
const model = auditQuery.getModel();
const deleteCount = await model.countDocuments({ operation: "delete" });
```

**Key design decisions:**

- **Fire & forget** — audit writes are async and never block or fail the main operation
- **Shared collection** — one `audit_trails` collection for all models (filtered by `model` field)
- **TTL index** — MongoDB auto-deletes old entries, no cron needed
- **Change diff** — compares before/after on updates, stores only changed fields

**Plugin options:**

| Option          | Default                          | Description                            |
| --------------- | -------------------------------- | -------------------------------------- |
| `operations`    | `['create', 'update', 'delete']` | Which operations to audit              |
| `trackChanges`  | `true`                           | Store before/after diff on updates     |
| `trackDocument` | `false`                          | Store full document snapshot on create |
| `ttlDays`       | `undefined` (keep forever)       | Auto-purge after N days                |
| `collectionName`| `'audit_trails'`                 | MongoDB collection name                |
| `excludeFields` | `[]`                             | Fields to redact from diffs/snapshots  |
| `metadata`      | `undefined`                      | Callback to inject custom metadata     |

**TypeScript type safety:**

```typescript
import type { AuditTrailMethods } from "@classytic/mongokit";

type JobRepoWithAudit = JobRepo & AuditTrailMethods;

const repo = new JobRepo(JobModel, [
  methodRegistryPlugin(),
  auditTrailPlugin({ ttlDays: 90 }),
]) as JobRepoWithAudit;

// Full autocomplete for getAuditTrail
const trail = await repo.getAuditTrail(jobId, { operation: "update" });
```

### Observability

```javascript
import { observabilityPlugin } from "@classytic/mongokit";

const repo = new Repository(UserModel, [
  observabilityPlugin({
    onMetric: (metric) => {
      // Send to DataDog, New Relic, OpenTelemetry, etc.
      statsd.histogram(`mongokit.${metric.operation}`, metric.duration);
    },
    slowThresholdMs: 200, // log operations slower than 200ms
  }),
]);
```

### Custom ID Generation

Generate human-readable sequential IDs (e.g., `INV-0001`, `BILL-2026-02-0001`) using atomic MongoDB counters — safe under concurrency with zero duplicates.

```typescript
import {
  Repository,
  customIdPlugin,
  sequentialId,
  dateSequentialId,
  prefixedId,
} from "@classytic/mongokit";
```

#### Sequential Counter

```typescript
const invoiceRepo = new Repository(InvoiceModel, [
  customIdPlugin({
    field: "invoiceNumber",
    generator: sequentialId({
      prefix: "INV",
      model: InvoiceModel,
    }),
  }),
]);

const inv1 = await invoiceRepo.create({ amount: 100 });
// inv1.invoiceNumber → "INV-0001"

const inv2 = await invoiceRepo.create({ amount: 200 });
// inv2.invoiceNumber → "INV-0002"
```

**Options:**

| Option       | Default      | Description                                          |
| ------------ | ------------ | ---------------------------------------------------- |
| `prefix`     | _(required)_ | Prefix string (e.g., `'INV'`, `'ORD'`)               |
| `model`      | _(required)_ | Mongoose model (counter key derived from model name) |
| `padding`    | `4`          | Number of digits (`4` → `0001`)                      |
| `separator`  | `'-'`        | Separator between prefix and number                  |
| `counterKey` | model name   | Custom counter key to avoid collisions               |

#### Date-Partitioned Counter

Counter resets per period — ideal for invoice/bill numbering:

```typescript
const billRepo = new Repository(BillModel, [
  customIdPlugin({
    field: "billNumber",
    generator: dateSequentialId({
      prefix: "BILL",
      model: BillModel,
      partition: "monthly", // resets each month
    }),
  }),
]);

const bill = await billRepo.create({ total: 250 });
// bill.billNumber → "BILL-2026-02-0001"
```

**Partition modes:**

- `'yearly'` → `BILL-2026-0001` (resets every January)
- `'monthly'` → `BILL-2026-02-0001` (resets every month)
- `'daily'` → `BILL-2026-02-20-0001` (resets every day)

#### Prefixed Random ID

No database round-trip — purely in-memory random suffix:

```typescript
const orderRepo = new Repository(OrderModel, [
  customIdPlugin({
    field: "orderRef",
    generator: prefixedId({ prefix: "ORD", length: 10 }),
  }),
]);

const order = await orderRepo.create({ total: 99 });
// order.orderRef → "ORD_a7b3xk9m2p"
```

#### Custom Generator

Write your own generator function for full control:

```typescript
const repo = new Repository(OrderModel, [
  customIdPlugin({
    field: "orderRef",
    generator: async (context) => {
      const region = context.data?.region || "US";
      const seq = await getNextSequence("orders");
      return `ORD-${region}-${String(seq).padStart(4, "0")}`;
    },
  }),
]);
// → "ORD-US-0001", "ORD-EU-0002", ...
```

#### Plugin Options

| Option                | Default      | Description                                  |
| --------------------- | ------------ | -------------------------------------------- |
| `field`               | `'customId'` | Document field to store the generated ID     |
| `generator`           | _(required)_ | Function returning the ID (sync or async)    |
| `generateOnlyIfEmpty` | `true`       | Skip generation if field already has a value |

#### Batch Creation

Works with `createMany` — each document gets its own sequential ID:

```typescript
const docs = await invoiceRepo.createMany([
  { amount: 10 },
  { amount: 20, invoiceNumber: "MANUAL-001" }, // skipped (already has ID)
  { amount: 30 },
]);
// docs[0].invoiceNumber → "INV-0001"
// docs[1].invoiceNumber → "MANUAL-001"  (preserved)
// docs[2].invoiceNumber → "INV-0002"
```

#### Atomic Counter API

The `getNextSequence` helper is exported for use in custom generators:

```typescript
import { getNextSequence } from "@classytic/mongokit";

const seq = await getNextSequence("my-counter"); // → 1, 2, 3, ...
const batch = await getNextSequence("my-counter", 5); // → jumps by 5
```

Counters are stored in the `_mongokit_counters` collection using MongoDB's atomic `findOneAndUpdate` + `$inc` — guaranteed unique under any level of concurrency.

> **Note:** Counters are monotonically increasing and never decrement on document deletion.
> This is standard behavior for business documents (invoices, bills, receipts) — you never reuse a number.

### Vector Search (Atlas)

```javascript
import { vectorPlugin } from '@classytic/mongokit/ai';

const repo = new Repository(ProductModel, [
  methodRegistryPlugin(),
  vectorPlugin({
    fields: [{
      path: 'embedding',
      index: 'vector_index',
      dimensions: 1536,
      sourceFields: ['title', 'description'],
    }],
    embedFn: async ({ text }) =>
      openai.embeddings.create({ input: text, model: 'text-embedding-3-small' })
        .then(r => r.data[0].embedding),
    autoEmbed: true,
    onEmbedError: (err) => console.warn('Embed failed:', err.message),
  }),
]);

// Search by text (auto-embeds the query)
const results = await repo.searchSimilar({ query: 'running shoes', limit: 10 });

// Search by vector directly
const results = await repo.searchSimilar({ query: [0.1, 0.2, ...], limit: 5 });

// Embed manually
const vector = await repo.embed('some text');
```

### Elasticsearch / OpenSearch Plugin

Delegates heavy text and semantic search to an external search engine while fetching full documents from MongoDB. Keeps your OLTP (transactional) MongoDB operations fast by separating search I/O.

**Architecture:** Query ES/OpenSearch → get IDs + relevance scores → fetch full docs from MongoDB → return in ES ranking order.

```typescript
import {
  Repository,
  methodRegistryPlugin,
  elasticSearchPlugin,
} from "@classytic/mongokit";
import { Client } from "@elastic/elasticsearch"; // or '@opensearch-project/opensearch'

const esClient = new Client({ node: "http://localhost:9200" });

const productRepo = new Repository(ProductModel, [
  methodRegistryPlugin(), // Required first
  elasticSearchPlugin({
    client: esClient,
    index: "products",
    idField: "_id", // field in ES doc that maps to MongoDB _id
  }),
]);

// Perform semantic/full-text search
const results = await productRepo.search(
  { match: { description: "wireless headphones" } },
  {
    limit: 20, // capped to 1000 max (safety bound)
    from: 0,
    mongoOptions: {
      select: "name price description",
      lean: true,
    },
  },
);

// results.docs - MongoDB documents in ES ranking order
// results.docs[*]._score - ES relevance score (preserved, including 0)
// results.total - total hits count from ES
```

**Why this exists:**

- `$text` in MongoDB requires a text index and is not scalable for fuzzy/semantic search
- ES/OpenSearch provides BM25, vector search, semantic search, analyzers, facets
- This plugin bridges both: ES rank + MongoDB's transactional documents

**Bounds enforcement:**

- `limit` is clamped to `[1, 1000]` — prevents runaway ES queries
- `from` is clamped to `>= 0` — prevents negative offsets
- Returns `{ docs: [], total: 0 }` immediately if ES returns no hits

### Logging

```javascript
import { configureLogger } from "@classytic/mongokit";

// Silence all internal warnings
configureLogger(false);

// Custom logger
configureLogger({
  warn: (msg, ...args) => myLogger.warn(msg, ...args),
  debug: (msg, ...args) => myLogger.debug(msg, ...args),
});
```

### MongoDB Operations Plugin

The `mongoOperationsPlugin` adds MongoDB-specific atomic operations like `increment`, `upsert`, `pushToArray`, etc.

#### Basic Usage (No TypeScript Autocomplete)

```javascript
import {
  Repository,
  methodRegistryPlugin,
  mongoOperationsPlugin,
} from "@classytic/mongokit";

const repo = new Repository(ProductModel, [
  methodRegistryPlugin(), // Required first
  mongoOperationsPlugin(),
]);

// Works at runtime but TypeScript doesn't provide autocomplete
await repo.increment(productId, "views", 1);
await repo.upsert({ sku: "ABC" }, { name: "Product", price: 99 });
```

#### With TypeScript Type Safety (Recommended)

For full TypeScript autocomplete and type checking, use the `MongoOperationsMethods` type:

```typescript
import {
  Repository,
  methodRegistryPlugin,
  mongoOperationsPlugin,
} from "@classytic/mongokit";
import type { MongoOperationsMethods } from "@classytic/mongokit";

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
  mongoOperationsPlugin(),
]) as ProductRepoWithPlugins;

// 4. Now TypeScript provides full autocomplete and type checking!
await repo.increment(productId, "views", 1); // ✅ Autocomplete works
await repo.upsert({ sku: "ABC" }, { name: "Product" }); // ✅ Type-safe
await repo.pushToArray(productId, "tags", "featured"); // ✅ Validated
await repo.findBySku("ABC"); // ✅ Custom methods too
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
import type { WithPlugins } from "@classytic/mongokit";

class UserRepo extends Repository<IUser> {}

const repo = new UserRepo(Model, [
  methodRegistryPlugin(),
  mongoOperationsPlugin(),
  softDeletePlugin(),
]) as WithPlugins<IUser, UserRepo>;

// Full TypeScript autocomplete — field names inferred from IUser!
await repo.increment(id, "age", 1); // ✅ "age" autocompleted from IUser
await repo.groupBy("status"); // ✅ "status" autocompleted
await repo.restore(id); // ✅ Returns Promise<IUser>
await repo.getDeleted(); // ✅ Returns OffsetPaginationResult<IUser>
await repo.invalidateCache(id);
```

Field params use `DocField<TDoc>` — autocomplete for known fields, still accepts arbitrary strings for nested paths like `'address.city'`.

**Individual plugin types:** `MongoOperationsMethods<T>`, `BatchOperationsMethods`, `AggregateHelpersMethods`, `SubdocumentMethods<T>`, `SoftDeleteMethods<T>`, `CacheMethods`, `AuditTrailMethods`

## Event System

Event names are typed as `RepositoryEvent` — full autocomplete in TypeScript:

```typescript
// before:* receives context directly — mutate in-place
repo.on("before:create", async (context) => {
  context.data.processedAt = new Date();
});

// after:* receives { context, result }
repo.on("after:create", ({ context, result }) => {
  console.log("Created:", result);
});

// error:* receives { context, error }
repo.on("error:create", ({ context, error }) => {
  console.error("Failed:", error);
});

// Remove a listener
repo.off("after:create", myListener);
```

**Events:** `before:*`, `after:*`, `error:*` for `create`, `createMany`, `update`, `delete`, `deleteMany`, `updateMany`, `getById`, `getByQuery`, `getAll`, `aggregate`, `aggregatePaginate`, `lookupPopulate`, `getOrCreate`, `count`, `exists`, `distinct`, `bulkWrite`

### Microservice Integration (Kafka / RabbitMQ / Redis Pub-Sub)

Use `after:*` hooks to publish events to message brokers — zero additional libraries needed:

```typescript
import { HOOK_PRIORITY } from "@classytic/mongokit";

// Publish to Kafka after every create
repo.on("after:create", async ({ context, result }) => {
  await kafka.publish("orders.created", {
    operation: context.operation,
    model: context.model,
    document: result,
    userId: context.user?._id,
    tenantId: context.organizationId,
    timestamp: Date.now(),
  });
}, { priority: HOOK_PRIORITY.OBSERVABILITY });

// Redis Pub-Sub on updates
repo.on("after:update", async ({ context, result }) => {
  await redis.publish("order:updated", JSON.stringify({
    id: result._id,
    changes: context.data,
  }));
}, { priority: HOOK_PRIORITY.OBSERVABILITY });

// RabbitMQ on deletes (including soft-deletes)
repo.on("after:delete", async ({ context, result }) => {
  await rabbitMQ.sendToQueue("order.deleted", {
    id: result.id,
    soft: result.soft,
    tenantId: context.organizationId,
  });
}, { priority: HOOK_PRIORITY.OBSERVABILITY });
```

**Hook priority order:** `POLICY (100)` → `CACHE (200)` → `OBSERVABILITY (300)` → `DEFAULT (500)`. Event publishing at `OBSERVABILITY` ensures it runs after policy enforcement and cache invalidation.

## Building REST APIs

MongoKit provides a complete toolkit for building REST APIs: QueryParser for request handling, JSON Schema generation for validation/docs, and IController interface for framework-agnostic controllers.

### IController Interface

Framework-agnostic controller contract that works with Express, Fastify, Next.js, etc:

```typescript
import type {
  IController,
  IRequestContext,
  IControllerResponse,
} from "@classytic/mongokit";

// IRequestContext - what your controller receives
interface IRequestContext {
  query: Record<string, unknown>; // URL query params
  body: Record<string, unknown>; // Request body
  params: Record<string, string>; // Route params (:id)
  user?: { id: string; role?: string }; // Auth user
  context?: Record<string, unknown>; // Tenant ID, etc.
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
  list(
    ctx: IRequestContext,
  ): Promise<IControllerResponse<PaginationResult<TDoc>>>;
  get(ctx: IRequestContext): Promise<IControllerResponse<TDoc>>;
  create(ctx: IRequestContext): Promise<IControllerResponse<TDoc>>;
  update(ctx: IRequestContext): Promise<IControllerResponse<TDoc>>;
  delete(
    ctx: IRequestContext,
  ): Promise<IControllerResponse<{ message: string }>>;
}
```

### QueryParser

Converts HTTP query strings to MongoDB queries with built-in security:

```typescript
import { QueryParser } from "@classytic/mongokit";

const parser = new QueryParser({
  maxLimit: 100, // Prevent excessive queries
  maxFilterDepth: 5, // Prevent nested injection
  maxRegexLength: 100, // ReDoS protection
  allowedFilterFields: ['status', 'name', 'email'], // Whitelist filter fields
  allowedSortFields: ['createdAt', 'name'], // Whitelist sort fields
  allowedOperators: ['eq', 'ne', 'in', 'gt', 'lt'], // Whitelist operators
});

// Parse request query
const { filters, limit, page, sort, search } = parser.parse(req.query);

// Read back configured whitelists (used by Arc MCP integration)
parser.allowedFilterFields; // ['status', 'name', 'email'] or undefined
parser.allowedSortFields; // ['createdAt', 'name'] or undefined
parser.allowedOperators; // ['eq', 'ne', 'in', 'gt', 'lt'] or undefined
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

# Simple populate
GET /posts?populate=author,category

# Advanced populate with options
GET /posts?populate[author][select]=name,email
GET /posts?populate[author][match][active]=true
GET /posts?populate[comments][limit]=10
GET /posts?populate[comments][sort]=-createdAt
GET /posts?populate[author][populate][department][select]=name  # Nested
```

**Security features:**

- Blocks `$where`, `$function`, `$accumulator` operators (`$expr` allowed for `$lookup` correlation)
- ReDoS protection for regex patterns
- Max filter depth enforcement
- Field allowlists for filters and sorting (`allowedFilterFields`, `allowedSortFields`)
- Operator allowlists (`allowedOperators`)
- Collection allowlists for lookups
- Populate path sanitization (blocks `$where`, `__proto__`, etc.)
- Max populate depth limit (default: 5)

### Advanced Populate Options

QueryParser supports Mongoose populate options via URL query parameters:

```typescript
import { QueryParser } from "@classytic/mongokit";

const parser = new QueryParser();

// Parse URL: /posts?populate[author][select]=name,email&populate[author][match][active]=true
const parsed = parser.parse(req.query);

// Use with Repository
const posts = await postRepo.getAll(
  { filters: parsed.filters, page: parsed.page, limit: parsed.limit },
  { populateOptions: parsed.populateOptions },
);
```

**Supported populate options:**

| Option     | URL Syntax                                       | Description                                     |
| ---------- | ------------------------------------------------ | ----------------------------------------------- |
| `select`   | `populate[path][select]=field1,field2`           | Fields to include (space-separated in Mongoose) |
| `match`    | `populate[path][match][field]=value`             | Filter populated documents                      |
| `limit`    | `populate[path][limit]=10`                       | Limit number of populated docs                  |
| `sort`     | `populate[path][sort]=-createdAt`                | Sort populated documents                        |
| `populate` | `populate[path][populate][nested][select]=field` | Nested populate (max depth: 5)                  |

**Example - Complex populate:**

```typescript
// URL: /posts?populate[author][select]=name,avatar&populate[comments][limit]=5&populate[comments][sort]=-createdAt&populate[comments][match][approved]=true

const parsed = parser.parse(req.query);
// parsed.populateOptions = [
//   { path: 'author', select: 'name avatar' },
//   { path: 'comments', match: { approved: true }, options: { limit: 5, sort: { createdAt: -1 } } }
// ]

// Simple string populate still works
// URL: /posts?populate=author,category
// parsed.populate = 'author,category'
// parsed.populateOptions = undefined
```

### JSON Schema Generation

Auto-generate JSON schemas from Mongoose models for validation and OpenAPI docs:

```typescript
import { buildCrudSchemasFromModel } from "@classytic/mongokit";

const { crudSchemas } = buildCrudSchemasFromModel(UserModel, {
  fieldRules: {
    organizationId: { immutable: true }, // Can't update after create
    role: { systemManaged: true }, // Users can't set this
    createdAt: { systemManaged: true },
  },
  strictAdditionalProperties: true, // Reject unknown fields
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
} from "@classytic/mongokit";

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
    return { success: true, data: { message: "Deleted" }, status: 200 };
  }
}
```

### Fastify Integration

```typescript
import { buildCrudSchemasFromModel } from "@classytic/mongokit";

const controller = new UserController();
const { crudSchemas } = buildCrudSchemasFromModel(UserModel);

// Routes with auto-validation and OpenAPI docs
fastify.get(
  "/users",
  { schema: { querystring: crudSchemas.listQuery } },
  async (req, reply) => {
    const ctx = { query: req.query, body: {}, params: {}, user: req.user };
    const response = await controller.list(ctx);
    return reply.status(response.status).send(response);
  },
);

fastify.post(
  "/users",
  { schema: { body: crudSchemas.createBody } },
  async (req, reply) => {
    const ctx = { query: {}, body: req.body, params: {}, user: req.user };
    const response = await controller.create(ctx);
    return reply.status(response.status).send(response);
  },
);

fastify.get(
  "/users/:id",
  { schema: { params: crudSchemas.params } },
  async (req, reply) => {
    const ctx = { query: {}, body: {}, params: req.params, user: req.user };
    const response = await controller.get(ctx);
    return reply.status(response.status).send(response);
  },
);
```

### Express Integration

```typescript
const controller = new UserController();

app.get("/users", async (req, res) => {
  const ctx = { query: req.query, body: {}, params: {}, user: req.user };
  const response = await controller.list(ctx);
  res.status(response.status).json(response);
});

app.post("/users", async (req, res) => {
  const ctx = { query: {}, body: req.body, params: {}, user: req.user };
  const response = await controller.create(ctx);
  res.status(response.status).json(response);
});
```

## TypeScript

`TDoc` is inferred from the Mongoose model — no manual annotation needed:

```typescript
import { Repository } from "@classytic/mongokit";
import type { CacheableOptions, ReadOptions } from "@classytic/mongokit";

const repo = new Repository(UserModel); // TDoc inferred from UserModel

// All return types flow correctly
const user = await repo.getById("123"); // IUser | null
const users = await repo.getAll({ page: 1 }); // OffsetPaginationResult<IUser> | KeysetPaginationResult<IUser>

// Discriminated union — TypeScript narrows the type
if (users.method === "offset") {
  console.log(users.total, users.pages); // ✅ Available
}
if (users.method === "keyset") {
  console.log(users.next, users.hasMore); // ✅ Available
}

// Typed options — import and reuse
const opts: CacheableOptions = { skipCache: true, lean: true };
const fresh = await repo.getById("123", opts);
```

### Utility Types

```typescript
import type {
  InferDocument,   // Extract TDoc from Model: InferDocument<typeof UserModel>
  InferRawDoc,     // TDoc without Mongoose Document methods
  CreateInput,     // Omit<TDoc, '_id' | 'createdAt' | 'updatedAt' | '__v'>
  UpdateInput,     // Partial<Omit<TDoc, '_id' | 'createdAt' | '__v'>>
  DocField,        // (keyof TDoc & string) | (string & {}) — autocomplete + nested paths
  PartialBy,       // Make specific fields optional
  RequiredBy,      // Make specific fields required
  DeepPartial,     // Recursive partial
  KeysOfType,      // Extract keys by value type: KeysOfType<IUser, string>
} from "@classytic/mongokit";
```

## Extending Repository

Create custom repository classes with domain-specific methods:

```typescript
import {
  Repository,
  softDeletePlugin,
  timestampPlugin,
} from "@classytic/mongokit";
import UserModel, { IUser } from "./models/User.js";

class UserRepository extends Repository<IUser> {
  constructor() {
    super(UserModel, [timestampPlugin(), softDeletePlugin()], {
      defaultLimit: 20,
    });
  }

  // Custom domain methods
  async findByEmail(email: string) {
    return this.getByQuery({ email });
  }

  async findActiveUsers() {
    return this.getAll({
      filters: { status: "active" },
      sort: { createdAt: -1 },
    });
  }

  async deactivate(id: string) {
    return this.update(id, { status: "inactive", deactivatedAt: new Date() });
  }
}

// Usage
const userRepo = new UserRepository();
const user = await userRepo.findByEmail("john@example.com");
```

### Overriding Methods

```typescript
class AuditedUserRepository extends Repository<IUser> {
  constructor() {
    super(UserModel);
  }

  // Override create to add audit trail
  async create(data: Partial<IUser>, options = {}) {
    const result = await super.create(
      {
        ...data,
        createdBy: getCurrentUserId(),
      },
      options,
    );

    await auditLog("user.created", result._id);
    return result;
  }
}
```

## Factory Function

For simple cases without custom methods:

```javascript
import { createRepository, timestampPlugin } from "@classytic/mongokit";

const userRepo = createRepository(UserModel, [timestampPlugin()], {
  defaultLimit: 20,
});
```

## Error Handling

MongoKit translates MongoDB and Mongoose errors into HTTP-compatible errors with proper status codes:

| Error Type | Status | Example |
|---|---|---|
| Duplicate key (E11000) | **409** | `Duplicate value for email (email: "dup@test.com")` |
| Validation error | **400** | `Validation Error: name is required` |
| Cast error | **400** | `Invalid _id: not-a-valid-id` |
| Document not found | **404** | `Document not found` |
| Other errors | **500** | `Internal Server Error` |

```typescript
import { parseDuplicateKeyError } from "@classytic/mongokit";

// Use in custom error handlers
const dupErr = parseDuplicateKeyError(error);
if (dupErr) {
  // dupErr.status === 409
  // dupErr.message includes field name and value
}
```

## No Breaking Changes

Extending Repository works exactly the same with Mongoose 8 and 9. The package:

- Uses its own event system (not Mongoose middleware)
- Defines its own `FilterQuery` type (unaffected by Mongoose 9 rename)
- Properly gates update pipelines (safe for Mongoose 9's stricter defaults)
- All 1090+ tests pass on Mongoose 9

## License

MIT
