/**
 * Mongoose Adapter — produces a framework-agnostic `DataAdapter<TDoc>`.
 *
 * Bridges a Mongoose `Model<TDoc>` + a repository implementing
 * `MinimalRepo<TDoc>` into the cross-framework `DataAdapter` contract from
 * `@classytic/repo-core/adapter`. Any HTTP framework that consumes that
 * contract (arc, custom hosts, future arc-next) can wire the result
 * straight into its resource layer.
 *
 * No framework peer-dep — this module imports only from
 * `@classytic/repo-core` and `mongoose`.
 */

import type {
  AdapterRepositoryInput,
  AdapterSchemaContext,
  AdapterValidationResult,
  DataAdapter,
  OpenApiSchemas,
  RepositoryLike,
  SchemaMetadata,
} from '@classytic/repo-core/adapter';
import { asRepositoryLike, isRepository } from '@classytic/repo-core/adapter';
import type { SchemaBuilderOptions, SchemaGenerator } from '@classytic/repo-core/schema';
import { mergeFieldRuleConstraints } from '@classytic/repo-core/schema';
import type { Model } from 'mongoose';
import { warn } from '../utils/logger.js';
import { buildCrudSchemasFromModel } from '../utils/mongooseToJsonSchema.js';
import { isMongooseModel, type MongooseSchemaType } from './types.js';

const REQUIRED_REPO_METHODS = ['getAll', 'getById', 'create', 'update', 'delete'] as const;

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return t;
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
  return ctor && ctor !== 'Object' ? `${t} (${ctor})` : t;
}

function formatInvalidModelError(model: unknown): string {
  const got = describeValue(model);
  const looksLikeSchema =
    typeof model === 'object' && model !== null && 'paths' in (model as object);
  const hint = looksLikeSchema
    ? "Got a Schema — pass the value returned by mongoose.model('Name', schema), not the schema itself."
    : "Pass the value returned by mongoose.model('Name', schema).";

  return [
    'MongooseAdapter: invalid `model` — expected a Mongoose Model.',
    `Got: ${got}`,
    hint,
    '',
    'Example:',
    "  import { Repository, createMongooseAdapter } from '@classytic/mongokit';",
    "  const ProductModel = mongoose.model('Product', schema);",
    '  const adapter = createMongooseAdapter({',
    '    model: ProductModel,',
    '    repository: new Repository(ProductModel),',
    '  });',
  ].join('\n');
}

function formatInvalidRepositoryError(repository: unknown, model: unknown): string {
  const passedTheModel =
    repository != null && typeof repository === 'object' && repository === model;
  const looksLikeMongooseModel = isMongooseModel(repository);

  const missing =
    repository && typeof repository === 'object'
      ? REQUIRED_REPO_METHODS.filter(
          (m) => typeof (repository as Record<string, unknown>)[m] !== 'function',
        )
      : [...REQUIRED_REPO_METHODS];

  const cause = passedTheModel
    ? 'Got the same Mongoose Model that was passed as `model` — a Model is not a Repository.'
    : looksLikeMongooseModel
      ? 'Got a Mongoose Model — wrap it in a Repository first.'
      : `Got: ${describeValue(repository)}` +
        (missing.length && missing.length < REQUIRED_REPO_METHODS.length
          ? ` (missing method${missing.length === 1 ? '' : 's'}: ${missing.join(', ')})`
          : '');

  return [
    'MongooseAdapter: invalid `repository` — expected a Repository instance',
    `(or any object implementing ${REQUIRED_REPO_METHODS.join(', ')}).`,
    cause,
    '',
    'Fix: pass `new Repository(model)` from @classytic/mongokit.',
    '',
    'Example:',
    "  import { Repository, createMongooseAdapter } from '@classytic/mongokit';",
    '  const adapter = createMongooseAdapter({',
    '    model: ProductModel,',
    '    repository: new Repository(ProductModel),',
    '  });',
  ].join('\n');
}

/**
 * Options for creating a Mongoose adapter.
 *
 * `TDoc` is auto-inferred from the Mongoose model — no explicit type
 * needed in most call sites.
 */
