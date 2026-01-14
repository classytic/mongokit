# MongoKit Examples

Simple, copy-paste ready examples for different frameworks and use cases.

## Quick Start

- [getting-started.js](./getting-started.js) - Basic CRUD, pagination, and common patterns

## Framework-Agnostic Controllers (NEW)

MongoKit provides framework-agnostic controller interfaces that let you **write your controller logic once** and use it with Express, Fastify, Next.js, or any other framework. Only the thin adapter layer changes.

### Core Interfaces

- [express/UserController.ts](./express/UserController.ts) - Express integration with IController
- [fastify/UserHandler.ts](./fastify/UserHandler.ts) - Fastify integration (same controller logic)
- [nextjs/app/api/users/route.ts](./nextjs/app/api/users/route.ts) - Next.js App Router integration
- [api/BaseController.ts](./api/BaseController.ts) - Advanced base controller with security features (TypeScript)
- [api/baseController.js](./api/baseController.js) - Advanced base controller with security features (JavaScript)

### Why Framework-Agnostic?

```typescript
// 1. Write your controller ONCE (framework-agnostic)
class UserController implements IController<IUser> {
  async list(context: IRequestContext): Promise<IControllerResponse> {
    const parsed = this.queryParser.parse(context.query);
    const result = await this.repository.getAll(parsed);
    return { success: true, data: result, status: 200 };
  }
}

// 2. Use with Express
router.get('/', asyncHandler(controller.list.bind(controller)));

// 3. Use with Fastify (SAME controller)
fastify.get('/', asyncHandler(controller.list.bind(controller)));

// 4. Use with Next.js (SAME controller)
export async function GET(request: NextRequest) {
  const context = await extractContext(request);
  const response = await controller.list(context);
  return sendResponse(response);
}
```

