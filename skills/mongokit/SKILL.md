---
name: mongokit
description: |
  @classytic/mongokit — Production-grade MongoDB repository pattern for Node.js/TypeScript.
  Use when building MongoDB CRUD, REST APIs with Mongoose 9, repository pattern,
  pagination, caching, soft delete, audit trail, multi-tenant, custom ID generation, or query parsing.
  Triggers: mongoose model, repository pattern, mongokit, mongo crud, pagination,
  soft delete, audit trail, multi-tenant, custom id, query parser, cache plugin, BaseController.
version: 3.7.0
license: MIT
metadata:
  author: Classytic
  version: "3.7.0"
tags:
  - mongodb
  - mongoose
  - repository-pattern
  - crud
  - pagination
  - typescript
  - plugins
  - caching
  - soft-delete
  - audit-trail
  - multi-tenant
  - custom-id
  - query-parser
  - rest-api
progressive_disclosure:
  entry_point:
    summary: "Type-safe MongoDB repository with 17 plugins: pagination, caching, soft delete, audit trail, multi-tenant, custom IDs, observability"
    when_to_use: "Building MongoDB CRUD, REST APIs with Mongoose 9, repository pattern, pagination, caching, audit trail, or query parsing"
    quick_start: "1. npm install @classytic/mongokit mongoose 2. new Repository(Model, [plugins]) 3. repo.create/getAll/update/delete"
  context_limit: 700
---

# @classytic/mongokit

Production-grade MongoDB repository pattern with zero external dependencies. 17 built-in plugins, smart pagination, event-driven hooks, and full TypeScript support. **1622+ tests.**

**Requires:** Mongoose `>=9.4.1` | Node.js `>=22`

## Installation

```bash
npm install @classytic/mongokit mongoose
```

## Core Pattern

Every interaction starts with a Repository wrapping a Mongoose model:

```typescript
import { Repository } from "@classytic/mongokit";

const repo = new Repository(UserModel);

const user = await repo.create({ name: "John", email: "john@example.com" });
const users = await repo.getAll({ page: 1, limit: 20 });
const found = await repo.getById(id);
const updated = await repo.update(id, { name: "Jane" });
await repo.delete(id);
const exists = await repo.exists({ email: "john@example.com" });
const count = await repo.count({ status: "active" });
const userOrNew = await repo.getOrCreate({ email: "x@y.com" }, { name: "X" });
```

## Full API

| Method                           | Description                                    |
| -------------------------------- | ---------------------------------------------- |
| `create(data, opts)`             | Create single document                         |
| `createMany(data[], opts)`       | Create multiple documents                      |
| `getById(id, opts)`              | Find by ID                                     |
| `getByQuery(query, opts)`        | Find one by query                              |
| `getOne(filter, opts)`           | Find one by compound filter (for controllers)  |
| `getAll(params, opts)`           | Paginated list (auto-detects offset vs keyset) |
| `getAll({ noPagination: true })` | Returns raw `TDoc[]` — same as `findAll()`     |
| `findAll(filters, opts)`         | Fetch ALL docs without pagination (no limit)   |
| `getOrCreate(query, data, opts)` | Find or create                                 |
| `update(id, data, opts)`         | Update document                                |
| `delete(id, opts)`               | Delete document                                |
| `count(query, opts)`             | Count documents                                |
| `exists(query, opts)`            | Check existence                                |
| `aggregate(pipeline, opts)`      | Run aggregation                                |
| `aggregatePaginate(opts)`        | Paginated aggregation                          |
| `distinct(field, query)`         | Distinct values                                |
| `withTransaction(fn)`            | Atomic transaction                             |

## Pagination (Auto-Detected)

```typescript
// Offset (dashboards) — pass `page`
const result = await repo.getAll({
  page: 1,
  limit: 20,
  filters: { status: "active" },
  sort: { createdAt: -1 },
});
// → { method: 'offset', docs, total, pages, hasNext, hasPrev }

// Keyset (infinite scroll) — pass `sort` without `page`, or `after`
const stream = await repo.getAll({ sort: { createdAt: -1 }, limit: 20 });
// → { method: 'keyset', docs, hasMore, next: 'eyJ2IjoxLC...' }
const next = await repo.getAll({
  after: stream.next,
  sort: { createdAt: -1 },
  limit: 20,
});
```

**Detection:** `page` → offset | `after`/`cursor` → keyset | `sort` only → keyset | default → offset

**Cursor formats:** `after` accepts both base64 cursor tokens (from `next`) and plain 24-char ObjectId hex strings as fallback.

**Compound sort:** Keyset supports 3+ sort fields: `{ priority: -1, createdAt: -1, _id: -1 }` — `_id` is auto-added if missing.

**Collation:** Pass `collation: { locale: 'en', strength: 2 }` for case-insensitive sorting in both pagination modes.

**Required indexes for keyset:**

```javascript
Schema.index({ createdAt: -1, _id: -1 });
Schema.index({ priority: -1, createdAt: -1, _id: -1 }); // compound sort
Schema.index({ organizationId: 1, createdAt: -1, _id: -1 }); // multi-tenant
```

## Plugin System

Plugins compose via array — order matters:

