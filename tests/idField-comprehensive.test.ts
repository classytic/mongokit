/**
 * Comprehensive idField integration tests
 *
 * Validates that ALL plugins, pagination, lookups, and agent-facing APIs
 * work correctly with custom idField (slug, code, chatId, UUID).
 */
import mongoose, { type Document, Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Repository from '../src/Repository.js';
import {
  softDeletePlugin,
  timestampPlugin,
  methodRegistryPlugin,
  batchOperationsPlugin,
  cachePlugin,
  createMemoryCache,
  multiTenantPlugin,
  validationChainPlugin,
  uniqueField,
  requireField,
  observabilityPlugin,
  QueryParser,
} from '../src/index.js';

// ─── Schemas ────────────────────────────────────────────────────────────────

interface IChat extends Document {
  chatId: string;
  title: string;
  userId: string;
  orgId: string;
  status: string;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface IMessage extends Document {
  chatId: string;
  role: string;
  text: string;
  createdAt?: Date;
}

const ChatSchema = new Schema<IChat>({
  chatId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  userId: { type: String, required: true },
  orgId: { type: String, required: true },
  status: { type: String, default: 'active', enum: ['active', 'archived'] },
  deletedAt: { type: Date, default: null },
});
ChatSchema.index({ orgId: 1, status: 1 });
ChatSchema.index({ userId: 1, createdAt: -1, _id: -1 });

const MessageSchema = new Schema<IMessage>({
  chatId: { type: String, required: true, index: true },
  role: { type: String, required: true },
  text: { type: String, required: true },
});

let mongo: MongoMemoryServer;
let ChatModel: mongoose.Model<IChat>;
let MessageModel: mongoose.Model<IMessage>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ChatModel = mongoose.model<IChat>('CompChat', ChatSchema);
  MessageModel = mongoose.model<IMessage>('CompMessage', MessageSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await ChatModel.deleteMany({});
  await MessageModel.deleteMany({});
});

// ─── Helper ─────────────────────────────────────────────────────────────────

async function seedChats(count: number, orgId = 'org-1') {
  const chats = Array.from({ length: count }, (_, i) => ({
    chatId: `chat-${String(i).padStart(4, '0')}`,
    title: `Chat ${i}`,
    userId: `user-${i % 5}`,
    orgId,
    status: i % 4 === 0 ? 'archived' : 'active',
  }));
  await ChatModel.insertMany(chats, { ordered: false });
}

// ─── CRUD with idField ─────────────────────────────────────────────────────

describe('CRUD operations with idField: chatId', () => {
  let repo: Repository<IChat>;

  beforeEach(async () => {
    repo = new Repository(ChatModel, [], {}, { idField: 'chatId' });
    await seedChats(10);
  });

  it('create returns doc with chatId', async () => {
    const doc = await repo.create({ chatId: 'new-chat', title: 'New', userId: 'u1', orgId: 'org-1' });
    expect((doc as IChat).chatId).toBe('new-chat');
  });

  it('getById finds by chatId', async () => {
    const doc = await repo.getById('chat-0005');
    expect((doc as IChat).title).toBe('Chat 5');
  });

  it('getByQuery still works with arbitrary filter', async () => {
    const doc = await repo.getByQuery({ userId: 'user-0', status: 'active' });
    expect(doc).not.toBeNull();
  });

  it('getOne with compound filter', async () => {
    const doc = await repo.getOne({ chatId: 'chat-0003', orgId: 'org-1' });
    expect((doc as IChat).title).toBe('Chat 3');
  });

  it('update by chatId', async () => {
    const updated = await repo.update('chat-0002', { title: 'Updated' });
    expect((updated as IChat).title).toBe('Updated');
  });

  it('delete by chatId', async () => {
    await repo.delete('chat-0001');
    const gone = await ChatModel.findOne({ chatId: 'chat-0001' });
    expect(gone).toBeNull();
  });

  it('count and exists work', async () => {
    const count = await repo.count({ status: 'active' });
    expect(count).toBeGreaterThan(0);
    const exists = await repo.exists({ chatId: 'chat-0000' });
    expect(!!exists).toBe(true);
  });

  it('getOrCreate with chatId', async () => {
    const doc = await repo.getOrCreate(
      { chatId: 'maybe-new' },
      { chatId: 'maybe-new', title: 'Maybe', userId: 'u1', orgId: 'org-1' },
    );
    expect((doc as IChat).chatId).toBe('maybe-new');

    // Second call should find, not create
    const again = await repo.getOrCreate(
      { chatId: 'maybe-new' },
      { chatId: 'maybe-new', title: 'Different', userId: 'u2', orgId: 'org-2' },
    );
    expect((again as IChat).title).toBe('Maybe'); // Original title
  });
});

// ─── Pagination with idField ────────────────────────────────────────────────

describe('Pagination with idField', () => {
  let repo: Repository<IChat>;

  beforeEach(async () => {
    repo = new Repository(ChatModel, [], { maxLimit: 0 }, { idField: 'chatId' });
    await seedChats(50);
  });

  it('offset pagination returns correct total', async () => {
    const result = await repo.getAll({ page: 1, limit: 10 });
    expect(result.docs.length).toBe(10);
    expect(result.total).toBe(50);
  });

  it('keyset pagination walks all docs without duplicates', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let i = 0; i < 10; i++) {
      const result = await repo.getAll({
        sort: { chatId: 1 },
        limit: 10,
        ...(cursor ? { after: cursor } : {}),
      });

      if (!('next' in result)) break;
      const keyset = result as { docs: IChat[]; hasMore: boolean; next: string | null };

      for (const doc of keyset.docs) {
        expect(seen.has(doc.chatId)).toBe(false);
        seen.add(doc.chatId);
      }

      if (!keyset.hasMore || !keyset.next) break;
      cursor = keyset.next;
    }

    expect(seen.size).toBe(50);
  });

  it('findAll returns all docs sorted', async () => {
    const result = await repo.findAll({}, { sort: { chatId: -1 } });
    expect(result.length).toBe(50);
    expect((result[0] as IChat).chatId > (result[1] as IChat).chatId).toBe(true);
  });

  it('noPagination uses context.filters (not params.filters)', async () => {
    // Simulate multi-tenant by hooking
    repo.on('before:getAll', (ctx) => {
      ctx.filters = { ...(ctx.filters || {}), orgId: 'org-1' };
    });

    const result = await repo.getAll({ noPagination: true });
    for (const doc of result as IChat[]) {
      expect(doc.orgId).toBe('org-1');
    }
  });
});

