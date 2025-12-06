/**
 * Utils Unit Tests
 * 
 * Tests utility functions (no MongoDB required)
 */

import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import {
  createError,
  createFieldPreset,
  getFieldsForUser,
  getMongooseProjection,
  filterResponseData,
} from '../src/index.js';
import queryParser from '../src/utils/queryParser.js';
import {
  encodeCursor,
  decodeCursor,
  validateCursorSort,
  validateCursorVersion,
} from '../src/pagination/utils/cursor.js';
import {
  validateLimit,
  validatePage,
  calculateSkip,
  calculateTotalPages,
  shouldWarnDeepPagination,
} from '../src/pagination/utils/limits.js';
import {
  normalizeSort,
  validateKeysetSort,
  invertSort,
  getPrimaryField,
} from '../src/pagination/utils/sort.js';
import { buildKeysetFilter } from '../src/pagination/utils/filter.js';

// ============================================================
// ERROR UTILITIES
// ============================================================

describe('Error Utils', () => {
  describe('createError', () => {
    it('should create error with status', () => {
      const error = createError(404, 'Not found');
      
      expect(error.message).toBe('Not found');
      expect(error.status).toBe(404);
      expect(error instanceof Error).toBe(true);
    });

    it('should work with different status codes', () => {
      expect(createError(400, 'Bad request').status).toBe(400);
      expect(createError(401, 'Unauthorized').status).toBe(401);
      expect(createError(403, 'Forbidden').status).toBe(403);
      expect(createError(500, 'Server error').status).toBe(500);
    });
  });
});

// ============================================================
// FIELD SELECTION UTILITIES
// ============================================================

describe('Field Selection Utils', () => {
  const preset = createFieldPreset({
    public: ['id', 'name', 'avatar'],
    authenticated: ['email', 'phone'],
    admin: ['createdAt', 'internalNotes'],
  });

  describe('createFieldPreset', () => {
    it('should create field preset with defaults', () => {
      const p = createFieldPreset({});
      
      expect(p.public).toEqual([]);
      expect(p.authenticated).toEqual([]);
      expect(p.admin).toEqual([]);
    });

    it('should create field preset with values', () => {
      expect(preset.public).toContain('name');
      expect(preset.authenticated).toContain('email');
      expect(preset.admin).toContain('createdAt');
    });
  });

  describe('getFieldsForUser', () => {
    it('should return public fields for null user', () => {
      const fields = getFieldsForUser(null, preset);
      
      expect(fields).toContain('id');
      expect(fields).toContain('name');
      expect(fields).not.toContain('email');
      expect(fields).not.toContain('createdAt');
    });

    it('should return public + authenticated for logged in user', () => {
      const fields = getFieldsForUser({ id: '1' }, preset);
      
      expect(fields).toContain('name');
      expect(fields).toContain('email');
      expect(fields).not.toContain('createdAt');
    });

    it('should return all fields for admin', () => {
      const fields = getFieldsForUser({ id: '1', roles: ['admin'] }, preset);
      
      expect(fields).toContain('name');
      expect(fields).toContain('email');
      expect(fields).toContain('createdAt');
      expect(fields).toContain('internalNotes');
    });

    it('should deduplicate fields', () => {
      const overlappingPreset = createFieldPreset({
        public: ['name', 'email'],
        authenticated: ['email', 'phone'],
      });

      const fields = getFieldsForUser({ id: '1' }, overlappingPreset);
      const emailCount = fields.filter(f => f === 'email').length;
      
      expect(emailCount).toBe(1);
    });
  });

  describe('getMongooseProjection', () => {
    it('should return space-separated fields', () => {
      const projection = getMongooseProjection(null, preset);
      
      expect(projection).toBe('id name avatar');
    });
  });

  describe('filterResponseData', () => {
    it('should filter object fields', () => {
      const data = {
        id: '1',
        name: 'Test',
        email: 'test@example.com',
        secret: 'hidden',
      };

      const filtered = filterResponseData(data, preset, null);
      
      expect(filtered).toHaveProperty('id');
      expect(filtered).toHaveProperty('name');
      expect(filtered).not.toHaveProperty('email');
      expect(filtered).not.toHaveProperty('secret');
    });

    it('should filter array of objects', () => {
      const data = [
        { id: '1', name: 'User 1', secret: 'a' },
        { id: '2', name: 'User 2', secret: 'b' },
      ];

      const filtered = filterResponseData(data, preset, null);
      
      expect(filtered).toHaveLength(2);
      expect(filtered[0]).toHaveProperty('name');
      expect(filtered[0]).not.toHaveProperty('secret');
    });
  });
});

