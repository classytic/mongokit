/**
 * MongoKit Plugins
 * 
 * Composable, extensible plugins for repository functionality
 */

// Core plugins
export { fieldFilterPlugin } from './field-filter.plugin.js';
export { timestampPlugin } from './timestamp.plugin.js';
export { auditLogPlugin } from './audit-log.plugin.js';
export { softDeletePlugin } from './soft-delete.plugin.js';
export { methodRegistryPlugin } from './method-registry.plugin.js';
export type { MethodRegistryRepository } from './method-registry.plugin.js';
export {
  validationChainPlugin,
  blockIf,
  requireField,
  autoInject,
  immutableField,
  uniqueField,
} from './validation-chain.plugin.js';
export { mongoOperationsPlugin } from './mongo-operations.plugin.js';
export { batchOperationsPlugin } from './batch-operations.plugin.js';
export { aggregateHelpersPlugin } from './aggregate-helpers.plugin.js';
export { subdocumentPlugin } from './subdocument.plugin.js';
export { cachePlugin } from './cache.plugin.js';
export { cascadePlugin } from './cascade.plugin.js';
