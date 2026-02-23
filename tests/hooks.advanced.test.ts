import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import { Repository } from '../src/index.js';
import { configureLogger } from '../src/utils/logger.js';
import { connectDB, disconnectDB, createTestModel } from './setup.js';

interface IItem {
  _id: Types.ObjectId;
  name: string;
  status: 'active' | 'inactive';
  tags?: string[];
}

const ItemSchema = new Schema<IItem>({
  name: { type: String, required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  tags: [String],
});

describe('Hook lifecycle – advanced', () => {
  let Item: mongoose.Model<IItem>;

  beforeAll(async () => {
    await connectDB();
    Item = await createTestModel('HookAdvItem', ItemSchema);
  });

  afterAll(async () => {
    await Item.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await Item.deleteMany({});
  });

  // ---------------------------------------------------------------------------
  // before:* hooks
  // ---------------------------------------------------------------------------

  describe('before:* hooks', () => {
    it('before:create can modify data', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      repo.on('before:create', (ctx: Record<string, unknown>) => {
        // Inject a tag via the mutable context
        ctx.data = { ...(ctx.data as Record<string, unknown>), tags: ['injected'] };
      });

      const doc = await repo.create({ name: 'Test', status: 'active' });

      expect(doc.tags).toEqual(['injected']);
    });

    it('before:update can modify data', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      const created = await repo.create({ name: 'Original', status: 'active' });

      repo.on('before:update', (ctx: Record<string, unknown>) => {
        const data = ctx.data as Record<string, unknown>;
        ctx.data = { ...data, status: 'inactive' };
      });

      const updated = await repo.update(created._id.toString(), { name: 'Changed' });

      expect(updated.name).toBe('Changed');
      expect(updated.status).toBe('inactive');
    });

    it('before:delete can prevent deletion by throwing', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      const created = await repo.create({ name: 'Protected', status: 'active' });

      repo.on('before:delete', () => {
        throw new Error('Deletion blocked');
      });

      await expect(repo.delete(created._id.toString())).rejects.toThrow('Deletion blocked');

      // Document should still exist
      const still = await repo.getById(created._id.toString());
      expect(still).toBeDefined();
      expect(still!.name).toBe('Protected');
    });

    it('before:getAll can modify context filters', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      await repo.create({ name: 'Active1', status: 'active' });
      await repo.create({ name: 'Active2', status: 'active' });
      await repo.create({ name: 'Inactive', status: 'inactive' });

      // Hook forces a status filter regardless of caller input
      repo.on('before:getAll', (ctx: Record<string, unknown>) => {
        ctx.filters = { ...(ctx.filters as Record<string, unknown> || {}), status: 'active' };
      });

      const result = await repo.getAll({});

      expect(result.docs).toHaveLength(2);
      result.docs.forEach((d: unknown) => {
        expect((d as IItem).status).toBe('active');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // error:* hooks
  // ---------------------------------------------------------------------------

  describe('error:* hooks', () => {
    it('error:create fires on validation error', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      let captured: { context: unknown; error: unknown } | null = null;
      repo.on('error:create', (payload: { context: unknown; error: unknown }) => {
        captured = payload;
      });

      // Missing required "name" field triggers validation error
      await expect(
        repo.create({ status: 'active' } as Record<string, unknown>)
      ).rejects.toThrow();

      expect(captured).not.toBeNull();
      expect(captured!.error).toBeInstanceOf(Error);
    });

    it('error:update fires on not found', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      let captured: { context: unknown; error: unknown } | null = null;
      repo.on('error:update', (payload: { context: unknown; error: unknown }) => {
        captured = payload;
      });

      const fakeId = new Types.ObjectId().toString();
      await expect(repo.update(fakeId, { name: 'x' })).rejects.toThrow();

      expect(captured).not.toBeNull();
      expect((captured!.error as Error).message).toContain('not found');
    });

    it('error:delete fires on not found', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      let captured: { context: unknown; error: unknown } | null = null;
      repo.on('error:delete', (payload: { context: unknown; error: unknown }) => {
        captured = payload;
      });

      const fakeId = new Types.ObjectId().toString();
      await expect(repo.delete(fakeId)).rejects.toThrow();

      expect(captured).not.toBeNull();
      expect((captured!.error as Error).message).toContain('not found');
    });

    it('error hook receives the original error object', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      let receivedError: Error | null = null;
      repo.on('error:create', (payload: { context: unknown; error: unknown }) => {
        receivedError = payload.error as Error;
      });

      // Trigger a mongoose validation error
      try {
        await repo.create({} as Record<string, unknown>);
      } catch {
        // expected
      }

      expect(receivedError).not.toBeNull();
      expect(receivedError).toBeInstanceOf(mongoose.Error.ValidationError);
    });

    it('logs a warning when error hook itself throws (does not swallow silently)', async () => {
      const warnSpy = vi.fn();
      configureLogger({ warn: warnSpy });

      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      // Register an error hook that itself throws
      repo.on('error:create', () => {
        throw new Error('Telemetry tracking crashed');
      });

      // The original error should still propagate
      await expect(
        repo.create({ status: 'active' } as Record<string, unknown>)
      ).rejects.toThrow();

      // The warn logger should have been called with the hook failure
      expect(warnSpy).toHaveBeenCalled();
      const warnMessage = warnSpy.mock.calls[0][0] as string;
      expect(warnMessage).toContain('error:create');
      expect(warnMessage).toContain('Telemetry tracking crashed');

      // Restore default logger
      configureLogger({ warn: console.warn.bind(console) });
    });

    it('does not block the original error when error hook throws', async () => {
      // Silence warn output for this test
      configureLogger({ warn: () => {} });

      const repo = new Repository(Item, [], {}, { hooks: 'async' });

      repo.on('error:create', () => {
        throw new Error('Hook exploded');
      });

      // The original validation error must still propagate, not the hook error
      try {
        await repo.create({} as Record<string, unknown>);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).not.toContain('Hook exploded');
      }

      configureLogger({ warn: console.warn.bind(console) });
    });
  });

  // ---------------------------------------------------------------------------
  // Hook ordering
  // ---------------------------------------------------------------------------

  describe('Hook ordering', () => {
    it('multiple hooks on the same event execute in registration order', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });
      const order: number[] = [];

      repo.on('after:create', async () => { order.push(1); });
      repo.on('after:create', async () => { order.push(2); });
      repo.on('after:create', async () => { order.push(3); });

      await repo.create({ name: 'Order test', status: 'active' });

      expect(order).toEqual([1, 2, 3]);
    });

    it('before hook runs before after hook', async () => {
      const repo = new Repository(Item, [], {}, { hooks: 'async' });
      const sequence: string[] = [];

      repo.on('before:create', async () => { sequence.push('before'); });
      repo.on('after:create', async () => { sequence.push('after'); });

      await repo.create({ name: 'Sequence test', status: 'active' });

      expect(sequence).toEqual(['before', 'after']);
    });
  });
});
