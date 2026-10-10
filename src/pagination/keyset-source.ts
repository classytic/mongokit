/**
 * `keysetSource(repo, { name, sort, filters, ...scope })` — a mongokit repository as a repo-core
 * `KeysetSource`, for `mergeKeysetPages`. Pages are `getAll({ mode: 'keyset' })` under the given
 * scope; the per-row cursor is `repo.keysetCursor` (scope-bound like every mongokit cursor); the
 * source's `scope` string binds the composite cursor to (collection, filters, tenant values).
 */

import { stableStringify } from '@classytic/repo-core/hash';
import type { KeysetSource } from '@classytic/repo-core/pagination';
import type { Repository } from '../Repository.js';
import type { SortSpec } from '../types/core.js';
import type { ReadOptions } from '../types/operations.js';
import { forwardScope } from '../utils/scope.js';

export interface KeysetSourceOptions extends ReadOptions {
  name: string;
  sort: SortSpec;
  filters?: Record<string, unknown>;
}

export function keysetSource<TDoc>(
  repo: Repository<TDoc>,
  options: KeysetSourceOptions,
): KeysetSource<TDoc> {
  const { name, sort, filters = {}, ...scope } = options;
  const { session: _session, user: _user, ...tenant } = forwardScope(scope);
  return {
    name,
    scope: `${repo.Model.collection.collectionName}:${stableStringify({ filters, tenant })}`,
    async page({ after, limit }) {
      const page = await repo.getAll({
        ...scope,
        filters,
        sort,
        limit,
        mode: 'keyset',
        ...(after ? { after } : {}),
      });
      if (page.method !== 'keyset')
        throw new Error('[mongokit] keysetSource: getAll did not return a keyset page');
      return { data: page.data, hasMore: page.hasMore };
    },
    cursorOf: (row) => repo.keysetCursor(row, { ...scope, sort, filters }),
  };
}
