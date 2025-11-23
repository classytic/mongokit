import { Model, Document, ClientSession, PaginateOptions, PaginateResult, UpdateQuery, AggregateOptions } from 'mongoose';

// Compatibility alias: QueryFilter was introduced in Mongoose 9 and replaces FilterQuery.
// @ts-ignore - QueryFilter only exists in mongoose >= 9
type QueryFilterV9<T> = import('mongoose').QueryFilter<T>;
// @ts-ignore - FilterQuery was removed in mongoose >= 9
type QueryFilterV8<T> = import('mongoose').FilterQuery<T>;
type CompatibleQueryFilter<T> = QueryFilterV9<T> | QueryFilterV8<T>;

export interface RepositoryOptions {
  session?: ClientSession;
  populate?: string | string[] | any;
  select?: string | any;
  lean?: boolean;
  throwOnNotFound?: boolean;
  updatePipeline?: boolean;
}

export interface QueryParams {
  pagination?: {
    page: number;
    limit: number;
  };
  search?: string;
  sort?: string;
  filters?: Record<string, any>;
}

export interface RepositoryContext {
  operation: string;
  model: string;
  data?: any;
  dataArray?: any[];
  id?: string;
  query?: any;
  queryParams?: QueryParams;
  context?: any;
  user?: any;
  organizationId?: string;
  [key: string]: any;
}

export type EventListener = (data: any) => void | Promise<void>;

export interface Plugin {
  name: string;
  apply(repository: Repository<any>): void;
}

export type PluginFactory = (options?: any) => Plugin;

export class Repository<T extends Document> {
  Model: Model<T>;
  model: string;
  protected _hooks: Map<string, EventListener[]>;

  constructor(Model: Model<T>, plugins?: (Plugin | PluginFactory)[]);

  // Plugin system
  use(plugin: Plugin | PluginFactory): this;
  on(event: string, listener: EventListener): this;
  emit(event: string, data: any): void;

  // CRUD operations
  create(data: Partial<T>, options?: RepositoryOptions): Promise<T>;
  createMany(dataArray: Partial<T>[], options?: RepositoryOptions): Promise<T[]>;
  
  getById(id: string, options?: RepositoryOptions): Promise<T | null>;
  getByQuery(query: CompatibleQueryFilter<T>, options?: RepositoryOptions): Promise<T | null>;
  getAll(queryParams?: QueryParams, options?: RepositoryOptions): Promise<PaginateResult<T>>;
  getOrCreate(query: CompatibleQueryFilter<T>, createData: Partial<T>, options?: RepositoryOptions): Promise<T>;
  
  count(query?: CompatibleQueryFilter<T>, options?: RepositoryOptions): Promise<number>;
  exists(query: CompatibleQueryFilter<T>, options?: RepositoryOptions): Promise<boolean>;
  
  update(id: string, data: UpdateQuery<T>, options?: RepositoryOptions): Promise<T | null>;
  delete(id: string, options?: RepositoryOptions): Promise<T | null>;

  // Aggregation
  aggregate(pipeline: any[], options?: AggregateOptions): Promise<any[]>;
  aggregatePaginate(pipeline: any[], options?: PaginateOptions): Promise<any>;
  distinct(field: string, query?: CompatibleQueryFilter<T>, options?: RepositoryOptions): Promise<any[]>;

  // Transaction support
  withTransaction<R>(callback: (session: ClientSession) => Promise<R>): Promise<R>;

  // Internal methods
  protected _executeQuery(buildQuery: (model: Model<T>) => Promise<any>): Promise<any>;
  protected _buildContext(operation: string, options: any): Promise<RepositoryContext>;
  protected _parseSort(sort: string | object): object;
  protected _parsePopulate(populate: string | string[] | any): any[];
  protected _handleError(error: any): Error;
}

export function createRepository<T extends Document>(
  Model: Model<T>,
  plugins?: (Plugin | PluginFactory)[]
): Repository<T>;

// Plugin exports
export * from './plugins/index.js';
export * from './utils/index.js';
export * as actions from './actions/index.js';

