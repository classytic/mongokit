/**
 * Framework-Agnostic Base Controller with Auto-CRUD
 *
 * This is a reference implementation showing how to build auto-generated CRUD
 * on top of MongoKit's IController interface. It works with any framework.
 *
 * Features:
 * - Automatic CRUD operations (list, get, create, update, delete)
 * - Query parsing with lookup support
 * - Field sanitization and security
 * - System-managed field protection
 * - Lookup allowlists (per-collection and per-field)
 * - Multi-tenant context injection
 * - Consistent error handling
 *
 * Usage:
 * 1. Copy this file to your project
 * 2. Extend it for your resources
 * 3. Override methods to customize behavior
 * 4. Add custom methods alongside auto-CRUD
 *
 * @example
 * ```typescript
 * import { BaseController } from './BaseController';
 *
 * class UserController extends BaseController<IUser> {
 *   constructor(model: Model<IUser>) {
 *     super(model, {
 *       fieldRules: {
 *         role: { systemManaged: true },
 *       },
 *       query: {
 *         allowedLookups: ['departments', 'teams'],
 *       },
 *     });
 *   }
 *
 *   // Override create to add email verification
 *   async create(context: IRequestContext): Promise<IControllerResponse> {
 *     await this.sendVerificationEmail(context.body.email);
 *     return super.create(context);
 *   }
 *
 *   // Keep other CRUD auto-generated: list, get, update, delete
 * }
 * ```
 */

import type { Model } from 'mongoose';
import {
  Repository,
  QueryParser,
  type IController,
  type IRequestContext,
  type IControllerResponse,
  type PaginationResult,
  type LookupOptions,
} from '@classytic/mongokit';

/**
 * Route schema options for field and lookup security
 */
export type RouteSchemaOptions = {
  /** Field-level rules */
  fieldRules?: Record<
    string,
    {
      /** If true, field cannot be modified by users */
      systemManaged?: boolean;
    }
  >;

  /** Query options for lookups and security */
  query?: {
    /** Collections that can be joined via lookup */
    allowedLookups?: string[];

    /** Per-collection field allowlists for lookups */
    allowedLookupFields?: Record<
      string,
      {
        /** Allowed local fields for this collection */
        localFields?: string[];
        /** Allowed foreign fields for this collection */
        foreignFields?: string[];
      }
    >;
  };
};

/**
 * Framework-Agnostic Base Controller
 *
 * Implements IController with auto-CRUD and advanced security features.
 * Extend this class to get instant CRUD operations with the ability to
 * override specific methods or add custom endpoints.
 *
 * @template TDoc - The Mongoose document type
 */
export class BaseController<TDoc> implements IController<TDoc> {
  protected repository: Repository<TDoc>;
  protected queryParser: QueryParser;
  protected schemaOptions: RouteSchemaOptions;

  constructor(
    protected model: Model<TDoc>,
    schemaOptions: RouteSchemaOptions = {},
    queryParserOptions: {
      maxLimit?: number;
      enableAggregations?: boolean;
      maxFilterDepth?: number;
      maxRegexLength?: number;
      maxSearchLength?: number;
    } = {}
  ) {
    this.repository = new Repository(model);
    this.schemaOptions = schemaOptions;
    this.queryParser = new QueryParser({
      maxLimit: queryParserOptions.maxLimit ?? 100,
      enableAggregations: queryParserOptions.enableAggregations ?? false,
      maxFilterDepth: queryParserOptions.maxFilterDepth ?? 5,
      maxRegexLength: queryParserOptions.maxRegexLength,
      maxSearchLength: queryParserOptions.maxSearchLength,
    });
  }

  /**
   * List resources with filtering, sorting, pagination, lookups
   *
   * Supports:
   * - Filtering: ?filters[status]=active
   * - Sorting: ?sort=-createdAt
   * - Pagination: ?page=1&limit=20 or ?after=cursor&limit=20
   * - Lookups: ?lookup[department][localField]=deptId&lookup[department][foreignField]=_id
   *
   * @param context - Framework-agnostic request context
   * @returns Promise resolving to controller response with paginated data
   */
  async list(
    context: IRequestContext
  ): Promise<IControllerResponse<PaginationResult<TDoc>>> {
    try {
      const parsed = this.queryParser.parse(context.query);

      // Sanitize lookups based on configuration
      if (parsed.lookups && parsed.lookups.length > 0) {
        parsed.lookups = this._sanitizeLookups(parsed.lookups, this.schemaOptions);
      }

      // Inject tenant/organization filter if present
      if (context.context?.organizationId) {
        parsed.filters = {
          ...parsed.filters,
          organizationId: context.context.organizationId,
        };
      }

      const result = await this.repository.getAll(parsed);

      return {
        success: true,
        data: result,
        status: 200,
      };
    } catch (error) {
      return this._handleError(error, 'list') as IControllerResponse<PaginationResult<TDoc>>;
    }
  }

