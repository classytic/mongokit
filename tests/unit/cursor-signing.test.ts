/**
 * HMAC cursor signing.
 *
 * The signature itself is the easy part. What these tests actually guard is
 * every way a signature can be present and still protect nothing:
 *
 *  - an unsigned token accepted while signing is on (strip it and you are past);
 *  - a bare ObjectId accepted as a position (a second door, unsigned);
 *  - a blank secret treated as "no secret" (signing on, key guessable);
 *  - a rotated key locking out every cursor in flight.
 *
 * Each is a config that LOOKS enabled. That is the whole failure mode.
 */

import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  attachSignature,
  resolveCursorSecrets,
  verifySignature,
} from '../../src/pagination/utils/cursor-signing.js';
import {
  decodeCursor,
  encodeCursor,
  resolveCursorFilter,
} from '../../src/pagination/utils/cursor.js';

const SECRET = 'a-sufficiently-long-signing-key';
const OTHER = 'a-different-sufficiently-long-key';
const SORT = { createdAt: -1 as const, _id: -1 as const };
const doc = () => ({ _id: new mongoose.Types.ObjectId(), createdAt: new Date(1_700_000_000_000) });

describe('a signed cursor round-trips', () => {
  it('verifies and decodes back to the same position', () => {
    const d = doc();
    const token = encodeCursor(d, 'createdAt', SORT, 1, SECRET);
    const cursor = decodeCursor(token, SECRET);

    expect(cursor.id).toEqual(d._id);
    expect(cursor.value).toEqual(d.createdAt);
  });

  it('stays URL-safe — the signature must not reintroduce + or /', () => {
    for (let i = 0; i < 200; i++) {
      const token = encodeCursor(
        { _id: new mongoose.Types.ObjectId(), createdAt: new Date(1_700_000_000_000 + i * 7919) },
        'createdAt',
        SORT,
        1,
        SECRET,
      );
      expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
  });

  it('changes nothing when no secret is configured', () => {
    const d = doc();
    expect(encodeCursor(d, 'createdAt', SORT)).not.toContain('.');
    expect(decodeCursor(encodeCursor(d, 'createdAt', SORT)).id).toEqual(d._id);
  });
});

describe('a tampered cursor is refused', () => {
  it('rejects an edited payload', () => {
    const token = encodeCursor(doc(), 'createdAt', SORT, 1, SECRET);
    const [payload, sig] = token.split('.');
    // Move the position: decode, bump the sort value, re-encode. This is the
    // value-probing attack — without a signature it simply works.
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    edited.v = 0;
    const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`;

    expect(() => decodeCursor(forged, SECRET)).toThrow(/signature does not verify/i);
  });

  it('rejects a cursor signed with a key this deployment does not hold', () => {
    const token = encodeCursor(doc(), 'createdAt', SORT, 1, OTHER);
    expect(() => decodeCursor(token, SECRET)).toThrow(/signature does not verify/i);
  });

  it('rejects a truncated signature', () => {
    const token = encodeCursor(doc(), 'createdAt', SORT, 1, SECRET);
    expect(() => decodeCursor(token.slice(0, -4), SECRET)).toThrow(/signature does not verify/i);
  });
});

describe('stripping the signature does not get you past it', () => {
  it('refuses an UNSIGNED token while signing is on', () => {
    // The whole attack: remove everything after the dot.
    const unsigned = encodeCursor(doc(), 'createdAt', SORT, 1, SECRET).split('.')[0];

    expect(() => decodeCursor(unsigned, SECRET)).toThrow(/carries no signature/i);
  });

  it('refuses a BARE OBJECTID as a position while signing is on', () => {
    // The second door: `resolveCursorFilter` accepts a raw 24-hex id as a
    // fallback cursor. That carries no signature by construction, so honouring
    // it would let a caller skip verification entirely.
    const id = new mongoose.Types.ObjectId().toString();

    expect(() => resolveCursorFilter(id, SORT, 1, {}, 1, SORT, SECRET)).toThrow(
      /bare ObjectId is not accepted/i,
    );
  });

  it('still accepts a bare ObjectId when signing is OFF', () => {
    const id = new mongoose.Types.ObjectId().toString();
    expect(() => resolveCursorFilter(id, SORT, 1, {}, 1, SORT)).not.toThrow();
  });
});

describe('an unusable secret throws instead of silently not signing', () => {
  it.each([['', 0], ['short', 5], ['   ', 0], ['fifteen-chars-x', 15]] as const)(
    'rejects %p',
    (bad) => {
      expect(() => resolveCursorSecrets(bad)).toThrow(/at least 16 characters/i);
    },
  );

  it('rejects an empty rotation list', () => {
    expect(() => resolveCursorSecrets([])).toThrow(/empty list/i);
  });

  it('accepts undefined — that is "not configured", which is a real answer', () => {
    expect(resolveCursorSecrets(undefined)).toBeUndefined();
  });

  it('accepts a 16-character key (the boundary)', () => {
    expect(resolveCursorSecrets('sixteen-chars-ok')).toEqual(['sixteen-chars-ok']);
  });
});

describe('key rotation does not invalidate cursors in flight', () => {
  it('signs with the FIRST key and verifies against any', () => {
    const issuedUnderOld = encodeCursor(doc(), 'createdAt', SORT, 1, OTHER);

    // Deploy the new key first, keep the old one for verification.
    const rotating = [SECRET, OTHER];
    expect(() => decodeCursor(issuedUnderOld, rotating)).not.toThrow();

    // New cursors carry the NEW key, so the old one can be dropped later.
    const fresh = encodeCursor(doc(), 'createdAt', SORT, 1, rotating);
    expect(() => decodeCursor(fresh, [SECRET])).not.toThrow();
  });

  it('once the old key is retired, its cursors stop verifying', () => {
    const old = encodeCursor(doc(), 'createdAt', SORT, 1, OTHER);
    expect(() => decodeCursor(old, [SECRET])).toThrow(/signature does not verify/i);
  });
});

describe('turning signing OFF does not reject the tokens it issued', () => {
  it('accepts a signed token when no secret is configured', () => {
    // A rollback must not break every client mid-page.
    const d = doc();
    const signed = encodeCursor(d, 'createdAt', SORT, 1, SECRET);
    expect(decodeCursor(signed).id).toEqual(d._id);
  });
});

describe('the comparison is constant-time', () => {
  /**
   * A SOURCE assertion, not a behavioural one, and deliberately so.
   *
   * Replacing `timingSafeEqual` with `===` passes every other test in this
   * file — a timing side-channel is invisible to a functional assertion, and
   * measuring it for real is flaky enough in CI to be worse than useless. So
   * the property is pinned where it can actually be checked: the source.
   *
   * Without this the falsification pass found nothing when the comparison was
   * downgraded, which is the definition of an unguarded capability.
   */
  const source = readFileSync(
    new URL('../../src/pagination/utils/cursor-signing.ts', import.meta.url),
    'utf8',
  );

  it('uses timingSafeEqual to compare signatures', () => {
    expect(source).toContain('timingSafeEqual');
  });

  it('never compares a signature with == or ===', () => {
    // `matches()` is the only place two signatures meet.
    const body = source.slice(source.indexOf('function matches'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).not.toMatch(/[^=!]===?[^=]/);
  });
});

describe('the primitives themselves', () => {
  it('attachSignature is a no-op without secrets', () => {
    expect(attachSignature('payload', undefined)).toBe('payload');
  });

  it('verifySignature strips an unverifiable signature when unconfigured', () => {
    expect(verifySignature('payload.deadbeef', undefined)).toBe('payload');
  });

  it('splits on the LAST separator, so a payload containing one is safe', () => {
    const secrets = resolveCursorSecrets(SECRET);
    const token = attachSignature('a.b.c', secrets);
    expect(verifySignature(token, secrets)).toBe('a.b.c');
  });
});
