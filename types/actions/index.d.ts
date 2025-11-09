import { Model, Document, FilterQuery, UpdateQuery, ClientSession } from 'mongoose';

export interface ActionOptions {
  session?: ClientSession;
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
  query: FilterQuery<T>,
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
  query: FilterQuery<T>,
  options?: ActionOptions
): Promise<T | null>;

export function getOrCreate<T extends Document>(
  Model: Model<T>,
  query: FilterQuery<T>,
  createData: Partial<T>,
  options?: ActionOptions
): Promise<T>;

export function count<T extends Document>(
  Model: Model<T>,
  query?: FilterQuery<T>,
  options?: ActionOptions
): Promise<number>;

export function exists<T extends Document>(
  Model: Model<T>,
  query: FilterQuery<T>,
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
  query: FilterQuery<T>,
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
  query: FilterQuery<T>,
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
  query?: FilterQuery<T>,
  options?: ActionOptions
): Promise<any[]>;

