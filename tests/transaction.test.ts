import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { Repository } from '../src/index.js';

interface ITxUser {
  _id: Types.ObjectId;
  email: string;
}

const TxUserSchema = new Schema<ITxUser>({
  email: { type: String, required: true, unique: true },
});

describe('Repository.withTransaction()', () => {
  let replset: MongoMemoryReplSet;
  let TxUser: mongoose.Model<ITxUser>;
  let repo: Repository<ITxUser>;

  beforeAll(async () => {
    await mongoose.disconnect();
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

    await mongoose.connect(replset.getUri('mongokit-tx'));

    if (mongoose.models.TxUser) {
      delete mongoose.models.TxUser;
    }
    TxUser = mongoose.model<ITxUser>('TxUser', TxUserSchema);
    repo = new Repository(TxUser);
  }, 60000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replset.stop();
  }, 60000);

  beforeEach(async () => {
    await TxUser.deleteMany({});
  });

  it('rolls back writes on error', async () => {
    await expect(
      repo.withTransaction(async (session) => {
        await repo.create({ email: 'rollback@a.com' }, { session });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(await TxUser.countDocuments({})).toBe(0);
  });

  it('commits writes when callback succeeds', async () => {
    await repo.withTransaction(async (session) => {
      await repo.create({ email: 'commit@a.com' }, { session });
    });

    expect(await TxUser.countDocuments({})).toBe(1);
  });
});

describe('Repository.withTransaction() fallback', () => {
  it('re-runs callback without session when fallback is allowed', async () => {
    const TxFallbackSchema = new Schema({ email: String });
    const TxFallback = mongoose.model('TxFallback', TxFallbackSchema);
    const repo = new Repository(TxFallback);

    const startError = new Error('Transaction numbers are only allowed on a replica set member');
    const endSession = vi.fn();
    const startSessionSpy = vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      startTransaction: () => {
        throw startError;
      },
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      endSession,
      inTransaction: () => false,
    } as unknown as mongoose.ClientSession);

    const callback = vi.fn(async (session) => {
      expect(session).toBeNull();
      return 'ok';
    });

    await expect(repo.withTransaction(callback, { allowFallback: true })).resolves.toBe('ok');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledTimes(1);

    startSessionSpy.mockRestore();
  });

  it('throws when fallback is not allowed', async () => {
    const TxFallbackSchema = new Schema({ email: String });
    const TxFallback = mongoose.model('TxFallbackNoFallback', TxFallbackSchema);
    const repo = new Repository(TxFallback);

    const startError = new Error('Transaction numbers are only allowed on a replica set member');
    const startSessionSpy = vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      startTransaction: () => {
        throw startError;
      },
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      endSession: vi.fn(),
      inTransaction: () => false,
    } as unknown as mongoose.ClientSession);

    const callback = vi.fn(async () => 'ok');

    await expect(repo.withTransaction(callback)).rejects.toThrow(
      'Transaction numbers are only allowed on a replica set member'
    );
    expect(callback).toHaveBeenCalledTimes(0);

    startSessionSpy.mockRestore();
  });
});

describe('Repository.withTransaction() fallback (standalone)', () => {
  let server: MongoMemoryServer;
  let TxStandalone: mongoose.Model<ITxUser>;
  let repo: Repository<ITxUser>;

  beforeAll(async () => {
    await mongoose.disconnect();
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri('mongokit-standalone'));

    if (mongoose.models.TxStandalone) {
      delete mongoose.models.TxStandalone;
    }
    TxStandalone = mongoose.model<ITxUser>('TxStandalone', TxUserSchema);
    repo = new Repository(TxStandalone);
  }, 60000);

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  }, 60000);

  beforeEach(async () => {
    await TxStandalone.deleteMany({});
  });

  it('falls back to non-transactional write on standalone server', async () => {
    const onFallback = vi.fn();

    const result = await repo.withTransaction(
      async (session) => {
        if (session) {
          await repo.create({ email: 'standalone@a.com' }, { session });
          return 'txn';
        }
        await repo.create({ email: 'standalone@a.com' });
        return 'fallback';
      },
      { allowFallback: true, onFallback }
    );

    expect(result).toBe('fallback');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(await TxStandalone.countDocuments({})).toBe(1);
  });
});
