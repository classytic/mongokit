/**
 * Framework-Agnostic Base Controller with Auto-CRUD (JavaScript)
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
 * ```javascript
 * import { BaseController } from './baseController.js';
 *
 * class UserController extends BaseController {
 *   constructor(model) {
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
 *   async create(context) {
 *     await this.sendVerificationEmail(context.body.email);
 *     return super.create(context);
 *   }
 *
 *   // Keep other CRUD auto-generated: list, get, update, delete
 * }
 * ```
 */

import { Repository, QueryParser } from '@classytic/mongokit';

/**
 * Framework-Agnostic Base Controller
 *
 * Implements IController with auto-CRUD and advanced security features.
 * Extend this class to get instant CRUD operations with the ability to
 * override specific methods or add custom endpoints.
 */
export class BaseController {
  /**
   * @param {import('mongoose').Model} model - Mongoose model
   * @param {Object} [schemaOptions={}] - Route schema options
   * @param {Object} [schemaOptions.fieldRules] - Field-level rules
   * @param {Object} [schemaOptions.query] - Query options for lookups and security
   * @param {string[]} [schemaOptions.query.allowedLookups] - Collections that can be joined via lookup
   * @param {Object} [schemaOptions.query.allowedLookupFields] - Per-collection field allowlists for lookups
   * @param {Object} [queryParserOptions={}] - Query parser options
   * @param {number} [queryParserOptions.maxLimit=100] - Maximum limit for pagination
   * @param {boolean} [queryParserOptions.enableAggregations=false] - Enable aggregation pipelines
   * @param {number} [queryParserOptions.maxFilterDepth=5] - Maximum filter nesting depth
   * @param {number} [queryParserOptions.maxRegexLength] - Maximum regex pattern length
   * @param {number} [queryParserOptions.maxSearchLength] - Maximum search query length
   */
  constructor(model, schemaOptions = {}, queryParserOptions = {}) {
    this.model = model;
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
   * @param {Object} context - Framework-agnostic request context
   * @param {Object} context.query - Query parameters
   * @param {Object} context.body - Request body
   * @param {Object} context.params - Route parameters
   * @param {Object} [context.user] - Authenticated user
   * @param {Object} [context.context] - Custom context (tenant ID, etc.)
   * @returns {Promise<Object>} Controller response with paginated data
   */
  async list(context) {
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
      return this._handleError(error, 'list');
    }
  }

  /**
   * Get single resource by ID
   *
   * @param {Object} context - Framework-agnostic request context (id in params)
   * @returns {Promise<Object>} Controller response with single document
   */
  async get(context) {
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
          data: doc,
          status: 200,
        };
      } catch (error) {
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
      return this._handleError(error, 'get');
    }
  }

  /**
   * Create new resource
   *
   * Automatically:
   * - Sanitizes system-managed fields
   * - Injects tenant/organization context
   *
   * @param {Object} context - Framework-agnostic request context (data in body)
   * @returns {Promise<Object>} Controller response with created document
   */
  async create(context) {
    try {
      // Sanitize system-managed fields
      const sanitizedData = this._sanitizeSystemFields(
        context.body,
        this.schemaOptions
      );

      // Inject context (tenant ID, organization, etc.)
      const dataWithContext = {
        ...sanitizedData,
        ...(context.context?.organizationId && {
          organizationId: context.context.organizationId,
        }),
      };

      const doc = await this.repository.create(dataWithContext);

      return {
        success: true,
        data: doc,
        status: 201,
      };
    } catch (error) {
      return this._handleError(error, 'create');
    }
  }

  /**
   * Update existing resource
   *
   * Automatically:
   * - Sanitizes system-managed fields
   * - Prevents modification of protected fields
   *
   * @param {Object} context - Framework-agnostic request context (id in params, updates in body)
   * @returns {Promise<Object>} Controller response with updated document
   */
  async update(context) {
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
        context.body,
        this.schemaOptions
      );

      try {
        const doc = await this.repository.update(id, sanitizedData);
        return {
          success: true,
          data: doc,
          status: 200,
        };
      } catch (error) {
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
      return this._handleError(error, 'update');
    }
  }

  /**
   * Delete resource
   *
   * @param {Object} context - Framework-agnostic request context (id in params)
   * @returns {Promise<Object>} Controller response with deletion result
   */
  async delete(context) {
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
      return this._handleError(error, 'delete');
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
   * @param {Object} data - Request body data
   * @param {Object} schemaOptions - Route schema options with field rules
   * @returns {Object} Sanitized data
   *
   * @example
   * ```javascript
   * _sanitizeSystemFields(data, schemaOptions) {
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
  _sanitizeSystemFields(data, schemaOptions) {
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
   * @param {Array} lookups - Lookup options from query parser
   * @param {Object} schemaOptions - Route schema options with lookup rules
   * @returns {Array} Sanitized lookups
   *
   * @example
   * ```javascript
   * _sanitizeLookups(lookups, schemaOptions) {
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
  _sanitizeLookups(lookups, schemaOptions) {
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
   * @param {Error|unknown} error - The error object
   * @param {string} operation - The operation that failed (list, get, create, update, delete)
   * @returns {Object} Controller response with error details
   *
   * @example
   * ```javascript
   * _handleError(error, operation) {
   *   // Custom error handling
   *   if (error.name === 'ValidationError') {
   *     return {
   *       success: false,
   *       error: 'Validation failed',
   *       details: error.details,
   *       status: 400,
   *     };
   *   }
   *
   *   // Log to monitoring service
   *   console.error(`[${operation}] Error:`, error);
   *
   *   // Fallback to parent
   *   return super._handleError(error, operation);
   * }
   * ```
   */
  _handleError(error, operation) {
    console.error(`[BaseController] Error in ${operation}:`, error);

    return {
      success: false,
      error: error instanceof Error ? error.message : `Failed to ${operation}`,
      status: 500,
    };
  }
}