// ============================================================
// QUERY PARSER
// ============================================================

describe('Query Parser', () => {
  describe('parseQuery', () => {
    it('should parse basic query', () => {
      const result = queryParser.parseQuery({
        page: '2',
        limit: '20',
        sort: '-createdAt',
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(20);
      expect(result.sort).toEqual({ createdAt: -1 });
    });

    it('should parse filters', () => {
      const result = queryParser.parseQuery({
        status: 'active',
        age: '25',
      });

      expect(result.filters.status).toBe('active');
      expect(result.filters.age).toBe('25');
    });

    it('should parse operator syntax', () => {
      const result = queryParser.parseQuery({
        'age[gte]': '18',
        'age[lte]': '65',
      });

      expect(result.filters.age).toEqual({ $gte: 18, $lte: 65 });
    });

    it('should parse in operator', () => {
      const result = queryParser.parseQuery({
        status: { in: 'active,pending' },
      });

      expect(result.filters.status).toEqual({ $in: ['active', 'pending'] });
    });

    it('should detect keyset mode with after param', () => {
      const result = queryParser.parseQuery({
        after: 'cursor-token',
        limit: '10',
      });

      expect(result.after).toBe('cursor-token');
      expect(result.page).toBeUndefined();
    });

    it('should detect offset mode with page param', () => {
      const result = queryParser.parseQuery({
        page: '1',
        limit: '10',
      });

      expect(result.page).toBe(1);
      expect(result.after).toBeUndefined();
    });

    it('should handle contains/like operators', () => {
      const result = queryParser.parseQuery({
        name: { contains: 'john' },
      });

      expect(result.filters.name.$regex).toBeDefined();
    });

    it('should parse multiple sort fields', () => {
      const result = queryParser.parseQuery({
        sort: '-createdAt,name',
      });

      expect(result.sort).toEqual({ createdAt: -1, name: 1 });
    });
  });
});

// ============================================================
// CURSOR UTILITIES
// ============================================================

describe('Cursor Utils', () => {
  describe('encodeCursor / decodeCursor', () => {
    it('should encode and decode string values', () => {
      const doc = { _id: new mongoose.Types.ObjectId(), name: 'Test' };
      const sort = { name: 1 as const };

      const cursor = encodeCursor(doc, 'name', sort, 1);
      const decoded = decodeCursor(cursor);

      expect(decoded.value).toBe('Test');
      expect(decoded.sort).toEqual(sort);
      expect(decoded.version).toBe(1);
    });

    it('should encode and decode date values', () => {
      const date = new Date('2024-01-01');
      const doc = { _id: new mongoose.Types.ObjectId(), createdAt: date };
      const sort = { createdAt: -1 as const };

      const cursor = encodeCursor(doc, 'createdAt', sort, 1);
      const decoded = decodeCursor(cursor);

      expect(decoded.value).toEqual(date);
    });

    it('should encode and decode number values', () => {
      const doc = { _id: new mongoose.Types.ObjectId(), score: 100 };
      const sort = { score: -1 as const };

      const cursor = encodeCursor(doc, 'score', sort, 1);
      const decoded = decodeCursor(cursor);

      expect(decoded.value).toBe(100);
    });

    it('should encode and decode ObjectId', () => {
      const id = new mongoose.Types.ObjectId();
      const doc = { _id: id, name: 'Test' };
      const sort = { name: 1 as const };

      const cursor = encodeCursor(doc, 'name', sort, 1);
      const decoded = decodeCursor(cursor);

      expect(decoded.id.toString()).toBe(id.toString());
    });

    it('should throw on invalid cursor', () => {
      expect(() => decodeCursor('invalid')).toThrow('Invalid cursor');
    });
  });

  describe('validateCursorSort', () => {
    it('should pass for matching sorts', () => {
      const sort = { createdAt: -1 as const };
      expect(() => validateCursorSort(sort, sort)).not.toThrow();
    });

    it('should throw for mismatched sorts', () => {
      expect(() => validateCursorSort(
        { createdAt: -1 },
        { createdAt: 1 }
      )).toThrow('does not match');
    });
  });

  describe('validateCursorVersion', () => {
    it('should pass for matching versions', () => {
      expect(() => validateCursorVersion(1, 1)).not.toThrow();
    });

    it('should throw for mismatched versions', () => {
      expect(() => validateCursorVersion(1, 2)).toThrow('does not match');
    });
  });
});

// ============================================================
// LIMIT UTILITIES
// ============================================================

describe('Limit Utils', () => {
  const config = {
    defaultLimit: 10,
    maxLimit: 100,
    maxPage: 1000,
  };

  describe('validateLimit', () => {
    it('should return default for invalid values', () => {
      expect(validateLimit(NaN, config)).toBe(10);
      expect(validateLimit(-1, config)).toBe(10);
      expect(validateLimit(0, config)).toBe(10);
    });

    it('should cap at maxLimit', () => {
      expect(validateLimit(500, config)).toBe(100);
    });

    it('should parse string values', () => {
      expect(validateLimit('50', config)).toBe(50);
    });

    it('should floor decimal values', () => {
      expect(validateLimit(25.9, config)).toBe(25);
    });
  });

  describe('validatePage', () => {
    it('should return 1 for invalid values', () => {
      expect(validatePage(NaN, config)).toBe(1);
      expect(validatePage(-1, config)).toBe(1);
      expect(validatePage(0, config)).toBe(1);
    });

    it('should throw for page exceeding maxPage', () => {
      expect(() => validatePage(1001, config)).toThrow('exceeds max');
    });

    it('should parse string values', () => {
      expect(validatePage('5', config)).toBe(5);
    });
  });

  describe('calculateSkip', () => {
    it('should calculate correct skip value', () => {
      expect(calculateSkip(1, 10)).toBe(0);
      expect(calculateSkip(2, 10)).toBe(10);
      expect(calculateSkip(5, 20)).toBe(80);
    });
  });

  describe('calculateTotalPages', () => {
    it('should calculate correct total pages', () => {
      expect(calculateTotalPages(100, 10)).toBe(10);
      expect(calculateTotalPages(101, 10)).toBe(11);
      expect(calculateTotalPages(0, 10)).toBe(0);
    });
  });

  describe('shouldWarnDeepPagination', () => {
    it('should warn for deep pages', () => {
      expect(shouldWarnDeepPagination(101, 100)).toBe(true);
      expect(shouldWarnDeepPagination(100, 100)).toBe(false);
      expect(shouldWarnDeepPagination(50, 100)).toBe(false);
    });
  });
});

// ============================================================
// SORT UTILITIES
// ============================================================

describe('Sort Utils', () => {
  describe('normalizeSort', () => {
    it('should put _id last', () => {
      const sort = { _id: 1 as const, name: 1 as const };
      const normalized = normalizeSort(sort);
      const keys = Object.keys(normalized);

      expect(keys[keys.length - 1]).toBe('_id');
    });
  });

  describe('validateKeysetSort', () => {
    it('should add _id tie-breaker', () => {
      const sort = validateKeysetSort({ createdAt: -1 });

      expect(sort).toHaveProperty('_id');
      expect(sort._id).toBe(-1); // Same direction as primary
    });

    it('should throw for multi-field without _id', () => {
      expect(() => validateKeysetSort({ name: 1, age: 1 }))
        .toThrow('requires _id');
    });

    it('should throw for mismatched _id direction', () => {
      expect(() => validateKeysetSort({ name: 1, _id: -1 }))
        .toThrow('direction must match');
    });

    it('should accept valid two-field sort', () => {
      const sort = validateKeysetSort({ name: 1, _id: 1 });
      expect(sort.name).toBe(1);
      expect(sort._id).toBe(1);
    });
  });

  describe('invertSort', () => {
    it('should invert all directions', () => {
      const inverted = invertSort({ createdAt: -1, _id: -1 });

      expect(inverted.createdAt).toBe(1);
      expect(inverted._id).toBe(1);
    });
  });

  describe('getPrimaryField', () => {
    it('should return first non-_id field', () => {
      expect(getPrimaryField({ createdAt: -1, _id: -1 })).toBe('createdAt');
      expect(getPrimaryField({ _id: -1 })).toBe('_id');
    });
  });
});

// ============================================================
// FILTER UTILITIES
// ============================================================

describe('Filter Utils', () => {
  describe('buildKeysetFilter', () => {
    it('should build filter for descending sort', () => {
      const filter = buildKeysetFilter(
        { status: 'active' },
        { score: -1, _id: -1 },
        100,
        new mongoose.Types.ObjectId()
      );

      expect(filter.status).toBe('active');
      expect(filter.$or).toBeDefined();
      expect(filter.$or).toHaveLength(2);
      expect(filter.$or[0].score.$lt).toBe(100);
    });

    it('should build filter for ascending sort', () => {
      const filter = buildKeysetFilter(
        {},
        { score: 1, _id: 1 },
        100,
        new mongoose.Types.ObjectId()
      );

      expect(filter.$or[0].score.$gt).toBe(100);
    });
  });
});
