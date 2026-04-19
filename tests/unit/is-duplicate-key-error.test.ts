/**
 * isDuplicateKeyError — narrow, authoritative duplicate-key classifier.
 *
 * Contract (arc 2.9.1 depends on these exact semantics):
 *   - Returns true ONLY for driver-native dup-key signals
 *     (`code === 11000` or `codeName === 'DuplicateKey'`).
 *   - Returns false for every other server-side Mongo error
 *     (WriteConflict, NotWritablePrimary, ExceededTimeLimit, …) so
 *     transactional retries are not silently swallowed as "already saved".
 */

import { describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { isDuplicateKeyError } from '../../src/utils/error.js';

describe('isDuplicateKeyError (pure utility)', () => {
  it('returns true for MongoDB E11000 (code: 11000)', () => {
    const err = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('returns true when codeName === "DuplicateKey" (server-side canonical)', () => {
    const err = Object.assign(new Error('duplicate key'), { codeName: 'DuplicateKey' });
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it('returns false for WriteConflict (code: 112) — transactional retry signal', () => {
    const err = Object.assign(new Error('WriteConflict'), {
      code: 112,
      codeName: 'WriteConflict',
    });
    expect(isDuplicateKeyError(err)).toBe(false);
  });

  it('returns false for NotWritablePrimary (code: 10107) — replica set failover', () => {
    const err = Object.assign(new Error('not primary'), {
      code: 10107,
      codeName: 'NotWritablePrimary',
    });
    expect(isDuplicateKeyError(err)).toBe(false);
  });

  // Defensive — guard against obvious footguns.
  it('returns false for null / undefined / primitive errors', () => {
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError('E11000' as unknown)).toBe(false);
    expect(isDuplicateKeyError(11000 as unknown)).toBe(false);
  });

  it('returns false for a bare Error with no mongo fields', () => {
    expect(isDuplicateKeyError(new Error('boom'))).toBe(false);
  });
});

describe('Repository.isDuplicateKeyError (instance method)', () => {
  // The Repository instance method is a thin delegate — we don't need a
  // live connection to prove the predicate. Construct a minimal stub so
  // the method call doesn't require mongoose init.
  const stubModel = {
    modelName: 'Stub',
    schema: { indexes: () => [] },
  } as unknown as import('mongoose').Model<unknown>;
  const repo = new Repository(stubModel, [], {}, { pluginOrderChecks: 'off' });

  it('matches the pure utility for all four contract cases', () => {
    expect(repo.isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(repo.isDuplicateKeyError({ codeName: 'DuplicateKey' })).toBe(true);
    expect(repo.isDuplicateKeyError({ code: 112, codeName: 'WriteConflict' })).toBe(false);
    expect(repo.isDuplicateKeyError({ code: 10107, codeName: 'NotWritablePrimary' })).toBe(false);
  });

  it('is exposed on the RepositoryLike surface arc 2.9.1 consumes', () => {
    // Arc's RepositoryLike declares `isDuplicateKeyError?(err): boolean`.
    // This assertion locks the method shape so renaming breaks here loudly.
    expect(typeof repo.isDuplicateKeyError).toBe('function');
    expect(repo.isDuplicateKeyError.length).toBe(1);
  });
});
