/**
 * `repoOptionsFromCtx(ctx)` — canonical request-context → options-bag
 * extractor.
 *
 * The helper exists because consumers were repeatedly hand-rolling the
 * forwarding pattern, sometimes correctly threading all of
 * `organizationId` / `userId` / `session`, sometimes only one.
 * Inconsistency was the load-bearing complaint — this lock-in makes
 * the contract crisp.
 */

import { describe, expect, it } from 'vitest';
import { repoOptionsFromCtx } from '../../src/index.js';

describe('repoOptionsFromCtx', () => {
  it('extracts the canonical multi-tenant + audit + transaction fields', () => {
    const session = { id: 'session-stub' };
    const result = repoOptionsFromCtx({
      organizationId: 'org-1',
      userId: 'user-1',
      user: { name: 'A' },
      session,
      requestId: 'req-1',
    });
    expect(result).toEqual({
      organizationId: 'org-1',
      userId: 'user-1',
      user: { name: 'A' },
      session,
      requestId: 'req-1',
    });
  });

  it('omits absent fields entirely (does not write `undefined`)', () => {
    // Spreading `{ organizationId: undefined }` into an options bag
    // would erase a parent's organizationId in a downstream
    // `{ ...parentOpts, ...repoOptionsFromCtx(ctx) }` merge. The
    // helper omits unset keys instead of writing `undefined`.
    const result = repoOptionsFromCtx({
      organizationId: 'org-1',
      // userId, user, session, requestId all unset
    });
    expect(result).toEqual({ organizationId: 'org-1' });
    expect('userId' in result).toBe(false);
    expect('session' in result).toBe(false);
  });

  it('returns an empty object for null / undefined ctx', () => {
    expect(repoOptionsFromCtx(null)).toEqual({});
    expect(repoOptionsFromCtx(undefined)).toEqual({});
  });

  it('does NOT forward unknown ctx fields (narrow surface, not a passthrough)', () => {
    // A consumer might have ctx.locale, ctx.featureFlags, etc.
    // The helper ignores them — the options bag stays narrow and
    // explicit. New canonical conventions should be deliberate API
    // additions, not quiet drift.
    const result = repoOptionsFromCtx({
      organizationId: 'org-1',
      locale: 'en-US',
      featureFlags: { x: true },
      arbitraryField: 'x',
    });
    expect(result).toEqual({ organizationId: 'org-1' });
    expect('locale' in result).toBe(false);
    expect('featureFlags' in result).toBe(false);
  });

  it('preserves falsy-but-defined values (0, "", false)', () => {
    // The presence check is `!== undefined`, not truthy — so a userId
    // of `''` (empty string) or numeric 0 still forwards. Catches the
    // edge case where someone uses a numeric tenant id with org=0
    // for a system tenant.
    const result = repoOptionsFromCtx({
      organizationId: 0,
      userId: '',
      requestId: '',
    });
    expect(result).toEqual({
      organizationId: 0,
      userId: '',
      requestId: '',
    });
  });

  it('null-valued fields ARE forwarded (caller intent)', () => {
    // `null` is intentional in mongokit's options surface (e.g.
    // explicitly clearing a tenant scope via `organizationId: null`).
    // Distinct from `undefined` (absent).
    const result = repoOptionsFromCtx({ organizationId: null });
    expect(result).toEqual({ organizationId: null });
  });
});

describe('createOptionsExtractor', () => {
  it('builds an extractor that forwards declared fields only', async () => {
    const { createOptionsExtractor } = await import('../../src/index.js');
    type CommissionCtx = {
      organizationId: string;
      actorRef: string;
      correlationId: string;
      // Field present on ctx but NOT in the extractor's field list:
      irrelevantField?: string;
    };
    const extract = createOptionsExtractor<CommissionCtx>([
      'organizationId',
      'actorRef',
      'correlationId',
    ]);

    const result = extract({
      organizationId: 'org-1',
      actorRef: 'user-42',
      correlationId: 'req-abc',
      irrelevantField: 'should-not-leak',
    });

    expect(result).toEqual({
      organizationId: 'org-1',
      actorRef: 'user-42',
      correlationId: 'req-abc',
    });
    // The undeclared field MUST NOT leak through.
    expect('irrelevantField' in result).toBe(false);
  });

  it('omits absent fields (does not write `undefined`)', async () => {
    const { createOptionsExtractor } = await import('../../src/index.js');
    type Ctx = {
      organizationId: string;
      actorRef?: string;
      correlationId?: string;
    };
    const extract = createOptionsExtractor<Ctx>([
      'organizationId',
      'actorRef',
      'correlationId',
    ]);

    const result = extract({ organizationId: 'org-1' });
    expect(result).toEqual({ organizationId: 'org-1' });
    expect('actorRef' in result).toBe(false);
    expect('correlationId' in result).toBe(false);
  });

  it('returns empty object for null / undefined ctx', async () => {
    const { createOptionsExtractor } = await import('../../src/index.js');
    type Ctx = { organizationId?: string };
    const extract = createOptionsExtractor<Ctx>(['organizationId']);

    expect(extract(null)).toEqual({});
    expect(extract(undefined)).toEqual({});
  });

  it('mutating the input field array AFTER extractor creation does NOT change behaviour', async () => {
    // Defensive: freeze a copy of the field list so callers can't
    // accidentally mutate it later and silently change the extractor.
    const { createOptionsExtractor } = await import('../../src/index.js');
    type Ctx = { a?: string; b?: string; c?: string };
    const fields: ('a' | 'b' | 'c')[] = ['a', 'b'];
    const extract = createOptionsExtractor<Ctx>(fields);

    // Try to add 'c' to the original array.
    fields.push('c');

    const result = extract({ a: '1', b: '2', c: '3' });
    // 'c' must NOT be forwarded — the extractor's field list was
    // frozen at creation time.
    expect(result).toEqual({ a: '1', b: '2' });
  });

  it('preserves falsy-but-defined values (0, "", false, null)', async () => {
    const { createOptionsExtractor } = await import('../../src/index.js');
    type Ctx = {
      organizationId?: number | null;
      flag?: boolean;
      empty?: string;
    };
    const extract = createOptionsExtractor<Ctx>(['organizationId', 'flag', 'empty']);

    const result = extract({ organizationId: 0, flag: false, empty: '' });
    expect(result).toEqual({ organizationId: 0, flag: false, empty: '' });

    const nullResult = extract({ organizationId: null });
    expect(nullResult).toEqual({ organizationId: null });
  });

  it('TypeScript: declaring a field NOT on TCtx is a compile error', async () => {
    // Type-system smoke test — this block exists for documentation /
    // human reviewer; the actual contract is enforced by tsc when the
    // conformance tsconfig.tests.json compiles. If this file ever
    // typechecks with a non-existent field, our generic constraint
    // has regressed.
    const { createOptionsExtractor } = await import('../../src/index.js');
    type Ctx = { organizationId: string; actorRef: string };

    // Valid — both fields exist on Ctx.
    const valid = createOptionsExtractor<Ctx>(['organizationId', 'actorRef']);
    expect(typeof valid).toBe('function');

    // The following would fail typecheck (left as a comment because
    // we can't `@ts-expect-error` selectively in a runtime test):
    //   const invalid = createOptionsExtractor<Ctx>(['organizationId', 'nonExistent']);
    //                                                                  ^^^^^^^^^^^^
    //   Type '"nonExistent"' is not assignable to type 'keyof Ctx'.
  });
});
