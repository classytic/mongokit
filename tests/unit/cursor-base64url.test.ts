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
      const token = encodeCursor(doc, 'createdAt', { createdAt: -1, score: 1, _id: -1 });
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('round-trips through its own decoder', () => {
    const doc = docs[0];
    const cursor = decodeCursor(encodeCursor(doc, 'createdAt', { createdAt: -1, _id: -1 }));
    expect(cursor.id).toEqual(doc._id);
    expect(cursor.value).toEqual(doc.createdAt);
  });
});

describe('a token issued under the OLD alphabet still decodes', () => {
  it('accepts standard base64 with + / and padding', () => {
    const doc = docs[1];
    const urlSafe = encodeCursor(doc, 'createdAt', { createdAt: -1, _id: -1 });
    // Re-encode the same payload the way the old encoder did.
    const legacy = Buffer.from(Buffer.from(urlSafe, 'base64url')).toString('base64');
    expect(legacy).not.toBe(urlSafe);

    const cursor = decodeCursor(legacy);
    expect(cursor.id).toEqual(doc._id);
  });
});
