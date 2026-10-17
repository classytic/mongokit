/**
 * How a write changes the search fields: the pure analysis behind the
 * search-keys plugin. Given one write (a document, a replacement, or an update
 * with its filter), it says which search-field values the write determines and
 * which it leaves to the stored document, so the plugin can derive the keys in
 * the SAME write (no second round-trip, no window where keys are stale).
 */

import { collectSearchTokens, valuesAtPath } from './prefix.js';

/** Thrown (as `status: 400` with a `code`) for a write the keys cannot follow. */
export const SEARCH_KEYS_ERROR_CODES = {
  /** An operator or path the plugin cannot evaluate touches a search field. */
  UNSUPPORTED_UPDATE: 'SEARCH_KEYS_UNSUPPORTED_UPDATE',
  /** A multi-document update sets SOME search fields; the rest differ per document. */
  PARTIAL_MULTI_UPDATE: 'SEARCH_KEYS_PARTIAL_MULTI_UPDATE',
} as const;

export class SearchKeysWriteError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    readonly code: (typeof SEARCH_KEYS_ERROR_CODES)[keyof typeof SEARCH_KEYS_ERROR_CODES],
  ) {
    super(message);
    this.name = 'SearchKeysWriteError';
  }
}

/** Source values for the keys: `field → value` (an absent field contributes no tokens). */
export type FieldValues = Record<string, unknown>;

/** What one update does to the search fields. */
export interface UpdateEffect {
  /** Fields the update path sets or unsets, with their new value (undefined = unset). */
  updated: FieldValues;
  /** Fields only `$setOnInsert` provides (insert path only). */
  onInsert: FieldValues;
  /** Fields pinned by an equality in the filter: the matched document's current value. */
  pinned: FieldValues;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Operators whose effect on a search field the plugin evaluates. */
const EVALUATED = new Set(['$set', '$setOnInsert', '$unset']);

/**
 * Resolve each search field against one `path → value` bag (`$set`, a plain
 * patch): an exact key, or an ANCESTOR key (`profile` for `profile.name`). A
 * DESCENDANT key (`tags.0` for `tags`) changes part of the value the plugin
 * cannot see, so it is refused.
 */
function resolveBag(
  bag: Record<string, unknown>,
  fields: readonly string[],
  op: string,
  out: FieldValues,
  unset = false,
): void {
  for (const key of Object.keys(bag)) {
    for (const field of fields) {
      if (key === field) {
        out[field] = unset ? undefined : bag[key];
      } else if (field.startsWith(`${key}.`)) {
        out[field] = unset ? undefined : valuesAtPath(bag[key], field.slice(key.length + 1));
      } else if (key.startsWith(`${field}.`)) {
        throw new SearchKeysWriteError(
          `[mongokit] search keys: '${op}' on '${key}' changes part of search field '${field}'; ` +
            `set the whole field ('${field}') so its search keys can be derived`,
          SEARCH_KEYS_ERROR_CODES.UNSUPPORTED_UPDATE,
        );
      }
    }
  }
}

const touches = (key: string, fields: readonly string[]): boolean =>
  fields.some((f) => key === f || f.startsWith(`${key}.`) || key.startsWith(`${f}.`));

/** Equalities in a filter's top level (and top-level `$and` arms) on search fields. */
function pinnedValues(filter: unknown, fields: readonly string[], out: FieldValues): void {
  if (!isPlainObject(filter)) return;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const arm of value) pinnedValues(arm, fields, out);
      continue;
    }
    if (!fields.includes(key)) continue;
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
    else if (isPlainObject(value) && Object.keys(value).length === 1 && '$eq' in value) {
      const eq = value.$eq;
      if (typeof eq === 'string' || typeof eq === 'number') out[key] = eq;
    }
  }
}

/**
 * Analyse an update (plain patch, operator update, or pipeline) against the
 * search fields. Strips any caller-supplied value for `keysField` (the keys
 * are derived, never client-settable). Throws {@link SearchKeysWriteError} for
 * an operator other than `$set`/`$setOnInsert`/`$unset` (or a pipeline stage)
 * that touches a search field.
 */
