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
 * Every public method is CLASSIFIED — session-aware IO (`SESSION_OPTIONS_INDEX`), non-IO or
 * deliberately non-transactional (`PASS_THROUGH`), or impossible inside a transaction
 * (`REFUSED_IN_TX`). An unclassified method THROWS when called: passing it through would run its
 * write outside the transaction, so part of the unit of work would commit on its own.
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
  getByIds: 1, // (ids, options?)

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
  aggregatePipeline: 1, // (pipeline, options?)
  aggregatePipelinePaginate: 0, // (options?)
  lookupPopulate: 0, // (options)
  cursor: 1, // (filter?, options?)
  iterate: 1, // (filter?, options?): keyset batches, each a find on the session
  bulkUpsert: 1, // (rows, options)
  keysetCursor: 1, // (row, options): policy hooks only, no IO

  // ── State machines / CAS verbs ──────────────────────────────────────
  claim: 3, // (id, transition, patch?, options?)
  claimVersion: 3, // (id, transition, update, options?)
  applyTransition: 3, // (id, machine, args, options?)

  // ── Retention / tenant purge ────────────────────────────────────────
  archiveByFilter: 2, // (filter, sink, options?)
  purgeByField: 3, // (field, value, strategy, options?)
  purgeByFilter: 2, // (filter, strategy, options?)

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
 * Public methods that pass through bound to the outer repo, WITHOUT the session — each for a stated
 * reason. Anything neither here nor in `SESSION_OPTIONS_INDEX` throws when called.
 */
const PASS_THROUGH: ReadonlySet<string> = new Set([
  // No database IO: hook engine, builders, classifiers, cache bookkeeping, method registry.
  'on',
  'off',
  'emit',
  'emitAsync',
  'removeAllListeners',
  'use',
  'useMiddleware',
  'buildAggregation',
  'buildLookup',
  'isDuplicateKeyError',
  'isTransientConflictError',
  'invalidateAggregateCache',
  'registerMethod',
  'hasMethod',
  'getRegisteredMethods',
  // External services, not this database.
  'embed',
  'search',
  // Deliberately OUTSIDE any transaction: a lease or an idempotency claim must survive the
  // unit of work rolling back, and Atlas `$vectorSearch` cannot run in one.
  'lease',
  'extend',
  'release',
  'claimKey',
  'completeClaim',
  'expireClaim',
  'failClaim',
  'releaseClaim',
  'saveClaimProgress',
  'searchSimilar',
]);

/** Methods MongoDB cannot run inside a transaction. */
const REFUSED_IN_TX: Readonly<Record<string, string>> = Object.freeze({
  watch: 'a change stream cannot be opened inside a transaction',
});

/** Whether a method name is classified for tx-bound use (session-aware, pass-through or refused). */
export function isTxClassified(name: string): boolean {
  // withTransaction has its own branch in the proxy: a nested call throws.
  return (
    name === 'withTransaction' ||
    name in SESSION_OPTIONS_INDEX ||
    PASS_THROUGH.has(name) ||
    name in REFUSED_IN_TX
  );
}

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
      // Non-function values (modelName, idField, hooks state, ...) — return as-is.
      if (typeof value !== 'function') return value;

      // The mongoose `Model` is a function (constructor) but NOT a method —
      // it carries static properties (`modelName`, `schema`, `collection`,
      // etc.) that `Function.prototype.bind` does NOT preserve on the
      // bound wrapper. Return the underlying constructor as-is so callers
      // can still introspect schema or use the raw mongoose API inside a
      // bound repo if they need to.
      if (prop === 'Model') return value;

      // Symbols, private (underscore-prefixed), and un-listed methods — pass
      // through bound to the outer repo. `prop.startsWith('_')` covers
      // `_buildContext`, `_emitHook`, `_handleError`, etc. that shouldn't
      // have session auto-injected.
      if (typeof prop === 'symbol') return value.bind(target);
      if (prop.startsWith('_')) return value.bind(target);

      const optionsIndex = SESSION_OPTIONS_INDEX[prop];
      if (optionsIndex === undefined) {
        // Bound to outer so listener registration and emit targets stay on the real hook engine.
        if (PASS_THROUGH.has(prop)) return value.bind(target);
        const refused = REFUSED_IN_TX[prop];
        // Thrown on CALL, not on property read: `typeof txRepo.x` and destructuring stay safe.
        return () => {
          throw new Error(
            refused
              ? `[mongokit] ${prop}() cannot run on a tx-bound repository: ${refused}.`
              : `[mongokit] ${prop}() is not classified for transactions, so on a tx-bound repository it ` +
                  'would run OUTSIDE the transaction. Call it on the outer repository with the session the ' +
                  `callback receives — \`repo.${prop}(..., { session: uow.session })\` — or add it to tx-bound's ` +
                  'SESSION_OPTIONS_INDEX / PASS_THROUGH.',
          );
        };
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
          // Not an options bag where one belongs: running it would drop the session silently.
          throw new TypeError(
            `[mongokit] ${prop}(): argument ${optionsIndex} must be an options object on a tx-bound ` +
              `repository (got ${Array.isArray(current) ? 'an array' : typeof current}) — the session could not be threaded.`,
          );
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Type-only witness: ensures `Model` stays structural across the proxy. */
// biome-ignore lint/correctness/noUnusedVariables: compile-time witness
type _ProxyPreservesModel<M> = M extends Model<infer _> ? M : never;