```typescript
import {
  Repository,
  timestampPlugin,
  softDeletePlugin,
  cachePlugin,
  createMemoryCache,
  customIdPlugin,
  sequentialId,
} from "@classytic/mongokit";

const repo = new Repository(UserModel, [
  timestampPlugin(),
  softDeletePlugin(),
  cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
]);
```

### All 17 Plugins

| Plugin                              | Description                              | Needs methodRegistry? |
| ----------------------------------- | ---------------------------------------- | --------------------- |
| `timestampPlugin()`                 | Auto `createdAt`/`updatedAt`             | No                    |
| `softDeletePlugin(opts)`            | Mark deleted instead of removing         | No                    |
| `auditLogPlugin(logger)`            | Log all CUD operations (external logger) | No                    |
| `auditTrailPlugin(opts)`            | DB-persisted audit trail + change diffs  | No (Yes for queries)  |
| `cachePlugin(opts)`                 | Redis/memory caching + auto-invalidation | No                    |
| `validationChainPlugin(validators)` | Custom validation rules                  | No                    |
| `fieldFilterPlugin(preset)`         | Role-based field visibility (RBAC)       | No                    |
| `cascadePlugin(opts)`               | Auto-delete related documents            | No                    |
| `multiTenantPlugin(opts)`           | Auto-inject tenant isolation + `fieldType` casting | No                    |
| `customIdPlugin(opts)`              | Sequential/random ID generation          | No                    |
| `observabilityPlugin(opts)`         | Timing, metrics, slow queries            | No                    |
| `methodRegistryPlugin()`            | Dynamic method registration              | No (base for below)   |
| `mongoOperationsPlugin()`           | `increment`, `pushToArray`, `upsert`     | Yes                   |
| `batchOperationsPlugin()`           | `updateMany`, `deleteMany`, `bulkWrite`  | Yes                   |
| `aggregateHelpersPlugin()`          | `groupBy`, `sum`, `average`              | Yes                   |
| `subdocumentPlugin()`               | Manage subdocument arrays                | Yes                   |
| `elasticSearchPlugin(opts)`         | Delegate search to ES/OpenSearch         | Yes                   |

### Soft Delete

```typescript
const repo = new Repository(UserModel, [
  methodRegistryPlugin(),
  batchOperationsPlugin(),
  softDeletePlugin({ deletedField: "deletedAt" }),
]);
await repo.delete(id); // Sets deletedAt
await repo.getAll(); // Auto-excludes deleted
await repo.getAll({ includeDeleted: true }); // Include deleted

// Batch operations respect soft-delete automatically
await repo.deleteMany({ status: "draft" }); // Soft-deletes matching docs
await repo.updateMany({ status: "active" }, { $set: { featured: true } }); // Skips soft-deleted
```

**Unique index gotcha:** Use partial filter expressions:

```javascript
Schema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
```

### Populate via URL (Array Refs + Field Selection)

```bash
GET /orders?populate=products                                    # full populate
GET /orders?populate[products][select]=name,price                # field selection
GET /orders?populate[products][match][status]=active              # filter populated
GET /orders?populate[products][limit]=5&populate[products][sort]=-price  # limit + sort
```

### Lookup Joins via URL (No Refs Needed)

Join by any field (slug, code, SKU) using `$lookup` — no `ref` required:

```bash
GET /products?lookup[category][from]=categories&lookup[category][localField]=categorySlug&lookup[category][foreignField]=slug&lookup[category][single]=true&lookup[category][select]=name,slug
```

```typescript
// getAll auto-routes to $lookup when lookups are present
const parsed = parser.parse(req.query);
const result = await repo.getAll({
  filters: parsed.filters,
  lookups: parsed.lookups,
  select: parsed.select,
  sort: parsed.sort,
  page: parsed.page,
  limit: parsed.limit,
});
// select + lookups work together — lookup `as` fields are auto-included in projection
// single lookup with no match → null (not undefined)
// total count is accurate (not inflated by $unwind)
```

### Microservice Event Hooks (Kafka / RabbitMQ / Redis)

```typescript
repo.on('after:create', async ({ context, result }) => {
  await kafka.publish('orders.created', {
    document: result, userId: context.user?._id,
    tenantId: context.organizationId,
  });
}, { priority: HOOK_PRIORITY.OBSERVABILITY });
```

### Caching

```typescript
const repo = new Repository(UserModel, [
  cachePlugin({
    adapter: createMemoryCache(),
    ttl: 60,
    byIdTtl: 300,
    queryTtl: 30,
  }),
]);
const user = await repo.getById(id); // Cached
const fresh = await repo.getById(id, { skipCache: true }); // Skip cache
await repo.update(id, { name: "New" }); // Auto-invalidates
```

**Redis adapter:**

```typescript
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
    /* bulk invalidation */
  },
};
```

### Multi-Tenant

```typescript
const repo = new Repository(UserModel, [
  multiTenantPlugin({
    tenantField: 'organizationId',
    contextKey: 'organizationId',
    required: true,
    fieldType: 'objectId', // cast tenant ID to ObjectId (enables $lookup / .populate())
  }),
]);
// All ops auto-scoped: repo.getAll({ organizationId: 'org_123' })
// Cross-tenant → returns "not found"
```

