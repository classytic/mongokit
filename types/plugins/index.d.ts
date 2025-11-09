import { Plugin, PluginFactory, Repository, RepositoryContext } from '../index.js';
import { Document } from 'mongoose';

// Field Filter Plugin
export interface FieldPreset {
  public?: string[];
  authenticated?: string[];
  admin?: string[];
}

export function fieldFilterPlugin(fieldPreset: FieldPreset): Plugin;

// Soft Delete Plugin
export interface SoftDeleteOptions {
  deletedField?: string;
  deletedByField?: string;
}

export function softDeletePlugin(options?: SoftDeleteOptions): Plugin;

// Timestamp Plugin
export interface TimestampOptions {
  createdAtField?: string;
  updatedAtField?: string;
}

export function timestampPlugin(options?: TimestampOptions): Plugin;

// Audit Log Plugin
export interface Logger {
  info(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
}

export function auditLogPlugin(logger: Logger): Plugin;

// Validation Chain Plugin
export interface Validator {
  name: string;
  operations?: string[];
  validate(context: RepositoryContext, repo: Repository<any>): void | Promise<void>;
}

export interface ValidationChainOptions {
  stopOnFirstError?: boolean;
}

export function validationChainPlugin(
  validators: Validator[],
  options?: ValidationChainOptions
): Plugin;

// Validator helpers
export function blockIf(
  name: string,
  operations: string[],
  condition: (context: RepositoryContext) => boolean,
  errorMessage: string
): Validator;

export function requireField(field: string, operations?: string[]): Validator;

export function autoInject(
  field: string,
  getter: (context: RepositoryContext) => any,
  operations?: string[]
): Validator;

export function immutableField(field: string): Validator;

export function uniqueField(field: string, errorMessage?: string): Validator;

// Method Registry Plugin
export function methodRegistryPlugin(): Plugin;

// Mongo Operations Plugin
export function mongoOperationsPlugin(): Plugin;

// Batch Operations Plugin
export function batchOperationsPlugin(): Plugin;

// Aggregate Helpers Plugin
export function aggregateHelpersPlugin(): Plugin;

// Subdocument Plugin
export function subdocumentPlugin(): Plugin;

