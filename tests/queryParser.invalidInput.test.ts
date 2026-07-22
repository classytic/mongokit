/**
 * QueryParser `invalidInput` policy tests (3.25)
 *
 * `'drop'` (default) preserves the legacy warn-and-drop behavior.
 * `'throw'` makes the parser fail-closed at API boundaries: invalid or
 * disallowed input raises HTTP 400 (`code: 'INVALID_QUERY_INPUT'`) instead
 * of silently broadening the query.
 */

import { describe, expect, it } from 'vitest';
import { QueryParser } from '../src/index.js';

interface HttpErrorLike extends Error {
  status?: number;
  code?: string;
}

function expect400(fn: () => unknown): HttpErrorLike {
  let caught: HttpErrorLike | undefined;
  try {
    fn();
  } catch (err) {
    caught = err as HttpErrorLike;
  }
  expect(caught, 'expected parser to throw').toBeDefined();
  expect(caught?.status).toBe(400);
  expect(caught?.code).toBe('INVALID_QUERY_INPUT');
  return caught as HttpErrorLike;
}

describe("QueryParser invalidInput: 'throw'", () => {
  const parser = new QueryParser({ invalidInput: 'throw' });

  it('throws 400 on dangerous top-level operators', () => {
    expect400(() => parser.parse({ $where: 'this.x == 1' }));
  });

  it('throws 400 on dangerous bracket operators', () => {
    expect400(() => parser.parse({ 'field[where]': '1' }));
  });

  it('throws 400 on filter fields outside the allowlist', () => {
    const p = new QueryParser({ invalidInput: 'throw', allowedFilterFields: ['status'] });
    expect400(() => p.parse({ role: 'admin' }));
    // Allowed field still parses.
    expect(p.parse({ status: 'active' }).filters).toEqual({ status: 'active' });
  });

  it('throws 400 on operators outside the allowlist', () => {
    const p = new QueryParser({ invalidInput: 'throw', allowedOperators: ['eq', 'in'] });
    expect400(() => p.parse({ 'age[gte]': '18' }));
  });

  it('throws 400 on sort fields outside the allowlist', () => {
    const p = new QueryParser({ invalidInput: 'throw', allowedSortFields: ['createdAt'] });
    expect400(() => p.parse({ sort: '-secretRank' }));
  });

  it('throws 400 on non-numeric range operator values', () => {
    expect400(() => parser.parse({ 'score[gte]': 'not-a-number' }));
  });

  it('throws 400 on over-deep filters instead of matching everything', () => {
    // Depth increments when a filter value is a nested object; maxFilterDepth: 0
    // makes any nested-object filter over-deep.
    const p = new QueryParser({ invalidInput: 'throw', maxFilterDepth: 0 });
    expect400(() => p.parse({ field: { nested: { deeper: '1' } } }));
  });

  it('throws 400 on blocked lookup collections', () => {
    const p = new QueryParser({
      invalidInput: 'throw',
      allowedLookupCollections: ['departments'],
    });
    expect400(() => p.parse({ lookup: { secret: 'slug' } }));
  });

  it('throws 400 on lookups missing localField/foreignField', () => {
    expect400(() => parser.parse({ lookup: { department: { from: 'departments' } } }));
  });

  it('throws 400 on dangerous populate paths', () => {
    expect400(() => parser.parse({ populate: { $where: 'x' } }));
  });

  it('throws 400 on dangerous aggregation operators', () => {
    const p = new QueryParser({ invalidInput: 'throw', enableAggregations: true });
    expect400(() => p.parse({ aggregate: { match: { $where: 'this.x' } } }));
  });

  it('throws 400 on unsupported aggregation stages', () => {
    const p = new QueryParser({ invalidInput: 'throw', enableAggregations: true });
    expect400(() => p.parse({ aggregate: { unionWith: { coll: 'other' } } }));
  });

  it('throws 400 on unparseable between values', () => {
    expect400(() => parser.parse({ 'created[between]': 'garbage,alsogarbage' }));
  });

  it('throws 400 on explicit regex operator with pathological patterns', () => {
    expect400(() => parser.parse({ 'name[regex]': '(a+)+b{1,9999}' }));
  });

  it('does NOT throw for literal-semantics input: search terms and contains', () => {
    // `search` and `contains`/`like` are literal substrings — special regex
    // chars are escaped, never rejected.
    const p = new QueryParser({
      invalidInput: 'throw',
      searchMode: 'regex',
      searchFields: ['name'],
    });
    expect(() => p.parse({ search: 'c++ (parens) {braces}' })).not.toThrow();
    expect(() => p.parse({ 'name[contains]': 'a+b++' })).not.toThrow();
    expect(() => p.parse({ 'name[like]': '100% {legit}' })).not.toThrow();
  });

  it('does NOT throw for valid queries', () => {
    const result = parser.parse({
      status: 'active',
      'age[gte]': '18',
      'tags[in]': 'a,b',
      sort: '-createdAt',
      page: '2',
      limit: '10',
    });
    expect(result.filters.status).toBe('active');
    expect(result.filters.age).toEqual({ $gte: 18 });
    expect(result.page).toBe(2);
  });

  it('still caps limit instead of throwing (clamping is not invalid input)', () => {
    const p = new QueryParser({ invalidInput: 'throw', maxLimit: 50 });
    expect(p.parse({ limit: '5000' }).limit).toBe(50);
  });

  it('throws 400 on non-integer / garbage page and limit', () => {
    expect400(() => parser.parse({ page: 'abc' }));
    expect400(() => parser.parse({ page: '2garbage' })); // pre-3.25 parseInt → 2
    expect400(() => parser.parse({ page: '-1' }));
    expect400(() => parser.parse({ page: '0' }));
    expect400(() => parser.parse({ page: '1.5' }));
    expect400(() => parser.parse({ limit: 'abc' })); // pre-3.25 → silent 20
    expect400(() => parser.parse({ limit: '-5' }));
    expect400(() => parser.parse({ limit: '0' }));
  });

  it('accepts valid integer page/limit and clamps over-max limit', () => {
    const p = new QueryParser({ invalidInput: 'throw', maxLimit: 100 });
    expect(p.parse({ page: '3', limit: '25' }).page).toBe(3);
    expect(p.parse({ page: '3', limit: '25' }).limit).toBe(25);
    // absent page → undefined, absent limit → default 20
    const bare = p.parse({});
    expect(bare.page).toBeUndefined();
    expect(bare.limit).toBe(20);
    // over-max still clamps, never throws
    expect(p.parse({ limit: '9999' }).limit).toBe(100);
  });
});