  /**
   * Get single resource by ID
   *
   * @param context - Framework-agnostic request context (id in params)
   * @returns Promise resolving to controller response with single document
   */
  async get(context: IRequestContext): Promise<IControllerResponse<TDoc>> {
    try {
      const { id } = context.params;

      if (!id) {
        return {
          success: false,
          error: 'Resource ID required',
          status: 400,
        };
      }

      try {
        const doc = await this.repository.getById(id);
        return {
          success: true,
          data: doc as TDoc,
          status: 200,
        };
      } catch (error: any) {
        // Repository.getById throws error if not found
        if (error?.status === 404 || error?.message?.includes('not found')) {
          return {
            success: false,
            error: 'Resource not found',
            status: 404,
          };
        }
        throw error;
      }
    } catch (error) {
      return this._handleError(error, 'get') as IControllerResponse<TDoc>;
    }
  }

  /**
   * Create new resource
   *
   * Automatically:
   * - Sanitizes system-managed fields
   * - Injects tenant/organization context
   *
   * @param context - Framework-agnostic request context (data in body)
   * @returns Promise resolving to controller response with created document
   */
  async create(context: IRequestContext): Promise<IControllerResponse<TDoc>> {
    try {
      // Sanitize system-managed fields
      const sanitizedData = this._sanitizeSystemFields(
        context.body as Record<string, unknown>,
        this.schemaOptions
      );

      // Inject context (tenant ID, organization, etc.)
      const dataWithContext = {
        ...sanitizedData,
        ...(context.context?.organizationId && {
          organizationId: context.context.organizationId,
        }),
      };

      const doc = await this.repository.create(dataWithContext as Partial<TDoc>);

      return {
        success: true,
        data: doc,
        status: 201,
      };
    } catch (error) {
      return this._handleError(error, 'create') as IControllerResponse<TDoc>;
    }
  }

  /**
   * Update existing resource
   *
   * Automatically:
   * - Sanitizes system-managed fields
   * - Prevents modification of protected fields
   *
   * @param context - Framework-agnostic request context (id in params, updates in body)
   * @returns Promise resolving to controller response with updated document
   */
  async update(context: IRequestContext): Promise<IControllerResponse<TDoc>> {
    try {
      const { id } = context.params;

      if (!id) {
        return {
          success: false,
          error: 'Resource ID required',
          status: 400,
        };
      }

      // Sanitize system-managed fields
      const sanitizedData = this._sanitizeSystemFields(
        context.body as Record<string, unknown>,
        this.schemaOptions
      );

      try {
        const doc = await this.repository.update(id, sanitizedData);
        return {
          success: true,
          data: doc,
          status: 200,
        };
      } catch (error: any) {
        // Handle not found error
        if (error?.status === 404 || error?.message?.includes('not found')) {
          return {
            success: false,
            error: 'Resource not found',
            status: 404,
          };
        }
        throw error;
      }
    } catch (error) {
      return this._handleError(error, 'update') as IControllerResponse<TDoc>;
    }
  }

  /**
   * Delete resource
   *
   * @param context - Framework-agnostic request context (id in params)
   * @returns Promise resolving to controller response with deletion result
   */
  async delete(
    context: IRequestContext
  ): Promise<IControllerResponse<{ message: string }>> {
    try {
      const { id } = context.params;

      if (!id) {
        return {
          success: false,
          error: 'Resource ID required',
          status: 400,
        };
      }

      const result = await this.repository.delete(id);

      if (!result.success) {
        return {
          success: false,
          error: 'Resource not found',
          status: 404,
        };
      }

      return {
        success: true,
        data: { message: result.message },
        status: 200,
      };
    } catch (error) {
      return this._handleError(error, 'delete') as IControllerResponse<{ message: string }>;
    }
  }

  // ============================================================================
  // Protected Helper Methods - Override these to customize behavior
  // ============================================================================

