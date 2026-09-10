/**
 * Better Auth × Mongoose overlay.
 *
 * Better Auth owns writes to its own collections (`user`, `organization`,
 * `member`, `invitation`, `session`, `account`, `verification`, ...) via
 * its own driver — typically `@better-auth/mongo-adapter` (mongodb v7).
 * This module gives you a *read-side* overlay for those collections so
 * arc / any host that consumes `DataAdapter<TDoc>` from
 * `@classytic/repo-core/adapter` can expose them as fully-featured
 * resources — pagination, query parser, filters, sort, OpenAPI, audit,
 * permissions, multi-tenant scope — without re-implementing CRUD.
 *
 * **API symmetry with `@classytic/sqlitekit/better-auth`** — both kits
 * expose `createBetterAuthOverlay({ auth, db, collection })` (db is
 * mongoose vs Drizzle). Both are async because they read BA's resolved
 * schema (`auth.$context.tables`) at boot — picks up `additionalFields`,
 * `modelName` overrides, and plugin schema additions automatically.
 *
 * @example
 * ```ts
 * import mongoose from 'mongoose';
 * import { betterAuth } from 'better-auth';
 * import { mongodbAdapter } from '@better-auth/mongo-adapter';
 * import { organization } from 'better-auth/plugins/organization';
 * import {
 *   createBetterAuthOverlay,
 *   registerBetterAuthStubs,
 * } from '@classytic/mongokit/better-auth';
 *
 * const auth = betterAuth({
 *   database: mongodbAdapter(mongoose.connection.getClient().db()),
 *   plugins: [organization()],
 * });
 *
 * // Bulk-register stubs so populate('user'), ref: 'organization' work app-wide.
 * registerBetterAuthStubs(mongoose, { plugins: ['organization'] });
 *
 * // Per-resource overlay — async because we await BA's schema. Resolves once at boot.
 * const orgAdapter = await createBetterAuthOverlay({
 *   auth,
 *   mongoose,
 *   collection: 'organization',
 * });
 *
 * defineResource({
 *   name: 'organization',
 *   adapter: orgAdapter,
 *   permissions: { list: requireAuth(), create: requireOrgRole('admin') },
 * });
 * ```
 */

/** Index declared on an overlay call — compared against an existing schema on reuse. */
type OverlayIndex = { fields: Record<string, 1 | -1>; options?: Record<string, unknown> };

/**
 * Field key with ORDER PRESERVED — a compound index is identified by its key sequence.
 * `{ organizationId: 1, createdAt: -1 }` is a DIFFERENT index from `{ createdAt: -1, organizationId: 1 }`
 * (they serve different queries), so sorting the keys here would wrongly equate them.
 */
