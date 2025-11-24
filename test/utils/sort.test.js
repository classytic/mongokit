import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSort,
  validateKeysetSort,
  getPrimaryField,
  getDirection
} from '../../src/pagination/utils/sort.js';

describe('Sort Utils', () => {
  describe('normalizeSort', () => {
    it('should put primary field before _id', () => {
      const sort = { _id: -1, createdAt: -1 };
      const normalized = normalizeSort(sort);

      const keys = Object.keys(normalized);
      assert.strictEqual(keys[0], 'createdAt');
      assert.strictEqual(keys[1], '_id');
    });

    it('should handle _id only sort', () => {
      const sort = { _id: 1 };
      const normalized = normalizeSort(sort);

      assert.deepStrictEqual(normalized, { _id: 1 });
    });

    it('should maintain field order except _id last', () => {
      const sort = { name: 1, _id: 1 };
      const normalized = normalizeSort(sort);

      const keys = Object.keys(normalized);
      assert.strictEqual(keys[0], 'name');
      assert.strictEqual(keys[1], '_id');
    });
  });

  describe('validateKeysetSort', () => {
    it('should auto-add _id for single field', () => {
      const sort = { createdAt: -1 };
      const validated = validateKeysetSort(sort);

      assert.deepStrictEqual(validated, { createdAt: -1, _id: -1 });
    });

    it('should accept _id only', () => {
      const sort = { _id: 1 };
      const validated = validateKeysetSort(sort);

      assert.deepStrictEqual(validated, { _id: 1 });
    });

    it('should accept field + _id with matching direction', () => {
      const sort = { name: 1, _id: 1 };
      const validated = validateKeysetSort(sort);

      assert.deepStrictEqual(validated, { name: 1, _id: 1 });
    });

    it('should reject field + _id with mismatched direction', () => {
      const sort = { name: 1, _id: -1 };

      assert.throws(
        () => validateKeysetSort(sort),
        /direction must match/
      );
    });

    it('should reject more than 2 fields', () => {
      const sort = { name: 1, age: 1, _id: 1 };

      assert.throws(
        () => validateKeysetSort(sort),
        /only supports single field/
      );
    });

    it('should reject 2 fields without _id', () => {
      const sort = { name: 1, age: 1 };

      assert.throws(
        () => validateKeysetSort(sort),
        /requires _id/
      );
    });
  });

  describe('getPrimaryField', () => {
    it('should return primary field', () => {
      const sort = { createdAt: -1, _id: -1 };
      assert.strictEqual(getPrimaryField(sort), 'createdAt');
    });

    it('should return _id if only field', () => {
      const sort = { _id: 1 };
      assert.strictEqual(getPrimaryField(sort), '_id');
    });
  });

  describe('getDirection', () => {
    it('should return field direction', () => {
      const sort = { createdAt: -1, _id: -1 };
      assert.strictEqual(getDirection(sort, 'createdAt'), -1);
    });
  });
});
