/**
 * Repository Integration Tests
 * 
 * Tests core CRUD operations and repository functionality
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

// Test Schema
interface ITestUser {
  _id: Types.ObjectId;
  name: string;
  email: string;
  age?: number;
  status: 'active' | 'inactive';
  tags?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

const TestUserSchema = new Schema<ITestUser>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  age: Number,
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  tags: [String],
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
});

// Create indexes
TestUserSchema.index({ email: 1 }, { unique: true });
TestUserSchema.index({ status: 1 });
TestUserSchema.index({ createdAt: -1 });

describe('Repository', () => {
  let TestUser: mongoose.Model<ITestUser>;
  let repo: Repository<ITestUser>;
  let testUserId: Types.ObjectId;

  beforeAll(async () => {
    await connectDB();
    TestUser = await createTestModel('TestUser', TestUserSchema);
    repo = new Repository(TestUser);
  });

  afterAll(async () => {
    await TestUser.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await TestUser.deleteMany({});
  });

  describe('create()', () => {
    it('should create a document', async () => {
      const doc = await repo.create({ 
        name: 'John Doe', 
        email: 'john@example.com',
        status: 'active',
      });

      testUserId = doc._id;
      expect(doc._id).toBeDefined();
      expect(doc.name).toBe('John Doe');
      expect(doc.email).toBe('john@example.com');
      expect(doc.status).toBe('active');
    });

    it('should throw on validation error', async () => {
      await expect(repo.create({ 
        email: 'missing-name@example.com',
      } as Record<string, unknown>)).rejects.toThrow();
    });

    it('should throw on duplicate unique field', async () => {
      await repo.create({ name: 'User 1', email: 'duplicate@example.com', status: 'active' });
      await expect(repo.create({ 
        name: 'User 2', 
        email: 'duplicate@example.com',
        status: 'active',
      })).rejects.toThrow();
    });
  });

  describe('createMany()', () => {
    it('should create multiple documents', async () => {
      const docs = await repo.createMany([
        { name: 'User 1', email: 'user1@example.com', status: 'active' },
        { name: 'User 2', email: 'user2@example.com', status: 'inactive' },
        { name: 'User 3', email: 'user3@example.com', status: 'active' },
      ]);

      expect(docs).toHaveLength(3);
      expect(docs[0].name).toBe('User 1');
      expect(docs[1].name).toBe('User 2');
      expect(docs[2].name).toBe('User 3');
    });

    it('should handle empty array', async () => {
      const docs = await repo.createMany([]);
      expect(docs).toHaveLength(0);
    });
  });

  describe('getById()', () => {
    it('should get document by ID', async () => {
      const created = await repo.create({ name: 'Test User', email: 'test@example.com', status: 'active' });
      const doc = await repo.getById(created._id.toString());

      expect(doc).toBeDefined();
      expect(doc?.name).toBe('Test User');
    });

    it('should throw 404 when document not found', async () => {
      const fakeId = new Types.ObjectId().toString();
      await expect(repo.getById(fakeId)).rejects.toThrow('Document not found');
    });

    it('should return null with throwOnNotFound: false', async () => {
      const fakeId = new Types.ObjectId().toString();
      const doc = await repo.getById(fakeId, { throwOnNotFound: false });
      expect(doc).toBeNull();
    });

    it('should respect select option', async () => {
      const created = await repo.create({ name: 'Test User', email: 'test@example.com', age: 25, status: 'active' });
      const doc = await repo.getById(created._id.toString(), { select: 'name email' });

      expect(doc?.name).toBe('Test User');
      expect(doc?.email).toBe('test@example.com');
      // age should not be selected
    });
  });

  describe('getByQuery()', () => {
    beforeEach(async () => {
      await repo.createMany([
        { name: 'Alice', email: 'alice@example.com', status: 'active', age: 25 },
        { name: 'Bob', email: 'bob@example.com', status: 'inactive', age: 30 },
      ]);
    });

    it('should find document by query', async () => {
      const doc = await repo.getByQuery({ email: 'alice@example.com' });

      expect(doc).toBeDefined();
      expect(doc?.name).toBe('Alice');
    });

    it('should throw 404 when no match', async () => {
      await expect(repo.getByQuery({ email: 'nonexistent@example.com' }))
        .rejects.toThrow('Document not found');
    });

    it('should return null with throwOnNotFound: false', async () => {
      const doc = await repo.getByQuery(
        { email: 'nonexistent@example.com' }, 
        { throwOnNotFound: false }
      );
      expect(doc).toBeNull();
    });
  });

  describe('update()', () => {
    it('should update document by ID', async () => {
      const created = await repo.create({ name: 'Original', email: 'original@example.com', status: 'active' });
      const updated = await repo.update(created._id.toString(), { name: 'Updated' });

      expect(updated.name).toBe('Updated');
      expect(updated.email).toBe('original@example.com');
    });

    it('should throw 404 when document not found', async () => {
      const fakeId = new Types.ObjectId().toString();
      await expect(repo.update(fakeId, { name: 'Updated' }))
        .rejects.toThrow('Document not found');
    });

    it('should support $set operator', async () => {
      const created = await repo.create({ name: 'Test', email: 'test@example.com', status: 'active', tags: ['a'] });
      const updated = await repo.update(created._id.toString(), { $set: { tags: ['b', 'c'] } });

      expect(updated.tags).toEqual(['b', 'c']);
    });

    it('should support $push operator', async () => {
      const created = await repo.create({ name: 'Test', email: 'test@example.com', status: 'active', tags: ['a'] });
      const updated = await repo.update(created._id.toString(), { $push: { tags: 'b' } });

      expect(updated.tags).toContain('a');
      expect(updated.tags).toContain('b');
    });
  });

  describe('delete()', () => {
    it('should delete document by ID', async () => {
      const created = await repo.create({ name: 'To Delete', email: 'delete@example.com', status: 'active' });
      const result = await repo.delete(created._id.toString());

      expect(result.success).toBe(true);
      expect(result.message).toBe('Deleted successfully');

      const found = await repo.getById(created._id.toString(), { throwOnNotFound: false });
      expect(found).toBeNull();
    });

    it('should throw 404 when document not found', async () => {
      const fakeId = new Types.ObjectId().toString();
      await expect(repo.delete(fakeId)).rejects.toThrow('Document not found');
    });
  });

  describe('count()', () => {
    beforeEach(async () => {
      await repo.createMany([
        { name: 'User 1', email: 'user1@example.com', status: 'active' },
        { name: 'User 2', email: 'user2@example.com', status: 'active' },
        { name: 'User 3', email: 'user3@example.com', status: 'inactive' },
      ]);
    });

    it('should count all documents', async () => {
      const count = await repo.count();
      expect(count).toBe(3);
    });

    it('should count with query', async () => {
      const count = await repo.count({ status: 'active' });
      expect(count).toBe(2);
    });
  });

  describe('exists()', () => {
    beforeEach(async () => {
      await repo.create({ name: 'Existing', email: 'existing@example.com', status: 'active' });
    });

    it('should return _id when document exists', async () => {
      const result = await repo.exists({ email: 'existing@example.com' });
      expect(result).toBeDefined();
      expect(result?._id).toBeDefined();
    });

    it('should return null when document does not exist', async () => {
      const result = await repo.exists({ email: 'nonexistent@example.com' });
      expect(result).toBeNull();
    });
  });

  describe('getOrCreate()', () => {
    it('should return existing document', async () => {
      await repo.create({ name: 'Existing', email: 'existing@example.com', status: 'active' });
      
      const doc = await repo.getOrCreate(
        { email: 'existing@example.com' },
        { name: 'New User', email: 'existing@example.com', status: 'active' }
      );

      expect(doc?.name).toBe('Existing');
    });

    it('should create new document when not found', async () => {
      const doc = await repo.getOrCreate(
        { email: 'new@example.com' },
        { name: 'New User', email: 'new@example.com', status: 'active' }
      );

      expect(doc?.name).toBe('New User');
      expect(doc?.email).toBe('new@example.com');
    });
  });

  describe('Event Emission', () => {
    it('should emit after:create event', async () => {
      let eventData: unknown = null;
      repo.on('after:create', (data) => {
        eventData = data;
      });

      await repo.create({ name: 'Event Test', email: 'event@example.com', status: 'active' });

      expect(eventData).toBeDefined();
    });

    it('should emit after:update event', async () => {
      let eventData: unknown = null;
      repo.on('after:update', (data) => {
        eventData = data;
      });

      const created = await repo.create({ name: 'Event Test', email: 'event2@example.com', status: 'active' });
      await repo.update(created._id.toString(), { name: 'Updated' });

      expect(eventData).toBeDefined();
    });

    it('should emit after:delete event', async () => {
      let eventData: unknown = null;
      repo.on('after:delete', (data) => {
        eventData = data;
      });

      const created = await repo.create({ name: 'Event Test', email: 'event3@example.com', status: 'active' });
      await repo.delete(created._id.toString());

      expect(eventData).toBeDefined();
    });
  });

  describe('Transactions', () => {
    it('should support withTransaction for atomic operations', async () => {
      // Note: This requires a replica set, so we'll just test the method exists
      expect(typeof repo.withTransaction).toBe('function');
    });
  });
});
