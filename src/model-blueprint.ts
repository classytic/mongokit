/**
 * Model BLUEPRINT — the batch, connection-free counterpart to {@link defineModel}.
 *
 * ## Why this exists
 *
 * A domain kernel's persistence shape (its set of models) can be DESCRIBED without a
 * connection, and BOUND to one later. Every kernel today fuses the two: `createXModels(connection)`
 * both decides the model set AND calls `connection.model(...)`, so merely *constructing* an
 * engine mutates a connection's registry. That is why composing a module graph — which happens
 * before the DB connection — leaks models, and why hosts wrap engines in thunks/slots to defer
 * construction to boot.
 *
 * `defineModels()` splits that seam:
 *
 *   - **describe** (this call): validate the spec, freeze the model NAMES. No connection, no
 *     schema built, no I/O. Safe at import / composition time.
 *   - **bind** (`blueprint.bind(connection)`): compile each schema factory ONCE against the
 *     supplied connection and register it, with an explicit existing-model policy per model.
 *
 * It is deliberately persistence-only: no services, events, providers, permissions or Arc
 * concepts (those belong to the kernel / Spine layers). It is built on {@link defineModel},
 * reusing its lazy-schema + collision semantics.
 */
import type { Connection, Model, Schema } from 'mongoose';
import { defineModel, isModelRegistered } from './model-registry.js';

/** A model captured before `replace` deleted it — enough to re-register it on rollback. */
interface ReplacedModel {
  readonly name: string;
  readonly schema: Schema<unknown>;
  readonly collection: string;
}

/**
 * What a bind does when a model name is ALREADY registered on the connection.
 *
 * There is no default — the kernel chooses per model, because the three are not
 * interchangeable and a silent choice is how schema/index contributions get dropped.
 */
export type ExistingModelPolicy =
  /**
   * The caller is contributing schema (fields, indexes) Mongoose cannot apply to a locked
   * schema — reusing would silently drop it, so fail loud. The production default.
   */
  | { readonly mode: 'throw'; readonly hint?: string }
  /** Idempotent registration — the caller adds nothing new, so an existing model is correct. */
  | { readonly mode: 'reuse' }
  /**
   * Clobber an existing model, then register fresh. An explicit test/development escape hatch
   * (hot-reload, fixtures) — replacing a live model in production is a footgun and THROWS.
   * `environment` documents intent; a bind still refuses when `NODE_ENV === 'production'`.
   */
  | { readonly mode: 'replace'; readonly environment: 'test' | 'development' };

export interface ModelSpec<TDocument = unknown> {
  readonly name: string;
  /** Explicit collection name. Omit for Mongoose's default pluralization. */
  readonly collection?: string;
  /** Schema FACTORY — built at most once, only when this model is actually registered. */
  readonly schema: () => Schema<TDocument>;
  /** What to do if `name` is already registered on the bind connection. */
  readonly existing: ExistingModelPolicy;
}

