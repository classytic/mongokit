/**
 * Type definitions for MongoKit
 * Used for type checking and auto-completion
 */

import { Model, Document, PopulateOptions, ClientSession, Types } from 'mongoose';

// Re-export mongoose ObjectId
export type ObjectId = Types.ObjectId;

// Pagination configuration
export interface PaginationConfig {
  defaultLimit?: number;
  maxLimit?: number;
  maxPage?: number;
  deepPageThreshold?: number;
  cursorVersion?: number;
  useEstimatedCount?: boolean;
}

// Pagination options
export interface OffsetPaginationOptions {
  filters?: Record<string, any>;
  sort?: Record<string, 1 | -1>;
  page?: number;
  limit?: number;
  select?: string | string[];
  populate?: string | string[] | PopulateOptions | PopulateOptions[];
  lean?: boolean;
  session?: ClientSession;
}

export interface KeysetPaginationOptions {
  filters?: Record<string, any>;
  sort: Record<string, 1 | -1>;
  after?: string;
  limit?: number;
  select?: string | string[] | Record<string, any>;
  populate?: string | string[] | PopulateOptions | PopulateOptions[];
  lean?: boolean;
  session?: ClientSession;
}

export interface AggregatePaginationOptions {
  pipeline?: any[];
  page?: number;
  limit?: number;
  session?: ClientSession;
}

// Pagination result types
export interface OffsetPaginationResult<T = any> {
  method: 'offset';
  docs: T[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
  warning?: string;
}

export interface KeysetPaginationResult<T = any> {
  method: 'keyset';
  docs: T[];
  limit: number;
  hasMore: boolean;
  next: string | null;
}

export interface AggregatePaginationResult<T = any> {
  method: 'aggregate';
  docs: T[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
  warning?: string;
}

export type PaginationResult<T = any> =
  | OffsetPaginationResult<T>
  | KeysetPaginationResult<T>
  | AggregatePaginationResult<T>;