**`fieldType` option:**
- `'string'` (default) — injects tenant ID as-is. Backward-compatible.
- `'objectId'` — casts to `mongoose.Types.ObjectId` before injection. Use when the schema declares `organizationId: { type: Schema.Types.ObjectId, ref: 'organization' }`. Enables `$lookup` joins and `.populate()` against the referenced collection. Without this, MongoDB's strict type matching causes `$lookup` to silently return empty results (string `"507f..."` !== ObjectId `ObjectId("507f...")`).

**Other options:** `skipOperations`, `skipWhen` (dynamic per-request bypass), `resolveContext` (AsyncLocalStorage / CLS fallback).

**Request-scoped tenant context (3.7.0):** `createTenantContext()` wraps `AsyncLocalStorage` so handlers don't have to pass `organizationId` on every call.

```typescript
import { createTenantContext, multiTenantPlugin } from '@classytic/mongokit';

const tenantContext = createTenantContext();

// Express middleware (or Fastify / NestJS equivalent):
app.use((req, _res, next) => {
  tenantContext.run({ tenantId: req.auth.organizationId }, next);
});

const repo = new Repository(Invoice, [
  multiTenantPlugin({
    tenantField: 'organizationId',
    resolveContext: () => tenantContext.getTenantId(),
  }),
]);

// In handlers — no explicit organizationId needed:
await repo.getAll({ filters: { status: 'paid' } });

// Assert presence at hot paths:
tenantContext.requireTenantId(); // throws if no context is active
```

### Custom Search Backends (search-resolver plugin contract)

Search has three layers, ordered from simplest to most flexible:

| Layer                       | When to use                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `searchMode: 'text'`        | Default. Mongo `$text`, requires a text index.                                                    |
| `searchMode: 'regex'`/`auto`| Index-free `$or` of `$regex` across `searchFields`. Built-in fast path. No external dependencies. |
| Search-resolver plugin      | External engine (Elasticsearch, Meilisearch, Typesense, pgvector, Pinecone, hybrid BM25+vector).  |

The plugin contract is **4 lines**:

1. Hook `before:getAll`.
2. If `ctx.search` is set, resolve it against your backend (returns IDs).
3. Mutate `ctx.filters` to constrain the Mongo query: `_id: { $in: ids }`.
4. Set `ctx.search = undefined` so Repository's text-index check is bypassed.

```typescript
function meilisearchPlugin({ client, index }) {
  return (repo) => {
    repo.on('before:getAll', async (ctx) => {
      if (!ctx.search) return;
      const hits = await client.index(index).search(ctx.search, {
        limit: ctx.limit ?? 20,
      });
      const ids = hits.hits.map((h) => h.id);
      ctx.filters = { ...(ctx.filters ?? {}), _id: { $in: ids } };
      ctx.search = undefined;          // bypass text-index check (framework-guaranteed)
      ctx._meiliRanking = ids;         // stash for after:getAll re-sort
    });
    repo.on('after:getAll', (ctx) => {
      if (!ctx._meiliRanking) return;
      const order = new Map(ctx._meiliRanking.map((id, i) => [String(id), i]));
      ctx.result.docs.sort(
        (a, b) => order.get(String(a._id)) - order.get(String(b._id)),
      );
    });
  };
}

// Composes cleanly with cache, multi-tenant, soft-delete, audit
const repo = new Repository(ProductModel, [
  meilisearchPlugin({ client: meili, index: 'products' }),
  cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
]);
```

**Why it composes:** `before:getAll` runs inside `_buildContext`, before Repository reads `ctx.search` or hits the text-index check. `Repository.getAll` reads `search` only from the post-hook context — no fallback to original params — so `ctx.search = undefined` is a real clear, not a silently-overridden no-op. The caller's existing filters are preserved by spreading. Multi-tenant scoping, soft-delete filters, and the search plugin compose without ordering concerns because they all mutate `ctx.filters` independently. Cache plugin sees the post-hook filters, so cache keys are accurate.

The bundled `elasticSearchPlugin` is the canonical reference implementation. The `tests/repository-search-mode.test.ts` suite exercises this contract end-to-end with multi-tenant + soft-delete + cache composition.

### Custom ID Generation

Atomic MongoDB counters — concurrency-safe, zero duplicates:

```typescript
import {
  customIdPlugin,
  sequentialId,
  dateSequentialId,
  prefixedId,
  getNextSequence,
} from "@classytic/mongokit";

// Sequential: INV-0001, INV-0002, ...
customIdPlugin({
  field: "invoiceNumber",
  generator: sequentialId({ prefix: "INV", model: InvoiceModel }),
});

// Date-partitioned: BILL-2026-02-0001 (resets monthly/yearly/daily)
customIdPlugin({
  field: "billNumber",
  generator: dateSequentialId({
    prefix: "BILL",
    model: BillModel,
    partition: "monthly",
  }),
});

// Random: ORD_a7b3xk9m2p (no DB round-trip)
customIdPlugin({
  field: "orderRef",
  generator: prefixedId({ prefix: "ORD", length: 10 }),
});

// Custom generator with getNextSequence()
customIdPlugin({
  field: "ref",
  generator: async (ctx) =>
    `ORD-${ctx.data?.region || "US"}-${String(await getNextSequence("orders")).padStart(4, "0")}`,
});
```

