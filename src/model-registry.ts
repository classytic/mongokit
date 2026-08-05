/**
 * Model registration — the ONE place `mongoose.models` is touched.
 *
 * ## Why this exists
 *
 * Mongoose locks a schema on the first `model()` call and throws (`OverwriteModelError`)
 * on the second, so every caller that might register twice hand-rolls a guard:
 *
 * ```ts
 * const Counter = mongoose.models.LoyaltyCardCounter ?? mongoose.model('LoyaltyCardCounter', schema);
 * if (!mongoose.models.organization) mongoose.model('organization', new Schema({}, { strict: false }));
 * ```
 *
 * That idiom was written at least five times across the hosts and twice inside mongokit
 * itself. Worse, the hand-rolled form silently REUSES whatever is registered — so a second
 * call passing extra fields or indexes has them dropped with no error, which is how a
 * model ends up missing an index nobody can explain.
 *
 * ## The two policies, made explicit
 *
 * - `onExisting: 'reuse'` — idempotent registration. The caller adds nothing new, so an
 *   existing model is the right answer (stubs, counters, boot-time guards).
 * - `onExisting: 'throw'` — the caller is contributing schema (extra fields, indexes) that
 *   mongoose CANNOT apply to a locked schema. Silently reusing loses it; this fails loud.
 *
 * There is deliberately no default. Picking one for the caller is how the silent-drop bug
 * got in, and the two are not interchangeable.
 */
import mongoose, { type Connection, type Model, type Schema } from 'mongoose';

/**
 * A model name was already registered when a `throw` policy required it to be free.
 *
 * Typed (not a bare `Error`) so consumers — kernels wrapping their own domain collision error,
 * tests asserting the failure — can `instanceof`-check it instead of matching a message string.
 */
export class ModelCollisionError extends Error {
  readonly modelName: string;
  constructor(modelName: string, detail?: string) {
    super(
      `[mongokit] model '${modelName}' is already registered. Mongoose locks a schema on the ` +
        `first model() call, so anything this call adds (fields, indexes) would be SILENTLY ` +
        `DROPPED.${detail ? ` ${detail}` : ''}`,
    );
    this.name = 'ModelCollisionError';
    this.modelName = modelName;
  }
}

export interface DefineModelOptions {
  /** What to do when the name is already registered. Required — see the note above. */
  onExisting: 'reuse' | 'throw';
  /** Register on a specific connection instead of the default mongoose instance. */
  connection?: Connection;
  /** Extra context appended to the `throw` message (which call site, what would be lost). */
  throwHint?: string;
  /**
   * Explicit collection name — Mongoose's third `model()` argument. Omit for Mongoose's
   * default pluralization. Passed through only on a FRESH registration (a `reuse` hit
   * returns the existing model, whose collection is already fixed).
   */
  collection?: string;
}

/** Is this model name already registered? Prefer {@link defineModel} over asking. */
export function isModelRegistered(name: string, connection?: Connection): boolean {
  const registry = connection ? connection.models : mongoose.models;
  return Boolean(registry[name]);
}

/**
 * Register a model, or return the existing one, according to `onExisting`.
 *
 * `schema` is a FACTORY so it is never built when an existing model wins — building a
 * schema has side effects (plugin application, index declaration) that should not run for
 * a registration that is about to be discarded.
 */
export function defineModel<TDoc>(
  name: string,
  schema: () => Schema<TDoc>,
  options: DefineModelOptions,
): Model<TDoc> {
  const target = options.connection;
  const registry = (target ? target.models : mongoose.models) as Record<string, unknown>;
  const existing = registry[name] as Model<TDoc> | undefined;

  if (existing) {
    if (options.onExisting === 'throw') {
      throw new ModelCollisionError(name, options.throwHint);
    }
    return existing;
  }

  return target
    ? target.model<TDoc>(name, schema(), options.collection)
    : mongoose.model<TDoc>(name, schema(), options.collection);
}