function indexFieldsKey(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}:${String(v)}`)
    .join(',');
}

/** Deterministic canonical form (sorted object keys, recursive) for value equality. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonical(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Is every DECLARED option satisfied by the existing index's options? A subset check, not
 * equality: Mongoose augments stored index options with defaults (e.g. `background`), so the
 * existing side legitimately carries extra keys. We require each declared key to deep-equal the
 * existing value — covering ALL declared options (unique, sparse, expireAfterSeconds, collation,
 * name, weights, default_language, partialFilterExpression, …) with no hand-maintained subset.
 */
function declaredOptionsSatisfied(
  declared: Record<string, unknown> = {},
  existing: Record<string, unknown> = {},
): boolean {
  for (const [key, value] of Object.entries(declared)) {
    if (JSON.stringify(canonical(value)) !== JSON.stringify(canonical(existing[key]))) return false;
  }
  return true;
}

/** Which declared indexes are NOT already present on the existing model's schema. */
function missingIndexesOn(
  existing: { schema?: unknown } | undefined,
  declared: readonly OverlayIndex[],
): OverlayIndex[] {
  if (declared.length === 0) return [];
  const schema = existing?.schema as
    | { indexes?: () => Array<[Record<string, unknown>, Record<string, unknown>]> }
    | undefined;
  const existingIndexes = schema?.indexes?.() ?? [];
  return declared.filter(
    (d) =>
      !existingIndexes.some(
        ([fields, options]) =>
          indexFieldsKey(fields) === indexFieldsKey(d.fields) &&
          declaredOptionsSatisfied(d.options ?? {}, options ?? {}),
      ),
  );
}

import type { DataAdapter, RepositoryLike } from '@classytic/repo-core/adapter';
import {
  type BetterAuthPluginKey,
  pluralizeBetterAuthCollection,
  resolveBetterAuthCollections,
} from '@classytic/repo-core/better-auth';
import { asReadOnlyRepo } from '@classytic/repo-core/repository';
import { createMongooseAdapter } from '../adapter/index.js';
import { Repository } from '../Repository.js';

// Re-export the registry types so callers don't need a second import line.
export type { BetterAuthPluginKey } from '@classytic/repo-core/better-auth';

/**
 * Minimal structural type for the Mongoose surface this module touches.
 * Declared structurally so the file has zero runtime `import` of mongoose —
 * mongoose stays a peer dep and is never bundled with mongokit.
 */
export interface MongooseLike {
  models: Record<string, unknown>;
  Schema: new (
    definition?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => MongooseSchemaLike;
  model: (name: string, schema?: unknown) => MongooseModelLike;
}

interface MongooseSchemaLike {
  index(fields: Record<string, 1 | -1>, options?: Record<string, unknown>): MongooseSchemaLike;
}

interface MongooseModelLike {
  modelName: string;
  schema: { paths: Record<string, unknown> };
}

/**
 * Minimal structural type for a `betterAuth()` instance. We only need
 * `$context` (resolved tables map). Avoids a runtime peer dep on
 * `better-auth` from this module — declared as an *optional* peer in
 * package.json for hosts that import this subpath.
 */
export interface BetterAuthInstance {
  $context:
    | Promise<{ tables: Record<string, BATableConfig> }>
    | { tables: Record<string, BATableConfig> };
}

interface BATableConfig {
  modelName: string;
  fields: Record<string, BAFieldAttribute>;
}

interface BAFieldAttribute {
  type: 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'number[]';
  required?: boolean;
  unique?: boolean;
  fieldName?: string;
  references?: { model: string; field: string; onDelete?: string };
  defaultValue?: unknown;
}

// ============================================================================
// registerBetterAuthStubs — bulk stub registration for populate() resolution
// ============================================================================

/**
 * How Better Auth's `_id` values are stored, so mongoose casts queries the same way.
 *
 * - `'objectid'` (DEFAULT) — BA's mongo adapter generating its own ids writes
 *   real ObjectIds. Mongoose's default `_id` SchemaType casts a hex string to
 *   ObjectId, which is what makes `findById`, `_id` filters and `populate`
 *   resolve.
 * - `'string'` — the host overrode `advanced.database.generateId` (commonly to
 *   `randomBytes(12).toString('hex')`, which AVOIDS a cross-driver ObjectId
 *   `instanceof` failure). BA then stores those ids as STRINGS.
 *
 * Getting this wrong fails in the quiet direction, in BOTH directions: an
 * ObjectId-typed schema over string ids casts every lookup to an ObjectId that
 * matches nothing, so `getById` 404s and `populate` yields null — no error, no
 * log. Measured on a real deployment: `GET /me`, `GET /users/:id` and
 * `GET /branches/code/:code` all 404'd for rows that existed.
 *
 * There is no safe default that covers both, which is why this is an explicit
 * option rather than a guess: read `typeof doc._id` from a live row.
 */
export type BetterAuthIdType = 'objectid' | 'string';

/** The `_id` path for a stub/overlay schema, or `{}` to inherit mongoose's ObjectId default. */
function idPath(idType: BetterAuthIdType | undefined): Record<string, unknown> {
  return idType === 'string' ? { _id: { type: String } } : {};
}

export interface RegisterBetterAuthStubsOptions {
  /** Plugin sets to include. `core` is always implied. */
  plugins?: BetterAuthPluginKey[];
  /** How BA stores `_id` — see {@link BetterAuthIdType}. Default `'objectid'`. */
  idType?: BetterAuthIdType;
  /** Additional collection names beyond the plugin set. */
  extraCollections?: string[];
  /** Mirror BA's `usePlural` flag — appends `s` to every collection name. */
  usePlural?: boolean;
  /** Per-collection model name override (mirrors BA's `user.modelName`). */
  modelOverrides?: Partial<Record<string, string>>;
  /**
   * Canonical collection names to SKIP — because something else owns their model.
   *
   * The normal reason is `createBetterAuthOverlay`: a host wants stubs for the collections it merely
   * REFERENCES (`organization`, `member`) and a full overlay for the one it exposes CRUD on (`user`).
   * Without this the two helpers collide — the stub registers `user` first, and the overlay then
   * THROWS, correctly, because mongoose locks a schema on first `model()` and its `additionalFields`
   * would be silently dropped.
   *
   * Names are CANONICAL (`'user'`, not a pluralised or overridden model name); exclusion is applied
   * before `usePlural` / `modelOverrides`, so a caller does not have to predict the final name.
   */
  exclude?: string[];
}

/**
 * Register stub Mongoose models for Better Auth's collections so that
 * Mongoose-based resources can `.populate()` references to BA-owned
 * documents. Idempotent — safe to call multiple times.
 *
 * Schemas are `strict: false` (so BA's writes flow through unchanged and
 * Mongoose hydrates whatever BA wrote) and keep the DEFAULT ObjectId `_id`
 * SchemaType — BA's mongo adapter stores ObjectId `_id`s, so the caster is
 * required for `findById`, `_id` filters, and `populate`/`ref` to resolve a
 * hex-string id (see the NOTE in the loop below). Use this when you have
 * resources that *reference* BA collections (`createdBy: { ref: 'user' }`)
 * but don't expose CRUD on the BA collection itself.
 *
 * For full CRUD on a BA collection, use `createBetterAuthOverlay` instead —
 * it registers the model AND wires it into a `DataAdapter<TDoc>`.
 *
 * @returns the model names that were newly registered (excluding any that
 *          already existed on `mongoose.models`).
 */
export function registerBetterAuthStubs(
  mongoose: MongooseLike,
  options: RegisterBetterAuthStubsOptions = {},
): string[] {
  const excluded = new Set(options.exclude ?? []);
  // Canonical names are resolved WITH the exclusion applied, so `usePlural` / `modelOverrides` cannot
  // reintroduce a collection the caller deliberately handed to an overlay.
  const names = resolveBetterAuthCollections({
    ...options,
    ...(excluded.size ? { exclude: [...excluded] } : {}),
  });

  const registered: string[] = [];
  for (const finalName of names) {
    // Check + register on the SUPPLIED Mongoose instance, never mongokit's global
    // registry. A host may pass a custom `mongoose.createConnection`-style instance (tests,
    // multi-registry apps); `isModelRegistered`/`defineModel` default to the global instance,
    // which would register the stub on the wrong registry. `MongooseLike` is not a mongoose
    // `Connection`, so it cannot be handed to those helpers — use its own `models`/`model`.
    if (finalName in mongoose.models) continue;
    // NOTE: do NOT set `_id: false`. The Better Auth mongo adapter stores
    // ObjectId `_id`s, so the schema needs a default `_id` SchemaType for
    // Mongoose to CAST query ids (string → ObjectId) on `findById`, `_id`
    // filters, and `populate`/`ref` resolution. Disabling `_id` removed that
    // caster, so a hex-string id was queried as a raw string and never matched
    // the ObjectId doc — every overlay `getById` 404'd. Matches the schema
    // built by `createBetterAuthOverlay` below (which correctly omits it).
    const schema = new mongoose.Schema(idPath(options.idType), {
      strict: false,
      collection: finalName,
      timestamps: false,
    });
    // The loop already `continue`d for an existing name, so this always registers fresh.
    mongoose.model(finalName, schema);
    registered.push(finalName);
  }
  return registered;
}

// ============================================================================
// createBetterAuthOverlay — per-collection DataAdapter factory
// ============================================================================

export interface BetterAuthOverlayOptions<TDoc = Record<string, unknown>> {
  /** A `betterAuth()` instance. Used to read the resolved schema (`auth.$context.tables`). */
  auth: BetterAuthInstance;
  /** Mongoose instance — passed in to keep mongoose a peer dep. */
  mongoose: MongooseLike;
  /**
   * Canonical BA collection name (`'user'`, `'organization'`, `'member'`, ...).
   * The factory looks up `auth.$context.tables[collection]` to derive the
   * actual model name (honoring BA's `user.modelName` overrides) and the
   * field set (honoring `additionalFields` and plugin schema additions).
   */
  collection: string;

  /**
   * Additional fields to declare on the Mongoose schema. Use this when:
   *   - You added them via `betterAuth({ user: { additionalFields: { ... } } })`
   *     and want typed access from your repository
   *   - You want to declare validators / defaults / indexes on those fields
   *
   * Schema stays `strict: false`, so any field BA writes that you DON'T
   * declare here still round-trips — declaring is about typed access and
   * Mongoose-side concerns (validators, indexes, defaults).
   */
  additionalFields?: Record<string, unknown>;
  /** How BA stores `_id` — see {@link BetterAuthIdType}. Default `'objectid'`. */
  idType?: BetterAuthIdType;

  /**
   * Mongoose schema indexes to attach to the overlay model.
   *
   * @example [{ fields: { code: 1 }, options: { unique: true, sparse: true } }]
   */
  indexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }>;

  /**
   * Mirror BA's `usePlural: true` flag. Only used as a fallback when
   * `auth.$context.tables[collection].modelName` doesn't already include
   * the pluralization (rare — BA's resolver normally bakes it in).
   */
  usePlural?: boolean;

  /**
   * Subclass `Repository<TDoc>` to add domain methods (e.g. `getByEmail`,
   * `deactivate`, `getAdmins`). When omitted, the default `Repository<TDoc>`
   * is used — the standard CRUD surface is already complete.
   *
   * **Plugin composition warning.** The default overlay repo is built with
   * NO plugins, deliberately:
   *
   *   - **Do NOT apply `multiTenantPlugin` to BA overlays.** Better Auth's
   *     tables are global by design — `user`, `session`, `account`,
   *     `verification` have no tenant column at all, and `member` /
   *     `invitation` carry `organizationId` under BA's OWN semantics
   *     (membership rows, not tenant-scoped data). A tenant plugin with
   *     `required: true` would break every read; scope BA queries with
   *     explicit filters (`{ organizationId }`) at the call site instead.
   *   - **`cachePlugin` is safe only because the data is global** — if you
   *     wire it in a custom `RepositoryClass`, remember BA's own writes go
   *     through BA's driver and will NOT invalidate mongokit's cache. Use
   *     short TTLs or skip caching BA collections entirely.
   */
  RepositoryClass?: new (
    Model: ReturnType<MongooseLike['model']>,
  ) => RepositoryLike<TDoc>;

  /**
   * Optional schema generator. Pass `buildCrudSchemasFromModel` from
   * `@classytic/mongokit` to wire OpenAPI auto-gen.
   */
  // biome-ignore lint/suspicious/noExplicitAny: schema generator signature is owned by repo-core.
  schemaGenerator?: any;

  /**
   * Return a WRITABLE repository. Default `false` — the overlay is a
   * read-side projection, and its repository is sealed
   * (`asReadOnlyRepo`): writes throw, and `capabilities.readOnly` lets a
   * host refuse write ROUTES at boot.
   *
   * Better Auth owns writes to these collections and enforces invariants
   * the documents cannot: password hashing, session revocation, org
   * membership cascades, and every plugin hook (passkey, SSO, ...). A
   * generic `POST /users` through this repository bypasses all of it and
   * writes a row Better Auth never saw. That is one route-config line away
   * whenever the repository is writable, so the seal is the default rather
   * than a docstring.
   *
   * Set `true` ONLY for administrative repair paths where you have
   * accepted that responsibility. Normal identity mutations go through
   * `auth.api`.
   */
  unsafeWritable?: boolean;
}

/**
 * Create a `DataAdapter<TDoc>` over a Better Auth collection.
 *
 * Reads `auth.$context.tables[collection]` to resolve the actual model
 * name and any BA-declared fields. Registers a `strict: false` Mongoose
 * model, wraps it in a `Repository`, and returns the framework-agnostic
 * adapter ready for `defineResource({ adapter })`.
 *
 * Async because we await BA's resolved schema. Resolves once at boot —
 * there's no per-request cost. Symmetric with
 * `@classytic/sqlitekit/better-auth.createBetterAuthOverlay`.
 *
 * @throws if `collection` doesn't match any table BA knows about (typo or
 *         missing plugin), or if a model with the resolved name is already
 *         registered on `mongoose.models` from a prior call (re-registration
 *         would silently drop this call's `additionalFields` / `indexes`).
 */
export async function createBetterAuthOverlay<TDoc = Record<string, unknown>>(
  options: BetterAuthOverlayOptions<TDoc>,
): Promise<DataAdapter<TDoc>> {
  const {
    auth,
    mongoose,
    collection,
    additionalFields = {},
    indexes = [],
    usePlural = false,
    RepositoryClass,
    schemaGenerator,
    unsafeWritable = false,
  } = options;

  // Resolve BA's authoritative table config — honors modelName overrides + additionalFields.
  const ctx = await auth.$context;
  const tableConfig = ctx.tables[collection];
  if (!tableConfig) {
    throw new Error(
      `[mongokit:better-auth] Better Auth has no table named '${collection}'. Available: ${Object.keys(ctx.tables).join(', ')}. Did you enable the right plugin in your betterAuth() config?`,
    );
  }

  // BA's `modelName` is authoritative for the actual collection name.
  // `usePlural` only kicks in when BA hasn't already pluralized.
  const finalName = usePlural
    ? pluralizeBetterAuthCollection(tableConfig.modelName)
    : tableConfig.modelName;

  // Refuse to overwrite a pre-existing model — additionalFields / indexes
  // declared on this call would be silently dropped, masking real bugs.
  // If the host called `registerBetterAuthStubs` first, they should
  // either drop that call OR pass additionalFields THERE, not here.
  if (finalName in mongoose.models) {
    const declared = Object.keys(additionalFields);
    if (declared.length > 0 || indexes.length > 0) {
      /**
       * Distinguish "a STUB got here first" from "this same overlay already ran in this process".
       *
       * The guard exists because mongoose locks a schema on first `model()`, so declared
       * `additionalFields` would be silently dropped. That danger is real when a
       * `registerBetterAuthStubs()` call registered an EMPTY `strict: false` schema first.
       *
       * It is NOT real on a re-boot: a process that composes the app twice (every integration suite,
       * and any host that recomposes) hits an existing model whose schema ALREADY carries these exact
       * paths, because an identical overlay call put them there. Throwing then just makes the second
       * boot impossible — which is precisely why hosts hand-rolled `models.X || model(X, schema)` and
       * inherited the silent-drop bug this guard was written to stop.
       *
       * So the test is the SCHEMA, not the mere presence of a model: if every declared field is
       * already a path, the fields are applied and reuse is safe. If any is missing, something else
       * owns this model and the throw stands.
       */
      const existing = mongoose.models[finalName] as MongooseModelLike | undefined;
      const paths = existing?.schema?.paths ?? {};
      const missing = declared.filter((f) => !(f in paths));
      // Indexes are subject to the SAME lock: a schema is frozen on first model(), so a
      // declared index that is not already present would be silently dropped. Reuse is only
      // safe when every declared index is ALSO already on the existing schema (the re-boot case
      // where an identical overlay ran earlier). Compare fields + relevant uniqueness options.
      const missingIdx = missingIndexesOn(existing, indexes);
      if (missing.length > 0 || missingIdx.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) {
          parts.push(
            `${missing.length === 1 ? 'field' : 'fields'} ${missing.map((f) => `'${f}'`).join(', ')}`,
          );
        }
        if (missingIdx.length > 0) {
          parts.push(
            `${missingIdx.length === 1 ? 'index' : 'indexes'} on ${missingIdx.map((i) => `{${Object.keys(i.fields).join(',')}}`).join(', ')}`,
          );
        }
        throw new Error(
          `[mongokit:better-auth] '${finalName}' already registered on mongoose.models WITHOUT ${parts.join(' and ')}. ` +
            `Cannot apply additionalFields / indexes from this createBetterAuthOverlay() call — ` +
            `mongoose locks schema on first model() call, so they would be SILENTLY DROPPED. ` +
            `Either: (a) exclude '${finalName}' from the prior registerBetterAuthStubs() call ` +
            `(\`exclude: ['${collection}']\`), or (b) move additionalFields / indexes there.`,
        );
      }
      // Same fields AND indexes already present — an identical overlay ran earlier. Reuse.
    }
    // No additions requested — reuse the existing model. Fine.
  }

  let Model = mongoose.models[finalName] as MongooseModelLike | undefined;
  if (!Model) {
    // `_id` first so an explicit `additionalFields._id` still wins.
    const schema = new mongoose.Schema(
      { ...idPath(options.idType), ...additionalFields },
      { strict: false, collection: finalName, timestamps: false },
    );
    for (const idx of indexes) {
      schema.index(idx.fields, idx.options);
    }
    Model = mongoose.model(finalName, schema);
  }

  const RepoCtor =
    RepositoryClass ?? (Repository as unknown as new (m: unknown) => RepositoryLike<TDoc>);
  // biome-ignore lint/suspicious/noExplicitAny: caller-supplied or cast-widened ctor; the runtime model is mongoose-compatible by construction.
  const built = new RepoCtor(Model as any);
  const repository = unsafeWritable
    ? built
    : asReadOnlyRepo(built, {
        reason:
          `Better Auth owns writes to '${finalName}' (hashing, session revocation, org ` +
          'cascades, plugin hooks) — mutate via auth.api, not generic CRUD. Pass ' +
          '`unsafeWritable: true` to this overlay if raw administrative writes are required',
      });

  return createMongooseAdapter<TDoc>({
    // biome-ignore lint/suspicious/noExplicitAny: structural Mongoose type bridges to the real Model<T> the adapter expects.
    model: Model as any,
    repository,
    schemaGenerator,
  });
}

