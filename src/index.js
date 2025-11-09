/**
 * Repository Pattern - Data Access Layer
 * 
 * Event-driven, plugin-based abstraction for MongoDB operations
 * Inspired by Meta & Stripe's repository patterns
 * 
 * @module common/repositories
 * 
 * Documentation:
 * - README.md - Main documentation (concise overview)
 * - QUICK_REFERENCE.md - One-page cheat sheet
 * - EXAMPLES.md - Detailed examples and patterns
 */

/**
 * MongoKit - Event-driven repository pattern for MongoDB
 * 
 * @module @classytic/mongokit
 * @author Sadman Chowdhury (Github: @siam923)
 * @license MIT
 */

export { Repository } from './Repository.js';

// Plugins
export { fieldFilterPlugin } from './plugins/field-filter.plugin.js';
export { timestampPlugin } from './plugins/timestamp.plugin.js';
export { auditLogPlugin } from './plugins/audit-log.plugin.js';
export { softDeletePlugin } from './plugins/soft-delete.plugin.js';
export { methodRegistryPlugin } from './plugins/method-registry.plugin.js';
export {
  validationChainPlugin,
  blockIf,
  requireField,
  autoInject,
  immutableField,
  uniqueField,
} from './plugins/validation-chain.plugin.js';
export { mongoOperationsPlugin } from './plugins/mongo-operations.plugin.js';
export { batchOperationsPlugin } from './plugins/batch-operations.plugin.js';
export { aggregateHelpersPlugin } from './plugins/aggregate-helpers.plugin.js';
export { subdocumentPlugin } from './plugins/subdocument.plugin.js';

// Utilities
export {
  getFieldsForUser,
  getMongooseProjection,
  filterResponseData,
  createFieldPreset,
} from './utils/field-selection.js';

export * as actions from './actions/index.js';

import { Repository } from './Repository.js';

export const createRepository = (Model, plugins = []) => {
  return new Repository(Model, plugins);
};

export default Repository;
