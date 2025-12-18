import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
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

