/**
 * Parser runtime — the shared context every parser module receives.
 *
 * The `QueryParser` facade resolves options once at construction and builds a
 * single `ParserRuntime`; the extracted modules (filter compiler, sanitizers,
 * populate/lookup/sort parsers, …) are pure functions over it. This keeps the
 * modules independently testable and the facade thin, without threading six
 * separate arguments through every call.
 */

import { isQueryGrammarError, type QueryFieldType } from '@classytic/repo-core/query-parser';
import { createError } from '../../utils/error.js';
import { warn } from '../../utils/logger.js';
import type { FieldType, QueryParserOptions } from './types.js';

/**
 * Options with defaults applied. Allowlists and feature flags stay optional
 * (undefined = unrestricted / disabled), everything else is concrete.
 */
type ResolvedParserOptions = Required<
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

/** Always-blocked MongoDB operators (extended via `additionalDangerousOperators`). */
export const BASE_DANGEROUS_OPERATORS = ['$where', '$function', '$accumulator', '$expr'] as const;

export interface ParserRuntime {
  readonly options: ResolvedParserOptions;
  /** Every URL operator this parser accepts: the shared grammar's plus mongokit's extensions. */
  readonly urlOperators: readonly string[];
  readonly dangerousOperators: readonly string[];
  /** Schema-aware coercion map — empty when neither `schema` nor `fieldTypes` was given. */
  readonly fieldTypes: Map<string, FieldType>;
  /** {@link fieldTypes} narrowed to the shared grammar's portable types. */
  readonly grammarFieldTypes: Readonly<Record<string, QueryFieldType>>;
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

/**
 * Run a grammar reader under the `invalidInput` policy: `'throw'` lets its 400 through untouched;
 * `'drop'` warns and returns `fallback`.
 */
export function guarded<T>(rt: ParserRuntime, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    if (!isQueryGrammarError(error) || rt.options.invalidInput !== 'drop') throw error;
    rt.reject(error.message);
    return fallback;
  }
}