See [Framework-Agnostic Architecture](#framework-agnostic-architecture) for complete guide.

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

## Framework-Agnostic Architecture

### Overview

MongoKit ships framework-agnostic **interfaces** in the core package, with reference **implementations** in examples. This approach (inspired by Prisma) gives you:

1. **Write Once, Run Anywhere**: Same controller logic works with Express, Fastify, Next.js
2. **Zero Framework Lock-in**: Switch frameworks without rewriting business logic
3. **Type Safety**: Full TypeScript support across all frameworks
4. **Customization Freedom**: Copy and adapt examples to your needs

### 3-Layer Architecture

```
┌─────────────────────────────────────────────────────┐
│ Framework Layer (Express/Fastify/Next.js)          │
│ - extractContext(): Framework req → IRequestContext │
│ - sendResponse(): IControllerResponse → Framework res│
│ - asyncHandler(): Error handling wrapper            │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ Controller Layer (Framework-Agnostic)               │
│ - Implements IController<TDoc>                      │
│ - Business logic, validation, authorization         │
│ - Returns IControllerResponse                       │
└─────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────┐
│ Data Layer (MongoKit Core)                          │
│ - Repository: CRUD operations                       │
│ - QueryParser: Filter/sort/pagination parsing       │
│ - Plugins: Caching, soft deletes, etc.              │
└─────────────────────────────────────────────────────┘
```

### Step-by-Step: Express Integration

**1. Import interfaces from core package:**

```typescript
import {
  Repository,
  QueryParser,
  type IController,
  type IRequestContext,
  type IControllerResponse,
} from '@classytic/mongokit';
```

**2. Create framework-agnostic controller:**

```typescript
class UserController implements IController<IUser> {
  protected repository: Repository<IUser>;
  protected queryParser: QueryParser;

  constructor(protected model: Model<IUser>) {
    this.repository = new Repository(model);
    this.queryParser = new QueryParser({
      maxLimit: 100,
      enableAggregations: false,
    });
  }

  async list(context: IRequestContext): Promise<IControllerResponse> {
    try {
      const parsed = this.queryParser.parse(context.query);
      const result = await this.repository.getAll(parsed);
      return { success: true, data: result, status: 200 };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch users',
        status: 500,
      };
    }
  }

  // ... other CRUD methods (get, create, update, delete)
}
```

**3. Create Express adapter layer:**

```typescript
import { Router, type Request, type Response, type NextFunction } from 'express';

// Extract framework-agnostic context from Express
function extractContext(req: Request): IRequestContext {
  return {
    query: req.query as Record<string, unknown>,
    body: req.body as Record<string, unknown>,
    params: req.params as Record<string, string>,
    user: (req as any).user,       // From your auth middleware
    context: (req as any).context, // Custom context (tenant ID, etc.)
  };
}

// Send framework-agnostic response to Express
function sendResponse(res: Response, response: IControllerResponse): Response {
  if (response.success) {
    return res.status(response.status).json(response.data);
  } else {
    return res.status(response.status).json({
      error: response.error,
      ...(response.details && { details: response.details }),
    });
  }
}

// Async handler wrapper
function asyncHandler(
  handler: (context: IRequestContext) => Promise<IControllerResponse>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = extractContext(req);
      const response = await handler(context);
      sendResponse(res, response);
    } catch (error) {
      next(error);
    }
  };
}
```

**4. Wire up routes:**

```typescript
export function createUserRouter(User: Model<IUser>): Router {
  const router = Router();
  const controller = new UserController(User);

  router.get('/', asyncHandler(controller.list.bind(controller)));
  router.get('/:id', asyncHandler(controller.get.bind(controller)));
  router.post('/', asyncHandler(controller.create.bind(controller)));
  router.patch('/:id', asyncHandler(controller.update.bind(controller)));
  router.delete('/:id', asyncHandler(controller.delete.bind(controller)));

  return router;
}
```

**5. Use in Express app:**

```typescript
import express from 'express';
import { createUserRouter } from './controllers/UserController';

const app = express();
app.use(express.json());
app.use('/api/users', createUserRouter(User));
```

See [express/UserController.ts](./express/UserController.ts) for complete example.

### Step-by-Step: Fastify Integration

The **controller logic is IDENTICAL** to Express. Only the adapter layer changes:

**Fastify adapter layer:**

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

function extractContext(request: FastifyRequest): IRequestContext {
  return {
    query: request.query as Record<string, unknown>,
    body: request.body as Record<string, unknown>,
    params: request.params as Record<string, string>,
    user: (request as any).user,
    context: (request as any).context,
  };
}

function sendResponse(reply: FastifyReply, response: IControllerResponse): FastifyReply {
  if (response.success) {
    return reply.code(response.status).send(response.data);
  } else {
    return reply.code(response.status).send({
      error: response.error,
      ...(response.details && { details: response.details }),
    });
  }
}

function asyncHandler(
  handler: (context: IRequestContext) => Promise<IControllerResponse>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const context = extractContext(request);
    const response = await handler(context);
    return sendResponse(reply, response);
  };
}
```

**Wire up Fastify routes:**

```typescript
export async function registerUserRoutes(
  fastify: FastifyInstance,
  User: Model<IUser>
) {
  const controller = new UserController(User); // Same controller!

  fastify.get('/', asyncHandler(controller.list.bind(controller)));
  fastify.get('/:id', asyncHandler(controller.get.bind(controller)));
  fastify.post('/', asyncHandler(controller.create.bind(controller)));
  fastify.patch('/:id', asyncHandler(controller.update.bind(controller)));
  fastify.delete('/:id', asyncHandler(controller.delete.bind(controller)));
}
```

See [fastify/UserHandler.ts](./fastify/UserHandler.ts) for complete example.

### Step-by-Step: Next.js App Router Integration

Again, the **controller logic is IDENTICAL**. Next.js adapter layer:

**Next.js adapter layer:**

```typescript
import { NextRequest, NextResponse } from 'next/server';

async function extractContext(
  request: NextRequest,
  params?: Promise<{ id?: string }>
): Promise<IRequestContext> {
  const query = Object.fromEntries(request.nextUrl.searchParams);

  let body = {};
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    try {
      body = await request.json();
    } catch {}
  }

  const resolvedParams = params ? await params : {};

  return {
    query,
    body,
    params: resolvedParams as Record<string, string>,
    user: (request as any).user,
    context: (request as any).context,
  };
}