// ============================================================================
// clearActiveOrganizationFromSessions — org-delete / member-removal integrity
// ============================================================================

/**
 * Minimal structural surface for the one write we need. Satisfied by BOTH a
 * native MongoDB `Collection` (`db.collection('session')`) and a Mongoose
 * `Model` — so the host passes whichever it has, and mongokit keeps mongoose +
 * the mongodb driver as peer deps with zero runtime import.
 */
/**
 * Ensure the TTL index that reaps expired Better Auth sessions.
 *
 * BA stamps `expiresAt` on every session (tunable via `session.expiresIn`,
 * default 7 days) but its mongo adapter creates NO index for it, and nothing
 * else sweeps the collection — so `session` grows without bound on the hottest
 * auth table. Measured on two live deployments before this existed: 568 rows
 * (233 expired) and 909 rows of which EVERY ONE was expired, the oldest five
 * months old.
 *
 * It lives here rather than in a host or a spine module because this kit is
 * what knows Better Auth's collection names — a host-side fix only protects
 * that host, and every other consumer keeps leaking.
 *
 * `expireAfterSeconds: 0` means "delete once `expiresAt` has passed", so
 * mongo's background task keeps the collection bounded with no application
 * code. Idempotent — re-creating an existing index is a no-op.
 *
 * NOT called automatically by {@link registerBetterAuthStubs}: that function is
 * synchronous and writes nothing to the database, and silently issuing DDL from
 * a model-registration helper would be a surprise. Call this once at boot.
 *
 * @returns `true` when an index was created or already present, `false` when
 *          the attempt failed (logged by the caller, never thrown — a missing
 *          TTL degrades storage, and refusing to boot over it is worse).
 */