// ─── Soft-delete + idField ──────────────────────────────────────────────────

describe('Soft-delete plugin with idField', () => {
  let repo: Repository<IChat>;

  beforeEach(async () => {
    repo = new Repository(ChatModel, [softDeletePlugin()], {}, { idField: 'chatId' });
    await seedChats(5);
  });

  it('delete soft-deletes by chatId', async () => {
    await repo.delete('chat-0002');
    const raw = await ChatModel.findOne({ chatId: 'chat-0002' });
    expect(raw).not.toBeNull();
    expect(raw!.deletedAt).toBeInstanceOf(Date);
  });

  it('getById excludes soft-deleted', async () => {
    await repo.delete('chat-0002');
    const result = await repo.getById('chat-0002', { throwOnNotFound: false });
    expect(result).toBeNull();
  });

  it('getAll excludes soft-deleted', async () => {
    await repo.delete('chat-0001');
    await repo.delete('chat-0003');
    const result = await repo.getAll();
    expect(result.docs.length).toBe(3);
  });

  it('includeDeleted shows all', async () => {
    await repo.delete('chat-0001');
    const result = await repo.getAll({ includeDeleted: true } as Record<string, unknown>);
    expect(result.total).toBe(5);
  });
});

// ─── Batch ops + idField ────────────────────────────────────────────────────

describe('Batch operations with idField', () => {
  let repo: Repository<IChat> & {
    deleteMany: (filter: Record<string, unknown>) => Promise<unknown>;
    updateMany: (filter: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
  };

  beforeEach(async () => {
    repo = new Repository(ChatModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ], {}, { idField: 'chatId' }) as typeof repo;
    await seedChats(20);
  });

  it('deleteMany works', async () => {
    await repo.deleteMany({ status: 'archived' });
    const remaining = await ChatModel.countDocuments();
    expect(remaining).toBe(15); // 20 - 5 archived (every 4th)
  });

  it('updateMany works', async () => {
    await repo.updateMany({ status: 'active' }, { $set: { title: 'Bulk Updated' } });
    const updated = await ChatModel.countDocuments({ title: 'Bulk Updated' });
    expect(updated).toBe(15);
  });
});

// ─── Soft-delete + batch + idField ──────────────────────────────────────────