describe('QueryParser invalidInput default', () => {
  it("defaults to 'throw' — fail-closed out of the box (3.25)", () => {
    const parser = new QueryParser();
    expect400(() => parser.parse({ $where: 'x', status: 'active' }));
  });
});

describe("QueryParser invalidInput: 'drop' (explicit opt-out)", () => {
  it('drops dangerous operators, rest of the query survives', () => {
    const parser = new QueryParser({ invalidInput: 'drop' });
    const result = parser.parse({ $where: 'x', status: 'active' });
    expect(result.filters).toEqual({ status: 'active' });
  });

  it('falls back to defaults on garbage page/limit instead of throwing', () => {
    const parser = new QueryParser({ invalidInput: 'drop', maxLimit: 100 });
    const result = parser.parse({ page: 'abc', limit: '-5' });
    expect(result.page).toBeUndefined(); // rejected → omitted
    expect(result.limit).toBe(20); // rejected → default
  });

  it('drops disallowed filter fields without throwing', () => {
    const parser = new QueryParser({ invalidInput: 'drop', allowedFilterFields: ['status'] });
    const result = parser.parse({ status: 'active', role: 'admin' });
    expect(result.filters).toEqual({ status: 'active' });
  });

  it('drops invalid between values entirely (no `{ field: {} }` artifact)', () => {
    const parser = new QueryParser({ invalidInput: 'drop' });
    const result = parser.parse({ 'created[between]': 'garbage,alsogarbage' });
    // Pre-3.25 this produced `{ created: {} }` — an equality match against
    // the literal empty object.
    expect(result.filters.created).toBeUndefined();
  });
});