export interface MongooseAdapterOptions<TDoc = unknown> {
  /** Mongoose model instance — preserves document type for type safety. */
  model: Model<TDoc>;
  /**
   * Repository implementing CRUD operations.
   *
   * Typed as `AdapterRepositoryInput<TDoc>` (permissive structural shape)
   * so kit-native repository classes plug in directly. See
   * `AdapterRepositoryInput` JSDoc in `@classytic/repo-core/adapter` for
   * why the wider input exists at the boundary.
   */
  repository: AdapterRepositoryInput<TDoc>;
  /**
   * Schema generator for OpenAPI / introspection docs.
   *
   * **Defaults to mongokit's own `buildCrudSchemasFromModel`** (3.21) — the
   * canonical Mongoose→JSON-Schema generator ships in this package, so
   * omitting the option now means "use it" rather than "no schemas". An
   * audit of a 68-resource production host found 28 adapters that omitted
   * it by accident and silently shipped `null` OpenAPI bodies + empty MCP
   * tool schemas — correct-by-default closes that failure class.
   *
   * Pass `false` to opt OUT of schema generation entirely (`generateSchemas`
   * returns `null`, hosts fall back to permissive bodies). Pass your own
   * `SchemaGenerator` to replace the default.
   *
   * **Model type is intentionally `Model<unknown>`, not `Model<TDoc>`**:
   * schema generators introspect `.schema.paths` — they read metadata,
   * not document types. Typing as `Model<TDoc>` would force every host
   * to cast `m as unknown as Model<unknown>` when handing the model to
   * `buildCrudSchemasFromModel`, because `Model<T>` is invariant in T.
   * Widening here at the callback boundary trades one documented internal
   * cast for zero host-side casts.
   *
   * @example
   * ```ts
   * // Default — full OpenAPI/MCP schemas, zero config:
   * createMongooseAdapter({ model: ProductModel, repository: productRepository });
   *
   * // Explicit opt-out (permissive bodies, no generated schemas):
   * createMongooseAdapter({ model, repository, schemaGenerator: false });
   * ```
   */
  schemaGenerator?: SchemaGenerator<Model<unknown>> | false;
}

/**
 * Mongoose data adapter — implements the `DataAdapter<TDoc>` contract from
 * `@classytic/repo-core/adapter`.
 */
export class MongooseAdapter<TDoc = unknown> implements DataAdapter<TDoc> {
  readonly type = 'mongoose' as const;
  readonly name: string;
  readonly model: Model<TDoc>;
  readonly repository: RepositoryLike<TDoc>;
  // Stored as the canonical `SchemaGenerator<Model<unknown>>` from
  // `@classytic/repo-core/schema` so `buildCrudSchemasFromModel` plugs in
  // directly without glue. The internal call site in `generateSchemas`
  // widens `this.model` to `Model<unknown>` once when invoking — the one
  // documented cast that lets every host stop eating one each.
  private readonly schemaGenerator?: SchemaGenerator<Model<unknown>>;

  constructor(options: MongooseAdapterOptions<TDoc>) {
    if (!isMongooseModel(options.model)) {
      throw new TypeError(formatInvalidModelError(options.model));
    }

    if (!isRepository(options.repository)) {
      throw new TypeError(formatInvalidRepositoryError(options.repository, options.model));
    }

    this.model = options.model;
    // Single documented widening from the permissive boundary input to
    // the strict internal view — see `AdapterRepositoryInput` JSDoc.
    this.repository = asRepositoryLike<TDoc>(options.repository);
    // Correct-by-default: omitted → mongokit's own generator; `false` →
    // explicit opt-out (generateSchemas returns null).
    this.schemaGenerator =
      options.schemaGenerator === false
        ? undefined
        : (options.schemaGenerator ?? buildCrudSchemasFromModel);
    this.name = `MongooseAdapter<${options.model.modelName}>`;
  }

  /**
   * Lightweight path-existence check for hosts that infer absent fields
   * (e.g. arc's `defineResource()` infers `tenantField: false` when the
   * configured tenant field doesn't exist on the model). Reads
   * `model.schema.paths[name]` directly — no allocation, no metadata walk.
   */
  hasFieldPath(name: string): boolean {
    return Boolean(this.model.schema?.paths?.[name]);
  }

