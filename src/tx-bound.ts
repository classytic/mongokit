/**
 * Tx-bound repository — session-threaded proxy.
 *
 * When a caller runs `repo.withTransaction(async (txRepo) => ...)`, mongokit
 * needs the `txRepo` to behave like the outer repo but automatically thread
 * the mongoose `ClientSession` into every IO call. This module builds that
 * proxy.
 *
 * ## Why a Proxy and not a subclass
 *
 * Mongokit's plugin system installs methods onto repo *instances*
 * (`repo['increment'] = ...`, `repo['upsert'] = ...`). A subclass wouldn't
 * inherit those because they live on the instance, not the prototype. A
 * Proxy over the outer repo catches every property lookup so plugin-added
 * methods are transparently reachable on the tx-bound repo too.
 *
 * ## How session threading works
 *
 * Every mongokit CRUD method has a documented "options position" — the
 * positional index of the `{ session?, ... }` bag. `delete(id, options)`
 * has options at index 1; `update(id, data, options)` has it at index 2.
 * When the proxy intercepts a call to one of these methods, it:
 *
 *   1. Pads missing intermediate args with `undefined`.
 *   2. If the slot at `optionsIndex` is an options object, merges `{ session }` in.
 *   3. If the slot is undefined, sets it to `{ session }`.
 *   4. Calls through to the outer method with the augmented args.
 *
 * Methods NOT in the known-set pass through unchanged. Callers who need
 * session threading on a custom plugin method can reach for the standalone
 * `withTransaction(connection, ...)` helper from `@classytic/mongokit`,
 * which always gives them raw session access.
 *
 * ## Nested withTransaction
 *
 * Calling `txRepo.withTransaction(...)` throws. Nested transactions in
 * MongoDB are a footgun (the inner callback runs under the outer session,
 * which is rarely what the caller actually wants). Reuse the outer
 * `txRepo`, or collapse the nesting.
 */

import type { ClientSession, Model } from 'mongoose';

/**
 * Map of session-aware method name → positional index of the `{ session }`
 * options bag. Keep this list in sync with the method signatures in
 * `Repository.ts` and the plugin method definitions. Unknown plugin
 * methods pass through unwrapped (callers use the standalone helper).
 */
const SESSION_OPTIONS_INDEX: Readonly<Record<string, number>> = Object.freeze({
  // ── MinimalRepo ─────────────────────────────────────────────────────
  create: 1, // (data, options?)
  update: 2, // (id, data, options?)
  delete: 1, // (id, options?)
  getById: 1, // (id, options?)
  getAll: 1, // (params?, options?)

  // ── StandardRepo ────────────────────────────────────────────────────
  createMany: 1, // (dataArray, options?)
  findAll: 1, // (filters?, options?)
  getOrCreate: 2, // (query, createData, options?)
  count: 1, // (query?, options?)
  exists: 1, // (query, options?)
  getByQuery: 1, // (query, options?)
  getOne: 1, // (query, options?)
  findOneAndUpdate: 2, // (filter, update, options?)
  distinct: 2, // (field, query?, options?)

  // ── Mongokit-specific CRUD ──────────────────────────────────────────
  aggregate: 1, // (pipeline, options?)
  aggregatePaginate: 0, // (options?)
  lookupPopulate: 0, // (options)

  // ── mongoOperationsPlugin ───────────────────────────────────────────
  upsert: 2, // (query, data, options?)
  increment: 3, // (id, field, value?, options?)
  decrement: 3,
  multiplyField: 3,
  setMin: 3,
  setMax: 3,
  pushToArray: 3, // (id, field, value, options?)
  pullFromArray: 3,
  addToSet: 3,
  setField: 3, // (id, field, value, options?)
  unsetField: 2, // (id, fields, options?)
  renameField: 3, // (id, oldName, newName, options?)
  atomicUpdate: 2, // (id, operators, options?)

  // ── Repository batch primitives + bulkWrite (plugin) ────────────────
  updateMany: 2, // (query, data, options?)
  deleteMany: 1, // (query, options?)
  bulkWrite: 1, // (operations, options?) — plugin-only; see batchOperationsPlugin

  // ── soft-delete plugin ──────────────────────────────────────────────
  restore: 1, // (id, options?)
  getDeleted: 1, // (params?, options?)

  // ── subdocument plugin ──────────────────────────────────────────────
  addSubdocument: 3, // (parentId, arrayPath, subData, options?)
  getSubdocument: 3, // (parentId, arrayPath, subId, options?)
  updateSubdocument: 4, // (parentId, arrayPath, subId, updateData, options?)
  deleteSubdocument: 3, // (parentId, arrayPath, subId, options?)

  // ── aggregate-helpers plugin ────────────────────────────────────────
  groupBy: 1, // (field, options?)
  sum: 2, // (field, query?, options?)
  average: 2,
  min: 2,
  max: 2,
});

/**
 * Build a session-threaded proxy over `outer`. The returned object has the
 * same method signatures, but every CRUD call auto-injects the supplied
 * session into the options bag. Non-CRUD properties (Model, modelName,
 * hook API, utility helpers) pass through.
 */
export function createTxBoundRepo<R extends object>(outer: R, session: ClientSession): R {
  return new Proxy(outer, {
    get(target, prop, receiver) {
      // Guard against nested transactions — hard error, not a silent no-op.
      if (prop === 'withTransaction') {
        return () => {
          throw new Error(
            '[mongokit] Nested withTransaction is not supported on a tx-bound repository. ' +
              'Reuse the outer `txRepo` directly, or collapse the nesting.',
          );
        };
      }

      const value = Reflect.get(target, prop, receiver);
      // Non-function values (Model, modelName, hooks, idField, ...) — return as-is.
      if (typeof value !== 'function') return value;

      // Symbols, private (underscore-prefixed), and un-listed methods — pass
      // through bound to the outer repo. `prop.startsWith('_')` covers
      // `_buildContext`, `_emitHook`, `_handleError`, etc. that shouldn't
      // have session auto-injected.
      if (typeof prop === 'symbol') return value.bind(target);
      if (prop.startsWith('_')) return value.bind(target);

      const optionsIndex = SESSION_OPTIONS_INDEX[prop];
      if (optionsIndex === undefined) {
        // Unknown or non-session-aware public method (on/off/emit/use/
        // buildAggregation/isDuplicateKeyError/...). Bind to outer so
        // listener registration, emit targets, etc. remain attached to the
        // original hook engine — never to the proxy.
        return value.bind(target);
      }

      // Known session-aware method — auto-inject session into the options slot.
      return function txBoundMethod(this: unknown, ...args: unknown[]): unknown {
        // Pad missing intermediate args so `args[optionsIndex]` is addressable.
        while (args.length <= optionsIndex) args.push(undefined);
        const current = args[optionsIndex];
        if (current === undefined) {
          args[optionsIndex] = { session };
        } else if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
          args[optionsIndex] = { ...(current as object), session };
        } else {
          // The slot is a non-object at a position we expect to be options —
          // likely the caller made a mistake. Pass through untouched and
          // let the underlying method surface its own type error, rather
          // than masking it by silently mutating the caller's value.
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Type-only witness: ensures `Model` stays structural across the proxy. */
// biome-ignore lint/correctness/noUnusedVariables: compile-time witness
type _ProxyPreservesModel<M> = M extends Model<infer _> ? M : never;
