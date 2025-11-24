/**
 * Getting Started - Quick Examples
 *
 * Copy-paste ready code snippets
 */

import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';

// 1. Basic Setup
const UserSchema = new mongoose.Schema({
  name: String,
  email: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const userRepo = new Repository(User);

// 2. CRUD Operations
async function crudExamples() {
  // Create
  const user = await userRepo.create({
    name: 'John Doe',
    email: 'john@example.com'
  });

  // Read by ID
  const found = await userRepo.getById(user._id);

  // Update
  const updated = await userRepo.update(user._id, {
    name: 'Jane Doe'
  });

  // Delete
  await userRepo.delete(user._id);

  // Count
  const total = await userRepo.count({ status: 'active' });

  // Check existence
  const exists = await userRepo.exists({ email: 'john@example.com' });
}

// 3. Pagination Examples
async function paginationExamples() {
  // Offset Pagination (page-based) - for admin dashboards
  const page1 = await userRepo.getAll({
    page: 1,
    limit: 20,
    filters: { status: 'active' },
    sort: { createdAt: -1 }
  });

  console.log(page1.method); // 'offset'
  console.log(page1.total); // Total documents
  console.log(page1.pages); // Total pages
  console.log(page1.docs); // Array of users

  // Keyset Pagination (cursor-based) - for infinite scroll
  const stream1 = await userRepo.getAll({
    sort: { createdAt: -1 },
    limit: 20
  });

  console.log(stream1.method); // 'keyset'
  console.log(stream1.next); // Cursor token
  console.log(stream1.hasMore); // Boolean

  // Load next page
  const stream2 = await userRepo.getAll({
    after: stream1.next,
    sort: { createdAt: -1 },
    limit: 20
  });
}

// 4. Advanced Queries
async function advancedExamples() {
  // Complex filters
  const users = await userRepo.getAll({
    page: 1,
    limit: 20,
    filters: {
      status: 'active',
      role: { $in: ['admin', 'moderator'] },
      createdAt: { $gte: new Date('2024-01-01') }
    },
    sort: { createdAt: -1 }
  });

  // Field selection
  const minimal = await userRepo.getAll({
    page: 1,
    limit: 20
  }, {
    select: 'name email' // Only return these fields
  });

  // Population
  const PostSchema = new mongoose.Schema({
    title: String,
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  });

  const Post = mongoose.model('Post', PostSchema);
  const postRepo = new Repository(Post);

  const posts = await postRepo.getAll({
    page: 1,
    limit: 20
  }, {
    populate: 'authorId' // Populate author
  });
}

// 5. Aggregation
async function aggregationExamples() {
  // Basic aggregation
  const stats = await userRepo.aggregate([
    { $match: { status: 'active' } },
    { $group: { _id: '$role', count: { $sum: 1 } } }
  ]);

  // Paginated aggregation
  const result = await userRepo.aggregatePaginate({
    pipeline: [
      { $match: { status: 'active' } },
      { $sort: { createdAt: -1 } }
    ],
    page: 1,
    limit: 20
  });
}

// 6. Custom Repository
class UserRepository extends Repository {
  constructor() {
    super(User, [], {
      defaultLimit: 20,
      maxLimit: 100
    });
  }

  // Add custom methods
  async findActiveUsers() {
    return this.getAll({
      filters: { status: 'active' },
      sort: { createdAt: -1 }
    });
  }

  async findByEmail(email) {
    return this.getByQuery({ email });
  }

  async activateUser(userId) {
    return this.update(userId, { status: 'active' });
  }
}

// 7. Event Hooks
const repoWithHooks = new Repository(User);

repoWithHooks.on('before:create', async (context) => {
  console.log('Creating user:', context.data);
  // Add timestamps, validation, etc.
  context.data.createdAt = new Date();
});

repoWithHooks.on('after:create', ({ result }) => {
  console.log('User created:', result._id);
  // Send welcome email, update cache, etc.
});

repoWithHooks.on('error:create', ({ error }) => {
  console.error('Failed to create user:', error);
  // Log error, send alert, etc.
});

// 8. Transactions
async function transactionExample() {
  await userRepo.withTransaction(async (session) => {
    await userRepo.create({ name: 'User 1' }, { session });
    await userRepo.create({ name: 'User 2' }, { session });
    // Auto-commits if no errors
  });
}

// 9. Plugin Usage
import {
  softDeletePlugin,
  timestampPlugin,
  auditLogPlugin
} from '@classytic/mongokit';

const repoWithPlugins = new Repository(User, [
  softDeletePlugin(), // Soft delete instead of hard delete
  timestampPlugin(), // Auto createdAt/updatedAt
  auditLogPlugin(console) // Log all operations
], {
  defaultLimit: 20
});

// 10. Multi-Tenant Example
class TenantUserRepository extends Repository {
  constructor() {
    super(User);
  }

  async getAllForTenant(tenantId, params = {}) {
    return this.getAll({
      ...params,
      filters: {
        tenantId,
        ...params.filters
      }
    });
  }
}

/**
 * Quick Start:
 *
 * 1. Install: npm install @classytic/mongokit mongoose
 * 2. Connect to MongoDB
 * 3. Create a Repository
 * 4. Start using CRUD + pagination methods
 *
 * That's it! No additional dependencies needed.
 */
