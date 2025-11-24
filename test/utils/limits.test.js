import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLimit,
  validatePage,
  shouldWarnDeepPagination,
  calculateSkip,
  calculateTotalPages
} from '../../src/pagination/utils/limits.js';

describe('Limits Utils', () => {
  const config = {
    maxLimit: 100,
    maxPage: 10000,
    deepPageThreshold: 100
  };

  describe('validateLimit', () => {
    it('should return limit within bounds', () => {
      assert.strictEqual(validateLimit(50, config), 50);
    });

    it('should cap at maxLimit', () => {
      assert.strictEqual(validateLimit(200, config), 100);
    });

    it('should enforce minimum of 1', () => {
      assert.strictEqual(validateLimit(0, config), 1);
      assert.strictEqual(validateLimit(-5, config), 1);
    });
  });

  describe('validatePage', () => {
    it('should return page within bounds', () => {
      assert.strictEqual(validatePage(5, config), 5);
    });

    it('should throw on exceeding maxPage', () => {
      assert.throws(
        () => validatePage(10001, config),
        /exceeds maximum/
      );
    });

    it('should enforce minimum of 1', () => {
      assert.strictEqual(validatePage(0, config), 1);
      assert.strictEqual(validatePage(-5, config), 1);
    });
  });

  describe('shouldWarnDeepPagination', () => {
    it('should return false for shallow pages', () => {
      assert.strictEqual(shouldWarnDeepPagination(50, 100), false);
    });

    it('should return true for deep pages', () => {
      assert.strictEqual(shouldWarnDeepPagination(101, 100), true);
    });

    it('should return false at threshold', () => {
      assert.strictEqual(shouldWarnDeepPagination(100, 100), false);
    });
  });

  describe('calculateSkip', () => {
    it('should calculate skip for page 1', () => {
      assert.strictEqual(calculateSkip(1, 10), 0);
    });

    it('should calculate skip for page 2', () => {
      assert.strictEqual(calculateSkip(2, 10), 10);
    });

    it('should calculate skip for page 10', () => {
      assert.strictEqual(calculateSkip(10, 20), 180);
    });
  });

  describe('calculateTotalPages', () => {
    it('should calculate exact pages', () => {
      assert.strictEqual(calculateTotalPages(100, 10), 10);
    });

    it('should round up partial pages', () => {
      assert.strictEqual(calculateTotalPages(105, 10), 11);
    });

    it('should return 0 for empty results', () => {
      assert.strictEqual(calculateTotalPages(0, 10), 0);
    });

    it('should handle single item', () => {
      assert.strictEqual(calculateTotalPages(1, 10), 1);
    });
  });
});
