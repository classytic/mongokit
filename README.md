# @classytic/mongokit

[![Test](https://github.com/classytic/mongokit/actions/workflows/test.yml/badge.svg)](https://github.com/classytic/mongokit/actions/workflows/test.yml)
[![npm version](https://badge.fury.io/js/@classytic%2Fmongokit.svg)](https://www.npmjs.com/package/@classytic/mongokit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Event-driven MongoDB repositories for any Node.js framework

**Works with:** Express • Fastify • NestJS • Next.js • Koa • Hapi • Serverless

- ✅ **Plugin-based architecture** 
- ✅ **Event hooks** for every operation
- ✅ **Framework-agnostic** 
- ✅ **TypeScript** support
- ✅ **Battle-tested** in production

---

## 📦 Installation

```bash
npm install @classytic/mongokit mongoose mongoose-paginate-v2 mongoose-aggregate-paginate-v2
```

> **Peer Dependencies:** 
> - `mongoose ^8.0.0`
> - `mongoose-paginate-v2 ^1.9.0` (for pagination support)
> - `mongoose-aggregate-paginate-v2 ^1.1.0` (for aggregation pagination)

---


## 🚀 Quick Start

### Basic Usage

```javascript
import { Repository } from '@classytic/mongokit';
import UserModel from './models/User.js';

class UserRepository extends Repository {
  constructor() {
    super(UserModel);
  }
  
  async findActiveUsers() {
    return this.getAll({ filters: { status: 'active' } });
  }
}

const userRepo = new UserRepository();

// Create
const user = await userRepo.create({ name: 'John', email: 'john@example.com' });

// Read
const users = await userRepo.getAll({ pagination: { page: 1, limit: 10 } });
const user = await userRepo.getById('user-id');

// Update
await userRepo.update('user-id', { name: 'Jane' });

// Delete
await userRepo.delete('user-id');
```

### With Express

```javascript
import express from 'express';
import { Repository } from '@classytic/mongokit';

const app = express();
const userRepo = new Repository(UserModel);

app.get('/users', async (req, res) => {
  const users = await userRepo.getAll({
    filters: { status: 'active' },
    pagination: { page: req.query.page || 1, limit: 20 }
  });
  res.json(users);
});
```

### With Fastify

```javascript
import Fastify from 'fastify';
import { Repository } from '@classytic/mongokit';

const fastify = Fastify();
const userRepo = new Repository(UserModel);

fastify.get('/users', async (request, reply) => {
  const users = await userRepo.getAll();
  return users;
});
```

### With Next.js API Routes

```javascript
// pages/api/users.js
import { Repository } from '@classytic/mongokit';
import UserModel from '@/models/User';

const userRepo = new Repository(UserModel);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const users = await userRepo.getAll();
    res.json(users);
  }
}
```

---

## 🔌 Built-in Plugins

### Field Filtering (Role-based Access)

Control which fields are visible based on user roles:

```javascript
import { Repository, fieldFilterPlugin } from '@classytic/mongokit';

const fieldPreset = {
  public: ['id', 'name', 'email'],
  authenticated: ['phone', 'address'],
  admin: ['createdAt', 'updatedAt', 'internalNotes']
};

class UserRepository extends Repository {
  constructor() {
    super(User, [fieldFilterPlugin(fieldPreset)]);
  }
}
```

### Validation Chain

Add custom validation rules:

```javascript
import { 
  Repository, 
  validationChainPlugin, 
  requireField, 
  uniqueField,
  immutableField 
} from '@classytic/mongokit';

class UserRepository extends Repository {
  constructor() {
    super(User, [
      validationChainPlugin([
        requireField('email', ['create']),
        uniqueField('email', 'Email already exists'),
        immutableField('userId')
      ])
    ]);
  }
}
```

### Soft Delete

Mark records as deleted without actually removing them:

```javascript
import { Repository, softDeletePlugin } from '@classytic/mongokit';

class UserRepository extends Repository {
  constructor() {
    super(User, [softDeletePlugin({ deletedField: 'deletedAt' })]);
  }
}

// repo.delete(id) → marks as deleted instead of removing
// repo.getAll() → excludes deleted records
// repo.getAll({ includeDeleted: true }) → includes deleted
```

### Audit Logging

Log all create, update, and delete operations:

```javascript
import { Repository, auditLogPlugin } from '@classytic/mongokit';
import logger from './logger.js';

class UserRepository extends Repository {
  constructor() {
    super(User, [auditLogPlugin(logger)]);
  }
}

// All CUD operations automatically logged
```

### More Plugins

- **`timestampPlugin()`** - Auto-manage `createdAt`/`updatedAt`
- **`mongoOperationsPlugin()`** - Adds `increment`, `pushToArray`, `upsert`, etc.
- **`batchOperationsPlugin()`** - Adds `updateMany`, `deleteMany`
- **`aggregateHelpersPlugin()`** - Adds `groupBy`, `sum`, `average`, etc.
- **`subdocumentPlugin()`** - Manage subdocument arrays easily

---

## 🎯 Core API

### CRUD Operations

| Method | Description | Example |
|--------|-------------|---------|
| `create(data, opts)` | Create single document | `repo.create({ name: 'John' })` |
| `createMany(data[], opts)` | Create multiple documents | `repo.createMany([{...}, {...}])` |
| `getById(id, opts)` | Find by ID | `repo.getById('123')` |
| `getByQuery(query, opts)` | Find one by query | `repo.getByQuery({ email: 'a@b.com' })` |
| `getAll(params, opts)` | Paginated list | `repo.getAll({ filters: { active: true } })` |
| `getOrCreate(query, data, opts)` | Find or create | `repo.getOrCreate({ email }, { email, name })` |
| `update(id, data, opts)` | Update document | `repo.update('123', { name: 'Jane' })` |
| `delete(id, opts)` | Delete document | `repo.delete('123')` |
| `count(query, opts)` | Count documents | `repo.count({ status: 'active' })` |
| `exists(query, opts)` | Check existence | `repo.exists({ email: 'a@b.com' })` |

### Aggregation

```javascript
// Basic aggregation
const result = await repo.aggregate([
  { $match: { status: 'active' } },
  { $group: { _id: '$category', total: { $sum: 1 } } }
]);

// Paginated aggregation
const result = await repo.aggregatePaginate([
  { $match: { status: 'active' } }
], { page: 1, limit: 20 });

// Distinct values
const categories = await repo.distinct('category');
```

### Transactions

```javascript
await repo.withTransaction(async (session) => {
  await repo.create({ name: 'User 1' }, { session });
  await repo.create({ name: 'User 2' }, { session });
  // Auto-commits if no errors, auto-rollbacks on errors
});
```

---

## 🎨 Event System

Every operation emits lifecycle events:

```javascript
repo.on('before:create', async (context) => {
  console.log('About to create:', context.data);
  // Modify context.data if needed
  context.data.processedAt = new Date();
});

repo.on('after:create', ({ context, result }) => {
  console.log('Created:', result);
  // Send notification, update cache, etc.
});

repo.on('error:create', ({ context, error }) => {
  console.error('Failed to create:', error);
  // Log error, send alert, etc.
});
```

**Available Events:**
- `before:create`, `after:create`, `error:create`
- `before:update`, `after:update`, `error:update`
- `before:delete`, `after:delete`, `error:delete`
- `before:createMany`, `after:createMany`, `error:createMany`
- `before:getAll`, `before:getById`, `before:getByQuery`

---

## 🔧 Custom Plugins

Create your own plugins:

```javascript
export const timestampPlugin = () => ({
  name: 'timestamp',
  
  apply(repo) {
    repo.on('before:create', (context) => {
      context.data.createdAt = new Date();
      context.data.updatedAt = new Date();
    });
    
    repo.on('before:update', (context) => {
      context.data.updatedAt = new Date();
    });
  }
});

// Use it
class UserRepository extends Repository {
  constructor() {
    super(User, [timestampPlugin()]);
  }
}
```

---

## 📚 TypeScript Support

Full TypeScript definitions included:

```typescript
import { Repository, Plugin, RepositoryContext } from '@classytic/mongokit';
import { Model, Document } from 'mongoose';

interface IUser extends Document {
  name: string;
  email: string;
  status: 'active' | 'inactive';
}

class UserRepository extends Repository<IUser> {
  constructor() {
    super(UserModel);
  }
  
  async findActive(): Promise<IUser[]> {
    const result = await this.getAll({ 
      filters: { status: 'active' } 
    });
    return result.docs;
  }
}
```

---

## 🏗️ Advanced Patterns

### Custom Methods

```javascript
class MembershipRepository extends Repository {
  constructor() {
    super(Membership);
  }
  
  async findActiveByCustomer(customerId) {
    return this.getAll({
      filters: { 
        customerId, 
        status: { $in: ['active', 'paused'] } 
      }
    });
  }
  
  async recordVisit(membershipId) {
    return this.update(membershipId, {
      $set: { lastVisitedAt: new Date() },
      $inc: { totalVisits: 1 }
    });
  }
}
```

### Combining Multiple Plugins

```javascript
import { 
  Repository,
  softDeletePlugin,
  auditLogPlugin,
  fieldFilterPlugin
} from '@classytic/mongokit';

class UserRepository extends Repository {
  constructor() {
    super(User, [
      softDeletePlugin(),
      auditLogPlugin(logger),
      fieldFilterPlugin(userFieldPreset)
    ]);
  }
}
```

---

## 🌟 Why MongoKit?

### vs. Mongoose Directly
- ✅ Consistent API across all models
- ✅ Built-in pagination, filtering, sorting
- ✅ Multi-tenancy without repetitive code
- ✅ Event hooks for cross-cutting concerns
- ✅ Plugin system for reusable behaviors

### vs. TypeORM / Prisma
- ✅ Lighter weight (works with Mongoose)
- ✅ Event-driven architecture
- ✅ More flexible plugin system
- ✅ No migration needed if using Mongoose
- ✅ Framework-agnostic

### vs. Raw Repository Pattern
- ✅ Battle-tested implementation
- ✅ 11 built-in plugins ready to use
- ✅ Comprehensive documentation
- ✅ TypeScript support
- ✅ Active maintenance

---

## 🧪 Testing

```bash
npm test
```

---

## 📄 License

MIT © [Classytic](https://github.com/classytic)

