/**
 * Cursor tokens must survive a query string unescaped.
 *
 * Standard base64 puts `+` in a token, and `?after=abc+def` reaches the server
 * as `abc def`. The URL-safe alphabet has no such character. A token issued
 * under the old alphabet must still decode — clients hold them.
 */

import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/pagination/utils/cursor.js';

/** Cursors are bound to a scope fingerprint; these codec tests use a fixed one. */
const SCOPE = 'unit-test-scope';

// Enough entropy in the payload that standard base64 WOULD produce `+` or `/`
// for some of these — the property is asserted over many docs, not one.
const docs = Array.from({ length: 200 }, (_, i) => ({
  _id: new mongoose.Types.ObjectId(),
  createdAt: new Date(1_700_000_000_000 + i * 7_919_137),
  score: (i * 2654435761) % 1_000_003,
}));

describe('encodeCursor emits base64url', () => {
  it('never contains +, / or = across 200 tokens', () => {
    for (const doc of docs) {
      const token = encodeCursor(doc, 'createdAt', { createdAt: -1, score: 1, _id: -1 }, 1, SCOPE);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('round-trips through its own decoder', () => {
    const doc = docs[0];
    const cursor = decodeCursor(encodeCursor(doc, 'createdAt', { createdAt: -1, _id: -1 }, 1, SCOPE));
    expect(cursor.id).toEqual(doc._id);
    expect(cursor.value).toEqual(doc.createdAt);
  });
});

describe('a token issued under the OLD alphabet still decodes', () => {
  it('accepts standard base64 with + / and padding', () => {
    // Find a payload whose standard-base64 form differs (a + / or padding), so the case is real.
    // The compound sort carries `score` (varying length), so some payload needs padding or + /.
    const sort = { createdAt: -1, score: 1, _id: -1 } as const;
    const found = docs
      .map((d) => ({ d, urlSafe: encodeCursor(d, 'createdAt', sort, 1, SCOPE) }))
      .map((x) => ({ ...x, legacy: Buffer.from(x.urlSafe, 'base64url').toString('base64') }))
      .find((x) => x.legacy !== x.urlSafe);
    if (!found) throw new Error('fixture produced no token whose two alphabets differ');
    const { d: doc, urlSafe, legacy } = found;
    expect(legacy).not.toBe(urlSafe);

    const cursor = decodeCursor(legacy);
    expect(cursor.id).toEqual(doc._id);
  });
});