function sendResponse(response: IControllerResponse): NextResponse {
  if (response.success) {
    return NextResponse.json(response.data, { status: response.status });
  } else {
    return NextResponse.json(
      {
        error: response.error,
        ...(response.details && { details: response.details }),
      },
      { status: response.status }
    );
  }
}
```

**Wire up Next.js route handlers:**

```typescript
// app/api/users/route.ts
export async function GET(request: NextRequest) {
  const controller = new UserController(User); // Same controller!
  const context = await extractContext(request);
  const response = await controller.list(context);
  return sendResponse(response);
}

export async function POST(request: NextRequest) {
  const controller = new UserController(User);
  const context = await extractContext(request);
  const response = await controller.create(context);
  return sendResponse(response);
}

// app/api/users/[id]/route.ts
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const controller = new UserController(User);
  const context = await extractContext(request, params);
  const response = await controller.get(context);
  return sendResponse(response);
}
```

See [nextjs/app/api/users/route.ts](./nextjs/app/api/users/route.ts) for complete example.

### Side-by-Side Comparison

| Component | Express | Fastify | Next.js |
|-----------|---------|---------|---------|
| **Controller** | `UserController` | `UserController` (SAME) | `UserController` (SAME) |
| **Extract Context** | `req.query, req.body, req.params` | `request.query, request.body, request.params` | `searchParams, await request.json(), await params` |
| **Send Response** | `res.status(200).json(data)` | `reply.code(200).send(data)` | `NextResponse.json(data, {status:200})` |
| **Error Handling** | `try/catch + next(error)` | `try/catch (built-in async)` | `try/catch` |
| **Route Registration** | `router.get('/', handler)` | `fastify.get('/', handler)` | `export async function GET()` |

**Key Insight**: Only 3 small adapter functions change across frameworks. All business logic stays the same.

### Security Best Practices

#### 1. Lookup Sanitization

```typescript
async list(context: IRequestContext): Promise<IControllerResponse> {
  const parsed = this.queryParser.parse(context.query);

  // Apply security: only allow specific lookups
  if (parsed.lookup) {
    const allowedCollections = ['departments', 'teams'];
    parsed.lookup = parsed.lookup.filter(l =>
      allowedCollections.includes(l.from)
    );
  }

  const result = await this.repository.getAll(parsed);
  return { success: true, data: result, status: 200 };
}
```

#### 2. Per-Collection Field Allowlists

For advanced security, use the BaseController pattern:

```typescript
protected async list(
  context: IRequestContext,
  schemaOptions: RouteSchemaOptions
): Promise<IControllerResponse> {
  // Define field-level allowlists
  const options = {
    query: {
      allowedLookups: ['departments', 'teams'],
      allowedLookupFields: {
        departments: {
          localFields: ['departmentId'],      // Only allow these local fields
          foreignFields: ['_id', 'name'],     // Only allow these foreign fields
        },
        teams: {
          localFields: ['teamId'],
          foreignFields: ['_id', 'name', 'members'],
        },
      },
    },
  };

  // BaseController sanitizes lookups automatically
  const parsed = this.queryParser.parse(context.query);
  const sanitized = this._sanitizeLookups(parsed.lookup || [], options);
  // ...
}
```

See [api/baseController.ts](./api/baseController.ts) for complete BaseController implementation.

#### 3. Disable Aggregations for Public Endpoints

```typescript
const queryParser = new QueryParser({
  maxLimit: 100,
  enableAggregations: false, // IMPORTANT: Disable for public APIs
});
```

Aggregations are powerful but can expose MongoDB internals. Only enable for trusted clients with per-route allowlists.

See [QueryParser Security Documentation](../src/query/QueryParser.ts) for comprehensive security guide.

### Customization Patterns

#### Custom Error Handling

```typescript
class UserController implements IController<IUser> {
  protected handleError(error: unknown, operation: string): IControllerResponse {
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: 'Validation failed',
        details: error.details,
        status: 400,
      };
    }

    if (error instanceof MongoError && error.code === 11000) {
      return {
        success: false,
        error: 'Duplicate key error',
        status: 409,
      };
    }

    // Log unexpected errors
    console.error(`[${operation}] Unexpected error:`, error);

    return {
      success: false,
      error: 'Internal server error',
      status: 500,
    };
  }

  async create(context: IRequestContext): Promise<IControllerResponse> {
    try {
      const user = await this.repository.create(context.body as Partial<IUser>);
      return { success: true, data: user, status: 201 };
    } catch (error) {
      return this.handleError(error, 'create');
    }
  }
}
```

#### Multi-Tenant Support

```typescript
async list(context: IRequestContext): Promise<IControllerResponse> {
  const parsed = this.queryParser.parse(context.query);

  // Inject tenant filter from context
  if (context.context?.organizationId) {
    parsed.filters = {
      ...parsed.filters,
      organizationId: context.context.organizationId,
    };
  }

  const result = await this.repository.getAll(parsed);
  return { success: true, data: result, status: 200 };
}
```

#### Custom Response Format

```typescript
class CustomController implements IController<IUser> {
  async list(context: IRequestContext): Promise<IControllerResponse> {
    const parsed = this.queryParser.parse(context.query);
    const result = await this.repository.getAll(parsed);

    // Custom response format
    return {
      success: true,
      data: result.docs,
      status: 200,
      meta: {
        pagination: {
          total: result.total,
          page: result.page,
          pages: result.pages,
          hasNext: result.hasNext,
          hasPrev: result.hasPrev,
        },
        timestamp: new Date().toISOString(),
        version: '1.0',
      },
    };
  }
}
```

### Extending BaseController

BaseController is designed to be extended and customized. You can:
1. Use all auto-generated CRUD methods as-is
2. Override specific methods to customize behavior
3. Add new custom methods
4. Use protected helper methods for common patterns

#### 1. Override Specific Methods

Override only the methods you need to customize, keep the rest auto-generated:

```typescript
import { BaseController } from './api/baseController';