export async function ensureBetterAuthSessionTtl(
  connection: {
    collection(name: string): {
      createIndex(keys: Record<string, 1>, opts: Record<string, unknown>): Promise<unknown>;
    };
  },
  options: { collection?: string; indexName?: string } = {},
): Promise<boolean> {
  const name = options.collection ?? 'session';
  try {
    await connection
      .collection(name)
      .createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: options.indexName ?? 'ttl_session_expiresAt' },
      );
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// ensureBetterAuthIndexes — the full index set, not just the session TTL
// ============================================================================

/**
 * One declared index on a Better Auth collection.
 *
 * `unique` is a REQUEST, not a guarantee: {@link ensureBetterAuthIndexes}
 * downgrades to a non-unique index when existing rows already violate it,
 * because failing a boot over historical duplicates is worse than running with
 * a plain lookup index and reporting the degradation.
 */
export interface BetterAuthIndexSpec {
  /** Canonical collection name (`'user'`, `'session'`, ...). */
  collection: string;
  keys: Record<string, 1 | -1>;
  name: string;
  unique?: boolean;
  /** Present on self-expiring rows; always paired with `expireAfterSeconds: 0`. */
  ttl?: boolean;
}

/**
 * The indexes Better Auth's own queries need, which its mongo adapter does NOT
 * create. Grouped by the plugin that owns the collection so a host only pays
 * for what it enabled.
 *
 * Every entry below backs a query BA runs on a hot path:
 *   - `session.token`   — read on EVERY authenticated request
 *   - `user.email`      — read on every sign-in / sign-up, and must be unique
 *   - `account.(providerId|issuer, accountId)` — the credential lookup at sign-in
 *   - `member.(organizationId, userId)` — the membership check on org-scoped requests
 * Without them each of those is a collection scan, and `email` / `slug` /
 * `token` have no uniqueness guarantee at all.
 *
 * TTL entries (`expiresAt`) additionally keep the collection BOUNDED — see
 * {@link ensureBetterAuthSessionTtl} for the measurements that motivated it.
 */
