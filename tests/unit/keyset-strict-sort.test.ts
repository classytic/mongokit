/**
 * Unit tests for `validateKeysetSort` allowlist mode.
 *
 * Pure — no mongo. Pins the contract for `PaginationConfig.strictKeysetSortFields`.
 */

import { describe, expect, it } from 'vitest';
import { validateKeysetSort } from '../../src/pagination/utils/sort.js';

describe('validateKeysetSort — allowlist mode', () => {
  it('without allowlist, any primary field is accepted (legacy behavior)', () => {
    expect(() => validateKeysetSort({ createdAt: -1 })).not.toThrow();
    expect(() => validateKeysetSort({ arbitraryField: 1 })).not.toThrow();
  });

  it('empty allowlist behaves as "no allowlist" — backward compatible', () => {
    expect(() => validateKeysetSort({ createdAt: -1 }, [])).not.toThrow();
  });

  it('rejects a primary field not on the allowlist', () => {
    expect(() => validateKeysetSort({ nullableField: -1 }, ['createdAt', 'score'])).toThrow(
      /strictKeysetSortFields/,
    );
  });

  it('accepts a primary field on the allowlist', () => {
    const sort = validateKeysetSort({ createdAt: -1 }, ['createdAt']);
    expect(sort).toEqual({ createdAt: -1, _id: -1 });
  });

  it('accepts _id-only sort regardless of allowlist (always safe)', () => {
    const sort = validateKeysetSort({ _id: -1 }, ['unrelatedField']);
    expect(sort).toEqual({ _id: -1 });
  });

  it('compound sort — all non-_id fields must be on allowlist', () => {
    expect(() => validateKeysetSort({ createdAt: -1, unknownField: -1 }, ['createdAt'])).toThrow(
      /unknownField/,
    );

    // Both on allowlist: OK.
    expect(() =>
      validateKeysetSort({ createdAt: -1, score: -1 }, ['createdAt', 'score']),
    ).not.toThrow();
  });

  it('error message lists the allowlist and points to the config knob', () => {
    try {
      validateKeysetSort({ mystery: -1 }, ['createdAt']);
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('mystery');
      expect(msg).toContain('createdAt');
      expect(msg).toContain('strictKeysetSortFields');
    }
  });

  it('a mixed-direction sort passes the allowlist like any other — direction is not a gate', () => {
    // Mixed directions are a supported keyset shape (the ESR-shaped compound
    // index); `buildKeysetFilter` picks the operator per position. The
    // allowlist guards WHICH fields may lead a keyset sort, never their direction.
    expect(validateKeysetSort({ createdAt: -1, score: 1 }, ['createdAt', 'score'])).toEqual({
      createdAt: -1,
      score: 1,
      _id: -1,
    });
  });
});