**Options:** `sequentialId({ prefix, model, padding?: 4, separator?: '-', counterKey? })`
**Partitions:** `'yearly'` | `'monthly'` | `'daily'`
**Behavior:** Counters never decrement on delete (standard for invoices/bills).

**Transaction-aware:** When `customIdPlugin` runs inside a `withTransaction` callback, the built-in `sequentialId` / `dateSequentialId` generators forward `context.session` to `getNextSequence` automatically — so the counter bump commits (or rolls back) atomically with your business write. If the tx aborts, the counter does NOT advance, and a retry reuses the same sequence number (no gap).

```typescript
await withTransaction(mongoose.connection, async (session) => {
  const inv = await invoiceRepo.create({ amount: 100 }, { session });
  await ledgerRepo.create({ invoiceNumber: inv.invoiceNumber, debit: 100 }, { session });
  // If anything throws, both the invoice AND the counter bump roll back together.
});
```

Callers of the raw `getNextSequence(key, inc, conn, session?)` can pass a session too — it's a new optional 4th positional arg, fully backward-compatible.

### Validation Chain

```typescript
import {
  validationChainPlugin,
  requireField,
  uniqueField,
  immutableField,
  blockIf,
  autoInject,
} from "@classytic/mongokit";
validationChainPlugin([
  requireField("email", ["create"]),
  uniqueField("email", "Email already exists"),
  immutableField("userId"),
  blockIf(
    "noAdminDelete",
    ["delete"],
    (ctx) => ctx.data?.role === "admin",
    "Cannot delete admins",
  ),
  autoInject("slug", (ctx) => slugify(ctx.data?.name), ["create"]),
]);
```

### Cascade Delete

```typescript
cascadePlugin({
  relations: [
    { model: "StockEntry", foreignKey: "product" },
    { model: "Review", foreignKey: "product", softDelete: false },
  ],
  parallel: true,
});
```

### MongoDB Operations (Atomic)

```typescript
import type { MongoOperationsMethods } from "@classytic/mongokit";
type Repo = Repository<IUser> & MongoOperationsMethods<IUser>;
const repo = new Repository(UserModel, [
  methodRegistryPlugin(),
  mongoOperationsPlugin(),
]) as Repo;

await repo.increment(id, "views", 1);
await repo.pushToArray(id, "tags", "featured");
await repo.upsert({ sku: "ABC" }, { name: "Product", price: 99 });
await repo.addToSet(id, "roles", "admin");
```

### Audit Trail (DB-Persisted)

```typescript
import { auditTrailPlugin, AuditTrailQuery } from "@classytic/mongokit";
import type { AuditTrailMethods } from "@classytic/mongokit";

// Per-repo: track operations with change diffs
const repo = new Repository(JobModel, [
  methodRegistryPlugin(),
  auditTrailPlugin({
    operations: ["create", "update", "delete"],
    trackChanges: true, // before/after diff
    ttlDays: 90, // auto-purge
    excludeFields: ["password"],
    metadata: (ctx) => ({ ip: ctx.req?.ip }),
  }),
]);
const trail = await repo.getAuditTrail(docId, { operation: "update" });

// Standalone: query across all models (admin dashboards)
const auditQuery = new AuditTrailQuery();
await auditQuery.getOrgTrail(orgId);
await auditQuery.getUserTrail(userId);
await auditQuery.getDocumentTrail("Job", jobId);
await auditQuery.query({ orgId, operation: "delete", from: startDate, to: endDate });
```

**Options:** `operations`, `trackChanges` (default: true), `trackDocument` (default: false), `ttlDays`, `collectionName` (default: `'audit_trails'`), `excludeFields`, `metadata`

### Observability

```typescript
observabilityPlugin({
  onMetric: (m) => statsd.histogram(`mongokit.${m.operation}`, m.duration),
  slowThresholdMs: 200,
});
```

## Event System

Event names are typed as `RepositoryEvent` — full autocomplete in TypeScript:

```typescript
repo.on("before:create", async (ctx) => {
  ctx.data.processedAt = new Date();
});
repo.on("after:create", ({ context, result }) => {
  console.log("Created:", result._id);
});
repo.on("error:create", ({ context, error }) => {
  reportError(error);
});
repo.off("after:create", myListener); // Remove listener
```

**Events:** `before:*`, `after:*`, `error:*` for all operations: `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `getById`, `getByQuery`, `getAll`, `aggregate`, `aggregatePaginate`, `lookupPopulate`, `getOrCreate`, `count`, `exists`, `distinct`, `bulkWrite`

**Custom search backends:** see "Custom Search Backends" under Plugin System above for the `before:getAll` resolver contract that powers Elasticsearch, Meilisearch, Typesense, pgvector, and any other external engine.

## QueryParser (HTTP to MongoDB)

```typescript
import { QueryParser } from "@classytic/mongokit";
const parser = new QueryParser({
  schema: ProductModel.schema,                        // Schema-aware coercion (recommended)
  maxLimit: 100, maxFilterDepth: 5, maxRegexLength: 100,
  allowedFilterFields: ['status', 'name', 'email'],  // Whitelist filter fields
  allowedSortFields: ['createdAt', 'name'],           // Whitelist sort fields
  allowedOperators: ['eq', 'ne', 'in', 'gt', 'lt'],   // Whitelist operators
});
const { filters, limit, page, sort, search, populateOptions } = parser.parse(req.query);

