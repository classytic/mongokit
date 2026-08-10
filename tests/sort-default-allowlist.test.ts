/**
 * The parser must not reject its OWN default sort.
 *
 * `sort = '-createdAt'` was a destructuring default, so an absent `?sort=` became
 * `-createdAt` and was then validated like caller input. A parser configured with
 * `allowedSortFields` that omits `createdAt` therefore threw on `parse({})` — an
 * EMPTY query — because rejection has thrown since 3.25.
 *
 * Downstream that meant every list call on such a resource answered 400
 * (`Blocked sort field not in allowlist: createdAt`), through REST and through
 * arc's MCP tools alike, with no request the caller could make to avoid it. It
 * survived 2,797 tests because nothing here combined a restricted sort allowlist
 * with an empty query.
 */

import { describe, expect, it } from 'vitest';
import { QueryParser } from '../src/query/QueryParser.js';

describe('default sort vs allowedSortFields', () => {
  it('does not apply — or reject — the default when the allowlist forbids it', () => {
    const qp = new QueryParser({ allowedSortFields: ['name', 'price'] });
    expect(() => qp.parse({})).not.toThrow();
    expect(qp.parse({}).sort).toBeUndefined();
  });

  it('still applies the default when the allowlist permits it', () => {
    const qp = new QueryParser({ allowedSortFields: ['createdAt', 'name'] });
    expect(qp.parse({}).sort).toEqual({ createdAt: -1 });
  });

  it('still applies the default when there is no allowlist at all', () => {
    expect(new QueryParser({}).parse({}).sort).toEqual({ createdAt: -1 });
  });

  it('STILL rejects a sort the caller actually sent — fail-closed is unchanged', () => {
    // The 3.25 behaviour this fix must not weaken: a caller naming a blocked
    // field gets a 400, because that IS a caller error with someone to report to.
    const qp = new QueryParser({ allowedSortFields: ['name'] });
    expect(() => qp.parse({ sort: '-createdAt' })).toThrow(/not in allowlist/);
  });

  it('accepts a permitted explicit sort', () => {
    const qp = new QueryParser({ allowedSortFields: ['name'] });
    expect(qp.parse({ sort: 'name' }).sort).toEqual({ name: 1 });
  });

  it('withdraws a MULTI-field default when any field is forbidden', () => {
    // The check is all-or-nothing: a partially-applied default would silently
    // change ordering rather than honour the declaration.
    const qp = new QueryParser({ allowedSortFields: ['name'] });
    expect(qp.parse({}).sort).toBeUndefined();
  });
});