export const BA_INDEXES_BY_PLUGIN: Record<string, readonly BetterAuthIndexSpec[]> = {
  core: [
    { collection: 'user', keys: { email: 1 }, name: 'ba_user_email', unique: true },
    { collection: 'session', keys: { token: 1 }, name: 'ba_session_token', unique: true },
    { collection: 'session', keys: { userId: 1 }, name: 'ba_session_userId' },
    { collection: 'session', keys: { expiresAt: 1 }, name: 'ttl_session_expiresAt', ttl: true },
    { collection: 'account', keys: { userId: 1 }, name: 'ba_account_userId' },
    // 1.6 shape (providerId) and 1.7 shape (issuer) both kept: a host mid-upgrade
    // queries by one or the other, and an unused index costs only writes.
    {
      collection: 'account',
      keys: { providerId: 1, accountId: 1 },
      name: 'ba_account_provider_accountId',
    },
    {
      collection: 'account',
      keys: { issuer: 1, accountId: 1 },
      name: 'ba_account_issuer_accountId',
    },
    { collection: 'verification', keys: { identifier: 1 }, name: 'ba_verification_identifier' },
    {
      collection: 'verification',
      keys: { expiresAt: 1 },
      name: 'ttl_verification_expiresAt',
      ttl: true,
    },
  ],
  organization: [
    { collection: 'organization', keys: { slug: 1 }, name: 'ba_organization_slug', unique: true },
    {
      collection: 'member',
      keys: { organizationId: 1, userId: 1 },
      name: 'ba_member_org_user',
      unique: true,
    },
    { collection: 'member', keys: { userId: 1 }, name: 'ba_member_userId' },
    { collection: 'invitation', keys: { organizationId: 1 }, name: 'ba_invitation_org' },
    { collection: 'invitation', keys: { email: 1 }, name: 'ba_invitation_email' },
    {
      collection: 'invitation',
      keys: { expiresAt: 1 },
      name: 'ttl_invitation_expiresAt',
      ttl: true,
    },
  ],
  'organization-teams': [
    { collection: 'team', keys: { organizationId: 1 }, name: 'ba_team_org' },
    { collection: 'teamMember', keys: { teamId: 1, userId: 1 }, name: 'ba_teamMember_team_user' },
  ],
  twoFactor: [{ collection: 'twoFactor', keys: { userId: 1 }, name: 'ba_twoFactor_userId' }],
  deviceAuthorization: [
    { collection: 'deviceCode', keys: { deviceCode: 1 }, name: 'ba_deviceCode_code' },
    { collection: 'deviceCode', keys: { userCode: 1 }, name: 'ba_deviceCode_userCode' },
    {
      collection: 'deviceCode',
      keys: { expiresAt: 1 },
      name: 'ttl_deviceCode_expiresAt',
      ttl: true,
    },
  ],
};