export interface ModelBlueprint<TModels> {
  /** Every model name this blueprint will register — known WITHOUT a connection. */
  readonly modelNames: readonly string[];
  /**
   * Compile + register every model on `connection`, then assemble the typed model bag.
   *
   * Registration is connection-local (uses `connection.models`, never the global registry).
   * On a partial failure, models THIS bind created are removed from the connection's registry
   * (a registry rollback — it never touches database collections) and the original error is
   * re-thrown with the names that had already bound.
   */
  bind(connection: Connection): TModels;
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Describe a set of models as a connection-free blueprint. Duplicate spec names are rejected
 * here, at describe time, before any connection is involved.
 */
export function defineModels<TModels>(spec: {
  // A model set is heterogeneous — each spec has its OWN document type — so the array is
  // erased to `ModelSpec<any>` at this boundary; per-model types are restored by `assemble`.
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous per-spec doc types; assemble() re-types.
  readonly models: readonly ModelSpec<any>[];
  /** Turn the bound `name -> Model` map into the kernel's typed model bag. */
  readonly assemble: (models: ReadonlyMap<string, Model<unknown>>) => TModels;
}): ModelBlueprint<TModels> {
  const { models, assemble } = spec;

  // Describe-time validation: duplicate names, no connection required.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.name)) {
      throw new Error(
        `[mongokit] defineModels: duplicate model spec name '${m.name}'. Each model must be ` +
          'described exactly once.',
      );
    }
    seen.add(m.name);
    names.push(m.name);
  }
  const modelNames = Object.freeze([...names]);

  return {
    modelNames,
    bind(connection: Connection): TModels {
      const map = new Map<string, Model<unknown>>();
      // FRESH registrations (name did not pre-exist) — removed on rollback.
      const created: string[] = [];
      // Pre-existing models this bind REPLACED — captured so rollback can RESTORE them.
      // Without this, a `replace` that deletes the original then a later failure would leave the
      // connection missing a model that existed before the bind (the reviewer's finding #2).
      const replaced: ReplacedModel[] = [];

      try {
        for (const s of models) {
          const preExisting = isModelRegistered(s.name, connection);

          if (s.existing.mode === 'replace') {
            if (isProductionRuntime()) {
              throw new Error(
                `[mongokit] model '${s.name}' declares existing policy 'replace', which is ` +
                  'forbidden when NODE_ENV=production. Use a separate connection for a second ' +
                  'engine; do not clobber a live production model.',
              );
            }
            if (preExisting) {
              const original = connection.models[s.name] as Model<unknown>;
              // Capture BEFORE delete so rollback can put the original back exactly.
              replaced.push({
                name: s.name,
                schema: original.schema as unknown as Schema<unknown>,
                collection: original.collection.name,
              });
              connection.deleteModel(s.name);
            }
          }

          const onExisting = s.existing.mode === 'reuse' ? 'reuse' : ('throw' as const);
          const throwHint =
            s.existing.mode === 'throw' && s.existing.hint
              ? s.existing.hint
              : `Registering model set [${modelNames.join(', ')}]; already bound this call: ` +
                `[${created.join(', ') || 'none'}]${s.collection ? ` (collection '${s.collection}')` : ''}.`;

          const model = defineModel<unknown>(s.name, s.schema, {
            onExisting,
            connection,
            throwHint,
            ...(s.collection !== undefined ? { collection: s.collection } : {}),
          });

          // A replacement pre-existed, so it is NOT "created" — it is tracked in `replaced`,
          // whose rollback both removes the replacement AND restores the original.
          if (!preExisting) created.push(s.name);
          map.set(s.name, model);
        }

        return assemble(map);
      } catch (err) {
        // Registry-only rollback: restore the connection to its pre-bind model set. Never
        // touches database collections. Rollback FAILURES are collected, not swallowed —
        // a failed restore leaves the registry damaged, and reporting only the original error
        // would falsely imply the registry was restored.
        const rollbackErrors: unknown[] = [];
        for (const name of created) {
          try {
            connection.deleteModel(name);
          } catch (e) {
            rollbackErrors.push(e);
          }
        }
        for (const r of replaced) {
          try {
            if (connection.models[r.name]) connection.deleteModel(r.name); // drop our replacement
            connection.model(r.name, r.schema, r.collection); // put the original back
          } catch (e) {
            rollbackErrors.push(e);
          }
        }
        // Clean rollback → rethrow the ORIGINAL error unchanged (preserves its type, e.g.
        // ModelCollisionError, for `instanceof` checks). Rollback also failed → surface BOTH
        // via AggregateError so the caller knows the registry may be inconsistent.
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [err, ...rollbackErrors],
            `[mongokit] defineModels.bind failed AND ${rollbackErrors.length} rollback ` +
              'operation(s) failed — the connection model registry may be inconsistent.',
          );
        }
        throw err;
      }
    },
  };
}
