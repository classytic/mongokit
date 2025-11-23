/**
 * Create Actions
 * Pure functions for document creation
 */

/**
 * Create single document
 */
export async function create(Model, data, options = {}) {
  const document = new Model(data);
  await document.save({ session: options.session });
  return document;
}

/**
 * Create multiple documents
 */
export async function createMany(Model, dataArray, options = {}) {
  return Model.insertMany(dataArray, {
    session: options.session,
    ordered: options.ordered !== false,
  });
}

/**
 * Create with defaults (useful for initialization)
 */
export async function createDefault(Model, overrides = {}, options = {}) {
  const defaults = {};
  
  // Extract defaults from schema
  Model.schema.eachPath((path, schemaType) => {
    if (schemaType.options.default !== undefined && path !== '_id') {
      defaults[path] = typeof schemaType.options.default === 'function'
        ? schemaType.options.default()
        : schemaType.options.default;
    }
  });
  
  return create(Model, { ...defaults, ...overrides }, options);
}

/**
 * Upsert (create or update)
 */
export async function upsert(Model, query, data, options = {}) {
  return Model.findOneAndUpdate(
    query,
    { $setOnInsert: data },
    {
      upsert: true,
      new: true,
      runValidators: true,
      session: options.session,
      ...(options.updatePipeline !== undefined ? { updatePipeline: options.updatePipeline } : {}),
    }
  );
}

