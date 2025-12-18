import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

interface IHookUser {
  _id: Types.ObjectId;
  email: string;
}

const HookUserSchema = new Schema<IHookUser>({
  email: { type: String, required: true, unique: true },
});

describe('Repository hooks', () => {
  let HookUser: mongoose.Model<IHookUser>;

  beforeAll(async () => {
    await connectDB();
    HookUser = await createTestModel('HookUser', HookUserSchema);
  });

  afterAll(async () => {
    await HookUser.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await HookUser.deleteMany({});
  });

  it('awaits after hooks when hooks=async', async () => {
    const repo = new Repository(HookUser, [], {}, { hooks: 'async' });
    let afterRan = false;

    repo.on('after:create', async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      afterRan = true;
    });

    await repo.create({ email: 'a@a.com' });
    expect(afterRan).toBe(true);
  });

  it('emits error:hook when an async hook rejects in sync mode', async () => {
    const repo = new Repository(HookUser, [], {}, { hooks: 'sync' });

    const hookErrors: Array<{ event: string; error: Error }> = [];
    repo.on('error:hook', (payload: unknown) => {
      const p = payload as { event: string; error: Error };
      hookErrors.push({ event: p.event, error: p.error });
    });

    repo.on('after:create', async () => {
      throw new Error('hook failed');
    });

    await repo.create({ email: 'b@b.com' });

    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(hookErrors.length).toBe(1);
    expect(hookErrors[0].event).toBe('after:create');
    expect(hookErrors[0].error.message).toBe('hook failed');
  });
});