// Read back configured whitelists (used by Arc MCP integration)
parser.allowedFilterFields;  // string[] | undefined
parser.allowedSortFields;    // string[] | undefined
parser.allowedOperators;     // string[] | undefined
```

**Schema-aware value coercion:** with `schema: Model.schema`, filter values are coerced to each field's declared type — `?stock=50` against a `Number` field becomes `50`, `?name=12345` against a `String` field stays `'12345'`, `?releasedAt=2026-04-07` against a `Date` field becomes a `Date` instance, `?address.zip=01234` against a nested `String` field preserves the leading zero. Direct equality and operator syntax (`stock[gte]=50`) coerce identically. For DB-agnostic setups, use `fieldTypes: { stock: 'number', active: 'boolean', releasedAt: 'date' }` instead of (or alongside) a Mongoose schema; `fieldTypes` overrides `schema` per path. Without either, the parser uses a safe string-shape heuristic (rejects leading zeros, scientific notation, strings >15 chars to preserve zip codes and long numeric IDs).

**URL patterns:**

```
?status=active&role=admin             # exact match
?age[gte]=18&age[lte]=65             # range
?role[in]=admin,user                  # in-set
?name[regex]=^John                    # regex
?sort=-createdAt,name                 # multi-sort
?page=2&limit=50                      # offset pagination
?after=eyJfaWQiOi...&limit=20        # cursor pagination
?search=john                          # full-text (or regex if Repository configured with searchMode: 'regex'/'auto')
?populate[author][select]=name,email  # advanced populate
```

**Security:** Blocks `$where`/`$function`/`$accumulator` | `$expr` allowed (needed for `$lookup` correlation) | ReDoS protection | `$options` restricted to `[imsx]` | Populate path sanitization | Max 10 lookups

## BaseController (Auto-CRUD)

The package includes a `BaseController` reference implementation (see `examples/api/BaseController.ts`) that provides instant auto-generated CRUD with security:

```typescript
import { BaseController } from "./BaseController";

class UserController extends BaseController<IUser> {
  constructor(repository: Repository<IUser>) {
    super(repository, {
      fieldRules: {
        role: { systemManaged: true }, // Users cannot set role
        credits: { systemManaged: true }, // Users cannot set credits
      },
      query: {
        allowedLookups: ["departments", "teams"], // Only these collections can be joined
        allowedLookupFields: {
          departments: { localFields: ["deptId"], foreignFields: ["_id"] },
        },
      },
    });
  }

  // Override specific methods — the rest are auto-generated
  async create(ctx: IRequestContext) {
    await sendVerificationEmail(ctx.body.email);
    return super.create(ctx);
  }
}
```

**Features:**

- Auto list/get/create/update/delete from `IController` interface
- System-managed field sanitization (strips protected fields from user input)
- 3-level lookup security: collection allowlist → per-collection field allowlist → pipeline/let blocking
- Override any method, keep the rest auto-generated

## JSON Schema Generation

```typescript
import { buildCrudSchemasFromModel } from "@classytic/mongokit";
const { crudSchemas } = buildCrudSchemasFromModel(UserModel, {
  fieldRules: {
    organizationId: { immutable: true },
    role: { systemManaged: true },
  },
  strictAdditionalProperties: true,
});
// crudSchemas.createBody, updateBody, params, listQuery — use with Fastify schema validation or OpenAPI
```

**Soft-required fields** — DB required, HTTP optional (draft-friendly bodies):

```typescript
// Per-path (you own the schema):
const Schema = new mongoose.Schema({
  journalType: { type: String, required: true, softRequired: true }, // DB rejects null, body may omit
});