describe('Soft-delete + batch + idField combined', () => {
  let repo: Repository<IChat> & {
    deleteMany: (filter: Record<string, unknown>) => Promise<unknown>;
    updateMany: (filter: Record<string, unknown>, data: Record<string, unknown>) => Promise<unknown>;
  };

  beforeEach(async () => {
    repo = new Repository(ChatModel, [
      timestampPlugin(),
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      softDeletePlugin(),
    ], { maxLimit: 0 }, { idField: 'chatId' }) as typeof repo;
    await seedChats(20);
  });

  it('deleteMany soft-deletes, updateMany skips soft-deleted', async () => {
    // Soft-delete archived chats
    await repo.deleteMany({ status: 'archived' });

    // Verify soft-deleted (not hard-deleted)
    const rawArchived = await ChatModel.countDocuments({ status: 'archived', deletedAt: { $ne: null } });
    expect(rawArchived).toBe(5);

    // updateMany should skip soft-deleted
    await repo.updateMany({ orgId: 'org-1' }, { $set: { title: 'Mass Update' } });
    const updatedActive = await ChatModel.countDocuments({ title: 'Mass Update', deletedAt: null });
    const updatedDeleted = await ChatModel.countDocuments({ title: 'Mass Update', deletedAt: { $ne: null } });
    expect(updatedActive).toBe(15);
    expect(updatedDeleted).toBe(0); // Soft-deleted should NOT be updated
  });
});

// ─── Multi-tenant + idField ─────────────────────────────────────────────────

describe('Multi-tenant plugin with idField', () => {
  let repo: Repository<IChat>;

  beforeEach(async () => {
    repo = new Repository(ChatModel, [
      multiTenantPlugin({ tenantField: 'orgId', contextKey: 'organizationId' }),
    ], {}, { idField: 'chatId' });
    // Use different chatId prefixes per org to avoid unique constraint collision
    const orgAChats = Array.from({ length: 5 }, (_, i) => ({
      chatId: `a-chat-${i}`, title: `A-${i}`, userId: `user-${i}`, orgId: 'org-A', status: 'active',
    }));
    const orgBChats = Array.from({ length: 5 }, (_, i) => ({
      chatId: `b-chat-${i}`, title: `B-${i}`, userId: `user-${i}`, orgId: 'org-B', status: 'active',
    }));
    await ChatModel.insertMany([...orgAChats, ...orgBChats]);
  });

  afterEach(async () => {
    await ChatModel.deleteMany({});
  });

  it('getById scoped to tenant', async () => {
    const result = await repo.getById('a-chat-0', { organizationId: 'org-A' } as Record<string, unknown>);
    expect(result).not.toBeNull();
    expect((result as IChat).orgId).toBe('org-A');
  });

  it('getAll scoped to tenant', async () => {
    const result = await repo.getAll({
      filters: {},
    }, { organizationId: 'org-B' } as Record<string, unknown>);
    expect(result.docs.length).toBe(5);
    for (const doc of result.docs as IChat[]) {
      expect(doc.orgId).toBe('org-B');
    }
  });
});

// ─── Cache + idField ────────────────────────────────────────────────────────

describe('Cache plugin with idField', () => {
  let repo: Repository<IChat>;

  beforeEach(async () => {
    repo = new Repository(ChatModel, [
      cachePlugin({ adapter: createMemoryCache(), ttl: 60, byIdTtl: 120 }),
    ], {}, { idField: 'chatId' });
    await ChatModel.create({ chatId: 'cached-1', title: 'Cached', userId: 'u1', orgId: 'org-1' });
  });

  it('getById caches and invalidates on update', async () => {
    // Prime cache
    const first = await repo.getById('cached-1');
    expect((first as IChat).title).toBe('Cached');

    // Update
    await repo.update('cached-1', { title: 'Updated' });

    // Should return fresh data
    const second = await repo.getById('cached-1');
    expect((second as IChat).title).toBe('Updated');
  });

  it('getById caches and invalidates on delete', async () => {
    await repo.getById('cached-1');
    await repo.delete('cached-1');

    const gone = await repo.getById('cached-1', { throwOnNotFound: false });
    expect(gone).toBeNull();
  });
});

// ─── Validation chain + idField ─────────────────────────────────────────────

