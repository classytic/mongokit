/**
 * Create Actions
 * Pure functions for document creation
 */

import type { Model, ClientSession, SchemaType } from 'mongoose';
import type { CreateOptions, AnyDocument } from '../types.js';

/**
 * Create single document
 */
export async function create<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  data: Record<string, unknown>,
  options: CreateOptions = {}
): Promise<TDoc> {
  const document = new Model(data);
  await document.save({ session: options.session });
  return document as TDoc;
}

/**
 * Create multiple documents
 */
export async function createMany<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  dataArray: Record<string, unknown>[],
  options: CreateOptions = {}
): Promise<TDoc[]> {
  return Model.insertMany(dataArray, {
    session: options.session,
    ordered: options.ordered !== false,
  }) as Promise<TDoc[]>;
}

/**
 * Create with defaults (useful for initialization)
 */
export async function createDefault<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  overrides: Record<string, unknown> = {},
  options: CreateOptions = {}
): Promise<TDoc> {
  const defaults: Record<string, unknown> = {};

  // Extract defaults from schema
  Model.schema.eachPath((path: string, schemaType: SchemaType) => {
    const schemaOptions = schemaType.options as { default?: unknown };
    if (schemaOptions.default !== undefined && path !== '_id') {
      defaults[path] = typeof schemaOptions.default === 'function'
        ? schemaOptions.default()
        : schemaOptions.default;
    }
  });

  return create(Model, { ...defaults, ...overrides }, options);
}

/**
 * Upsert (create or update)
 */
export async function upsert<TDoc = AnyDocument>(
  Model: Model<TDoc>,
  query: Record<string, unknown>,
  data: Record<string, unknown>,
  options: { session?: ClientSession; updatePipeline?: boolean } = {}
): Promise<TDoc | null> {
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
