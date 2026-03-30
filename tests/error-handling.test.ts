/**
 * Error Handling Tests
 *
 * Verifies that MongoDB and Mongoose errors are properly
 * translated into HTTP-compatible errors with correct status codes:
 * - E11000 duplicate key → 409 Conflict
 * - ValidationError → 400 Bad Request
 * - CastError → 400 Bad Request
 * - Generic errors → 500 Internal Server Error
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/Repository.js';
import { parseDuplicateKeyError, createError } from '../src/utils/error.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

interface IUniqueDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  age?: number;
}

describe('Error Handling', () => {
  let Model: mongoose.Model<IUniqueDoc>;
  let repo: InstanceType<typeof Repository<IUniqueDoc>>;

  beforeAll(async () => {
    await connectDB();
    const UniqueSchema = new Schema<IUniqueDoc>({
      email: { type: String, required: true, unique: true },
      name: { type: String, required: true, minlength: 2 },
      age: { type: Number, min: 0 },
    });
    Model = await createTestModel('ErrorHandlingDoc', UniqueSchema);
    repo = new Repository(Model);
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await Model.deleteMany({});
  });

  // ==========================================================================
  // parseDuplicateKeyError unit tests
  // ==========================================================================

  describe('parseDuplicateKeyError', () => {
    it('should return null for non-duplicate errors', () => {
      expect(parseDuplicateKeyError(new Error('random error'))).toBeNull();
      expect(parseDuplicateKeyError({ code: 12345 })).toBeNull();
      expect(parseDuplicateKeyError(null)).toBeNull();
    });

    it('should parse E11000 with keyPattern and keyValue', () => {
      const mongoErr = Object.assign(new Error('E11000'), {
        code: 11000,
        keyPattern: { email: 1 },
        keyValue: { email: 'dup@test.com' },
      });

      const result = parseDuplicateKeyError(mongoErr);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(409);
      expect(result!.message).toContain('email');
      expect(result!.message).toContain('dup@test.com');
    });

    it('should parse E11000 without keyValue', () => {
      const mongoErr = Object.assign(new Error('E11000'), {
        code: 11000,
        keyPattern: { slug: 1 },
      });

      const result = parseDuplicateKeyError(mongoErr);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(409);
      expect(result!.message).toContain('slug');
    });
  });

  // ==========================================================================
  // Integration: Repository._handleError
  // ==========================================================================

  describe('Repository error translation', () => {
    it('should return 409 for duplicate key on create', async () => {
      await repo.create({ email: 'one@test.com', name: 'One' });

      try {
        await repo.create({ email: 'one@test.com', name: 'Two' });
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error & { status?: number };
        expect(error.status).toBe(409);
        expect(error.message).toContain('email');
      }
    });

    it('should return 400 for validation error', async () => {
      try {
        await repo.create({ email: 'ok@test.com', name: 'X' }); // minlength 2
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error & { status?: number };
        expect(error.status).toBe(400);
        expect(error.message).toContain('Validation');
      }
    });

    it('should return 400 for cast error (invalid ObjectId)', async () => {
      try {
        await repo.getById('not-a-valid-id');
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error & { status?: number };
        expect(error.status).toBe(400);
        expect(error.message).toContain('Invalid');
      }
    });

    it('should return 404 for document not found', async () => {
      const fakeId = new Types.ObjectId();
      try {
        await repo.getById(fakeId.toString());
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error & { status?: number };
        expect(error.status).toBe(404);
      }
    });
  });
});
