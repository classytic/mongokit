/**
 * Request-scoped tenant context via AsyncLocalStorage.
 *
 * The multi-tenant plugin already accepts a `resolveContext` callback for
 * reading tenant ID from an external store. This helper wraps Node's
 * `AsyncLocalStorage` into a tiny, batteries-included API so apps don't need
 * to wire the plumbing by hand — a common source of cross-tenant leaks.
 *
 * @example
 *   import { createTenantContext, multiTenantPlugin } from '@classytic/mongokit';
 *
 *   const tenantContext = createTenantContext();
 *
 *   // In your HTTP middleware (Express / Fastify / NestJS):
 *   app.use((req, _res, next) => {
 *     tenantContext.run({ tenantId: req.auth.organizationId }, next);
 *   });
 *
 *   // In your repository definition:
 *   const repo = new Repository(Invoice, [
 *     multiTenantPlugin({
 *       tenantField: 'organizationId',
 *       resolveContext: () => tenantContext.getTenantId(),
 *     }),
 *   ]);
 *
 *   // In your handler — no need to pass organizationId manually:
 *   await repo.getAll({ filters: { status: 'paid' } });
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantStore {
  tenantId: string | undefined;
  [key: string]: unknown;
}

export interface TenantContext {
  /** Run `fn` with the given tenant store active for its entire async tree. */
  run<T>(store: TenantStore, fn: () => T): T;
  /** Current tenant ID, or undefined if no context is active. */
  getTenantId(): string | undefined;
  /** Full store for the current context (use for extra per-request metadata). */
  getStore(): TenantStore | undefined;
  /**
   * Assert that a tenant context is active; throw otherwise.
   * Useful in hot paths where a missing tenant must fail loud, not silent.
   */
  requireTenantId(): string;
  /** Underlying AsyncLocalStorage — escape hatch for advanced composition. */
  readonly storage: AsyncLocalStorage<TenantStore>;
}

export function createTenantContext(): TenantContext {
  const storage = new AsyncLocalStorage<TenantStore>();

  const api: TenantContext = {
    storage,
    run(store, fn) {
      return storage.run(store, fn);
    },
    getStore() {
      return storage.getStore();
    },
    getTenantId() {
      return storage.getStore()?.tenantId;
    },
    requireTenantId() {
      const id = storage.getStore()?.tenantId;
      if (!id) {
        throw new Error(
          '[mongokit] No tenant context active. Wrap the request in tenantContext.run({ tenantId }, fn).',
        );
      }
      return id;
    },
  };

  return api;
}