/** Outcome of one declared index. */
export interface BetterAuthIndexResult {
  collection: string;
  name: string;
  status: 'created' | 'degraded' | 'failed';
  /** Set on `degraded` (unique dropped) and `failed`. */
  reason?: string;
}

export interface EnsureBetterAuthIndexesOptions {
  /** Plugin sets to include beyond `core` (always implied). */
  plugins?: BetterAuthPluginKey[];
  /** Mirror BA's `usePlural` — appends `s` to every collection name. */
  usePlural?: boolean;
  /** Per-collection name override (mirrors BA's `user.modelName`). */
  modelOverrides?: Partial<Record<string, string>>;
  /** Canonical collection names to skip entirely. */
  exclude?: string[];
}

export interface IndexCreator {
  collection(name: string): {
    createIndex(keys: Record<string, 1 | -1>, opts: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * Create every index Better Auth's queries need. Idempotent, never throws.
 *
 * BA's mongo adapter creates NO indexes — not even on `session.token`, which is
 * read on every authenticated request, nor a unique one on `user.email`. On a
 * small database nobody notices; the cost arrives as a full collection scan per
 * login once the tables grow, and until then nothing stops a duplicate email.
 *
 * This lives in the kit rather than a host for the same reason
 * {@link ensureBetterAuthSessionTtl} does: the kit is what knows BA's collection
 * names, so fixing it here protects every consumer instead of one host.
 *
 * **Uniqueness degrades rather than fails.** A `unique: true` spec is retried
 * without uniqueness when the collection already holds violating rows, and
 * reported as `degraded` — a boot must not die because historical data has a
 * duplicate. Inspect the returned report to find those.
 *
 * Call once at boot, after the connection is live. Safe to call again.
 */
export async function ensureBetterAuthIndexes(
  connection: IndexCreator,
  options: EnsureBetterAuthIndexesOptions = {},
): Promise<BetterAuthIndexResult[]> {
  const plugins = options.plugins ?? [];
  const excluded = new Set(options.exclude ?? []);
  const keys: string[] = ['core', ...plugins];

  const resolveName = (canonical: string): string => {
    const overridden = options.modelOverrides?.[canonical] ?? canonical;
    return options.usePlural ? pluralizeBetterAuthCollection(overridden) : overridden;
  };

  const specs: BetterAuthIndexSpec[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const spec of BA_INDEXES_BY_PLUGIN[key] ?? []) {
      if (excluded.has(spec.collection)) continue;
      // A plugin alias (oauthProvider/mcp) can repeat a spec — dedupe by name.
      const id = `${spec.collection}.${spec.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      specs.push(spec);
    }
  }

  const results: BetterAuthIndexResult[] = [];
  for (const spec of specs) {
    const target = resolveName(spec.collection);
    const base: Record<string, unknown> = { name: spec.name };
    if (spec.ttl) base.expireAfterSeconds = 0;
    try {
      await connection
        .collection(target)
        .createIndex(spec.keys, { ...base, ...(spec.unique ? { unique: true } : {}) });
      results.push({ collection: target, name: spec.name, status: 'created' });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!spec.unique) {
        results.push({ collection: target, name: spec.name, status: 'failed', reason });
        continue;
      }
      // Existing duplicates block the unique build — keep the lookup index.
      try {
        await connection.collection(target).createIndex(spec.keys, base);
        results.push({ collection: target, name: spec.name, status: 'degraded', reason });
      } catch (err2) {
        results.push({
          collection: target,
          name: spec.name,
          status: 'failed',
          reason: err2 instanceof Error ? err2.message : String(err2),
        });
      }
    }
  }
  return results;
}

export interface SessionUpdaterLike {
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount?: number }>;
}

/**
 * Clear a dangling `activeOrganizationId` from Better Auth `session` rows.
 *
 * WHY THIS EXISTS: Better Auth purges its `member` / `invitation` rows when an
 * org is deleted (or a member removed), but it NEVER clears
 * `session.activeOrganizationId`. A session left pointing at an org the user is
 * no longer a member of makes `organization.getActiveMember()` return
 * `MEMBER_NOT_FOUND`, and any frontend that trusts that stale pointer hangs —
 * amplified by `session.cookieCache`, which serves the dead pointer for minutes.
 *
 * This is intentionally a host-invoked helper, NOT part of the arc org-delete
 * cascade: arc is DB-agnostic (it purges through `@classytic/repo-core`
 * adapters and must not reach a raw collection), whereas the `session`
 * collection is a Better-Auth/mongo concern this kit already owns. Hosts wire
 * it into their `organizationHooks`:
 *   - `afterDeleteOrganization` → org-wide (omit `userId`)
 *   - `afterRemoveMember`       → one user (pass `userId`)
 *
 * The mongodb adapter stores `activeOrganizationId` as a STRING, so the org id
 * is matched as-is (no ObjectId construction). `session.userId` is an ObjectId,
 * so for the member-removal path pass `userId` already in the form your driver
 * compares against (a constructed ObjectId) — it's matched verbatim.
 *
 * @returns the number of sessions whose pointer was cleared.
 */
export async function clearActiveOrganizationFromSessions(
  sessions: SessionUpdaterLike,
  organizationId: string,
  options?: { userId?: unknown },
): Promise<number> {
  const filter: Record<string, unknown> = {
    activeOrganizationId: organizationId,
  };
  if (options?.userId != null) filter.userId = options.userId;

  const res = await sessions.updateMany(filter, {
    $set: { activeOrganizationId: null },
  });
  return res.modifiedCount ?? 0;
}
