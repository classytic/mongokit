/**
 * A `field[regex]` runs only if repo-core's analyser calls it safe. An unsafe pattern is REFUSED —
 * never rewritten to a literal, which would silently change what the caller asked for.
 */

import { describe, expect, it, vi } from 'vitest';
import { QueryParser } from '../../src/query/QueryParser.js';
import * as logger from '../../src/utils/logger.js';

const strict = new QueryParser();
const parseRegex = (parser: QueryParser, pattern: string) =>
  (parser.parse({ name: { regex: pattern } }).filters.name as Record<string, unknown> | undefined)
    ?.$regex;

const HOSTILE = {
  'too many unbounded quantifiers (>20)': 'a*'.repeat(25),
  'too many nested groups (>8)': `${'('.repeat(10)}a${')'.repeat(10)}`,
  'too many alternations (>10)': Array.from({ length: 12 }, (_, i) => `opt${i}`).join('|'),
  'group x quantifier density (>40)': '(a*)(b+)(c*)(d+)(e*)(f+)(g*)(h+)i+',
  'no nested (.+)+ but 26 unbounded quantifiers':
    'x*y*z*w*v*u*t*s*r*q*p*o*n*m*l*k*j*i*h*g*f*e*d*c*b*a*',
};

describe('QueryParser — regex complexity budget', () => {
  it('accepts a legitimate pattern untouched', () => {
    expect(parseRegex(strict, '^user[0-9]+')).toBe('^user[0-9]+');
  });

  it('accepts many ESCAPED quantifiers — a literal `*` is not a quantifier', () => {
    expect(parseRegex(strict, '\\*'.repeat(25))).toBe('\\*'.repeat(25));
  });

  for (const [label, pattern] of Object.entries(HOSTILE)) {
    it(`refuses ${label} with a 400`, () => {
      expect(() => strict.parse({ name: { regex: pattern } })).toThrow(
        expect.objectContaining({ status: 400, code: 'INVALID_QUERY_INPUT' }),
      );
    });
  }

  it('drop mode removes the filter and says why — never a rewritten pattern', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const drop = new QueryParser({ invalidInput: 'drop' });
    expect(parseRegex(drop, 'a*'.repeat(25))).toBeUndefined();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('regex refused'))).toBe(true);
    warnSpy.mockRestore();
  });
});