// Per-build override (upstream-owned model):
buildCrudSchemasFromModel(Model, { softRequiredFields: ['journalType', 'date'] });
```

Soft-required fields stay in `createBody.properties` (validated when present) but are excluded from `createBody.required[]`. Mongoose-level `required: true` is unaffected — `repo.create({ journalType: null })` still throws a ValidationError.

**Array & subdoc introspection:** Every Mongoose array shape serializes to the correct JSON Schema `items`:

| Declared | Emitted `items` |
| --- | --- |
| `[String]` / `[Number]` / `[Boolean]` / `[Date]` | matching primitive (Date → `{type:'string',format:'date-time'}`) |
| `[Schema.Types.ObjectId]` (including `{ type: ObjectId, ref: 'X' }`) | `{type:'string',pattern:'^[0-9a-fA-F]{24}$'}` |
| `{ type: [{ type: String, enum, minLength, match }] }` | full element validators carried through |
| `[{ name: String, url: String }]` (DocumentArray shorthand) | `{type:'object', properties, required}` (recursed) |
| `[new Schema({...}, { _id: false })]` (explicit) | same as above |
| `[[Number]]` / `[[InnerSchema]]` (array-of-array) | `{type:'array', items: <inner>}` (recursed) |
| Single-embedded `{ addr: AddressSchema }` | recurses into subdoc paths |
| `[Schema.Types.Mixed]` | `{type:'object',additionalProperties:true}` (objects only) |
| `Map` (with or without `of`) | `{type:'object',additionalProperties:<of>|true}` |

**listQuery shape:** `page` / `limit` are `{type:'integer', minimum:1, default:N}`; `lean` / `includeDeleted` are `{type:'boolean', default:false}`; `sort` / `populate` / `search` / `select` / `after` are strings. Fastify's default `coerceTypes` flips `?page=2` into a number at validation time, so handlers receive typed values.

**OpenAPI vendor extensions are opt-in:** `x-ref` (populated-ref hint) and other `x-*` keywords are emitted **only** when `{ openApiExtensions: true }` is passed. Default is OFF — generated schemas are keyword-clean and compile under Ajv `strict: true`. Turn ON when feeding the schema into `@fastify/swagger`, redocly, or any docgen pipeline.

```typescript
// Validation (Ajv strict-safe — default)
const { createBody } = buildCrudSchemasFromModel(User);
fastify.post('/users', { schema: { body: createBody } }, handler);

// Documentation (includes x-ref vendor extensions)
const { createBody } = buildCrudSchemasFromModel(User, { openApiExtensions: true });
swaggerDoc.paths['/users'].post.requestBody.content['application/json'].schema = createBody;
```

**Custom SchemaType extension:** if a SchemaType instance exposes `jsonSchema()` (either via prototype subclass, per-instance assignment `schema.path('x').jsonSchema = fn`, or because `mongoose-schema-jsonschema` is installed and monkey-patches the prototypes), mongokit defers to it. Buggy methods that throw are isolated — built-in introspection always fires as a fallback.

**Nullable types:** `{ type: X, default: null }` widens the schema type to `[X, 'null']` and echoes `default: null`.

**`description` / `title` passthrough:** when declared on a path, both are surfaced into the JSON Schema output for OpenAPI / Swagger / docgen consumers. These are standard JSON Schema keywords (not vendor extensions) so they pass Ajv strict mode without `openApiExtensions: true`.

**Mongoose option aliases accepted:** `minlength` + `minLength`, `maxlength` + `maxLength`, `enum: [...]` + `enum: { values, message }`, `match: RegExp` + `match: string`.

**Stripped by design:** auto-generated `_id` (ObjectId), `__v`, Map synthetic `$*` paths. Explicit `_id: String` stays in the schema (for UUID/slug ids). Timestamps dropped via `collectFieldsToOmit` defaults.

## Security & ops knobs (3.7.0)

**Cursor version negotiation** — bump `cursorVersion` and `minCursorVersion` together when shipping a breaking cursor format change. Clients holding stale cursors get a clear `"Pagination must restart"` 400 instead of silently paginating from the wrong position.

```typescript
new Repository(M, [], { cursorVersion: 2, minCursorVersion: 2 });
```

**Plugin order validation** — Repository now flags known-unsafe plugin compositions at construction time.

```typescript
// Warns: "multi-tenant must precede cache…" (prevents cross-tenant cache poisoning)
new Repository(M, [cachePlugin({ adapter }), multiTenantPlugin({ tenantField: 'orgId' })]);

// Promote to hard error in production:
new Repository(M, plugins, {}, { pluginOrderChecks: 'throw' });
```

**Cache TTL jitter** — spreads cache expirations to mitigate stampedes at scale.

```typescript
cachePlugin({ adapter, ttl: 60, jitter: 0.1 }); // [54s, 66s] per entry
cachePlugin({ adapter, ttl: 60, jitter: (t) => t * (0.95 + Math.random() * 0.1) });
```

**Duplicate-key (E11000) errors are PII-safe by default** — error message lists only the conflicting field names. Structured fields live on `error.duplicate.fields`. Opt into value exposure for dev/trusted contexts:

```typescript
import { parseDuplicateKeyError } from '@classytic/mongokit';
const httpErr = parseDuplicateKeyError(err, { exposeValues: true }); // dev only
```

**QueryParser hardening** — `maxFilterDepth` now guards both URL filters and aggregation `$match` sanitization. A static regex-complexity budget catches ReDoS patterns that slip past the heuristic detector.

**Vector plugin SSRF defense** — when the plugin auto-embeds from document media fields, you can lock down which URL origins are forwarded to the embed service:

```typescript
vectorPlugin({
  fields: [{ path: 'embedding', index: 'idx', dimensions: 1024, mediaFields: ['imageUrl'] }],
  embedFn,
  autoEmbed: true,
  allowedMediaOrigins: ['https://cdn.example.com', 'https://*.trusted.net'],
  blockPrivateIpUrls: true, // rejects 169.254.169.254, 127.0.0.1, RFC1918, etc.
});
```

**Keyset sort-field allowlist** — protects against the MongoDB null/non-null type-boundary gap in keyset pagination:

```typescript
new Repository(M, [], { strictKeysetSortFields: ['createdAt', 'score'] });
// Any getAll({ sort: { nullableField: -1 } }) now throws at validation time.
```

## RAG pipeline composition

A production RAG layer composes three repositories:

1. **Documents** — metadata (title, author, tenantId).
2. **Chunks** — text segments with embeddings, vector-indexed.
3. Optional **audit/cache** plugins on either.

```typescript
import { Repository, methodRegistryPlugin, multiTenantPlugin } from '@classytic/mongokit';
import { vectorPlugin } from '@classytic/mongokit/ai';

