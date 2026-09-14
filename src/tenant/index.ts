/**
 * `@classytic/mongokit/tenant` — the Mongoose half of the tenant contract.
 *
 * `@classytic/repo-core/tenant` owns the CONFIG (`TenantConfig`, `resolveTenantConfig`):
 * pure, database-agnostic, one definition. What it cannot own is the schema mutation that
 * config implies on a Mongo-shaped kit: add the tenant field, and lead every compound
 * index with it so scoped reads never cross a tenant partition (PACKAGE_RULES rule 36).
 *
 * Before this module every kernel carried its own `src/models/inject-tenant.ts` (38 copies
 * at the last count). They drifted the way copies do: some exempted TTL indexes, some did
 * not; one knew how to keep a global identity index unscoped (`order`), the rest silently
 * prefixed it; one applied host `extraIndexes` BEFORE the prepend so a host could never
 * declare an unscoped index at all, and kernels that needed one declared it by hand AFTER
 * the call, an ordering rule that lived only in comments. This is the one implementation,
 * with the ordering rule inside it.
 *
 * ## Index scope
 *
 * A multi-tenant collection serves two kinds of read:
 *
 *   - **tenant** (the overwhelming majority): "this org's orders, newest first". The tenant
 *     field leads the index; MongoDB serves both `{org}` and `{org, …}` from one compound.
 *   - **global**: an IDENTITY read that spans tenants by design. A buyer's own history
 *     across every seller, a kernel-generated event id that must be unique everywhere, a
 *     webhook looking up a provider session id it was never told the tenant of. The tenant
 *     field must NOT lead, because the query has no tenant to give and a non-leading key
 *     is not a usable prefix.
 *
 * {@link IndexDeclaration.scope} names which one an index is. `'global'` is explicit,
 * REQUIRES a name (an unnamed exemption is indistinguishable from an oversight), and must
 * be paired with a read that bypasses the tenant plugin; a global index nothing reads
 * across tenants is only write amplification.
 */

import type { ResolvedTenantConfig } from '@classytic/repo-core/tenant';
import mongoose, { type Schema } from 'mongoose';

/** Which read an index serves. Default `'tenant'`. See the module docblock. */
export type IndexScope = 'tenant' | 'global';

/** Key directions and types a declaration may use. Mirrors what `schema.index()` accepts. */
export type IndexKeyValue = 1 | -1 | 'text' | '2dsphere' | '2d' | 'hashed';

/**
 * Index options passed through to `schema.index()`. `name` is the only one this module
 * reads (to apply and to explain exemptions); everything else is Mongoose's.
 */
export interface IndexDeclarationOptions {
  name?: string | undefined;
  unique?: boolean | undefined;
  sparse?: boolean | undefined;
  partialFilterExpression?: Record<string, unknown> | undefined;
  expireAfterSeconds?: number | undefined;
  collation?: Record<string, unknown> | undefined;
  background?: boolean | undefined;
  [option: string]: unknown;
}

/**
 * One index, declared by a kernel for its own model or by a host through a kernel's
 * `indexes` seam. The kernel applies it through {@link injectTenantField}, which is what
 * makes `scope` mean something: a `'tenant'` declaration is prefixed exactly like the
 * kernel's own indexes, a `'global'` one is kept as written.
 */
export interface IndexDeclaration {
  readonly fields: Readonly<Record<string, IndexKeyValue>>;
  readonly options?: IndexDeclarationOptions | undefined;
  /** @default 'tenant' */
  readonly scope?: IndexScope | undefined;
}

export interface InjectTenantFieldOptions {
  /**
   * Index NAMES (the `name` option of `schema.index()`) already on the schema whose key
   * spec must NOT get the tenant prefix. The escape hatch for a kernel's OWN global
   * identity index declared inline in its schema builder (`order_event_id_unique`: the
   * event id is a kernel-generated UUID and the drain's idempotency contract is exactly
   * one row per event regardless of tenant). Prefer declaring such an index through
   * `indexes` with `scope: 'global'`; this exists so a schema builder need not know the
   * tenant config. Unnamed indexes cannot be exempted: give the index a name first.
   */
  readonly skipIndexes?: readonly string[] | undefined;
  /**
   * Additional declarations, applied AFTER the prepend pass so their `scope` is honoured.
   * This is where a kernel threads its host's `indexes` seam.
   */
  readonly indexes?: readonly IndexDeclaration[] | undefined;
}

type IndexEntry = [Record<string, unknown>, Record<string, unknown> | undefined];

/** Mongoose keeps declared indexes on `schema._indexes`; `schema.indexes()` is a copy. */
function indexEntries(schema: Schema): IndexEntry[] {
  const entries = (schema as unknown as { _indexes?: IndexEntry[] })._indexes;
  return entries ?? [];
}

function isScoped(tenant: ResolvedTenantConfig): boolean {
  return tenant.enabled && tenant.strategy === 'field';
}

/**
 * Refuse a declaration that cannot mean what it says. Called before any schema mutation
 * so a bad host config fails at DESCRIBE time, with the fix in the message, rather than
 * building a wrong index on the first bind.
 */
