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

import type mongoose from 'mongoose';
import { Schema, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../src/Repository.js';
import { createError, parseDuplicateKeyError } from '../src/utils/error.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

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

    it('should parse E11000 — PII-safe default omits the duplicate value from the message', () => {
      const mongoErr = Object.assign(new Error('E11000'), {
        code: 11000,
        keyPattern: { email: 1 },
        keyValue: { email: 'dup@test.com' },
      });

      const result = parseDuplicateKeyError(mongoErr);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(409);
      expect(result!.message).toContain('email');
      // The value must NOT appear in the message by default — protects PII in logs.
      expect(result!.message).not.toContain('dup@test.com');
      // Structured field list is always safe to expose.
      expect(result!.duplicate?.fields).toEqual(['email']);
      // Values are NOT attached unless opt-in.
      expect(result!.duplicate?.values).toBeUndefined();
    });

    it('should include the duplicate value only when exposeValues: true is passed', () => {
      const mongoErr = Object.assign(new Error('E11000'), {
        code: 11000,
        keyPattern: { email: 1 },
        keyValue: { email: 'dup@test.com' },
      });

      const result = parseDuplicateKeyError(mongoErr, { exposeValues: true });
      expect(result!.message).toContain('email');
      expect(result!.message).toContain('dup@test.com');
      expect(result!.duplicate?.values).toEqual({ email: 'dup@test.com' });
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
      expect(result!.duplicate?.fields).toEqual(['slug']);
    });

    it('handles compound-key duplicates — all field names, no values in default message', () => {
      const mongoErr = Object.assign(new Error('E11000'), {
        code: 11000,
        keyPattern: { tenantId: 1, email: 1 },
        keyValue: { tenantId: 'org_1', email: 'dup@test.com' },
      });

      const result = parseDuplicateKeyError(mongoErr);
      expect(result!.message).toContain('tenantId');
      expect(result!.message).toContain('email');
      expect(result!.message).not.toContain('dup@test.com');
      expect(result!.message).not.toContain('org_1');
      expect(result!.duplicate?.fields).toEqual(['tenantId', 'email']);
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

    it('returns null for a structurally invalid ObjectId (MinimalRepo contract)', async () => {
      const result = await repo.getById('not-a-valid-id');
      expect(result).toBeNull();
    });

    it('throws 404 for invalid ObjectId with throwOnNotFound:true (legacy opt-in)', async () => {
      try {
        await repo.getById('not-a-valid-id', { throwOnNotFound: true });
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error & { status?: number };
        expect(error.status).toBe(404);
        expect(error.message).toContain('not found');
      }
    });

    it('returns null for non-existent document (MinimalRepo contract)', async () => {
      const fakeId = new Types.ObjectId();
      const result = await repo.getById(fakeId.toString());
      expect(result).toBeNull();
    });

    it('throws 404 for non-existent document with throwOnNotFound:true (legacy opt-in)', async () => {
      const fakeId = new Types.ObjectId();
      try {
        await repo.getById(fakeId.toString(), { throwOnNotFound: true });
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error & { status?: number };
        expect(error.status).toBe(404);
      }
    });

    // ========================================================================
    // Transactional retry-label preservation
    //
    // `mongoose.Connection.withTransaction()` decides whether to auto-retry
    // a transaction by reading `error.hasErrorLabel('TransientTransactionError')`
    // (and `'UnknownTransactionCommitResult'`) on the thrown error. If
    // `_handleError` wraps the original `MongoServerError` in a fresh `Error`
    // via `createError(...)`, both `errorLabels` and `hasErrorLabel` are lost
    // and the retry signal vanishes. Hot upsert paths under contention then
    // surface raw WriteConflicts to userland instead of being retried by
    // the driver.
    // ========================================================================
    describe('transactional retry-label preservation', () => {
      it('preserves errorLabels array when wrapping MongoServerError', () => {
        const labeledErr = new Error('Write conflict during transaction') as Error & {
          errorLabels?: string[];
        };
        labeledErr.errorLabels = ['TransientTransactionError'];

        const handled = repo._handleError(labeledErr);
        expect((handled as Error & { errorLabels?: string[] }).errorLabels).toEqual([
          'TransientTransactionError',
        ]);
      });

      it('preserves hasErrorLabel method when it reports a retry label (mongoose driver shape)', () => {
        const labeledErr = new Error('Write conflict during transaction') as Error & {
          hasErrorLabel?: (l: string) => boolean;
        };
        labeledErr.hasErrorLabel = (l: string) => l === 'TransientTransactionError';

        const handled = repo._handleError(labeledErr) as Error & {
          hasErrorLabel?: (l: string) => boolean;
        };
        expect(typeof handled.hasErrorLabel).toBe('function');
        expect(handled.hasErrorLabel?.('TransientTransactionError')).toBe(true);
      });

      it('does NOT preserve hasErrorLabel when no retry label is reported (e.g. E11000)', () => {
        // MongoServerError prototype defines hasErrorLabel on EVERY
        // driver error. Only a positive answer to one of the retry
        // labels should short-circuit the wrap; otherwise normal
        // E11000/validation/cast handling must still run.
        const dupErr = new Error('Duplicate key') as Error & {
          code?: number;
          codeName?: string;
          hasErrorLabel?: (l: string) => boolean;
        };
        dupErr.code = 11000;
        dupErr.codeName = 'DuplicateKey';
        dupErr.hasErrorLabel = () => false; // present but reports no labels

        const handled = repo._handleError(dupErr) as Error & { status?: number };
        expect(handled.status).toBe(409); // wrapped as duplicate-key, not preserved
      });

      it('does NOT wrap labeled errors — returns the original instance', () => {
        const labeledErr = new Error('Unknown commit result') as Error & {
          errorLabels?: string[];
        };
        labeledErr.errorLabels = ['UnknownTransactionCommitResult'];

        const handled = repo._handleError(labeledErr);
        expect(handled).toBe(labeledErr); // same instance — not wrapped
      });

      it('still wraps unlabeled errors as 500 (no behavior change)', () => {
        const plainErr = new Error('Random failure');
        const handled = repo._handleError(plainErr) as Error & { status?: number };
        expect(handled.status).toBe(500);
        expect(handled.message).toBe('Random failure');
        expect(handled).not.toBe(plainErr);
      });

      it('label-preservation runs BEFORE duplicate-key wrap (E11000 with labels stays unwrapped)', () => {
        // Edge case: a duplicate-key error inside an aborting transaction
        // can carry both code 11000 AND TransientTransactionError. The
        // retry signal must win — the driver retries, then on next attempt
        // the same E11000 surfaces (or doesn't, if the conflicting writer
        // backed off). Wrapping early would short-circuit the retry.
        const dupWithLabel = new Error('Duplicate key within transaction') as Error & {
          code?: number;
          codeName?: string;
          errorLabels?: string[];
        };
        dupWithLabel.code = 11000;
        dupWithLabel.codeName = 'DuplicateKey';
        dupWithLabel.errorLabels = ['TransientTransactionError'];

        const handled = repo._handleError(dupWithLabel);
        expect(handled).toBe(dupWithLabel); // unwrapped — labels win
      });
    });
  });

  // ==========================================================================
  // findAll: optional `limit` option
  //
  // Pin the contract: `limit` is optional, defaults to "no limit" (historic
  // behavior), and when set caps the returned array at the driver level.
  // Closes the gap that previously forced callers into either the
  // unbounded `findAll(filter, opts)` or the paginated `getAll({...})`.
  // ==========================================================================
  describe('findAll limit option', () => {
    beforeEach(async () => {
      // Seed 5 docs so we can test limit < total, limit > total, no limit.
      await repo.create({ email: 'a@t.com', name: 'A1' });
      await repo.create({ email: 'b@t.com', name: 'B2' });
      await repo.create({ email: 'c@t.com', name: 'C3' });
      await repo.create({ email: 'd@t.com', name: 'D4' });
      await repo.create({ email: 'e@t.com', name: 'E5' });
    });

    it('returns all docs when limit is omitted (default behavior preserved)', async () => {
      const docs = await repo.findAll({});
      expect(docs).toHaveLength(5);
    });

    it('caps the result set when limit is provided', async () => {
      const docs = await repo.findAll({}, { limit: 2 });
      expect(docs).toHaveLength(2);
    });

    it('returns all docs when limit exceeds collection size', async () => {
      const docs = await repo.findAll({}, { limit: 100 });
      expect(docs).toHaveLength(5);
    });

    it('combines limit with sort + filter correctly', async () => {
      const docs = await repo.findAll({ name: { $regex: /^[A-C]/ } }, { sort: { name: 1 }, limit: 2 });
      expect(docs).toHaveLength(2);
      expect(docs[0]?.name).toBe('A1');
      expect(docs[1]?.name).toBe('B2');
    });

    it('ignores limit ≤ 0 (treats as unbounded)', async () => {
      const docs = await repo.findAll({}, { limit: 0 });
      expect(docs).toHaveLength(5);
    });

    it('forwards limit through getAll({ noPagination: true, limit })', async () => {
      const docs = (await repo.getAll({ noPagination: true, limit: 3 })) as IUniqueDoc[];
      expect(docs).toHaveLength(3);
    });
  });
});