class UserController extends BaseController {
  constructor(userService: UserService) {
    super(userService, {
      query: {
        allowedLookups: ['departments', 'teams'],
      },
    });
  }

  // Override create to add email verification
  async create(request: FastifyRequest, reply: FastifyReply) {
    const { email, name } = request.body as { email: string; name: string };

    // Custom validation
    if (!this.isValidEmail(email)) {
      return reply.code(400).send({ error: 'Invalid email format' });
    }

    // Check for duplicates
    const existing = await this.service.findByEmail(email);
    if (existing) {
      return reply.code(409).send({ error: 'Email already exists' });
    }

    // Send verification email
    await this.sendVerificationEmail(email);

    // Use parent's create logic
    return super.create(request, reply);
  }

  // Keep all other methods: getAll(), getById(), update(), delete()
  // They work automatically with no code needed!
}
```

#### 2. Add Custom Endpoints

Extend BaseController and add your own methods alongside auto-CRUD:

```typescript
class ProductController extends BaseController {
  constructor(productService: ProductService) {
    super(productService);
  }

  // Auto-generated: create(), getAll(), getById(), update(), delete()

  // Add custom endpoint: GET /products/featured
  async getFeatured(request: FastifyRequest, reply: FastifyReply) {
    const context = this._buildServiceContext(request);
    const parsed = this.queryParser.parse({ filters: { featured: true } });
    const products = await this.service.getAll(parsed, context);

    return reply.send(products);
  }

  // Add custom endpoint: POST /products/:id/publish
  async publish(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };

    // Custom business logic
    const product = await this.service.getById(id, this._buildServiceContext(request));

    if (!product) {
      return reply.code(404).send({ error: 'Product not found' });
    }

    if (product.status !== 'draft') {
      return reply.code(400).send({ error: 'Only draft products can be published' });
    }

    // Update status
    const updated = await this.service.update(
      id,
      { status: 'published', publishedAt: new Date() },
      this._buildServiceContext(request)
    );

    return reply.send(updated);
  }
}

// Wire up routes (Express example)
router.post('/products', controller.create);           // Auto-generated
router.get('/products', controller.getAll);            // Auto-generated
router.get('/products/featured', controller.getFeatured); // Custom
router.get('/products/:id', controller.getById);       // Auto-generated
router.post('/products/:id/publish', controller.publish); // Custom
router.patch('/products/:id', controller.update);      // Auto-generated
router.delete('/products/:id', controller.delete);     // Auto-generated
```

#### 3. Use Lifecycle Hooks

Override protected methods to add logic before/after operations:

```typescript
class OrderController extends BaseController {
  constructor(orderService: OrderService) {
    super(orderService);
  }

