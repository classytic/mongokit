/**
 * Transaction Edge Cases Test
 *
 * Tests real MongoDB transaction behavior including:
 * - E11000 duplicate key errors inside transactions
 * - Session state after auto-abort
 * - Consecutive transactions after failures
 * - Transaction number mismatch prevention
 *
 * Uses MongoMemoryReplSet for real replica set testing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Repository } from '../src/index.js';

interface ITestDoc {
  _id: Types.ObjectId;
  email: string;
  counter: number;
}

const TestSchema = new Schema<ITestDoc>({
  email: { type: String, required: true, unique: true },
  counter: { type: Number, default: 0 },
});

describe('Transaction Edge Cases (Replica Set)', () => {
  let replset: MongoMemoryReplSet;
  let TestModel: mongoose.Model<ITestDoc>;
  let repo: Repository<ITestDoc>;

  beforeAll(async () => {
    await mongoose.disconnect();
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replset.getUri('mongokit-edge-test'));

    if (mongoose.models.TxEdgeTest) {
      delete mongoose.models.TxEdgeTest;
    }
    TestModel = mongoose.model<ITestDoc>('TxEdgeTest', TestSchema);
    repo = new Repository(TestModel);

    // Ensure index exists
    await TestModel.createIndexes();
  }, 60000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replset.stop();
  }, 60000);

  beforeEach(async () => {
    await TestModel.deleteMany({});
  });

  describe('E11000 Duplicate Key Error Handling', () => {
    it('should handle E11000 inside transaction without corrupting session', async () => {
      // Create initial document
      await TestModel.create({ email: 'existing@test.com', counter: 1 });

      // Try to create duplicate inside transaction - should fail cleanly
      await expect(
        repo.withTransaction(async (session) => {
          await TestModel.create([{ email: 'existing@test.com', counter: 2 }], { session });
        })
      ).rejects.toThrow(/E11000|duplicate key/i);

      // Verify session is not corrupted - next transaction should work
      const result = await repo.withTransaction(async (session) => {
        const doc = await TestModel.create([{ email: 'new@test.com', counter: 3 }], { session });
        return doc[0];
      });

      expect(result.email).toBe('new@test.com');
      expect(await TestModel.countDocuments({})).toBe(2);
    });

    it('should not throw transaction number mismatch after E11000', async () => {
      await TestModel.create({ email: 'first@test.com' });

      // Trigger multiple E11000 errors
      for (let i = 0; i < 3; i++) {
        await expect(
          repo.withTransaction(async (session) => {
            await TestModel.create([{ email: 'first@test.com' }], { session });
          })
        ).rejects.toThrow(/E11000|duplicate key/i);
      }

      // After multiple failures, transactions should still work
      const result = await repo.withTransaction(async (session) => {
        return TestModel.create([{ email: `success-${Date.now()}@test.com` }], { session });
      });

      expect(result[0].email).toContain('success-');
    });
  });

  describe('Consecutive Transaction Handling', () => {
    it('should handle rapid consecutive transactions', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.withTransaction(async (session) => {
            const doc = await TestModel.create(
              [{ email: `rapid-${i}@test.com`, counter: i }],
              { session }
            );
            return doc[0];
          })
        )
      );

      expect(results).toHaveLength(10);
      expect(await TestModel.countDocuments({})).toBe(10);
    });

    it('should handle mixed success/failure transactions', async () => {
      await TestModel.create({ email: 'blocker@test.com' });

      const operations = [
        // Will succeed
        repo.withTransaction(async (session) => {
          return TestModel.create([{ email: 'ok-1@test.com' }], { session });
        }),
        // Will fail (duplicate)
        repo.withTransaction(async (session) => {
          return TestModel.create([{ email: 'blocker@test.com' }], { session });
        }).catch(() => null),
        // Will succeed
        repo.withTransaction(async (session) => {
          return TestModel.create([{ email: 'ok-2@test.com' }], { session });
        }),
        // Will fail (duplicate)
        repo.withTransaction(async (session) => {
          return TestModel.create([{ email: 'blocker@test.com' }], { session });
        }).catch(() => null),
        // Will succeed
        repo.withTransaction(async (session) => {
          return TestModel.create([{ email: 'ok-3@test.com' }], { session });
        }),
      ];

      const results = await Promise.all(operations);

      // 3 successes, 2 nulls (caught failures)
      expect(results.filter(r => r !== null)).toHaveLength(3);
      expect(await TestModel.countDocuments({})).toBe(4); // 1 blocker + 3 ok
    });
  });

  describe('Transaction Rollback Verification', () => {
    it('should fully rollback on error after partial writes', async () => {
      await expect(
        repo.withTransaction(async (session) => {
          await TestModel.create([{ email: 'rollback-1@test.com' }], { session });
          await TestModel.create([{ email: 'rollback-2@test.com' }], { session });
          // This will fail
          throw new Error('Intentional rollback');
        })
      ).rejects.toThrow('Intentional rollback');

      // Nothing should be persisted
      expect(await TestModel.countDocuments({})).toBe(0);
    });

    it('should rollback on E11000 after partial writes', async () => {
      await TestModel.create({ email: 'exists@test.com' });

      await expect(
        repo.withTransaction(async (session) => {
          // This succeeds
          await TestModel.create([{ email: 'new-in-tx@test.com' }], { session });
          // This fails with E11000
          await TestModel.create([{ email: 'exists@test.com' }], { session });
        })
      ).rejects.toThrow(/E11000|duplicate key/i);

      // Only the pre-existing document should exist
      expect(await TestModel.countDocuments({})).toBe(1);
      expect(await TestModel.findOne({ email: 'new-in-tx@test.com' })).toBeNull();
    });
  });

  describe('Session State After Abort', () => {
    it('should properly cleanup session after abort', async () => {
      // Force an abort
      await expect(
        repo.withTransaction(async () => {
          throw new Error('Force abort');
        })
      ).rejects.toThrow('Force abort');

      // Immediate next transaction should work without session issues
      const doc = await repo.withTransaction(async (session) => {
        return TestModel.create([{ email: 'after-abort@test.com' }], { session });
      });

      expect(doc[0].email).toBe('after-abort@test.com');
    });

    it('should handle abort when transaction already auto-aborted by MongoDB', async () => {
      await TestModel.create({ email: 'auto-abort@test.com' });

      // E11000 causes MongoDB to auto-abort the transaction
      // Our fix ensures we still try to abort (and ignore the error)
      await expect(
        repo.withTransaction(async (session) => {
          await TestModel.create([{ email: 'auto-abort@test.com' }], { session });
        })
      ).rejects.toThrow(/E11000|duplicate key/i);

      // Next transaction should work - no "transaction number mismatch"
      const result = await repo.withTransaction(async (session) => {
        return TestModel.findOne({}).session(session);
      });

      expect(result?.email).toBe('auto-abort@test.com');
    });
  });
});
