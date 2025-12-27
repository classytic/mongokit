/**
 * Fastify Example: User Handler
 *
 * This example shows how to use MongoKit's IController interface with Fastify.
 * The core controller logic is identical to Express - only the adapter layer changes.
 *
 * @see examples/express/UserController.ts - Compare with Express approach
 * @see examples/api/BaseController.ts - Framework-agnostic base controller
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Model } from 'mongoose';
import {
  Repository,
  QueryParser,
  type IController,
  type IRequestContext,
  type IControllerResponse,
} from '@classytic/mongokit';

// ============================================================================
// 1. Define Your Mongoose Model (same as Express)
// ============================================================================

interface IUser {
  _id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  departmentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// 2. Framework-Agnostic Controller (IDENTICAL to Express example)
// ============================================================================

/**
 * User Controller (Framework-Agnostic)
 *
 * This is THE SAME controller as in the Express example!
 * The beauty of IController: write once, use with any framework.
 */
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

      // Apply security: only allow specific lookups
      if (parsed.lookup) {
        const allowedCollections = ['departments', 'teams'];
        parsed.lookup = parsed.lookup.filter(l =>
          allowedCollections.includes(l.from)
        );
      }

      const result = await this.repository.getAll(parsed);

      return {
        success: true,
        data: result,
        status: 200,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch users',
        status: 500,
      };
    }
  }

  async get(context: IRequestContext): Promise<IControllerResponse> {
    try {
      const { id } = context.params;

      if (!id) {
        return { success: false, error: 'User ID required', status: 400 };
      }

      const user = await this.repository.getById(id);

      if (!user) {
        return { success: false, error: 'User not found', status: 404 };
      }

      return { success: true, data: user, status: 200 };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch user',
        status: 500,
      };
    }
  }

  async create(context: IRequestContext): Promise<IControllerResponse> {
    try {
      const { name, email } = context.body as { name?: string; email?: string };

      if (!name || !email) {
        return {
          success: false,
          error: 'Name and email are required',
          status: 400,
        };
      }

      const user = await this.repository.create(context.body as Partial<IUser>);

      return { success: true, data: user, status: 201 };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create user',
        status: 500,
      };
    }
  }

  async update(context: IRequestContext): Promise<IControllerResponse> {
    try {
      const { id } = context.params;

      if (!id) {
        return { success: false, error: 'User ID required', status: 400 };
      }

      const user = await this.repository.updateById(id, context.body as Partial<IUser>);

      if (!user) {
        return { success: false, error: 'User not found', status: 404 };
      }

      return { success: true, data: user, status: 200 };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update user',
        status: 500,
      };
    }
  }

  async delete(context: IRequestContext): Promise<IControllerResponse> {
    try {
      const { id } = context.params;

      if (!id) {
        return { success: false, error: 'User ID required', status: 400 };
      }

      const result = await this.repository.deleteById(id);

      if (!result.success) {
        return { success: false, error: 'User not found', status: 404 };
      }

      return {
        success: true,
        data: { message: result.message },
        status: 200,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete user',
        status: 500,
      };
    }
  }
}

// ============================================================================
// 3. Fastify Adapter Layer (DIFFERENT from Express)
// ============================================================================

/**
 * Extract IRequestContext from Fastify Request
 * This adapts Fastify-specific request object to framework-agnostic context
 */
function extractContext(request: FastifyRequest): IRequestContext {
  return {
    query: request.query as Record<string, unknown>,
    body: request.body as Record<string, unknown>,
    params: request.params as Record<string, string>,
    user: (request as any).user, // From your auth decorator
    context: (request as any).context, // Custom context
  };
}

/**
 * Send IControllerResponse as Fastify Response
 * This adapts framework-agnostic response to Fastify-specific reply object
 */
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

/**
 * Create Fastify async handler wrapper
 * Fastify has built-in async support, so this is simpler than Express
 */
function asyncHandler(
  handler: (context: IRequestContext) => Promise<IControllerResponse>
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const context = extractContext(request);
    const response = await handler(context);
    return sendResponse(reply, response);
  };
}

// ============================================================================
// 4. Register Fastify Routes
// ============================================================================

/**
 * Register user routes with Fastify
 * This wires up the framework-agnostic controller to Fastify routes
 */
export async function registerUserRoutes(
  fastify: FastifyInstance,
  User: Model<IUser>
) {
  const controller = new UserController(User);

  // List users: GET /users?status=active&sort=-createdAt&limit=20
  fastify.get('/', asyncHandler(controller.list.bind(controller)));

  // Get user: GET /users/:id
  fastify.get('/:id', asyncHandler(controller.get.bind(controller)));

  // Create user: POST /users
  fastify.post('/', asyncHandler(controller.create.bind(controller)));

  // Update user: PATCH /users/:id
  fastify.patch('/:id', asyncHandler(controller.update.bind(controller)));

  // Delete user: DELETE /users/:id
  fastify.delete('/:id', asyncHandler(controller.delete.bind(controller)));
}

// ============================================================================
// 5. Usage in Fastify App
// ============================================================================

/**
 * Example Fastify app setup
 *
 * @example
 * ```typescript
 * import fastify from 'fastify';
 * import { connectDB } from './db';
 * import { User } from './models/User';
 * import { registerUserRoutes } from './handlers/UserHandler';
 *
 * const app = fastify();
 *
 * // Register routes
 * app.register(
 *   async (instance) => {
 *     await registerUserRoutes(instance, User);
 *   },
 *   { prefix: '/api/users' }
 * );
 *
 * // Start server
 * connectDB().then(() => {
 *   app.listen({ port: 3000 }, (err) => {
 *     if (err) throw err;
 *     console.log('Server running on port 3000');
 *   });
 * });
 * ```
 */

export { UserController, extractContext, sendResponse, asyncHandler };
