/**
 * `QueryParser.parse` returns `before` and `mode` beside `after`, and never treats them as filters.
 */

import { describe, expect, it } from 'vitest';
import { QueryParser } from '../../src/index.js';

describe('QueryParser keyset params', () => {
  const parser = new QueryParser();

  it('returns before and mode, and they are not filters', () => {
    const parsed = parser.parse({ before: 'tok', mode: 'keyset', status: 'open' });
    expect(parsed.before).toBe('tok');
    expect(parsed.mode).toBe('keyset');
    expect(parsed.filters).toEqual({ status: 'open' });
  });

  it('refuses after with before, and an unknown mode', () => {
    expect(() => parser.parse({ after: 'a', before: 'b' })).toThrow();
    expect(() => parser.parse({ mode: 'sideways' })).toThrow();
  });
});
