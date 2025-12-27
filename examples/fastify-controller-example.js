/**
 * Example: Building Fastify Controllers with MongoKit Utils
 *
 * This example shows how to use @classytic/mongokit/utils to quickly
 * create controllers and routes with query parsing and schema validation.
 */

import { MongooseRepository, QueryParser } from '@classytic/mongokit';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import mongoose from 'mongoose';

// ============================================
// 1. Define your Mongoose Model
// ============================================

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  organizationId: { type: mongoose.Schema.Types.ObjectId, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  verifiedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', UserSchema);

// ============================================
// 2. Generate JSON Schemas for Validation
// ============================================

const { crudSchemas } = buildCrudSchemasFromModel(User, {
  strictAdditionalProperties: true, // Reject unknown fields
  fieldRules: {
    organizationId: { immutable: true },      // Cannot be updated after creation
    status: { systemManaged: true },          // System-only field (omitted from create/update)
    verifiedAt: { systemManaged: true },      // System-only field
  },
  create: {
    omitFields: ['createdAt', 'updatedAt'],   // Auto-generated fields
  },
  query: {
    filterableFields: {
      email: { type: 'string' },
      organizationId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
      role: { type: 'string', enum: ['admin', 'user'] },
    },
  },
});

// ============================================
// 3. Create Repository and Query Parser
// ============================================

const userRepository = new MongooseRepository(User);
const queryParser = new QueryParser();

// ============================================
// 4. Build Fastify Routes
// ============================================

export default async function userRoutes(fastify) {

  // CREATE User
  fastify.post('/users', {
    schema: crudSchemas.create,
  }, async (request, reply) => {
    const user = await userRepository.create(request.body);
    return reply.status(201).send(user);
  });

  // LIST Users with Query Parsing
  fastify.get('/users', {
    schema: crudSchemas.list,
  }, async (request, reply) => {
    // Parse HTTP query params into MongoDB filters
    const { filters, limit, page, sort } = queryParser.parse(request.query);

    const result = await userRepository.findPaginated({
      filter: filters,
      limit,
      page,
      sort,
    });

    return reply.send(result);
  });

  // GET User by ID
  fastify.get('/users/:id', {
    schema: crudSchemas.get,
  }, async (request, reply) => {
    const user = await userRepository.findById(request.params.id);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return reply.send(user);
  });

  // UPDATE User
  fastify.patch('/users/:id', {
    schema: crudSchemas.update,
  }, async (request, reply) => {
    const user = await userRepository.findByIdAndUpdate(
      request.params.id,
      request.body,
      { new: true }
    );
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return reply.send(user);
  });

  // DELETE User
  fastify.delete('/users/:id', {
    schema: crudSchemas.remove,
  }, async (request, reply) => {
    const user = await userRepository.findByIdAndDelete(request.params.id);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return reply.status(204).send();
  });
}

// ============================================
// 5. Example Query Parsing
// ============================================

/**
 * The queryParser automatically handles:
 *
 * 1. Filtering:
 *    GET /users?email=john@example.com
 *    GET /users?role=admin&organizationId=507f1f77bcf86cd799439011
 *
 * 2. Operators:
 *    GET /users?email[contains]=john
 *    GET /users?createdAt[gte]=2024-01-01
 *    GET /users?role[in]=admin,user
 *
 * 3. Pagination:
 *    GET /users?page=2&limit=50
 *    GET /users?after=eyJfaWQiOiI2M...  (cursor-based)
 *
 * 4. Sorting:
 *    GET /users?sort=-createdAt,name
 *
 * 5. Complex Queries:
 *    GET /users?role=admin&createdAt[gte]=2024-01-01&sort=-createdAt&limit=20
 */
