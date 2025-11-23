import { Model, Document, UpdateQuery, ClientSession } from 'mongoose';

// Compatibility alias: QueryFilter was introduced in Mongoose 9 and replaces FilterQuery.
// @ts-ignore - QueryFilter only exists in mongoose >= 9
type QueryFilterV9<T> = import('mongoose').QueryFilter<T>;
// @ts-ignore - FilterQuery was removed in mongoose >= 9
type QueryFilterV8<T> = import('mongoose').FilterQuery<T>;
type CompatibleQueryFilter<T> = QueryFilterV9<T> | QueryFilterV8<T>;

export interface ActionOptions {
  session?: ClientSession;
  updatePipeline?: boolean;
  [key: string]: any;
}

// Create actions
export function create<T extends Document>(
  Model: Model<T>,
  data: Partial<T>,
  options?: ActionOptions
): Promise<T>;

export function createMany<T extends Document>(
  Model: Model<T>,
  dataArray: Partial<T>[],
  options?: ActionOptions
): Promise<T[]>;

export function createDefault<T extends Document>(
  Model: Model<T>,
  overrides?: Partial<T>,
  options?: ActionOptions
): Promise<T>;

export function upsert<T extends Document>(
  Model: Model<T>,
  query: CompatibleQueryFilter<T>,
  data: Partial<T>,
  options?: ActionOptions
): Promise<T>;

// Read actions
export function getById<T extends Document>(
  Model: Model<T>,
  id: string,
  options?: ActionOptions
): Promise<T | null>;

export function getByQuery<T extends Document>(
  Model: Model<T>,
  query: CompatibleQueryFilter<T>,
  options?: ActionOptions
): Promise<T | null>;

export function getOrCreate<T extends Document>(
  Model: Model<T>,
  query: CompatibleQueryFilter<T>,
  createData: Partial<T>,
  options?: ActionOptions
): Promise<T>;

export function count<T extends Document>(
  Model: Model<T>,
  query?: CompatibleQueryFilter<T>,
  options?: ActionOptions
): Promise<number>;

export function exists<T extends Document>(
  Model: Model<T>,
  query: CompatibleQueryFilter<T>,
  options?: ActionOptions
): Promise<boolean>;

// Update actions
export function update<T extends Document>(
  Model: Model<T>,
  id: string,
  data: UpdateQuery<T>,
  options?: ActionOptions
): Promise<T | null>;

export function updateMany<T extends Document>(
  Model: Model<T>,
  query: CompatibleQueryFilter<T>,
  data: UpdateQuery<T>,
  options?: ActionOptions
): Promise<any>;

// Delete actions
export function deleteById<T extends Document>(
  Model: Model<T>,
  id: string,
  options?: ActionOptions
): Promise<T | null>;

export function deleteMany<T extends Document>(
  Model: Model<T>,
  query: CompatibleQueryFilter<T>,
  options?: ActionOptions
): Promise<any>;

// Aggregate actions
export function aggregate<T extends Document>(
  Model: Model<T>,
  pipeline: any[],
  options?: ActionOptions
): Promise<any[]>;

export function aggregatePaginate<T extends Document>(
  Model: Model<T>,
  pipeline: any[],
  options?: ActionOptions
): Promise<any>;

export function distinct<T extends Document>(
  Model: Model<T>,
  field: string,
  query?: CompatibleQueryFilter<T>,
  options?: ActionOptions
): Promise<any[]>;

