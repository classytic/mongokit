/**
 * Cache plugin re-export shim.
 *
 * Mongokit 3.13+ delegates cache wiring to the unified repo-core plugin
 * (`@classytic/repo-core/cache`), which subscribes to `before:<op>` /
 * `after:<op>` hooks for both CRUD AND aggregate ops in one integration.
 *
 * This file remains so existing
 * `import { cachePlugin } from '@classytic/mongokit'` paths keep working.
 *
 * **Per-call options shape** (TanStack-shaped):
 * - `staleTime: number` — seconds the entry is considered fresh
 * - `gcTime: number` — seconds retained past stale (default 60)
 * - `swr: boolean` — stale-while-revalidate
 * - `tags: readonly string[]` — group-invalidation tags
 * - `bypass: boolean` — force fresh fetch + cache write
 * - `enabled: boolean` — per-call kill switch
 * - `key: string` — explicit key override
 *
 * @example
 * ```ts
 * import { Repository, cachePlugin } from '@classytic/mongokit';
 * import { createMemoryCacheAdapter } from '@classytic/repo-core/cache';
 *
 * const repo = new Repository(UserModel, [
 *   cachePlugin({ adapter: createMemoryCacheAdapter() }),
 * ]);
 *
 * // Per-call freshness control:
 * await repo.getById(id, { cache: { staleTime: 60, swr: true } });
 * await repo.aggregate({
 *   measures: { sum: { op: 'sum', field: 'amount' } },
 *   cache: { staleTime: 30, tags: ['orders'] },
 * });
 * ```
 */

export {
  type CacheAdapter,
  type CacheOptions,
  cachePlugin,
  type RepositoryCacheHandle,
  type RepositoryCachePluginOptions,
} from '@classytic/repo-core/cache';
