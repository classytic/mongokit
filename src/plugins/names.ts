/**
 * Canonical identifiers exposed by mongokit's bundled plugins.
 *
 * Use these values with `RepositoryOptions.requirePlugins` and
 * `OperationOptions.skipPlugins` instead of repeating string literals.
 * The values intentionally preserve the plugins' existing public names.
 */
export const MONGOKIT_PLUGIN_NAMES = {
  aggregateHelpers: 'aggregate-helpers',
  appendOnly: 'appendOnly',
  auditLog: 'auditLog',
  auditTrail: 'auditTrail',
  batchOperations: 'batch-operations',
  cache: 'cache',
  cascade: 'cascade',
  changeLog: 'changeLog',
  customId: 'custom-id',
  elasticSearch: 'elastic-search',
  fieldFilter: 'fieldFilter',
  immutableStates: 'immutableStates',
  lease: 'lease',
  methodRegistry: 'method-registry',
  mongoOperations: 'mongo-operations',
  multiTenant: 'multi-tenant',
  observability: 'observability',
  softDelete: 'softDelete',
  subdocument: 'subdocument',
  timestamp: 'timestamp',
  validationChain: 'validation-chain',
} as const;

export type MongoKitPluginName = (typeof MONGOKIT_PLUGIN_NAMES)[keyof typeof MONGOKIT_PLUGIN_NAMES];

/** Bundled-name autocomplete while remaining open to third-party plugins. */
export type RepositoryPluginName = MongoKitPluginName | (string & Record<never, never>);
