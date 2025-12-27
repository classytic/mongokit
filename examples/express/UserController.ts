/**
 * Express Example: User Controller
 *
 * This example shows how to use MongoKit's IController interface with Express.
 *
 * Steps:
 * 1. Define your Mongoose model
 * 2. Create controller using BaseController (copy from examples/api/BaseController.ts)
 * 3. Create Express route handlers that adapt controller methods
 * 4. Wire up routes
 *
 * @see examples/api/BaseController.ts - Framework-agnostic base controller
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Model } from 'mongoose';
import {
  Repository,
  QueryParser,
  type IController,
  type IRequestContext,
  type IControllerResponse,
} from '@classytic/mongokit';

// ============================================================================
// 1. Define Your Mongoose Model
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

// Assume you have a User model defined elsewhere
// import { User } from '@/models/User';

// ============================================================================
// 2. Create Framework-Agnostic Controller
// ============================================================================

/**
 * User Controller (Framework-Agnostic)
 *
 * Implements IController interface from @mongokit/core.
 * This controller has NO framework dependencies - it works with any framework.
 */
class UserController implements IController<IUser> {
  protected repository: Repository<IUser>;
  protected queryParser: QueryParser;

  constructor(protected model: Model<IUser>) {
    this.repository = new Repository(model);
    this.queryParser = new QueryParser({
      maxLimit: 100,
      enableAggregations: false, // Disabled for public endpoints
    });
  }

  /**
   * List users with filtering, sorting, pagination, lookups
   * Framework-agnostic - returns IControllerResponse
   */
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

  /**
   * Get single user by ID
   */
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

  /**
   * Create new user
   */
  async create(context: IRequestContext): Promise<IControllerResponse> {
    try {
      // Validation
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

  /**
   * Update existing user
   */
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

  /**
   * Delete user
   */
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
// 3. Express Adapter Layer
// ============================================================================

/**
 * Extract IRequestContext from Express Request
 * This adapts Express-specific req object to framework-agnostic context
 */
function extractContext(req: Request): IRequestContext {
  return {
    query: req.query as Record<string, unknown>,
    body: req.body as Record<string, unknown>,
    params: req.params as Record<string, string>,
    user: (req as any).user, // From your auth middleware
    context: (req as any).context, // Custom context (tenant ID, etc.)
  };
}

/**
 * Send IControllerResponse as Express Response
 * This adapts framework-agnostic response to Express-specific res object
 */
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

/**
 * Create Express async handler wrapper
 * Automatically handles errors and sends responses
 */
function asyncHandler(
  handler: (
    context: IRequestContext
  ) => Promise<IControllerResponse>
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

// ============================================================================
// 4. Create Express Routes
// ============================================================================

/**
 * Create user router with Express
 * This wires up the framework-agnostic controller to Express routes
 */
export function createUserRouter(User: Model<IUser>): Router {
  const router = Router();
  const controller = new UserController(User);

  // List users: GET /users?status=active&sort=-createdAt&limit=20
  router.get('/', asyncHandler(controller.list.bind(controller)));

  // Get user: GET /users/:id
  router.get('/:id', asyncHandler(controller.get.bind(controller)));

  // Create user: POST /users
  router.post('/', asyncHandler(controller.create.bind(controller)));

  // Update user: PATCH /users/:id
  router.patch('/:id', asyncHandler(controller.update.bind(controller)));

  // Delete user: DELETE /users/:id
  router.delete('/:id', asyncHandler(controller.delete.bind(controller)));

  return router;
}

// ============================================================================
// 5. Usage in Express App
// ============================================================================

/**
 * Example Express app setup
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { connectDB } from './db';
 * import { User } from './models/User';
 * import { createUserRouter } from './controllers/UserController';
 *
 * const app = express();
 *
 * app.use(express.json());
 * app.use('/api/users', createUserRouter(User));
 *
 * connectDB().then(() => {
 *   app.listen(3000, () => console.log('Server running on port 3000'));
 * });
 * ```
 */

export { UserController, extractContext, sendResponse, asyncHandler };
