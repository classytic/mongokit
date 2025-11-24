import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { encodeCursor, decodeCursor, validateCursorSort } from '../../src/pagination/utils/cursor.js';

describe('Cursor Utils', () => {
  it('should encode and decode string value', () => {
    const doc = { name: 'Alice', _id: new mongoose.Types.ObjectId() };
    const sort = { name: 1, _id: 1 };

    const encoded = encodeCursor(doc, 'name', sort);
    const decoded = decodeCursor(encoded);

    assert.strictEqual(decoded.value, 'Alice');
    assert.ok(decoded.id.equals(doc._id));
    assert.deepStrictEqual(decoded.sort, sort);
  });

  it('should encode and decode date value', () => {
    const date = new Date('2024-01-15');
    const doc = { createdAt: date, _id: new mongoose.Types.ObjectId() };
    const sort = { createdAt: -1, _id: -1 };

    const encoded = encodeCursor(doc, 'createdAt', sort);
    const decoded = decodeCursor(encoded);

    assert.strictEqual(decoded.value.toISOString(), date.toISOString());
    assert.ok(decoded.id.equals(doc._id));
  });

  it('should encode and decode number value', () => {
    const doc = { age: 25, _id: new mongoose.Types.ObjectId() };
    const sort = { age: 1, _id: 1 };

    const encoded = encodeCursor(doc, 'age', sort);
    const decoded = decodeCursor(encoded);

    assert.strictEqual(decoded.value, 25);
  });

  it('should encode and decode boolean value', () => {
    const doc = { active: true, _id: new mongoose.Types.ObjectId() };
    const sort = { active: -1, _id: -1 };

    const encoded = encodeCursor(doc, 'active', sort);
    const decoded = decodeCursor(encoded);

    assert.strictEqual(decoded.value, true);
  });

  it('should encode and decode ObjectId value', () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = { userId, _id: new mongoose.Types.ObjectId() };
    const sort = { userId: 1, _id: 1 };

    const encoded = encodeCursor(doc, 'userId', sort);
    const decoded = decodeCursor(encoded);

    assert.ok(decoded.value.equals(userId));
  });

  it('should throw on invalid cursor token', () => {
    assert.throws(() => decodeCursor('invalid'), /Invalid cursor token/);
  });

  it('should validate matching cursor sort', () => {
    const sort = { createdAt: -1, _id: -1 };
    assert.doesNotThrow(() => validateCursorSort(sort, sort));
  });

  it('should throw on mismatched cursor sort', () => {
    const cursorSort = { createdAt: -1, _id: -1 };
    const currentSort = { name: 1, _id: 1 };

    assert.throws(
      () => validateCursorSort(cursorSort, currentSort),
      /Cursor sort does not match/
    );
  });
});