export function assertIndexDeclaration(
  declaration: IndexDeclaration,
  tenant: Pick<ResolvedTenantConfig, 'tenantField'>,
): void {
  const keys = Object.keys(declaration.fields);
  if (keys.length === 0) {
    throw new Error('[mongokit/tenant] an index declaration needs at least one field');
  }
  if (declaration.scope === 'global') {
    if (typeof declaration.options?.name !== 'string' || declaration.options.name.length === 0) {
      throw new Error(
        `[mongokit/tenant] a global index must be named: { fields: ${JSON.stringify(
          declaration.fields,
        )}, scope: 'global' } has no \`options.name\`. A tenant exemption is deliberate, and ` +
          'an unnamed one cannot be told from an oversight.',
      );
    }
    if (declaration.fields[tenant.tenantField] !== undefined) {
      throw new Error(
        `[mongokit/tenant] index "${declaration.options.name}" is scope 'global' but names the ` +
          `tenant field "${tenant.tenantField}". A global index serves reads that have no ` +
          "tenant to give; drop the field, or declare the index with scope 'tenant'.",
      );
    }
  }
}

/**
 * Add `declarations` to `schema` honouring each one's scope.
 *
 * `'tenant'` declarations are prefixed with the tenant field when scoping is enabled
 * (unless they already lead with it, so a host that wrote it out is not double-prefixed);
 * `'global'` ones are added exactly as written. When scoping is disabled every declaration
 * is added as written, because there is no partition to lead with.
 *
 * Exported for kernels whose optional models inject the tenant field on their own path and
 * only need the host's extra declarations applied afterwards.
 */
export function declareIndexes(
  schema: Schema,
  tenant: ResolvedTenantConfig,
  declarations: readonly IndexDeclaration[] | undefined,
): void {
  if (!declarations || declarations.length === 0) return;
  for (const declaration of declarations) {
    assertIndexDeclaration(declaration, tenant);
    const options = declaration.options as Record<string, unknown> | undefined;
    const scoped = isScoped(tenant) && declaration.scope !== 'global';
    const leadsWithTenant = Object.keys(declaration.fields)[0] === tenant.tenantField;
    const fields =
      scoped && !leadsWithTenant
        ? { [tenant.tenantField]: 1 as const, ...declaration.fields }
        : { ...declaration.fields };
    schema.index(fields as Parameters<Schema['index']>[0], options);
  }
}

/**
 * Inject the tenant field into a Mongoose schema and make its indexes tenant-correct.
 *
 * 1. Adds the field, typed by `tenant.fieldType` (`ObjectId` with `ref`, or `String`).
 *    `required` only when scoping is enabled and the config says so: a single-tenant
 *    deployment still gets the field, because domain verbs reference it in raw queries.
 * 2. When scoping is enabled, prepends the tenant field to every index already declared
 *    on the schema, EXCEPT: one that already names the field; a TTL index (MongoDB rejects
 *    a compound TTL spec outright, and a time-driven sweep has no tenant to give); and any
 *    index named in `skipIndexes`.
 * 3. Applies `indexes` through {@link declareIndexes}, so a `'global'` declaration is never
 *    touched by step 2 whatever order the caller thought about it in.
 * 4. Guarantees one tenant-leading index. After the prepend any compound serves a
 *    tenant-only query via the prefix rule, so a bare `{ tenant: 1 }` is added ONLY when
 *    nothing was prepended: next to a compound it is a redundant prefix paid on every
 *    insert (PACKAGE_RULES P11.1; the fleet index audit found this pattern behind most of
 *    86 redundant indexes across 615).
 */
export function injectTenantField(
  schema: Schema,
  tenant: ResolvedTenantConfig,
  options: InjectTenantFieldOptions = {},
): void {
  // Validate host declarations BEFORE touching the schema: a refused config leaves the
  // schema exactly as it was handed in.
  for (const declaration of options.indexes ?? []) assertIndexDeclaration(declaration, tenant);

  const isObjectId = tenant.fieldType === 'objectId';
  const scoped = isScoped(tenant);

  schema.add({
    [tenant.tenantField]: {
      type: isObjectId ? mongoose.Schema.Types.ObjectId : String,
      ...(scoped && tenant.required ? { required: true } : {}),
      ...(isObjectId && tenant.ref ? { ref: tenant.ref } : {}),
    },
  });

  if (!scoped) {
    declareIndexes(schema, tenant, options.indexes);
    return;
  }

  const skip = new Set(options.skipIndexes ?? []);
  for (const entry of indexEntries(schema)) {
    const [fields, indexOptions] = entry;
    if (fields[tenant.tenantField] !== undefined) continue;
    if (indexOptions?.expireAfterSeconds !== undefined) continue;
    const name = indexOptions?.name;
    if (typeof name === 'string' && skip.has(name)) continue;
    entry[0] = { [tenant.tenantField]: 1, ...fields };
  }

  declareIndexes(schema, tenant, options.indexes);

  const hasTenantLeading = indexEntries(schema).some(
    ([fields]) => Object.keys(fields)[0] === tenant.tenantField,
  );
  if (!hasTenantLeading) {
    schema.index({ [tenant.tenantField]: 1 } as Record<string, 1>);
  }
}
