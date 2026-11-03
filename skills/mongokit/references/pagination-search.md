# Pagination, search, QueryParser

## Envelopes (types from `@classytic/repo-core/pagination`)

```
offset: { method: 'offset', data, page, limit, total, pages, hasNext, hasPrev, warning? }
keyset: { method: 'keyset', data, limit, hasMore, next, prev?, hasPrev?, end? }
```

Narrow on `result.method`. Rows are in `data`.

## Choosing a mode

`mode` wins; else `page` means offset; else `after` means keyset; else `PaginationConfig.defaultMode`; else any non-default `sort` means keyset.
Pass `mode` so a changed sort does not flip the response shape. `before` walks backward from a `prev` cursor.

Keyset sort gets an `_id` tiebreak automatically; the index must match: `{ organizationId: 1, createdAt: -1, _id: -1 }`.
`strictKeysetSortFields` limits which fields may be sorted on. Cursors are scoped to collection, tenant, filter and collation; a wrong one
is 400 `repo.cursor.invalid` or `repo.cursor.scope_mismatch` (`PAGINATION_ERROR_CODES`). Sign cursors with `cursorSecret`.

## Counting

Offset pages count by default. `countStrategy`: `exact`, `estimated`, `capped` (with `countLimit`), `cached` (memoised per filter, never inside a
transaction), `none` (no total). Set a deployment default once at boot:

```ts
import { configurePaginationDefaults } from '@classytic/mongokit';
configurePaginationDefaults({ defaultCountStrategy: 'capped', defaultCountLimit: 10000 });
```

Offsets past `maxOffset` are refused with `mongokit.pagination.offset_too_deep`; page with keyset instead.

## Search modes (`RepositoryOptions.searchMode`)

| Mode | Behavior | Needs |
|---|---|---|
| `text` (default) | `$text` | text index |
| `regex` | case-insensitive `$or` over `searchFields` | `searchFields`, scans |
| `auto` | text if a text index exists, else regex | |
| `prefix` | every query word starts some stored token (`moh ali` finds "Mohammed Al-Ali") | `searchFields`, keys path, multikey index |

Prefix setup:

```ts
import { Repository, searchKeysPath } from '@classytic/mongokit';
schema.add({ _searchKeys: searchKeysPath() });
schema.index({ organizationId: 1, _searchKeys: 1 }); // tenant first when scoped
const repo = new Repository(Model, [], {}, { searchMode: 'prefix', searchFields: ['name', 'code'] });
await repo.getAll({ search: 'moh ali', mode: 'offset', page: 1, limit: 10 }, { organizationId });
```

Unscoped models can use `searchKeysIndex()`, which returns `{ fields, options }` for `schema.index`. Keys are rewritten on every repo write path.
Writes that skip the repo (raw model, an auth adapter) must call `buildSearchKeys` or be repaired with `rebuildSearchKeys`. Client-side highlight with
`findSearchMatches` from `@classytic/mongokit/search` (mongoose-free).
Folding: case, accents, tashkeel, `أ إ آ ٱ` to `ا`, `ة` to `ه`, `ى` to `ي`, Arabic-Indic digits. To OR the keys with a plain prefix on a code field
(not tokenised), build the filter yourself: `{ $or: [prefixSearchFilter(q, { keysField: repo.searchKeysField }), { code: { $regex: '^' + escaped } }] }`
(drop the first arm when it is `null`) and pass it as `filters`; `search` itself ANDs with `filters`.

## QueryParser

`new QueryParser({ schema, allowedFilterFields, allowedSortFields, maxLimit, searchMode, searchFields, invalidInput, allowedLookupCollections })`.
`parse(req.query)` returns `{ filters, sort, page, limit, after, select, populate, lookups, search }`, ready for `repo.getAll`.

```
?status=active&age[gte]=18&sort=-createdAt&page=1&limit=20
?populate[orders][select]=id,total&populate[orders][match][status]=paid
?lookup[category][from]=categories&lookup[category][localField]=slug&lookup[category][foreignField]=slug&lookup[category][single]=true
```

Invalid or blocked input throws 400 `INVALID_QUERY_INPUT`; `invalidInput: 'drop'` widens results and is for trusted tooling only.
Dangerous operators and ReDoS regexes are blocked; `$lookup` targets must be listed in `allowedLookupCollections`. The same grammar as other kits is
exposed by `parseUrl` in `@classytic/repo-core/query-parser`.

## Geo

Coordinates are always `lng,lat`. Operators on a 2dsphere field:

```
?location[near]=-73.97,40.78,5000            // sorted by distance, meters optional
?location[nearSphere]=-73.97,40.78,5000
?location[withinRadius]=-73.97,40.78,5000    // unsorted, safe for counts, pagination and joins
?location[geoWithin]=minLng,minLat,maxLng,maxLat
```

Out-of-range coordinates drop the clause. Declare the `2dsphere` index in the schema. `near` without a max distance cannot be counted (use
`countStrategy: 'none'`); do not combine `near` with keyset mode. Prefer `withinRadius` for paged lists. Pure builders are at
`@classytic/mongokit/query/primitives/geo`.
