/**
 * Repository populateOptions Integration Tests
 *
 * Tests that populateOptions works correctly across all read methods:
 * - getById
 * - getByQuery
 * - getAll
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB } from './setup.js';

// Author Schema
interface IAuthor {
  _id: Types.ObjectId;
  name: string;
  email: string;
  active: boolean;
}

const AuthorSchema = new Schema<IAuthor>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  active: { type: Boolean, default: true },
});

// Post Schema with author reference
interface IPost {
  _id: Types.ObjectId;
  title: string;
  content: string;
  author: Types.ObjectId;
  status: 'draft' | 'published';
  createdAt: Date;
}

const PostSchema = new Schema<IPost>({
  title: { type: String, required: true },
  content: { type: String, required: true },
  author: { type: Schema.Types.ObjectId, ref: 'PopulateTestAuthor', required: true },
  status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  createdAt: { type: Date, default: Date.now },
});

describe('Repository - populateOptions', () => {
  let AuthorModel: mongoose.Model<IAuthor>;
  let PostModel: mongoose.Model<IPost>;
  let authorRepo: Repository<IAuthor>;
  let postRepo: Repository<IPost>;
  let testAuthor: IAuthor;
  let testPost: IPost;

  beforeAll(async () => {
    await connectDB();

    // Clean up any existing models
    if (mongoose.models.PopulateTestAuthor) {
      delete mongoose.models.PopulateTestAuthor;
    }
    if (mongoose.models.PopulateTestPost) {
      delete mongoose.models.PopulateTestPost;
    }

    AuthorModel = mongoose.model<IAuthor>('PopulateTestAuthor', AuthorSchema);
    PostModel = mongoose.model<IPost>('PopulateTestPost', PostSchema);

    authorRepo = new Repository(AuthorModel);
    postRepo = new Repository(PostModel);
  });

  afterAll(async () => {
    await AuthorModel.deleteMany({});
    await PostModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await AuthorModel.deleteMany({});
    await PostModel.deleteMany({});

    // Create test data
    testAuthor = await AuthorModel.create({
      name: 'John Doe',
      email: 'john@example.com',
      active: true,
    });

    testPost = await PostModel.create({
      title: 'Test Post',
      content: 'This is test content',
      author: testAuthor._id,
      status: 'published',
    });
  });

  describe('getById with populateOptions', () => {
    it('should populate with advanced options', async () => {
      const post = await postRepo.getById(testPost._id, {
        populateOptions: [
          { path: 'author', select: 'name email' },
        ],
      });

      expect(post).toBeDefined();
      expect(post!.author).toBeDefined();
      // Author should be populated as an object
      const author = post!.author as unknown as IAuthor;
      expect(author.name).toBe('John Doe');
      expect(author.email).toBe('john@example.com');
    });

    it('should support select in populateOptions', async () => {
      const post = await postRepo.getById(testPost._id, {
        populateOptions: [
          { path: 'author', select: 'name' }, // Only select name
        ],
      });

      expect(post).toBeDefined();
      const author = post!.author as unknown as Record<string, unknown>;
      expect(author.name).toBe('John Doe');
      // email should not be selected (lean documents won't have undefined, field just won't exist)
      expect(author.email).toBeUndefined();
    });

    it('should support match in populateOptions', async () => {
      // Create an inactive author
      const inactiveAuthor = await AuthorModel.create({
        name: 'Inactive Author',
        email: 'inactive@example.com',
        active: false,
      });

      const inactivePost = await PostModel.create({
        title: 'Inactive Post',
        content: 'Content',
        author: inactiveAuthor._id,
        status: 'published',
      });

      // Populate only active authors
      const post = await postRepo.getById(inactivePost._id, {
        populateOptions: [
          { path: 'author', match: { active: true } },
        ],
      });

      expect(post).toBeDefined();
      // Author should be null because match condition failed
      expect(post!.author).toBeNull();
    });

    it('should prioritize populateOptions over populate', async () => {
      const post = await postRepo.getById(testPost._id, {
        populate: 'author', // Simple populate (should be ignored)
        populateOptions: [
          { path: 'author', select: 'name' }, // Advanced populate (should take priority)
        ],
      });

      expect(post).toBeDefined();
      const author = post!.author as unknown as Record<string, unknown>;
      expect(author.name).toBe('John Doe');
      // If populateOptions took priority, email should not be present
      expect(author.email).toBeUndefined();
    });
  });

  describe('getByQuery with populateOptions', () => {
    it('should populate with advanced options', async () => {
      const post = await postRepo.getByQuery(
        { title: 'Test Post' },
        {
          populateOptions: [
            { path: 'author', select: 'name email' },
          ],
        }
      );

      expect(post).toBeDefined();
      const author = post!.author as unknown as IAuthor;
      expect(author.name).toBe('John Doe');
      expect(author.email).toBe('john@example.com');
    });

    it('should support select in populateOptions', async () => {
      const post = await postRepo.getByQuery(
        { status: 'published' },
        {
          populateOptions: [
            { path: 'author', select: 'email' }, // Only select email
          ],
        }
      );

      expect(post).toBeDefined();
      const author = post!.author as unknown as Record<string, unknown>;
      expect(author.email).toBe('john@example.com');
      expect(author.name).toBeUndefined();
    });

    it('should prioritize populateOptions over populate', async () => {
      const post = await postRepo.getByQuery(
        { title: 'Test Post' },
        {
          populate: 'author',
          populateOptions: [
            { path: 'author', select: 'name' },
          ],
        }
      );

      expect(post).toBeDefined();
      const author = post!.author as unknown as Record<string, unknown>;
      expect(author.name).toBe('John Doe');
      expect(author.email).toBeUndefined();
    });
  });

  describe('getAll with populateOptions', () => {
    it('should populate with advanced options via params', async () => {
      const result = await postRepo.getAll({
        filters: { status: 'published' },
        populateOptions: [
          { path: 'author', select: 'name email' },
        ],
      });

      expect(result.docs).toHaveLength(1);
      const author = result.docs[0].author as unknown as IAuthor;
      expect(author.name).toBe('John Doe');
    });

    it('should populate with advanced options via options', async () => {
      const result = await postRepo.getAll(
        { filters: { status: 'published' } },
        {
          populateOptions: [
            { path: 'author', select: 'name' },
          ],
        }
      );

      expect(result.docs).toHaveLength(1);
      const author = result.docs[0].author as unknown as Record<string, unknown>;
      expect(author.name).toBe('John Doe');
      expect(author.email).toBeUndefined();
    });

    it('should support match in populateOptions', async () => {
      // Create posts with different author states
      const inactiveAuthor = await AuthorModel.create({
        name: 'Inactive',
        email: 'inactive@test.com',
        active: false,
      });

      await PostModel.create({
        title: 'Post by Inactive',
        content: 'Content',
        author: inactiveAuthor._id,
        status: 'published',
      });

      const result = await postRepo.getAll({
        filters: { status: 'published' },
        populateOptions: [
          { path: 'author', match: { active: true } },
        ],
      });

      expect(result.docs).toHaveLength(2);

      // Find the post with active author
      const activePost = result.docs.find(p => p.title === 'Test Post');
      const inactivePost = result.docs.find(p => p.title === 'Post by Inactive');

      expect((activePost!.author as unknown as IAuthor).name).toBe('John Doe');
      expect(inactivePost!.author).toBeNull(); // Match failed
    });
  });

  describe('backward compatibility', () => {
    it('should still work with simple populate string', async () => {
      const post = await postRepo.getById(testPost._id, {
        populate: 'author',
      });

      expect(post).toBeDefined();
      const author = post!.author as unknown as IAuthor;
      expect(author.name).toBe('John Doe');
      expect(author.email).toBe('john@example.com');
    });

    it('should still work with populate array', async () => {
      const post = await postRepo.getById(testPost._id, {
        populate: ['author'],
      });

      expect(post).toBeDefined();
      const author = post!.author as unknown as IAuthor;
      expect(author.name).toBe('John Doe');
    });
  });
});