describe('Validation chain with idField', () => {
  let repo: Repository<IChat>;

  beforeEach(async () => {
    repo = new Repository(ChatModel, [
      validationChainPlugin([
        requireField('title', ['create']),
        uniqueField('chatId', 'Chat ID already exists'),
      ]),
    ], {}, { idField: 'chatId' });
  });

  it('uniqueField blocks duplicate chatId on create', async () => {
    await repo.create({ chatId: 'unique-1', title: 'First', userId: 'u1', orgId: 'org-1' });
    await expect(
      repo.create({ chatId: 'unique-1', title: 'Dupe', userId: 'u2', orgId: 'org-1' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('uniqueField allows update of own doc', async () => {
    await repo.create({ chatId: 'own-1', title: 'Original', userId: 'u1', orgId: 'org-1' });
    // Update same doc — should not trigger uniqueness error
    const updated = await repo.update('own-1', { title: 'Renamed' });
    expect((updated as IChat).title).toBe('Renamed');
  });
});

// ─── QueryParser integration with idField ───────────────────────────────────

describe('QueryParser → Repository with idField', () => {
  let repo: Repository<IChat>;
  const parser = new QueryParser({ maxLimit: 50 });

  beforeEach(async () => {
    repo = new Repository(ChatModel, [], { maxLimit: 50 }, { idField: 'chatId' });
    await seedChats(30);
  });

  it('parsed filters + sort + pagination work end-to-end', async () => {
    const parsed = parser.parse({
      status: 'active',
      sort: '-chatId',
      limit: '10',
      page: '1',
    });

    const result = await repo.getAll({
      filters: parsed.filters,
      sort: parsed.sort,
      limit: parsed.limit,
      page: parsed.page,
    });

    expect(result.docs.length).toBe(10);
    for (const doc of result.docs as IChat[]) {
      expect(doc.status).toBe('active');
    }
  });

  it('per-call idField override works with parser', async () => {
    // Default repo uses chatId, but per-call we use _id
    const doc = await ChatModel.findOne({ chatId: 'chat-0005' });
    const result = await repo.getById(String(doc!._id), { idField: '_id' });
    expect((result as IChat).chatId).toBe('chat-0005');
  });
});

// ─── Observability + idField ────────────────────────────────────────────────

describe('Observability plugin with idField', () => {
  it('metrics fire with correct operation names', async () => {
    const metrics: { operation: string; duration: number }[] = [];
    const repo = new Repository(ChatModel, [
      observabilityPlugin({
        onMetric: (m) => metrics.push({ operation: m.operation, duration: m.duration }),
      }),
    ], {}, { idField: 'chatId' });

    await repo.create({ chatId: 'obs-1', title: 'Observable', userId: 'u1', orgId: 'org-1' });
    await repo.getById('obs-1');
    await repo.update('obs-1', { title: 'Updated' });
    await repo.delete('obs-1');

    const ops = metrics.map(m => m.operation);
    expect(ops).toContain('create');
    expect(ops).toContain('getById');
    expect(ops).toContain('update');
    expect(ops).toContain('delete');
  });
});

// ─── Load test with idField ─────────────────────────────────────────────────

describe('Load test with idField', () => {
  let repo: Repository<IChat>;

  beforeEach(async () => {
    repo = new Repository(ChatModel, [
      timestampPlugin(),
      softDeletePlugin(),
    ], { maxLimit: 0 }, { idField: 'chatId' });
    await seedChats(500);
  }, 30_000);

  it('findAll 500 docs without OOM or timeout', async () => {
    const result = await repo.findAll();
    expect(result.length).toBe(500);
  });

  it('keyset paginates 500 docs in under 2s', async () => {
    const start = performance.now();
    const seen = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const result = await repo.getAll({
        sort: { chatId: 1 },
        limit: 100,
        ...(cursor ? { after: cursor } : {}),
      });

      if (!('next' in result)) break;
      const keyset = result as { docs: IChat[]; hasMore: boolean; next: string | null };
      for (const doc of keyset.docs) seen.add(doc.chatId);
      if (!keyset.hasMore || !keyset.next) break;
      cursor = keyset.next;
    }

    const elapsed = performance.now() - start;
    expect(seen.size).toBe(500);
    expect(elapsed).toBeLessThan(2000);
  });

  it('concurrent getById by chatId does not corrupt', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `chat-${String(i).padStart(4, '0')}`);
    const results = await Promise.all(ids.map(id => repo.getById(id)));
    for (let i = 0; i < results.length; i++) {
      expect(results[i]).not.toBeNull();
      expect((results[i] as IChat).chatId).toBe(ids[i]);
    }
  });

  it('soft-delete + getAll excludes correctly at scale', async () => {
    // Soft-delete every archived chat
    for (let i = 0; i < 500; i += 4) {
      await repo.delete(`chat-${String(i).padStart(4, '0')}`);
    }

    const active = await repo.getAll({ limit: 500 });
    expect(active.docs.length).toBe(375); // 500 - 125 archived
    for (const doc of active.docs as IChat[]) {
      expect(doc.deletedAt).toBeNull();
    }
  });
});
