/**
 * Scope forwarding — the ONE rule for what travels from an operation to a
 * second repository call made on its behalf.
 *
 * mongokit makes such calls in several places (the cascade's restrict count,
 * detach and child deletes; a host's `repoOptionsFromCtx(ctx)`). Each used to
 * pick the fields itself, and each dropped something different: the cascade
 * forwarded `organizationId` but not `bypassTenant`, so a platform admin's
 * delete 500'd inside the child repo; `repoOptionsFromCtx` dropped the bypass
 * too; neither knew about a tenant plugin configured with a custom
 * `contextKey`. One function now owns the decision, so a new scope field is
 * added once and every hop carries it.
 *
 * What travels:
 *   - the TENANT: every context key a `multiTenantPlugin` on the repository
 *     declared (plus the `organizationId` / `tenantId` conventions);
 *   - the BYPASS, only when no tenant is present. The tenant plugin honours a
 *     bypass before a tenant, so forwarding both would silently widen a
 *     scoped call to every tenant;
 *   - the SESSION, so the second call joins the first one's transaction;
 *   - attribution: `user`, `userId`, `requestId`.
 */

import type { ClientSession } from 'mongoose';

/** The fields that decide whose rows an operation touches, and inside which transaction. */
export interface RepoScope {
  /** Platform-admin escape hatch. Present only when the source carried no tenant. */
  bypassTenant?: true;
  session?: ClientSession;
  user?: unknown;
  userId?: unknown;
  requestId?: unknown;
  /** Tenant values, keyed by each declared tenant context key (`organizationId`, …). */
  [tenantKey: string]: unknown;
}

/** Tenant context keys forwarded even when no tenant plugin declared one. */
const CONVENTIONAL_TENANT_KEYS = ['organizationId', 'tenantId'] as const;

const ATTRIBUTION_KEYS = ['session', 'user', 'userId', 'requestId'] as const;

/** Where a repository records the tenant context keys its plugins read. */
const TENANT_KEYS = Symbol.for('@classytic/mongokit/tenant-context-keys');

type WithTenantKeys = { [TENANT_KEYS]?: Set<string> };

/**
 * Record that `repo` resolves its tenant from `contextKey`. Called by
 * `multiTenantPlugin` at bind, so forwarding knows a custom key (`branchId`)
 * without the host restating it.
 */
export function declareTenantContextKey(repo: object, contextKey: string): void {
  const holder = repo as WithTenantKeys;
  if (!holder[TENANT_KEYS]) {
    Object.defineProperty(holder, TENANT_KEYS, { value: new Set<string>(), enumerable: false });
  }
  holder[TENANT_KEYS]?.add(contextKey);
}

/** Every tenant context key relevant to a call spanning these repositories. */
export function tenantContextKeysOf(...repos: ReadonlyArray<object | undefined>): string[] {
  const keys = new Set<string>(CONVENTIONAL_TENANT_KEYS);
  for (const repo of repos) {
    for (const key of (repo as WithTenantKeys | undefined)?.[TENANT_KEYS] ?? []) keys.add(key);
  }
  return [...keys];
}

/**
 * The scope to hand a second repository call made on behalf of `source`
 * (a hook's `RepositoryContext`, or a host's request context).
 *
 * Absent values are omitted, never written as `undefined`, so spreading the
 * result into an options bag cannot erase a value set there.
 */
export function forwardScope(
  source: Record<string, unknown> | null | undefined,
  tenantKeys: readonly string[] = CONVENTIONAL_TENANT_KEYS,
): RepoScope {
  if (!source) return {};
  // Values are copied as given; the session is whatever the caller holds.
  const out: Record<string, unknown> = {};
  let hasTenant = false;
  for (const key of tenantKeys) {
    const value = source[key];
    if (value === undefined) continue;
    // Forwarded as given: `null` is a caller's deliberate "no tenant" and must be
    // able to override an inherited value in a spread. Only a real value counts as
    // a tenant for the bypass decision below.
    out[key] = value;
    if (value !== null && value !== '') hasTenant = true;
  }
  if (!hasTenant && source.bypassTenant === true) out.bypassTenant = true;
  for (const key of ATTRIBUTION_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as RepoScope;
}

/** Every key `forwardScope` governs. Other forwarding helpers must not copy these themselves. */
export function isScopeKey(
  key: string,
  tenantKeys: readonly string[] = CONVENTIONAL_TENANT_KEYS,
): boolean {
  return (
    key === 'bypassTenant' ||
    tenantKeys.includes(key) ||
    (ATTRIBUTION_KEYS as readonly string[]).includes(key)
  );
}