  // Override create to add pre/post hooks
  async create(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as { items: any[]; total: number };

    // Pre-create validation
    if (!body.items || body.items.length === 0) {
      return reply.code(400).send({ error: 'Order must have at least one item' });
    }

    // Verify inventory before creating order
    for (const item of body.items) {
      const inStock = await this.checkInventory(item.productId, item.quantity);
      if (!inStock) {
        return reply.code(400).send({
          error: `Insufficient inventory for ${item.productId}`
        });
      }
    }

    // Call parent create
    const result = await super.create(request, reply);

    // Post-create actions (only if successful)
    if (result.statusCode === 201) {
      await this.reduceInventory(body.items);
      await this.sendOrderConfirmationEmail(request.user, result.body);
      await this.notifyWarehouse(result.body);
    }

    return result;
  }

  private async checkInventory(productId: string, quantity: number): Promise<boolean> {
    // Custom inventory check logic
  }

  private async reduceInventory(items: any[]): Promise<void> {
    // Reduce inventory for each item
  }

  private async sendOrderConfirmationEmail(user: any, order: any): Promise<void> {
    // Send email
  }

  private async notifyWarehouse(order: any): Promise<void> {
    // Notify warehouse system
  }
}
```

#### 4. Override Update with Field Protection

Prevent users from modifying system-managed fields:

```typescript
class UserController extends BaseController {
  constructor(userService: UserService) {
    super(userService, {
      fieldRules: {
        role: { systemManaged: true },      // Users can't change their own role
        credits: { systemManaged: true },   // Users can't change credits
        verified: { systemManaged: true },  // Users can't verify themselves
      },
    });
  }

  // Override update to add role-based restrictions
  async update(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const updates = request.body as any;
    const user = request.user as { id: string; role: string };

    // Users can only update their own profile (unless admin)
    if (user.role !== 'admin' && id !== user.id) {
      return reply.code(403).send({ error: 'Cannot update other users' });
    }

    // Admins can update roles, regular users cannot
    if (updates.role && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Cannot modify role' });
    }

    // Use parent update (which sanitizes system-managed fields)
    return super.update(request, reply);
  }
}
```

#### 5. Mix Auto-CRUD with Custom Implementation

Use some auto-generated methods, implement others from scratch:

```typescript
class ArticleController extends BaseController implements IController<IArticle> {
  constructor(articleService: ArticleService, searchService: SearchService) {
    super(articleService);
    this.searchService = searchService;
  }

  // Use auto-generated create, getById, update, delete
  // (inherited from BaseController)

  // Implement custom list with full-text search
  async list(context: IRequestContext): Promise<IControllerResponse> {
    const { search, ...filters } = context.query;

    // If there's a search query, use search service
    if (search) {
      const results = await this.searchService.search(search as string, {
        filters,
        type: 'article',
      });

      return {
        success: true,
        data: results,
        status: 200,
      };
    }

    // Otherwise, use standard query parsing
    const parsed = this.queryParser.parse(context.query);
    const result = await this.repository.getAll(parsed);

    return {
      success: true,
      data: result,
      status: 200,
    };
  }
}
```

### When to Use Each Approach

**Implement IController from scratch:**
- ✅ Full control over every operation
- ✅ Complex business logic that doesn't fit CRUD pattern
- ✅ Custom response formats
- ✅ Public APIs with unique requirements

**Extend BaseController:**
- ✅ Start with auto-CRUD, override specific methods
- ✅ Add custom endpoints alongside standard CRUD
- ✅ Reuse field sanitization and security patterns
- ✅ Admin panels, internal tools, rapid prototyping

**Use BaseController as-is:**
- ✅ Standard CRUD with no customization needed
- ✅ Simple resource management
- ✅ Prototyping and MVPs

## Need Help?

- [Main Documentation](../README.md)
- [GitHub Issues](https://github.com/classytic/mongokit/issues)
- [npm Package](https://www.npmjs.com/package/@classytic/mongokit)
