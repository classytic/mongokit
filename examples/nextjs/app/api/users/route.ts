/**
 * Next.js App Router Example: User API Routes
 *
 * This example shows how to use MongoKit's IController interface with Next.js App Router.
 * The core controller logic is IDENTICAL to Express/Fastify - only the adapter layer changes.
 *
 * @see examples/express/UserController.ts - Compare with Express approach
 * @see examples/fastify/UserHandler.ts - Compare with Fastify approach
 * @see examples/api/BaseController.ts - Framework-agnostic base controller
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Model } from 'mongoose';
import {
  Repository,
  QueryParser,
  type IController,
  type IRequestContext,
  type IControllerResponse,
} from '@classytic/mongokit';

// ============================================================================
// 1. Define Your Mongoose Model (same as Express/Fastify)
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

// Import your model (example)
// import { User } from '@/models/User';

// ============================================================================
// 2. Framework-Agnostic Controller (IDENTICAL to Express/Fastify)
// ============================================================================

/**
 * User Controller (Framework-Agnostic)
 *
 * This is THE SAME controller as Express and Fastify examples!
 * Write once, use with Express, Fastify, Next.js, or any other framework.
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

      if (parsed.lookup) {
        const allowedCollections = ['departments', 'teams'];
        parsed.lookup = parsed.lookup.filter(l =>
          allowedCollections.includes(l.from)
        );
      }

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

      return { success: true, data: { message: result.message }, status: 200 };
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
// 3. Next.js Adapter Layer (DIFFERENT from Express/Fastify)
// ============================================================================

/**
 * Extract IRequestContext from Next.js Request
 * This adapts Next.js-specific request object to framework-agnostic context
 */
async function extractContext(
  request: NextRequest,
  params?: Promise<{ id?: string }>
): Promise<IRequestContext> {
  // Extract query parameters from URL
  const query = Object.fromEntries(request.nextUrl.searchParams);

  // Parse body if present
  let body = {};
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    try {
      body = await request.json();
    } catch {
      // No body or invalid JSON
    }
  }

  // Await params (Next.js 15+ requires await for params)
  const resolvedParams = params ? await params : {};

  return {
    query,
    body,
    params: resolvedParams as Record<string, string>,
    user: (request as any).user, // From your auth middleware
    context: (request as any).context, // Custom context
  };
}

/**
 * Send IControllerResponse as Next.js Response
 * This adapts framework-agnostic response to Next.js-specific NextResponse
 */
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

// ============================================================================
// 4. Next.js Route Handlers
// ============================================================================

// Initialize controller (in real app, import User model)
// const controller = new UserController(User);

/**
 * List users
 * GET /api/users?status=active&sort=-createdAt&limit=20
 */
export async function GET(request: NextRequest) {
  // In real app: const controller = new UserController(User);
  // const context = await extractContext(request);
  // const response = await controller.list(context);
  // return sendResponse(response);

  return NextResponse.json({
    message: 'Example: Import User model and uncomment code above',
  });
}

/**
 * Create user
 * POST /api/users
 */
export async function POST(request: NextRequest) {
  // In real app: const controller = new UserController(User);
  // const context = await extractContext(request);
  // const response = await controller.create(context);
  // return sendResponse(response);

  return NextResponse.json({
    message: 'Example: Import User model and uncomment code above',
  });
}

// ============================================================================
// 5. Dynamic Route Handler (app/api/users/[id]/route.ts)
// ============================================================================

/**
 * For dynamic routes like /api/users/[id], create a separate file:
 * app/api/users/[id]/route.ts
 *
 * @example
 * ```typescript
 * import { NextRequest, NextResponse } from 'next/server';
 * import { User } from '@/models/User';
 * import { UserController, extractContext, sendResponse } from '../route';
 *
 * export async function GET(
 *   request: NextRequest,
 *   { params }: { params: Promise<{ id: string }> }
 * ) {
 *   const controller = new UserController(User);
 *   const context = await extractContext(request, params);
 *   const response = await controller.get(context);
 *   return sendResponse(response);
 * }
 *
 * export async function PATCH(
 *   request: NextRequest,
 *   { params }: { params: Promise<{ id: string }> }
 * ) {
 *   const controller = new UserController(User);
 *   const context = await extractContext(request, params);
 *   const response = await controller.update(context);
 *   return sendResponse(response);
 * }
 *
 * export async function DELETE(
 *   request: NextRequest,
 *   { params }: { params: Promise<{ id: string }> }
 * ) {
 *   const controller = new UserController(User);
 *   const context = await extractContext(request, params);
 *   const response = await controller.delete(context);
 *   return sendResponse(response);
 * }
 * ```
 */

export { UserController, extractContext, sendResponse };
