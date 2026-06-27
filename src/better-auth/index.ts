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
 * import { organization } from 'better-auth/plugins';
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

import type { DataAdapter, RepositoryLike } from '@classytic/repo-core/adapter';
import {
  type BetterAuthPluginKey,
  pluralizeBetterAuthCollection,
  resolveBetterAuthCollections,
} from '@classytic/repo-core/better-auth';
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

export interface RegisterBetterAuthStubsOptions {
  /** Plugin sets to include. `core` is always implied. */
  plugins?: BetterAuthPluginKey[];
  /** Additional collection names beyond the plugin set. */
  extraCollections?: string[];
  /** Mirror BA's `usePlural` flag — appends `s` to every collection name. */
  usePlural?: boolean;
  /** Per-collection model name override (mirrors BA's `user.modelName`). */
  modelOverrides?: Partial<Record<string, string>>;
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
  const names = resolveBetterAuthCollections(options);

  const registered: string[] = [];
  for (const finalName of names) {
    if (mongoose.models[finalName]) continue;
    // NOTE: do NOT set `_id: false`. The Better Auth mongo adapter stores
    // ObjectId `_id`s, so the schema needs a default `_id` SchemaType for
    // Mongoose to CAST query ids (string → ObjectId) on `findById`, `_id`
    // filters, and `populate`/`ref` resolution. Disabling `_id` removed that
    // caster, so a hex-string id was queried as a raw string and never matched
    // the ObjectId doc — every overlay `getById` 404'd. Matches the schema
    // built by `createBetterAuthOverlay` below (which correctly omits it).
    const schema = new mongoose.Schema(
      {},
      { strict: false, collection: finalName, timestamps: false },
    );
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
  if (mongoose.models[finalName]) {
    if (Object.keys(additionalFields).length > 0 || indexes.length > 0) {
      throw new Error(
        `[mongokit:better-auth] '${finalName}' already registered on mongoose.models. ` +
          `Cannot apply additionalFields / indexes from this createBetterAuthOverlay() call — ` +
          `mongoose locks schema on first model() call. ` +
          `Either: (a) drop the prior registerBetterAuthStubs() call for '${finalName}', or ` +
          `(b) move additionalFields / indexes into the existing schema definition.`,
      );
    }
    // No additions requested — reuse the existing model. Fine.
  }

  let Model = mongoose.models[finalName] as MongooseModelLike | undefined;
  if (!Model) {
    const schema = new mongoose.Schema(additionalFields, {
      strict: false,
      collection: finalName,
      timestamps: false,
    });
    for (const idx of indexes) {
      schema.index(idx.fields, idx.options);
    }
    Model = mongoose.model(finalName, schema);
  }

  const RepoCtor =
    RepositoryClass ?? (Repository as unknown as new (m: unknown) => RepositoryLike<TDoc>);
  // biome-ignore lint/suspicious/noExplicitAny: caller-supplied or cast-widened ctor; the runtime model is mongoose-compatible by construction.
  const repository = new RepoCtor(Model as any);

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
