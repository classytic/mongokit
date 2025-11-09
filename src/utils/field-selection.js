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
 * Usage:
 * ```javascript
 * // For Mongoose queries (PREFERRED - 90% of cases)
 * const projection = getMongooseProjection(request.user, fieldPresets.gymPlans);
 * const plans = await GymPlan.find().select(projection).lean();
 *
 * // For complex data (10% of cases - aggregations, multiple sources)
 * const filtered = filterResponseData(complexData, fieldPresets.gymPlans, request.user);
 * ```
 */

/**
 * Get allowed fields for a user based on their context
 *
 * @param {Object} user - User object from request.user (or null for public)
 * @param {Object} preset - Field preset configuration
 * @param {string[]} preset.public - Fields visible to everyone
 * @param {string[]} preset.authenticated - Additional fields for authenticated users
 * @param {string[]} preset.admin - Additional fields for admins
 * @returns {string[]} Array of allowed field names
 */
export const getFieldsForUser = (user, preset) => {
  if (!preset) {
    throw new Error('Field preset is required');
  }

  // Start with public fields
  let fields = [...(preset.public || [])];

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
};

/**
 * Get Mongoose projection string for query .select()
 *
 * @param {Object} user - User object from request.user
 * @param {Object} preset - Field preset configuration
 * @returns {string} Space-separated field names for Mongoose .select()
 *
 * @example
 * const projection = getMongooseProjection(request.user, fieldPresets.gymPlans);
 * const plans = await GymPlan.find({ organizationId }).select(projection).lean();
 */
export const getMongooseProjection = (user, preset) => {
  const fields = getFieldsForUser(user, preset);
  return fields.join(' ');
};

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
 * @param {Object|Array} data - Data to filter
 * @param {Object} preset - Field preset configuration
 * @param {Object} user - User object from request.user
 * @returns {Object|Array} Filtered data
 *
 * @example
 * const stats = await calculateComplexStats();
 * const filtered = filterResponseData(stats, fieldPresets.dashboard, request.user);
 * return reply.send(filtered);
 */
export const filterResponseData = (data, preset, user = null) => {
  const allowedFields = getFieldsForUser(user, preset);

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => filterObject(item, allowedFields));
  }

  // Handle single object
  return filterObject(data, allowedFields);
};

/**
 * Filter a single object to include only allowed fields
 *
 * @private
 * @param {Object} obj - Object to filter
 * @param {string[]} allowedFields - Array of allowed field names
 * @returns {Object} Filtered object
 */
const filterObject = (obj, allowedFields) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  const filtered = {};

  for (const field of allowedFields) {
    if (field in obj) {
      filtered[field] = obj[field];
    }
  }

  return filtered;
};

/**
 * Helper to create field presets (module-level)
 *
 * Each module should define its own field preset in its own directory.
 * This keeps modules independent and self-contained.
 *
 * @param {Object} config - Field configuration
 * @returns {Object} Field preset
 *
 * @example
 * // In modules/gym-plan/gym-plan.fields.js
 * import { createFieldPreset } from '#common/utils/field-selection.js';
 *
 * export const gymPlanFieldPreset = createFieldPreset({
 *   public: ['id', 'name', 'price'],
 *   authenticated: ['features', 'description'],
 *   admin: ['createdAt', 'updatedAt', 'internalNotes']
 * });
 *
 * // Then in controller:
 * import { gymPlanFieldPreset } from './gym-plan.fields.js';
 * super(gymPlanRepository, { fieldPreset: gymPlanFieldPreset });
 */
export const createFieldPreset = (config) => {
  return {
    public: config.public || [],
    authenticated: config.authenticated || [],
    admin: config.admin || [],
  };
};