  /**
   * Get schema metadata from a Mongoose model.
   */
  getSchemaMetadata(): SchemaMetadata {
    const schema = this.model.schema;
    const paths = schema.paths;
    const fields: SchemaMetadata['fields'] = {};

    for (const [fieldName, schemaType] of Object.entries(paths)) {
      if (fieldName.startsWith('_') && fieldName !== '_id') continue;

      const typeInfo = schemaType as MongooseSchemaType;
      const mongooseType = typeInfo.instance || 'Mixed';

      const typeMap: Record<
        string,
        'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'objectId' | 'enum'
      > = {
        String: 'string',
        Number: 'number',
        Boolean: 'boolean',
        Date: 'date',
        ObjectID: 'objectId',
        ObjectId: 'objectId',
        Array: 'array',
        Mixed: 'object',
        Buffer: 'object',
        Embedded: 'object',
      };

      fields[fieldName] = {
        type: typeMap[mongooseType] ?? 'object',
        required: !!typeInfo.isRequired,
        ref: typeInfo.options?.ref,
      };
    }

    return {
      name: this.model.modelName,
      fields,
      relations: this.extractRelations(paths),
    };
  }

  /**
   * Generate OpenAPI-shaped schemas from the model.
   *
   * Delegates to the `schemaGenerator` callback supplied at construction.
   * Returns `null` when no callback is configured — hosts treat that as
   * "no schemas available" and skip OpenAPI generation for the resource.
   *
   * Most call sites pass mongokit's own `buildCrudSchemasFromModel`:
   *
   * ```ts
   * createMongooseAdapter({
   *   model,
   *   repository,
   *   schemaGenerator: buildCrudSchemasFromModel,
   * });
   * ```
   */
  generateSchemas(
    schemaOptions?: SchemaBuilderOptions,
    context?: AdapterSchemaContext,
  ): OpenApiSchemas | Record<string, unknown> | null {
    if (!this.schemaGenerator) return null;
    try {
      // `Model<T>` is invariant in T — we widen via `unknown` at this
      // single call boundary so hosts pass `buildCrudSchemasFromModel`
      // without a cast. See `MongooseAdapterOptions.schemaGenerator`.
      const generated = this.schemaGenerator(
        this.model as unknown as Model<unknown>,
        schemaOptions,
        context,
      ) as unknown as OpenApiSchemas | Record<string, unknown>;
      // Layer portable `fieldRules` constraints onto the kit-emitted
      // property schemas (nullable, enum-with-null, minLength, ...).
      mergeFieldRuleConstraints(generated, schemaOptions);
      return generated;
    } catch (err) {
      // Schema generation is best-effort — never bubble up to the host's
      // request path — but a silent failure leaves consumers staring at
      // a missing resource in OpenAPI with no diagnostic. Emit a `warn`
      // through the configurable logger so misconfigured generators
      // surface during dev / boot, while production hosts can still
      // route the message into their own logging stack via
      // `configureLogger({ warn: ... })`.
      const message = err instanceof Error ? err.message : String(err);
      warn(
        `[MongooseAdapter:${this.model.modelName}] schemaGenerator threw — schema generation skipped: ${message}`,
      );
      return null;
    }
  }

  /**
   * Default `validate` — kits typically override or hosts skip this since
   * Mongoose enforces validation at save time. Provided for adapter-
   * contract completeness so consumers that branch on `adapter.validate`
   * find a no-op success path.
   */
  validate(_data: unknown): AdapterValidationResult {
    return { valid: true };
  }

  /**
   * No-op — mongokit's per-call resources (`watch()` change streams,
   * `cursor()` iterators) are released by their own `AbortSignal` /
   * end-of-iteration, so the adapter holds nothing long-lived. Provided
   * so hosts can call `adapter.close()` uniformly across every kit. Per
   * the `DataAdapter.close` ownership rule the host owns the mongoose
   * connection (`mongoose.connect(...)`) and closes it itself.
   */
  async close(): Promise<void> {
    // Nothing kit-owned to release.
  }

