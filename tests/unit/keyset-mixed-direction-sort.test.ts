/**
 * `validateKeysetSort` accepts mixed directions.
 *
 * `{ priority: 1, createdAt: -1 }` is the ESR-shaped compound index; the keyset
 * predicate is a per-position tuple comparison, so nothing about it requires
 * the directions to agree. The old rejection pushed those callers onto
 * `skip(n)` — the cost keyset exists to avoid.
 */

import { describe, expect, it } from 'vitest';
import { validateKeysetSort } from '../../src/pagination/utils/sort.js';

describe('validateKeysetSort — mixed directions', () => {
  it('accepts a mixed-direction compound sort', () => {
    expect(() => validateKeysetSort({ priority: 1, createdAt: -1 })).not.toThrow();
  });

  it('keeps the _id direction the caller gave, even when it differs from the primary', () => {
    expect(validateKeysetSort({ score: 1, _id: -1 })).toEqual({ score: 1, _id: -1 });
  });

  it('an absent _id still follows the primary field — unchanged for every existing caller', () => {
    expect(validateKeysetSort({ createdAt: -1 })).toEqual({ createdAt: -1, _id: -1 });
    expect(validateKeysetSort({ priority: 1, createdAt: -1 })).toEqual({
      priority: 1,
      createdAt: -1,
      _id: 1,
    });
  });

  it('still rejects a direction that is not 1 or -1', () => {
    expect(() => validateKeysetSort({ a: 0 as never })).toThrow(/must be 1 or -1/);
  });
});
