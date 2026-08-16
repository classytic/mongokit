import { describe, expect, it } from 'vitest';
import { compileFilterToMongo } from '../src/filter/compile.js';
import { compileFilterToMongoExpr } from '../src/filter/compile-expr.js';

/**
 * A `regex` node's `flags` must reach Mongo.
 *
 * repo-core's `FilterRegex` declares `flags?: string`, and arc's CRUD list route
 * produces one on every `?field[like]=…` request: the parsed query is normalised
 * through `toRepositoryFilter` → `policyRecordToFilter`, which turns BOTH parser
 * shapes (mongokit's `/x/i` RegExp and arc's `{$regex,$options:'i'}`) into
 * `{ op:'regex', pattern:'x', flags:'i' }`.
 *
 * The Mongo compiler used to rebuild that as `{ $regex: pattern }` — flags
 * dropped. Nothing threw. `?name[like]=heritage` returned 0 rows and
 * `?name[like]=Heritage` returned 3, against OpenAPI text promising
 * case-INSENSITIVE matching, so every operator search box in every consuming app
 * silently under-returned.
 *
 * Both compilers are asserted because they diverged: `like` honoured its
 * case-sensitivity in each, while `regex` honoured it in neither.
 */
describe('regex filter flags', () => {
  it('carries flags into $options (query form)', () => {
    expect(
      compileFilterToMongo({ op: 'regex', field: 'name', pattern: 'heritage', flags: 'i' }),
    ).toEqual({ name: { $regex: 'heritage', $options: 'i' } });
  });

  it('carries flags into $regexMatch.options (expression form)', () => {
    expect(
      compileFilterToMongoExpr({ op: 'regex', field: 'name', pattern: 'heritage', flags: 'i' }),
    ).toEqual({
      $regexMatch: { input: '$name', regex: 'heritage', options: 'i' },
    });
  });

  /**
   * No flags must NOT become `$options: undefined` — Mongo rejects an
   * `$options` key without a string value, so an absent-flags filter has to
   * compile to the bare shape rather than a key with nothing in it.
   */
  it('omits $options entirely when the node carries no flags', () => {
    expect(compileFilterToMongo({ op: 'regex', field: 'name', pattern: 'heritage' })).toEqual({
      name: { $regex: 'heritage' },
    });
    expect(compileFilterToMongoExpr({ op: 'regex', field: 'name', pattern: 'heritage' })).toEqual({
      $regexMatch: { input: '$name', regex: 'heritage' },
    });
  });
});