// Documents keyed by a domain code, not _id — idField handles the translation.
const documents = new Repository(DocumentModel,
  [multiTenantPlugin({ tenantField: 'tenantId', contextKey: 'tenantId' })],
  {},
  { idField: 'docCode' },
);

// Chunks auto-embed on write; $vectorSearch reads top-K by cosine similarity.
const chunks = new Repository(ChunkModel, [
  methodRegistryPlugin(),
  multiTenantPlugin({ tenantField: 'tenantId', contextKey: 'tenantId' }),
  vectorPlugin({
    fields: [{ path: 'embedding', index: 'chunk_idx', dimensions: 1024,
              similarity: 'cosine', sourceFields: ['text'] }],
    embedFn, autoEmbed: true,
    allowedMediaOrigins: ['https://cdn.example.com'], // SSRF defense if media fields are used
  }),
]);

// Ingest — embeddings populate automatically.
await chunks.createMany(chunksForDoc, { tenantId: 'org_alpha' });

// Retrieve — pass `filter` through to Atlas $vectorSearch; tenant scoping must
// be listed as a `filter` field in the Atlas index definition.
const topK = await chunks.searchSimilar({
  query: 'orbital velocity chapter',
  limit: 10,
  filter: { tenantId: 'org_alpha' },
});

// Enrich — one aggregation round-trip to $lookup parent metadata.
const chunkIds = topK.map(h => h.doc._id);
const enriched = await ChunkModel.aggregate([
  { $match: { _id: { $in: chunkIds } } },
  { $lookup: { from: 'documents', localField: 'documentId', foreignField: '_id', as: 'document' } },
  { $unwind: '$document' },
]);

// Paginate — RAG scores are client-side. Slice the scored array in the caller.
const page1 = topK.slice(0, 10);
```

**For server-side pagination over joined results**, use `chunks.lookupPopulate({ lookups, sort, limit, after, tenantId })` — that path supports keyset cursors, multi-tenant scoping, and the custom-idField join shape (`localField`/`foreignField`).

**Atlas Vector Search index required** for real `$vectorSearch`. mongokit tests the composition on memory-server with a simulated cosine-similarity aggregate; real Atlas runs live under `tests/e2e/` (gated, skipped by default — see `tests/e2e/README.md`).

## Configuration

```typescript
new Repository(UserModel, plugins, {
  defaultLimit: 20,
  maxLimit: 100,       // 0 = unlimited
  maxPage: 10000,
  deepPageThreshold: 100,
  useEstimatedCount: false,
  cursorVersion: 1,
  minCursorVersion: 1,        // reject stale cursors below this version (bump on breaking format change)
  strictKeysetSortFields: ['createdAt', 'score'], // allowlist primary keyset sort fields — protects against nullable-field keyset gaps
}, {
  idField: 'slug',         // getById/update/delete use { slug: id } instead of { _id: id }
  searchMode: 'regex',     // 'text' (default) | 'regex' | 'auto' — controls getAll({ search }) strategy
  searchFields: ['title', 'body'], // required when searchMode is 'regex' (or 'auto' falls back to it)
  pluginOrderChecks: 'warn', // 'warn' (default) | 'throw' | 'off' — flags unsafe plugin compositions
});

// Custom ID example: getById('laptop') → queries { slug: 'laptop' }
await repo.getById('laptop');
await repo.update('laptop', { price: 999 });
await repo.delete('laptop');
```

## Extending Repository

```typescript
class UserRepository extends Repository<IUser> {
  constructor() {
    super(UserModel, [timestampPlugin(), softDeletePlugin()], {
      defaultLimit: 20,
    });
  }
  async findByEmail(email: string) {
    return this.getByQuery({ email });
  }
  async findActive() {
    return this.getAll({
      filters: { status: "active" },
      sort: { createdAt: -1 },
    });
  }
}
```

## TypeScript Type Safety

```typescript
import type { WithPlugins, CacheableOptions, DocField } from "@classytic/mongokit";

// TDoc inferred from Model — no manual annotation needed
const repo = new Repository(UserModel, [
  methodRegistryPlugin(), mongoOperationsPlugin(), softDeletePlugin(),
  cachePlugin({ adapter: createMemoryCache() }),
]) as WithPlugins<IUser, Repository<IUser>>;

// DocField<TDoc> autocomplete on field params + accepts nested paths
await repo.increment(id, "views", 1);      // ✅ "views" autocompleted from IUser
await repo.groupBy("status");               // ✅ "status" autocompleted
await repo.restore(id);                     // ✅ Returns Promise<IUser>
await repo.getDeleted();                    // ✅ Returns OffsetPaginationResult<IUser>

