/**
 * idField + getOne — TDD tests
 *
 * Tests that Repository can use a custom ID field (slug, code, chatId)
 * instead of always hardcoding _id for getById/update/delete.
 */
import mongoose, { type Document, Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Repository from '../src/Repository.js';
import {
  softDeletePlugin,
  methodRegistryPlugin,
  batchOperationsPlugin,
  cascadePlugin,
} from '../src/index.js';

interface IProduct extends Document {
  slug: string;
  name: string;
  price: number;
  status: string;
  deletedAt?: Date | null;
}

const ProductSchema = new Schema<IProduct>({
  slug: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  status: { type: String, default: 'active' },
  deletedAt: { type: Date, default: null },
});

let mongo: MongoMemoryServer;
let ProductModel: mongoose.Model<IProduct>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ProductModel = mongoose.model<IProduct>('IdFieldProduct', ProductSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await ProductModel.deleteMany({});
});

// ─── idField on getById ─────────────────────────────────────────────────────

describe('idField: custom ID field', () => {
  let repo: Repository<IProduct>;

  beforeEach(async () => {
    repo = new Repository(ProductModel, [], {}, { idField: 'slug' });
    await ProductModel.insertMany([
      { slug: 'laptop', name: 'Laptop', price: 999 },
      { slug: 'phone', name: 'Phone', price: 699 },
      { slug: 'tablet', name: 'Tablet', price: 499 },
    ]);
  });

  it('getById with slug finds the correct document', async () => {
    const result = await repo.getById('laptop');
    expect(result).not.toBeNull();
    expect((result as IProduct).name).toBe('Laptop');
    expect((result as IProduct).slug).toBe('laptop');
  });

  it('getById with non-existent slug returns null (throwOnNotFound: false)', async () => {
    const result = await repo.getById('nonexistent', { throwOnNotFound: false });
    expect(result).toBeNull();
  });

  it('getById with non-existent slug returns null by default (MinimalRepo contract)', async () => {
    const result = await repo.getById('nonexistent');
    expect(result).toBeNull();
  });

  it('getById with non-existent slug throws 404 with throwOnNotFound:true (legacy opt-in)', async () => {
    await expect(repo.getById('nonexistent', { throwOnNotFound: true })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('update by slug updates the correct document', async () => {
    const updated = await repo.update('phone', { price: 799 });
    expect(updated).not.toBeNull();
    expect((updated as IProduct).price).toBe(799);
    expect((updated as IProduct).slug).toBe('phone');
  });

  it('delete by slug deletes the correct document', async () => {
    const result = await repo.delete('tablet');
    expect(result.success).toBe(true);

    const remaining = await ProductModel.countDocuments();
    expect(remaining).toBe(2);

    const deleted = await ProductModel.findOne({ slug: 'tablet' });
    expect(deleted).toBeNull();
  });

  it('default idField is _id (backwards compatible)', async () => {
    const defaultRepo = new Repository(ProductModel);
    const doc = await ProductModel.findOne({ slug: 'laptop' });
    const result = await defaultRepo.getById(String(doc!._id));
    expect(result).not.toBeNull();
    expect((result as IProduct).slug).toBe('laptop');
  });
});

// ─── idField with soft-delete ───────────────────────────────────────────────

describe('idField + soft-delete plugin', () => {
  let repo: Repository<IProduct>;

  beforeEach(async () => {
    repo = new Repository(
      ProductModel,
      [softDeletePlugin()],
      {},
      { idField: 'slug' },
    );
    await ProductModel.insertMany([
      { slug: 'item-a', name: 'Item A', price: 10 },
      { slug: 'item-b', name: 'Item B', price: 20 },
    ]);
  });

  it('delete by slug soft-deletes (sets deletedAt)', async () => {
    await repo.delete('item-a');
    const doc = await ProductModel.findOne({ slug: 'item-a' });
    expect(doc).not.toBeNull();
    expect(doc!.deletedAt).toBeInstanceOf(Date);
  });

  it('getById by slug excludes soft-deleted docs', async () => {
    await repo.delete('item-a');
    const result = await repo.getById('item-a', { throwOnNotFound: false });
    expect(result).toBeNull();
  });
});

// ─── Per-call idField override ──────────────────────────────────────────────

describe('idField: per-call override', () => {
  let repo: Repository<IProduct>;

  beforeEach(async () => {
    // Default repo uses _id
    repo = new Repository(ProductModel);
    await ProductModel.insertMany([
      { slug: 'keyboard', name: 'Keyboard', price: 79 },
      { slug: 'mouse', name: 'Mouse', price: 49 },
    ]);
  });

  it('getById with per-call idField: slug', async () => {
    const result = await repo.getById('keyboard', { idField: 'slug' });
    expect(result).not.toBeNull();
    expect((result as IProduct).name).toBe('Keyboard');
  });

  it('update with per-call idField: slug', async () => {
    const updated = await repo.update('mouse', { price: 59 }, { idField: 'slug' });
    expect((updated as IProduct).price).toBe(59);
  });

  it('delete with per-call idField: slug', async () => {
    await repo.delete('keyboard', { idField: 'slug' });
    const remaining = await ProductModel.countDocuments();
    expect(remaining).toBe(1);
  });

  it('same repo can use _id and slug in different calls', async () => {
    const doc = await ProductModel.findOne({ slug: 'mouse' });
    // By _id
    const byId = await repo.getById(String(doc!._id));
    expect((byId as IProduct).slug).toBe('mouse');
    // By slug
    const bySlug = await repo.getById('mouse', { idField: 'slug' });
    expect((bySlug as IProduct).slug).toBe('mouse');
  });
});

// ─── getOne ─────────────────────────────────────────────────────────────────

describe('getOne() — find single doc by arbitrary filter', () => {
  let repo: Repository<IProduct>;

  beforeEach(async () => {
    repo = new Repository(ProductModel);
    await ProductModel.insertMany([
      { slug: 'alpha', name: 'Alpha', price: 100, status: 'active' },
      { slug: 'beta', name: 'Beta', price: 200, status: 'active' },
      { slug: 'gamma', name: 'Gamma', price: 300, status: 'draft' },
    ]);
  });

  it('finds doc by arbitrary filter', async () => {
    const result = await repo.getOne({ slug: 'beta' });
    expect(result).not.toBeNull();
    expect((result as IProduct).name).toBe('Beta');
  });

  it('finds doc by compound filter', async () => {
    const result = await repo.getOne({ status: 'draft', price: 300 });
    expect(result).not.toBeNull();
    expect((result as IProduct).slug).toBe('gamma');
  });

  it('returns null when no match (throwOnNotFound: false)', async () => {
    const result = await repo.getOne({ slug: 'nonexistent' }, { throwOnNotFound: false });
    expect(result).toBeNull();
  });

  it('returns null when no match by default (MinimalRepo contract)', async () => {
    const result = await repo.getOne({ slug: 'nope' });
    expect(result).toBeNull();
  });

  it('throws 404 when no match with throwOnNotFound:true (legacy opt-in)', async () => {
    await expect(repo.getOne({ slug: 'nope' }, { throwOnNotFound: true })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('supports select option', async () => {
    const result = await repo.getOne({ slug: 'alpha' }, { select: 'name', lean: true });
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>)).toHaveProperty('name');
    expect((result as Record<string, unknown>)).not.toHaveProperty('price');
  });

  it('supports populate option', async () => {
    // Just test it doesn't throw — no refs to populate
    const result = await repo.getOne({ slug: 'alpha' }, { populate: '' });
    expect(result).not.toBeNull();
  });

  it('fires before:getOne and after:getOne hooks', async () => {
    const calls: string[] = [];
    repo.on('before:getOne', () => { calls.push('before'); });
    repo.on('after:getOne', () => { calls.push('after'); });

    await repo.getOne({ slug: 'alpha' });
    expect(calls).toEqual(['before', 'after']);
  });
});

// ─── cascadePlugin + deleteMany + idField ───────────────────────────────────

describe('cascadePlugin deleteMany respects idField', () => {
  interface IChat extends Document {
    chatId: string;
    title: string;
    userId: string;
  }

  interface IMessage extends Document {
    chatId: string;
    text: string;
  }

  const ChatSchema = new Schema<IChat>({
    chatId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    userId: { type: String, required: true },
  });

  const MessageSchema = new Schema<IMessage>({
    chatId: { type: String, required: true, index: true },
    text: { type: String, required: true },
  });

  let ChatModel: mongoose.Model<IChat>;
  let MessageModel: mongoose.Model<IMessage>;

  beforeAll(() => {
    ChatModel = mongoose.model<IChat>('CascadeChat', ChatSchema);
    MessageModel = mongoose.model<IMessage>('CascadeMessage', MessageSchema);
  });

  afterEach(async () => {
    await ChatModel.deleteMany({});
    await MessageModel.deleteMany({});
  });

  it('deleteMany cascades using idField (not _id)', async () => {
    const repo = new Repository(ChatModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      cascadePlugin({
        relations: [{ model: 'CascadeMessage', foreignKey: 'chatId' }],
      }),
    ], {}, { idField: 'chatId' }) as Repository<IChat> & {
      deleteMany: (filter: Record<string, unknown>) => Promise<unknown>;
    };

    // Create 2 chats with messages
    await ChatModel.create({ chatId: 'chat-1', title: 'Chat 1', userId: 'u1' });
    await ChatModel.create({ chatId: 'chat-2', title: 'Chat 2', userId: 'u1' });
    await MessageModel.create({ chatId: 'chat-1', text: 'msg1' });
    await MessageModel.create({ chatId: 'chat-1', text: 'msg2' });
    await MessageModel.create({ chatId: 'chat-2', text: 'msg3' });

    // Delete all chats for user u1
    await repo.deleteMany({ userId: 'u1' });

    // Both chats should be deleted
    expect(await ChatModel.countDocuments()).toBe(0);
    // All messages should be cascade-deleted using chatId (not _id)
    expect(await MessageModel.countDocuments()).toBe(0);
  });

  it('single delete cascades correctly with idField', async () => {
    const repo = new Repository(ChatModel, [
      cascadePlugin({
        relations: [{ model: 'CascadeMessage', foreignKey: 'chatId' }],
      }),
    ], {}, { idField: 'chatId' });

    await ChatModel.create({ chatId: 'chat-x', title: 'X', userId: 'u2' });
    await MessageModel.create({ chatId: 'chat-x', text: 'hello' });
    await MessageModel.create({ chatId: 'chat-x', text: 'world' });

    await repo.delete('chat-x');

    expect(await ChatModel.countDocuments()).toBe(0);
    expect(await MessageModel.countDocuments({ chatId: 'chat-x' })).toBe(0);
  });
});