export function analyzeUpdate(
  update: unknown,
  filter: unknown,
  fields: readonly string[],
  keysField: string,
): UpdateEffect {
  const effect: UpdateEffect = { updated: {}, onInsert: {}, pinned: {} };
  pinnedValues(filter, fields, effect.pinned);

  if (Array.isArray(update)) {
    for (const stage of update) {
      if (!isPlainObject(stage)) continue;
      for (const [name, body] of Object.entries(stage)) {
        const keys =
          name === '$unset'
            ? ([] as unknown[]).concat(body).map(String)
            : isPlainObject(body)
              ? Object.keys(body)
              : [];
        const whole = name === '$replaceRoot' || name === '$replaceWith' || name === '$project';
        if (whole || keys.some((k) => touches(k, fields))) {
          throw new SearchKeysWriteError(
            `[mongokit] search keys: pipeline stage '${name}' touches a search field (${fields.join(', ')}); ` +
              'use an operator update ($set / $unset) so the keys can be derived',
            SEARCH_KEYS_ERROR_CODES.UNSUPPORTED_UPDATE,
          );
        }
      }
    }
    return effect;
  }
  if (!isPlainObject(update)) return effect;

  const keys = Object.keys(update);
  const operator = keys.some((k) => k.startsWith('$'));
  if (!operator) {
    delete update[keysField];
    resolveBag(update, fields, '$set', effect.updated);
    return effect;
  }
  for (const op of keys) {
    const body = update[op];
    if (!isPlainObject(body)) continue;
    if (op === '$set' || op === '$setOnInsert') delete body[keysField];
    if (op === '$unset') delete body[keysField];
    if (!EVALUATED.has(op)) {
      const hit = Object.keys(body).find((k) => touches(k, fields));
      if (hit) {
        throw new SearchKeysWriteError(
          `[mongokit] search keys: '${op}' on '${hit}' cannot be followed by the search keys; ` +
            `set the whole value with $set (or call rebuildSearchKeys afterwards)`,
          SEARCH_KEYS_ERROR_CODES.UNSUPPORTED_UPDATE,
        );
      }
      continue;
    }
    if (op === '$set') resolveBag(body, fields, op, effect.updated);
    else if (op === '$unset') resolveBag(body, fields, op, effect.updated, true);
    else resolveBag(body, fields, op, effect.onInsert);
  }
  return effect;
}

/** Fields the effect leaves unknown for the update path (neither updated nor pinned). */
export function unresolvedForUpdate(effect: UpdateEffect, fields: readonly string[]): string[] {
  return fields.filter((f) => !(f in effect.updated) && !(f in effect.pinned));
}

/** The full value set an INSERT through this update would store. */
export function insertValues(effect: UpdateEffect): FieldValues {
  return { ...effect.pinned, ...effect.onInsert, ...effect.updated };
}

/**
 * Put `keys` into an update in place: a plain patch gets the key directly
 * (mongoose wraps it in `$set`), an operator update under `$set` (or
 * `$setOnInsert` for an insert-only derivation).
 */
export function writeKeys(
  update: Record<string, unknown>,
  keysField: string,
  keys: string[],
  slot: '$set' | '$setOnInsert' = '$set',
): void {
  const operator = Object.keys(update).some((k) => k.startsWith('$'));
  if (!operator) {
    // A plain patch is all-`$set`: it never needs the insert-only slot.
    update[keysField] = keys;
    return;
  }
  const bag = isPlainObject(update[slot]) ? (update[slot] as Record<string, unknown>) : {};
  bag[keysField] = keys;
  update[slot] = bag;
}

/** The values of `fields` read from a stored (or to-be-inserted) document. */
export function fieldValuesOf(doc: unknown, fields: readonly string[]): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) out[f] = valuesAtPath(doc, f);
  return out;
}

/** The keys for a resolved value set (see {@link collectSearchTokens}), in `fields` order. */
export function keysFromValues(values: FieldValues, fields: readonly string[]): string[] {
  return collectSearchTokens(fields.map((f) => values[f]));
}
