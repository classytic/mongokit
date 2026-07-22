/**
 * Parser runtime — the shared context every parser module receives.
 *
 * The `QueryParser` facade resolves options once at construction and builds a
 * single `ParserRuntime`; the extracted modules (filter compiler, sanitizers,
 * populate/lookup/sort parsers, …) are pure functions over it. This keeps the
 * modules independently testable and the facade thin, without threading six
 * separate arguments through every call.
 */

import { createError } from '../../utils/error.js';
import { warn } from '../../utils/logger.js';
import type { FieldType, QueryParserOptions } from './types.js';

/**
 * Options with defaults applied. Allowlists and feature flags stay optional
 * (undefined = unrestricted / disabled), everything else is concrete.
 */
export type ResolvedParserOptions = Required<
  Omit<
    QueryParserOptions,
    | 'enableLookups'
    | 'enableAggregations'
    | 'searchFields'
    | 'allowedLookupCollections'
    | 'allowedFilterFields'
    | 'allowedSortFields'
    | 'allowedOperators'
    | 'schema'
    | 'fieldTypes'
  >
> &
  Pick<
    QueryParserOptions,
    | 'enableLookups'
    | 'enableAggregations'
    | 'searchFields'
    | 'allowedLookupCollections'
    | 'allowedFilterFields'
    | 'allowedSortFields'
    | 'allowedOperators'
  >;

/** URL operator key → MongoDB operator. */
export const OPERATOR_MAP: Record<string, string> = {
  eq: '$eq',
  ne: '$ne',
  gt: '$gt',
  gte: '$gte',
  lt: '$lt',
  lte: '$lte',
  in: '$in',
  nin: '$nin',
  like: '$regex',
  contains: '$regex',
  regex: '$regex',
  exists: '$exists',
  size: '$size',
  type: '$type',
};

/** Always-blocked MongoDB operators (extended via `additionalDangerousOperators`). */
export const BASE_DANGEROUS_OPERATORS = ['$where', '$function', '$accumulator', '$expr'] as const;

export interface ParserRuntime {
  readonly options: ResolvedParserOptions;
  /** URL operator key → MongoDB operator (allowlist-filtered at call sites). */
  readonly operators: Record<string, string>;
  readonly dangerousOperators: readonly string[];
  /** Schema-aware coercion map — empty when neither `schema` nor `fieldTypes` was given. */
  readonly fieldTypes: Map<string, FieldType>;
  /**
   * Route an invalid-input finding through the configured `invalidInput`
   * policy: throw a 400 (`INVALID_QUERY_INPUT`) in `'throw'` mode, warn and
   * return in `'drop'` mode (the caller then performs its legacy drop /
   * escape / truncate fallback).
   */
  reject(message: string, meta?: Record<string, unknown>): void;
}

export function createReject(mode: 'throw' | 'drop'): ParserRuntime['reject'] {
  return (message, meta) => {
    if (mode === 'throw') {
      throw createError(400, `[mongokit] ${message}`, { code: 'INVALID_QUERY_INPUT', meta });
    }
    warn(`[mongokit] ${message}`);
  };
}