  /**
   * Extract relation metadata from Mongoose ref paths.
   *
   * Cardinality rules:
   *   - `field: { type: ObjectId, ref }`  → one-to-one (single ref)
   *   - `field: [{ type: ObjectId, ref }]` → one-to-many (array of refs)
   *
   * Mongoose surfaces array paths with `instance === 'Array'` and a
   * `caster` SchemaType holding the element-side metadata (including the
   * `ref` and inner instance). Reading the caster lets us distinguish
   * one-to-many from a scalar-array path that just happens to declare
   * something else. Pre-3.12.x this method always returned `'one-to-one'`
   * regardless of cardinality — wrong metadata for OpenAPI / docs hosts.
   */
  private extractRelations(paths: Record<string, unknown>): SchemaMetadata['relations'] {
    const relations: Record<
      string,
      {
        type: 'one-to-one' | 'one-to-many' | 'many-to-many';
        target: string;
        foreignKey?: string;
      }
    > = {};

    for (const [fieldName, schemaType] of Object.entries(paths)) {
      // Mongoose 9 surfaces array-element metadata under
      // `embeddedSchemaType` for `[{ type: ObjectId, ref }]` and
      // `{ type: [ObjectId], ref }` alike. Older mongoose versions used
      // `caster` for the same role — read either to stay
      // version-resilient.
      const path = schemaType as MongooseSchemaType & {
        instance?: string;
        caster?: MongooseSchemaType;
        embeddedSchemaType?: MongooseSchemaType;
      };

      // 1. Array-of-refs → one-to-many. The element-side `ref` lives
      //    on `embeddedSchemaType` (or `caster` on older mongoose).
      if (path.instance === 'Array') {
        const elementRef =
          path.embeddedSchemaType?.options?.ref ?? path.caster?.options?.ref ?? path.options?.ref;
        if (elementRef) {
          relations[fieldName] = {
            type: 'one-to-many',
            target: elementRef,
            foreignKey: fieldName,
          };
        }
        continue;
      }

      // 2. Scalar ref → one-to-one.
      const ref = path.options?.ref;
      if (ref) {
        relations[fieldName] = {
          type: 'one-to-one',
          target: ref,
          foreignKey: fieldName,
        };
      }
    }

    return Object.keys(relations).length > 0 ? relations : undefined;
  }
}

/**
 * Create a Mongoose adapter — produces a framework-agnostic
 * `DataAdapter<TDoc>` that any host consuming
 * `@classytic/repo-core/adapter` can wire in.
 *
 * Two call shapes:
 *
 * ```ts
 * // Object form (explicit)
 * const adapter = createMongooseAdapter({
 *   model: ProductModel,
 *   repository: productRepository,
 *   schemaGenerator: buildCrudSchemasFromModel,
 * });
 *
 * // Shorthand form (2-arg) — most common path
 * const adapter = createMongooseAdapter(ProductModel, productRepository);
 * ```
 */
export function createMongooseAdapter<TDoc = unknown>(
  model: Model<TDoc>,
  repository: AdapterRepositoryInput<TDoc>,
): DataAdapter<TDoc>;
export function createMongooseAdapter<TDoc = unknown>(
  options: MongooseAdapterOptions<TDoc>,
): DataAdapter<TDoc>;
export function createMongooseAdapter<TDoc = unknown>(
  modelOrOptions: Model<TDoc> | MongooseAdapterOptions<TDoc>,
  repository?: AdapterRepositoryInput<TDoc>,
): DataAdapter<TDoc> {
  if (isMongooseModel(modelOrOptions)) {
    if (!repository) {
      throw new TypeError(
        [
          'createMongooseAdapter: `repository` argument is required.',
          '',
          'Fix: pass `new Repository(model)` from @classytic/mongokit.',
          '',
          'Example:',
          "  import { Repository, createMongooseAdapter } from '@classytic/mongokit';",
          '  const adapter = createMongooseAdapter(ProductModel, new Repository(ProductModel));',
        ].join('\n'),
      );
    }
    return new MongooseAdapter<TDoc>({
      model: modelOrOptions as Model<TDoc>,
      repository,
    });
  }
  return new MongooseAdapter<TDoc>(modelOrOptions as MongooseAdapterOptions<TDoc>);
}