// Typed option hierarchy — no inline duplication
const opts: CacheableOptions = { skipCache: true, lean: true, readPreference: "secondary" };
await repo.getById(id, opts);
```

**Option type hierarchy:**
```
SessionOptions → ReadOptions → OperationOptions → CacheableOptions
                             → AggregateOptions
                             → LookupPopulateOptions
               → CreateOptions
```

**Plugin types:** `MongoOperationsMethods<T>`, `BatchOperationsMethods`, `AggregateHelpersMethods`, `SubdocumentMethods<T>`, `SoftDeleteMethods<T>`, `CacheMethods`, `AuditTrailMethods`

**Utility types:** `InferDocument<Model>`, `InferRawDoc<Model>`, `CreateInput<TDoc>`, `UpdateInput<TDoc>`, `DocField<TDoc>`, `PartialBy`, `RequiredBy`, `DeepPartial`, `KeysOfType`

## Error Handling

Translates MongoDB/Mongoose errors into HTTP status codes:

| Error | Status | Message |
|---|---|---|
| E11000 duplicate key | **409** | `Duplicate value for email (email: "x@y.com")` |
| Validation error | **400** | `Validation Error: name is required` |
| Cast error | **400** | `Invalid _id: not-a-valid-id` |
| Not found | **404** | `Document not found` |

```typescript
import { parseDuplicateKeyError } from "@classytic/mongokit";
const dupErr = parseDuplicateKeyError(error); // HttpError | null
```

## Choosing the right mongokit primitive

`getAll` is CRUD-shaped: **filter → sort → paginate documents**. It's fast, countable, and cache-friendly. Use it for list endpoints, admin tables, and the typical HTTP `?filter=...&page=...` flow. Do NOT use it when the query shape is fundamentally different.

| Scenario                                   | Right tool                         | Why `getAll` is wrong                                                                   |
| ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------- |
| Count + list by filter                     | `repo.getAll()`                    | ✓                                                                                       |
| Distance-sorted proximity (Google Maps)    | `repo.getAll({ filters })` + `[near]` / `[nearSphere]` | ✓ (Repository auto-skips forced sort + rewrites count)                                  |
| Paginated radius with custom sort          | `repo.getAll()` + `[withinRadius]` | ✓ ($geoWithin is a filter, composes with sort)                                          |
| Recommendation engine (scoring, ML)        | `repo.aggregate()` / vector search | Scoring is a pipeline concern; `getAll` doesn't support `$lookup`+`$addFields`+`$sort` composition |
| Social graph traversal (N-hop friends)     | `repo.aggregate([{ $graphLookup }])` | `getAll` only matches one collection; `$graphLookup` is the canonical traversal         |
| Time-series rollups / windowed analytics   | `repo.aggregate()`                 | Needs `$setWindowFields`, `$bucket`, `$group` — not a document-list query               |
| Bulk ETL (millions of docs, no pagination) | `repo.findAll({ stream })`         | `getAll` paginates; ETL wants a cursor                                                  |
| Semantic search / BM25+vector hybrid       | Search-resolver plugin (see above) | External backend; `getAll` is a Mongo-only shape                                        |
| Big-data export                            | `findAll({ noPagination: true })`  | No count, no skip — just a cursor                                                       |

**Customizing `getAll` without subclassing**: register a `before:getAll` hook to mutate `ctx.filters` / `ctx.sort` / `ctx.limit` / `ctx.search`, or an `after:getAll` hook to post-process results. This is how search-resolver plugins, multi-tenant scoping, soft-delete, and radius-capping all work — same pattern, different concern. Subclassing is also fine for one-off methods (e.g. adding `userRepo.findByEmailDomain(domain)`), but keep `getAll` logic in hooks so it composes with caching.

**Customizing for heavy analytics**: subclass `Repository` and add a domain method that calls `repo.aggregate()` / `repo.aggregatePaginate()`. Example:

```typescript
class ProductRepository extends Repository<IProduct> {
  // Recommendation engine: scoring pipeline, not a getAll shape
  async getRecommendations(userId: string, limit = 10) {
    return this.aggregate([
      { $match: { available: true } },
      { $lookup: { from: 'purchases', localField: '_id', foreignField: 'productId', as: 'p' } },
      { $addFields: { score: { $size: '$p' } } },
      { $sort: { score: -1 } },
      { $limit: limit },
    ]);
  }
}
```

## Architecture Decisions

- **Zero external deps** — only Mongoose as peer dep
- **Own event system** — not Mongoose middleware, fully async with `emitAsync`
- **Own `FilterQuery` type** — immune to Mongoose 9's rename to `RootFilterQuery`
- **Update pipelines gated** — must pass `{ updatePipeline: true }` explicitly
- **Atomic counters** — `findOneAndUpdate` + `$inc`, not `countDocuments` (race-safe)
- **Cache versioning** — `Date.now()` timestamps, not incrementing integers (survives Redis eviction)
- **Parallel pagination** — `find` and `countDocuments` run concurrently via `Promise.all`
- **Lookup keyset pagination** — lookups support O(1) cursor-based pagination, not just offset. Pass `sort` without `page` to auto-detect.
- **`countStrategy: 'none'`** — skip `$facet` count pipeline to avoid 16MB BSON limit on large documents