  /**
   * Sanitize system-managed fields from request data
   *
   * Removes fields marked as systemManaged to prevent users from
   * modifying protected fields like role, credits, verified, etc.
   *
   * Override this to add custom field protection logic.
   *
   * @param data - Request body data
   * @param schemaOptions - Route schema options with field rules
   * @returns Sanitized data
   *
   * @example
   * ```typescript
   * protected _sanitizeSystemFields(data, schemaOptions) {
   *   const sanitized = super._sanitizeSystemFields(data, schemaOptions);
   *
   *   // Custom: Remove internal fields
   *   delete sanitized._internal;
   *   delete sanitized.__v;
   *
   *   return sanitized;
   * }
   * ```
   */
  protected _sanitizeSystemFields(
    data: Record<string, unknown>,
    schemaOptions: RouteSchemaOptions
  ): Record<string, unknown> {
    const fieldRules = schemaOptions.fieldRules || {};
    const sanitized = { ...data };

    for (const [field, rules] of Object.entries(fieldRules)) {
      if (rules.systemManaged && field in sanitized) {
        console.warn(`[BaseController] Blocked system-managed field: ${field}`);
        delete sanitized[field];
      }
    }

    return sanitized;
  }

  /**
   * Sanitize lookups with collection and field allowlists
   *
   * Three levels of security:
   * 1. Collection allowlist (allowedLookups)
   * 2. Per-collection field allowlists (allowedLookupFields)
   * 3. Dangerous feature blocking (pipeline, let)
   *
   * Override this to add custom lookup security logic.
   *
   * @param lookups - Lookup options from query parser
   * @param schemaOptions - Route schema options with lookup rules
   * @returns Sanitized lookups
   *
   * @example
   * ```typescript
   * protected _sanitizeLookups(lookups, schemaOptions) {
   *   // Add custom security checks
   *   const sanitized = super._sanitizeLookups(lookups, schemaOptions);
   *
   *   // Block lookups for non-admin users
   *   if (!this.currentUser?.isAdmin) {
   *     return [];
   *   }
   *
   *   return sanitized;
   * }
   * ```
   */
  protected _sanitizeLookups(
    lookups: LookupOptions[],
    schemaOptions: RouteSchemaOptions
  ): LookupOptions[] {
    const allowedLookups = schemaOptions.query?.allowedLookups;
    const allowedLookupFields = schemaOptions.query?.allowedLookupFields;

    return lookups.filter((lookup) => {
      // Level 1: Collection allowlist
      if (allowedLookups && !allowedLookups.includes(lookup.from)) {
        console.warn(
          `[BaseController] Blocked lookup: collection "${lookup.from}" not in allowlist`
        );
        return false;
      }

      // Level 2: Per-collection field allowlists
      if (allowedLookupFields && allowedLookupFields[lookup.from]) {
        const rules = allowedLookupFields[lookup.from];

        if (rules.localFields && !rules.localFields.includes(lookup.localField)) {
          console.warn(
            `[BaseController] Blocked lookup: localField "${lookup.localField}" not in allowlist for "${lookup.from}"`
          );
          return false;
        }

        if (rules.foreignFields && !rules.foreignFields.includes(lookup.foreignField)) {
          console.warn(
            `[BaseController] Blocked lookup: foreignField "${lookup.foreignField}" not in allowlist for "${lookup.from}"`
          );
          return false;
        }
      }

      // Level 3: Block dangerous features
      if (lookup.pipeline || lookup.let) {
        console.warn(
          `[BaseController] Blocked lookup: pipeline/let not allowed for security`
        );
        return false;
      }

      return true;
    });
  }

  /**
   * Handle errors consistently
   *
   * Override this to customize error handling, logging, or error responses.
   *
   * @param error - The error object
   * @param operation - The operation that failed (list, get, create, update, delete)
   * @returns Controller response with error details
   *
   * @example
   * ```typescript
   * protected _handleError(error, operation) {
   *   // Custom error handling
   *   if (error instanceof ValidationError) {
   *     return {
   *       success: false,
   *       error: 'Validation failed',
   *       details: error.details,
   *       status: 400,
   *     };
   *   }
   *
   *   // Log to monitoring service
   *   this.logger.error(`[${operation}] Error:`, error);
   *
   *   // Fallback to parent
   *   return super._handleError(error, operation);
   * }
   * ```
   */
  protected _handleError(error: unknown, operation: string): IControllerResponse {
    console.error(`[BaseController] Error in ${operation}:`, error);

    return {
      success: false,
      error: error instanceof Error ? error.message : `Failed to ${operation}`,
      status: 500,
    };
  }
}
