import { FieldPreset } from '../plugins/index.js';

export interface User {
  roles?: string | string[];
  [key: string]: any;
}

// Field Selection utilities
export function getFieldsForUser(user: User | null, preset: FieldPreset): string[];

export function getMongooseProjection(user: User | null, preset: FieldPreset): string;

export function filterResponseData<T>(
  data: T | T[],
  preset: FieldPreset,
  user?: User | null
): T | T[];

export function createFieldPreset(config: {
  public?: string[];
  authenticated?: string[];
  admin?: string[];
}): FieldPreset;

