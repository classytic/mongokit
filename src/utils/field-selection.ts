/**
 * Field Selection Utilities
 *
 * Provides explicit, performant field filtering using Mongoose projections.
 *
 * Philosophy:
 * - Explicit is better than implicit
 * - Filter at DB level (10x faster than in-memory)
 * - Progressive disclosure (show more fields as trust increases)
 *
 * @example
 * ```typescript
 * // For Mongoose queries (PREFERRED - 90% of cases)
 * const projection = getMongooseProjection(request.user, fieldPresets.gymPlans);
 * const plans = await GymPlan.find().select(projection).lean();
 *
 * // For complex data (10% of cases - aggregations, multiple sources)
 * const filtered = filterResponseData(complexData, fieldPresets.gymPlans, request.user);
 * ```
 */

import type { FieldPreset, UserContext } from '../types.js';

/**
 * Get allowed fields for a user based on their context
 *
 * @param user - User object from request.user (or null for public)
 * @param preset - Field preset configuration
 * @returns Array of allowed field names
 * 
 * @example
 * const fields = getFieldsForUser(request.user, {
 *   public: ['id', 'name', 'price'],
 *   authenticated: ['description', 'features'],
 *   admin: ['createdAt', 'internalNotes']
 * });
 */
export function getFieldsForUser(user: UserContext | null | undefined, preset: FieldPreset): string[] {
  if (!preset) {
    throw new Error('Field preset is required');
  }

  // Start with public fields
  const fields: string[] = [...(preset.public || [])];

  // Add authenticated fields if user is logged in
  if (user) {
    fields.push(...(preset.authenticated || []));

    // Add admin fields if user is admin/superadmin
    const roles = Array.isArray(user.roles) ? user.roles : (user.roles ? [user.roles] : []);
    if (roles.includes('admin') || roles.includes('superadmin')) {
      fields.push(...(preset.admin || []));
    }
  }

  // Remove duplicates
  return [...new Set(fields)];
}

/**
 * Get Mongoose projection string for query .select()
 *
 * @param user - User object from request.user
 * @param preset - Field preset configuration
 * @returns Space-separated field names for Mongoose .select()
 *
 * @example
 * const projection = getMongooseProjection(request.user, fieldPresets.gymPlans);
 * const plans = await GymPlan.find({ organizationId }).select(projection).lean();
 */
export function getMongooseProjection(user: UserContext | null | undefined, preset: FieldPreset): string {
  const fields = getFieldsForUser(user, preset);
  return fields.join(' ');
}

/**
 * Filter a single object to include only allowed fields
 */
function filterObject<T extends Record<string, unknown>>(
  obj: T,
  allowedFields: string[]
): Partial<T> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  const filtered: Partial<T> = {};

  for (const field of allowedFields) {
    if (field in obj) {
      (filtered as Record<string, unknown>)[field] = obj[field];
    }
  }

  return filtered;
}

/**
 * Filter response data to include only allowed fields
 *
 * Use this for complex responses where Mongoose projections aren't applicable:
 * - Aggregation pipeline results
 * - Data from multiple sources
 * - Custom computed fields
 *
 * For simple DB queries, prefer getMongooseProjection() (10x faster)
 *
 * @param data - Data to filter
 * @param preset - Field preset configuration
 * @param user - User object from request.user
 * @returns Filtered data
 *
 * @example
 * const stats = await calculateComplexStats();
 * const filtered = filterResponseData(stats, fieldPresets.dashboard, request.user);
 * return reply.send(filtered);
 */
export function filterResponseData<T extends Record<string, unknown>>(
  data: T | T[],
  preset: FieldPreset,
  user: UserContext | null = null
): Partial<T> | Partial<T>[] {
  const allowedFields = getFieldsForUser(user, preset);

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => filterObject(item, allowedFields));
  }

  // Handle single object
  return filterObject(data, allowedFields);
}

/**
 * Helper to create field presets (module-level)
 *
 * Each module should define its own field preset in its own directory.
 * This keeps modules independent and self-contained.
 *
 * @param config - Field configuration
 * @returns Field preset
 *
 * @example
 * // In modules/gym-plan/gym-plan.fields.ts
 * export const gymPlanFieldPreset = createFieldPreset({
 *   public: ['id', 'name', 'price'],
 *   authenticated: ['features', 'description'],
 *   admin: ['createdAt', 'updatedAt', 'internalNotes']
 * });
 */
export function createFieldPreset(config: Partial<FieldPreset>): FieldPreset {
  return {
    public: config.public || [],
    authenticated: config.authenticated || [],
    admin: config.admin || [],
  };
}
