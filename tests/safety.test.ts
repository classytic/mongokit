/**
 * Safety & Edge Case Tests
 *
 * Tests for security, edge cases, and error handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';
import queryParser from '../src/utils/queryParser.js';

// Test Schema
interface ITestDoc {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  age: number;
  status: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const TestSchema = new Schema<ITestDoc>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  age: { type: Number, required: true },
  status: { type: String, default: 'active' },
  tags: [String],
  metadata: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
});

describe('Safety & Security Tests', () => {
  let TestModel: mongoose.Model<ITestDoc>;
  let repo: Repository<ITestDoc>;

  beforeAll(async () => {
    await connectDB();
    TestModel = await createTestModel('SafetyTest', TestSchema);
    repo = new Repository(TestModel);
  });

  afterAll(async () => {
    await TestModel.deleteMany({});
    await disconnectDB();
  });

  describe('Query Parser - Security', () => {
    it('should block dangerous NoSQL injection operators', () => {
      // Attempt to inject $where operator directly
      const malicious1 = queryParser.parseQuery({
        '$where': 'this.password.length > 0',
      });

      // Should be blocked by security filter
      expect(malicious1.filters).not.toHaveProperty('$where');

      // Attempt via bracket syntax
      const malicious2 = queryParser.parseQuery({
        'name[$where]': 'malicious code',
      });

      // Should be blocked
      expect(malicious2.filters.name).toBeUndefined();
    });

    it('should handle regex DoS prevention - long patterns', () => {
      const longPattern = 'a'.repeat(10000);
      const result = queryParser.parseQuery({
        name: { contains: longPattern },
      });

      // Should create regex but not crash
      expect(result.filters.name).toBeDefined();
      expect(result.filters.name.$regex).toBeDefined();
    });

    it('should handle deeply nested objects safely', () => {
      const deepObject = {
        a: { b: { c: { d: { e: 'value' } } } },
      };

      const result = queryParser.parseQuery(deepObject);

      // Should parse without crashing
      expect(result).toBeDefined();
      expect(result.filters).toBeDefined();
    });

    it('should handle null and undefined safely', () => {
      expect(() => queryParser.parseQuery(null)).not.toThrow();
      expect(() => queryParser.parseQuery(undefined)).not.toThrow();

      const result1 = queryParser.parseQuery(null);
      const result2 = queryParser.parseQuery(undefined);

      expect(result1.filters).toBeDefined();
      expect(result2.filters).toBeDefined();
    });

    it('should handle empty strings in operators', () => {
      const result = queryParser.parseQuery({
        'age[gte]': '',
        'age[lte]': '',
      });

      // Empty strings should result in NaN and be filtered out
      expect(result.filters.age).toEqual({});
    });

    it('should handle non-numeric values for numeric operators', () => {
      const result = queryParser.parseQuery({
        'age[gte]': 'not-a-number',
        'age[lte]': 'also-not-a-number',
      });

      // Should not add invalid numeric values
      expect(result.filters.age).toEqual({});
    });

    it('should handle special characters in field names', () => {
      const result = queryParser.parseQuery({
        'field.with.dots': 'value',
        'field-with-dashes': 'value2',
        'field_with_underscores': 'value3',
      });

      expect(result.filters['field.with.dots']).toBe('value');
      expect(result.filters['field-with-dashes']).toBe('value2');
      expect(result.filters['field_with_underscores']).toBe('value3');
    });

    it('should handle very large numbers safely', () => {
      const result = queryParser.parseQuery({
        'age[gte]': '999999999999999999999',
        'age[lte]': Number.MAX_SAFE_INTEGER.toString(),
      });

      expect(result.filters.age.$gte).toBeDefined();
      expect(result.filters.age.$lte).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle invalid ObjectId strings', () => {
      const result = queryParser.parseQuery({
        userId: 'not-a-valid-objectid',
      });

      // Should keep as string if not valid 24-char hex
      expect(result.filters.userId).toBe('not-a-valid-objectid');
    });

    it('should handle valid ObjectId strings', () => {
      const validId = new mongoose.Types.ObjectId().toString();
      const result = queryParser.parseQuery({
        userId: validId,
      });

      // Should keep as string (Mongoose will convert)
      expect(result.filters.userId).toBe(validId);
    });

    it('should handle array injection attempts', () => {
      const result = queryParser.parseQuery({
        status: ['active', 'pending', 'completed'],
      });

      // Arrays should be preserved for $in operations
      expect(Array.isArray(result.filters.status)).toBe(true);
    });

    it('should handle boolean conversion safely', () => {
      const result = queryParser.parseQuery({
        isActive: 'true',
        isDeleted: 'false',
        randomField: 'not-a-boolean',
      });

      expect(result.filters.isActive).toBe(true);
      expect(result.filters.isDeleted).toBe(false);
      expect(result.filters.randomField).toBe('not-a-boolean');
    });

    it('should handle $or operator injection safely', () => {
      const result = queryParser.parseQuery({
        $or: [
          { name: 'test' },
          { email: 'test@example.com' },
        ],
      });

      expect(result.filters.$or).toBeDefined();
      expect(Array.isArray(result.filters.$or)).toBe(true);
    });

    it('should handle between operator with invalid dates', () => {
      const result = queryParser.parseQuery({
        createdAt: { between: 'invalid-date,also-invalid' },
      });

      // Should create empty range for invalid dates
      expect(result.filters.createdAt).toEqual({});
    });

    it('should handle between operator with partial dates', () => {
      const result = queryParser.parseQuery({
        createdAt: { between: '2024-01-01,' },
      });

      // Should only add $gte when 'to' date is invalid
      expect(result.filters.createdAt.$gte).toBeDefined();
      expect(result.filters.createdAt.$lte).toBeUndefined();
    });

    it('should handle negative numbers in operators', () => {
      const result = queryParser.parseQuery({
        'temperature[gte]': '-10',
        'temperature[lte]': '-5',
      });

      expect(result.filters.temperature.$gte).toBe(-10);
      expect(result.filters.temperature.$lte).toBe(-5);
    });

    it('should handle decimal numbers in operators', () => {
      const result = queryParser.parseQuery({
        'price[gte]': '19.99',
        'price[lte]': '99.99',
      });

      expect(result.filters.price.$gte).toBe(19.99);
      expect(result.filters.price.$lte).toBe(99.99);
    });
  });

  describe('Repository - Error Handling', () => {
    it('should handle invalid ObjectId gracefully', async () => {
      await expect(
        repo.getById('invalid-id')
      ).rejects.toThrow();
    });

    it('should handle update on non-existent document', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      await expect(
        repo.update(fakeId, { name: 'Updated' })
      ).rejects.toThrow(/not found/i);
    });

    it('should handle delete on non-existent document', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();

      await expect(
        repo.delete(fakeId)
      ).rejects.toThrow(/not found/i);
    });

    it('should handle schema validation errors', async () => {
      await expect(
        repo.create({ email: 'test@example.com' } as any)
      ).rejects.toThrow(); // Missing required 'name' and 'age'
    });

    it('should handle empty array for createMany', async () => {
      const result = await repo.createMany([]);
      expect(result).toEqual([]);
    });

    it('should handle invalid session object', async () => {
      // Mongoose will throw if session is invalid
      await expect(
        repo.create(
          { name: 'Test', email: 'test@example.com', age: 25 },
          { session: {} as any }
        )
      ).rejects.toThrow();
    });
  });

  describe('Repository - Edge Cases', () => {
    it('should handle documents with special characters in strings', async () => {
      const doc = await repo.create({
        name: "O'Brien's \"Special\" <script>alert(1)</script>",
        email: 'special@example.com',
        age: 30,
      });

      expect(doc.name).toContain("O'Brien");
      expect(doc.name).toContain('Special');
      expect(doc.name).toContain('<script>');
    });

    it('should handle very long strings within limits', async () => {
      const longString = 'a'.repeat(1000);
      const doc = await repo.create({
        name: longString,
        email: 'long@example.com',
        age: 25,
      });

      expect(doc.name.length).toBe(1000);
    });

    it('should handle empty arrays', async () => {
      const doc = await repo.create({
        name: 'Test',
        email: 'empty-array@example.com',
        age: 25,
        tags: [],
      });

      expect(doc.tags).toEqual([]);
    });

    it('should handle unicode characters', async () => {
      const doc = await repo.create({
        name: '测试用户 👨‍💻',
        email: 'unicode@example.com',
        age: 25,
      });

      expect(doc.name).toBe('测试用户 👨‍💻');
    });

    it('should handle metadata with nested objects', async () => {
      const doc = await repo.create({
        name: 'Test',
        email: 'metadata@example.com',
        age: 25,
        metadata: {
          nested: {
            deeply: {
              value: 'test',
            },
          },
        },
      });

      expect(doc.metadata?.nested).toBeDefined();
    });

    it('should handle concurrent creates without conflicts', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        repo.create({
          name: `User ${i}`,
          email: `user${i}@concurrent.com`,
          age: 20 + i,
        })
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      expect(results.every(r => r._id)).toBe(true);
    });
  });

  describe('Pagination - Edge Cases', () => {
    beforeAll(async () => {
      await TestModel.deleteMany({});
      // Create test data
      const docs = Array.from({ length: 50 }, (_, i) => ({
        name: `User ${i}`,
        email: `user${i}@pagination.com`,
        age: 20 + (i % 30),
        status: i % 2 === 0 ? 'active' : 'inactive',
      }));
      await TestModel.insertMany(docs);
    });

    it('should handle page beyond available data', async () => {
      const result = await repo.getAll({
        page: 999,
        limit: 10,
      });

      expect(result.docs).toHaveLength(0);
      expect(result.page).toBe(999);
      expect(result.hasNext).toBe(false);
    });

    it('should handle limit of 0', async () => {
      const result = await repo.getAll({
        page: 1,
        limit: 0,
      });

      // Should use default limit (10) since 0 is invalid
      expect(result.limit).toBeGreaterThan(0);
    });

    it('should handle negative page number', async () => {
      const result = await repo.getAll({
        page: -5,
        limit: 10,
      });

      // Should default to page 1
      expect(result.page).toBe(1);
    });

    it('should handle very large limit', async () => {
      const result = await repo.getAll({
        page: 1,
        limit: 999999,
      });

      // Should cap at maxLimit
      expect(result.limit).toBeLessThanOrEqual(100);
    });

    it('should handle empty filters object', async () => {
      const result = await repo.getAll({
        filters: {},
      });

      expect(result.docs.length).toBeGreaterThan(0);
    });

    it('should handle invalid sort field', async () => {
      const result = await repo.getAll({
        sort: { nonExistentField: 1 },
      });

      // Should not throw, just sort by non-existent field
      expect(result.docs).toBeDefined();
    });
  });

  describe('Transaction Safety', () => {
    it.skip('should properly start and use session (requires replica set)', async () => {
      // Note: Transactions require MongoDB replica set or sharded cluster
      // This test is skipped in standalone MongoDB environments
      const result = await repo.withTransaction(async (session) => {
        const doc = await repo.create(
          {
            name: 'Transaction Test',
            email: 'tx@example.com',
            age: 25,
          },
          { session }
        );

        return doc;
      });

      expect(result._id).toBeDefined();
      expect(result.name).toBe('Transaction Test');
    });

    it.skip('should rollback on error (requires replica set)', async () => {
      // Note: Transactions require MongoDB replica set or sharded cluster
      // This test is skipped in standalone MongoDB environments
      const initialCount = await TestModel.countDocuments();

      await expect(
        repo.withTransaction(async (session) => {
          await repo.create(
            {
              name: 'Will Rollback',
              email: 'rollback@example.com',
              age: 25,
            },
            { session }
          );

          // Force an error
          throw new Error('Rollback test');
        })
      ).rejects.toThrow('Rollback test');

      const finalCount = await TestModel.countDocuments();
      expect(finalCount).toBe(initialCount);
    });
  });
});
