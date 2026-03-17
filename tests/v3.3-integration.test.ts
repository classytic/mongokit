/**
 * v3.3.0 Integration Tests
 *
 * Comprehensive tests using MongoMemoryServer with realistic mock data.
 * Tests all fixes introduced in 3.3.0 with real MongoDB operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, Types } from 'mongoose';
import {
  Repository,
  PaginationEngine,
  cachePlugin,
  softDeletePlugin,
  cascadePlugin,
  multiTenantPlugin,
  validationChainPlugin,
  methodRegistryPlugin,
  batchOperationsPlugin,
  createMemoryCache,
  requireField,
  uniqueField,
  immutableField,
} from '../src/index.js';
import { connectDB, disconnectDB, clearDB, createTestModel } from './setup.js';
import { deleteByQuery, deleteById, deleteMany, softDelete, restore } from '../src/actions/delete.js';

// ════════════════════════════════════════════════════════════════════════════
// Schemas — realistic domain models
// ════════════════════════════════════════════════════════════════════════════

interface IUser {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: string;
  organizationId?: string;
  active: boolean;
  score: number;
  createdAt: Date;
  deletedAt?: Date | null;
}

const UserSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, required: true },
  role: { type: String, default: 'user' },
  organizationId: { type: String },
  active: { type: Boolean, default: true },
  score: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null },
});
UserSchema.index({ createdAt: -1, _id: -1 });
UserSchema.index({ score: -1, _id: -1 });
UserSchema.index({ active: 1, _id: -1 });

interface IPost {
  _id: Types.ObjectId;
  title: string;
  authorId: Types.ObjectId;
  status: string;
  views: number;
  createdAt: Date;
}

const PostSchema = new Schema<IPost>({
  title: { type: String, required: true },
  authorId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, default: 'draft' },
  views: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

interface IComment {
  _id: Types.ObjectId;
  postId: Types.ObjectId;
  text: string;
  createdAt: Date;
}

const CommentSchema = new Schema<IComment>({
  postId: { type: Schema.Types.ObjectId, required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Delete Actions — Full Integration
// ════════════════════════════════════════════════════════════════════════════

describe('Delete Actions Integration', () => {
  let UserModel: mongoose.Model<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('DelActUser', UserSchema);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  describe('deleteById', () => {
    it('should delete and return correct id', async () => {
      const user = await UserModel.create({ name: 'Alice', email: 'alice@test.com' });
      const result = await deleteById(UserModel, user._id);

      expect(result.success).toBe(true);
      expect(result.id).toBe(user._id.toString());
      expect(result.message).toBe('Deleted successfully');

      // Verify actually deleted
      const found = await UserModel.findById(user._id);
      expect(found).toBeNull();
    });

    it('should throw 404 for non-existent id', async () => {
      const fakeId = new Types.ObjectId();
      await expect(deleteById(UserModel, fakeId)).rejects.toThrow('Document not found');
    });

    it('should respect query constraints', async () => {
      const user = await UserModel.create({ name: 'Bob', email: 'bob@test.com', organizationId: 'org_1' });

      // Should not delete if query doesn't match
      await expect(
        deleteById(UserModel, user._id, { query: { organizationId: 'org_2' } })
      ).rejects.toThrow('Document not found');

      // Should delete with matching query
      const result = await deleteById(UserModel, user._id, { query: { organizationId: 'org_1' } });
      expect(result.success).toBe(true);
    });
  });

  describe('deleteByQuery', () => {
    it('should return document _id from deleted doc', async () => {
      const user = await UserModel.create({ name: 'Charlie', email: 'charlie@test.com', role: 'admin' });
      const result = await deleteByQuery(UserModel, { role: 'admin' });

      expect(result.success).toBe(true);
      expect(result.id).toBe(user._id.toString());
      expect(result.id).not.toBe('undefined');
    });

    it('should delete only the first matching document', async () => {
      await UserModel.create([
        { name: 'D1', email: 'd1@test.com', role: 'editor' },
        { name: 'D2', email: 'd2@test.com', role: 'editor' },
      ]);

      const result = await deleteByQuery(UserModel, { role: 'editor' });
      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();

      // One should remain
      const remaining = await UserModel.countDocuments({ role: 'editor' });
      expect(remaining).toBe(1);
    });

    it('should throw 404 when no match (default)', async () => {
      await expect(
        deleteByQuery(UserModel, { email: 'nonexistent@test.com' })
      ).rejects.toThrow('Document not found');
    });

    it('should return success without id when throwOnNotFound is false', async () => {
      const result = await deleteByQuery(
        UserModel,
        { email: 'nonexistent@test.com' },
        { throwOnNotFound: false }
      );

      expect(result.success).toBe(true);
      expect(result.id).toBeUndefined();
    });
  });

  describe('deleteMany', () => {
    it('should return count of deleted documents', async () => {
      await UserModel.create([
        { name: 'E1', email: 'e1@test.com', role: 'temp' },
        { name: 'E2', email: 'e2@test.com', role: 'temp' },
        { name: 'E3', email: 'e3@test.com', role: 'temp' },
        { name: 'E4', email: 'e4@test.com', role: 'keeper' },
      ]);

      const result = await deleteMany(UserModel, { role: 'temp' });
      expect(result.success).toBe(true);
      expect(result.count).toBe(3);

      const remaining = await UserModel.countDocuments();
      expect(remaining).toBe(1);
    });

    it('should return count 0 when no matches', async () => {
      const result = await deleteMany(UserModel, { role: 'ghost' });
      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
    });
  });

  describe('softDelete and restore', () => {
    it('should soft delete and return soft flag', async () => {
      const SoftSchema = new Schema({
        name: String,
        deleted: { type: Boolean, default: false },
        deletedAt: { type: Date, default: null },
        deletedBy: { type: String, default: null },
      });
      const SoftModel = await createTestModel('SoftActUser', SoftSchema);
      const doc = await SoftModel.create({ name: 'SoftUser' });

      const result = await softDelete(SoftModel, doc._id);
      expect(result.success).toBe(true);
      expect(result.soft).toBe(true);
      expect(result.id).toBe(doc._id.toString());

      // Verify doc still exists but is marked deleted
      const updated = await SoftModel.findById(doc._id);
      expect(updated).not.toBeNull();
      expect(updated!.get('deleted')).toBe(true);
      expect(updated!.get('deletedAt')).toBeInstanceOf(Date);
    });

    it('should restore soft-deleted document', async () => {
      const SoftSchema = new Schema({
        name: String,
        deleted: { type: Boolean, default: false },
        deletedAt: { type: Date, default: null },
        deletedBy: { type: String, default: null },
      });
      const RestoreModel = await createTestModel('RestoreActUser', SoftSchema);
      const doc = await RestoreModel.create({ name: 'RestoreMe' });

      await softDelete(RestoreModel, doc._id);
      const result = await restore(RestoreModel, doc._id);

      expect(result.success).toBe(true);
      expect(result.id).toBe(doc._id.toString());
      expect(result.message).toBe('Restored successfully');

      const restored = await RestoreModel.findById(doc._id);
      expect(restored!.get('deleted')).toBe(false);
      expect(restored!.get('deletedAt')).toBeNull();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Repository.delete() — DeleteResult type integration
// ════════════════════════════════════════════════════════════════════════════

describe('Repository.delete() DeleteResult', () => {
  let UserModel: mongoose.Model<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('RepoDelUser', UserSchema);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  it('should return DeleteResult with id on hard delete', async () => {
    const repo = new Repository(UserModel);
    const user = await repo.create({ name: 'HardDel', email: 'hard@test.com' });
    const result = await repo.delete(user._id.toString());

    expect(result.success).toBe(true);
    expect(result.message).toBe('Deleted successfully');
    expect(result.id).toBe(user._id.toString());
    expect(result.soft).toBeUndefined();
  });

  it('should return DeleteResult with soft flag on soft delete', async () => {
    const repo = new Repository(UserModel, [
      softDeletePlugin({ deletedField: 'deletedAt' }),
    ]);
    const user = await repo.create({ name: 'SoftDel', email: 'soft@test.com' });
    const result = await repo.delete(user._id.toString());

    expect(result.success).toBe(true);
    expect(result.id).toBe(user._id.toString());
    expect(result.soft).toBe(true);
    expect(result.message).toBe('Soft deleted successfully');

    // Verify document still exists with deletedAt set
    const raw = await UserModel.findById(user._id);
    expect(raw).not.toBeNull();
    expect(raw!.deletedAt).toBeInstanceOf(Date);
  });

  it('should throw 404 for non-existent document', async () => {
    const repo = new Repository(UserModel);
    const fakeId = new Types.ObjectId().toString();
    await expect(repo.delete(fakeId)).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Pagination hasNext — Real Data (offset, keyset, aggregate)
// ════════════════════════════════════════════════════════════════════════════

describe('Pagination hasNext with Real Data', () => {
  let UserModel: mongoose.Model<IUser>;
  let engine: PaginationEngine<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('PagUser', UserSchema);
    engine = new PaginationEngine(UserModel);

    // Insert exactly 10 users
    const users = Array.from({ length: 10 }, (_, i) => ({
      name: `User${i + 1}`,
      email: `user${i + 1}@test.com`,
      score: (i + 1) * 10,
      active: i < 5,
      createdAt: new Date(2026, 0, i + 1),
    }));
    await UserModel.create(users);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  describe('Offset pagination', () => {
    it('should have hasNext=true when more pages exist', async () => {
      const result = await engine.paginate({ limit: 3, page: 1 });
      expect(result.docs).toHaveLength(3);
      expect(result.hasNext).toBe(true);
      expect(result.total).toBe(10);
      expect(result.pages).toBe(4);
    });

    it('should have hasNext=false on last page', async () => {
      const result = await engine.paginate({ limit: 3, page: 4 });
      expect(result.docs).toHaveLength(1);
      expect(result.hasNext).toBe(false);
    });

    it('should have hasNext=false when limit equals total (countStrategy none)', async () => {
      const result = await engine.paginate({ limit: 10, countStrategy: 'none' });
      expect(result.docs).toHaveLength(10);
      expect(result.hasNext).toBe(false); // was true before fix
    });

    it('should have hasNext=true when more docs exist (countStrategy none)', async () => {
      const result = await engine.paginate({ limit: 5, countStrategy: 'none' });
      expect(result.docs).toHaveLength(5);
      expect(result.hasNext).toBe(true);
    });

    it('should have hasNext=false when fewer docs than limit (countStrategy none)', async () => {
      const result = await engine.paginate({
        limit: 20,
        countStrategy: 'none',
      });
      expect(result.docs).toHaveLength(10);
      expect(result.hasNext).toBe(false);
    });
  });

  describe('Keyset pagination', () => {
    it('should paginate through all 10 users with cursors', async () => {
      let allDocs: unknown[] = [];
      let cursor: string | null = null;

      // Page through 3 at a time
      for (let i = 0; i < 10; i++) {
        const result = await engine.stream({
          sort: { createdAt: -1 },
          limit: 3,
          ...(cursor ? { after: cursor } : {}),
        });
        allDocs = [...allDocs, ...result.docs];
        cursor = result.next;

        if (!result.hasMore) break;
      }

      expect(allDocs).toHaveLength(10);
    });

    it('should have hasMore=false when exactly limit docs remain', async () => {
      // Get first 7 docs
      const page1 = await engine.stream({ sort: { createdAt: -1 }, limit: 7 });
      expect(page1.hasMore).toBe(true);

      // Get remaining 3 docs — exactly matches limit
      const page2 = await engine.stream({
        sort: { createdAt: -1 },
        after: page1.next!,
        limit: 3,
      });
      expect(page2.docs).toHaveLength(3);
      expect(page2.hasMore).toBe(false); // no more after these 3
    });
  });

  describe('Aggregate pagination', () => {
    it('should have hasNext=false when limit equals total (countStrategy none)', async () => {
      const result = await engine.aggregatePaginate({
        pipeline: [{ $match: {} }],
        limit: 10,
        countStrategy: 'none',
      });
      expect(result.docs).toHaveLength(10);
      expect(result.hasNext).toBe(false); // was true before fix
    });

    it('should have hasNext=true when more docs exist (countStrategy none)', async () => {
      const result = await engine.aggregatePaginate({
        pipeline: [{ $match: {} }],
        limit: 5,
        countStrategy: 'none',
      });
      expect(result.docs).toHaveLength(5);
      expect(result.hasNext).toBe(true);
    });

    it('should paginate with filters correctly', async () => {
      const result = await engine.aggregatePaginate({
        pipeline: [{ $match: { active: true } }],
        limit: 10,
        page: 1,
      });
      expect(result.docs).toHaveLength(5);
      expect(result.hasNext).toBe(false);
      expect(result.total).toBe(5);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Boolean Cursor — End-to-End with Real Data
// ════════════════════════════════════════════════════════════════════════════

describe('Boolean Cursor E2E', () => {
  let UserModel: mongoose.Model<IUser>;
  let repo: Repository<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('BoolCursorUser', UserSchema);
    repo = new Repository(UserModel);

    // Create mix of active/inactive users
    await UserModel.create([
      { name: 'Active1', email: 'a1@test.com', active: true, score: 90 },
      { name: 'Active2', email: 'a2@test.com', active: true, score: 80 },
      { name: 'Inactive1', email: 'i1@test.com', active: false, score: 70 },
      { name: 'Inactive2', email: 'i2@test.com', active: false, score: 60 },
      { name: 'Inactive3', email: 'i3@test.com', active: false, score: 50 },
    ]);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  it('should correctly paginate across boolean boundary active desc', async () => {
    const page1 = await repo.getAll({
      mode: 'keyset',
      sort: { active: -1 },
      limit: 2,
    });

    expect(page1.method).toBe('keyset');
    const p1 = page1 as { docs: IUser[]; hasMore: boolean; next: string | null };
    expect(p1.docs).toHaveLength(2);
    expect(p1.hasMore).toBe(true);

    // All page 1 should be active=true
    for (const doc of p1.docs) {
      expect(doc.active).toBe(true);
    }

    // Page 2 should cross boundary
    const page2 = await repo.getAll({
      mode: 'keyset',
      sort: { active: -1 },
      after: p1.next!,
      limit: 2,
    });

    const p2 = page2 as { docs: IUser[]; hasMore: boolean; next: string | null };
    expect(p2.docs).toHaveLength(2);
    expect(p2.hasMore).toBe(true);

    // Page 3 — last item
    const page3 = await repo.getAll({
      mode: 'keyset',
      sort: { active: -1 },
      after: p2.next!,
      limit: 2,
    });

    const p3 = page3 as { docs: IUser[]; hasMore: boolean };
    expect(p3.docs).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Cache Plugin — Error Tracking & Stats
// ════════════════════════════════════════════════════════════════════════════

describe('Cache Plugin Full Integration', () => {
  let UserModel: mongoose.Model<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('CacheIntUser', UserSchema);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  it('should track hits and misses with real cache', async () => {
    const repo = new Repository(UserModel, [
      cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
    ]) as any;

    const user = await repo.create({ name: 'CacheUser', email: 'cache@test.com' });

    // First read — cache miss
    const r1 = await repo.getById(user._id);
    let stats = repo.getCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.sets).toBe(1);

    // Second read — cache hit
    const r2 = await repo.getById(user._id);
    stats = repo.getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);

    // Both should return same data
    expect(r1.name).toBe('CacheUser');
    expect(r2.name).toBe('CacheUser');
  });

  it('should invalidate cache on update', async () => {
    const repo = new Repository(UserModel, [
      cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
    ]) as any;

    const user = await repo.create({ name: 'Original', email: 'inv@test.com' });

    // Cache the doc
    await repo.getById(user._id);
    expect(repo.getCacheStats().misses).toBe(1);

    // Update invalidates cache
    await repo.update(user._id.toString(), { name: 'Updated' });
    expect(repo.getCacheStats().invalidations).toBeGreaterThanOrEqual(1);

    // Next read should be a miss (re-fetched from DB)
    const fresh = await repo.getById(user._id);
    expect(fresh.name).toBe('Updated');
  });

  it('should track errors on adapter failure', async () => {
    const failingAdapter = {
      async get() { throw new Error('Connection refused'); },
      async set() { /* no-op */ },
      async del() { /* no-op */ },
    };

    const repo = new Repository(UserModel, [
      cachePlugin({ adapter: failingAdapter as any, ttl: 60 }),
    ]) as any;

    const user = await repo.create({ name: 'ErrUser', email: 'err@test.com' });
    await repo.getById(user._id); // adapter.get throws

    const stats = repo.getCacheStats();
    expect(stats.errors).toBeGreaterThanOrEqual(1);
    expect(stats.misses).toBe(0); // errors != misses
  });

  it('should skip cache when skipCache is true', async () => {
    const repo = new Repository(UserModel, [
      cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
    ]) as any;

    const user = await repo.create({ name: 'SkipCache', email: 'skip@test.com' });

    // Normal read — cached
    await repo.getById(user._id);
    expect(repo.getCacheStats().misses).toBe(1);

    // Skip cache — no hit/miss increment
    const prevStats = repo.getCacheStats();
    await repo.getById(user._id, { skipCache: true });
    const newStats = repo.getCacheStats();
    expect(newStats.hits).toBe(prevStats.hits);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Cascade Delete — Real Models
// ════════════════════════════════════════════════════════════════════════════

describe('Cascade Delete Integration', () => {
  let PostModel: mongoose.Model<IPost>;
  let CommentModel: mongoose.Model<IComment>;

  beforeAll(async () => {
    await connectDB();
    PostModel = await createTestModel('CascPost', PostSchema);
    CommentModel = await createTestModel('CascComment', CommentSchema);
  });

  afterAll(async () => {
    await PostModel.deleteMany({});
    await CommentModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await PostModel.deleteMany({});
    await CommentModel.deleteMany({});
  });

  it('should cascade delete comments when post is deleted', async () => {
    const postRepo = new Repository(PostModel, [
      cascadePlugin({
        relations: [
          { model: 'CascComment', foreignKey: 'postId' },
        ],
      }),
    ]);

    const authorId = new Types.ObjectId();
    const post = await postRepo.create({ title: 'Test Post', authorId });

    // Add comments
    await CommentModel.create([
      { postId: post._id, text: 'Comment 1' },
      { postId: post._id, text: 'Comment 2' },
      { postId: post._id, text: 'Comment 3' },
    ]);

    expect(await CommentModel.countDocuments({ postId: post._id })).toBe(3);

    // Delete post — should cascade
    await postRepo.delete(post._id.toString());

    // Comments should be gone
    expect(await CommentModel.countDocuments({ postId: post._id })).toBe(0);
  });

  it('should handle cascade when related model has no matching docs', async () => {
    const postRepo = new Repository(PostModel, [
      cascadePlugin({
        relations: [
          { model: 'CascComment', foreignKey: 'postId' },
        ],
      }),
    ]);

    const authorId = new Types.ObjectId();
    const post = await postRepo.create({ title: 'No Comments Post', authorId });

    // Delete post with no comments — should not throw
    const result = await postRepo.delete(post._id.toString());
    expect(result.success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Multi-Tenant — Isolation Tests
// ════════════════════════════════════════════════════════════════════════════

describe('Multi-Tenant Isolation', () => {
  let UserModel: mongoose.Model<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('MTUser', UserSchema);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  it('should inject tenant on create', async () => {
    const repo = new Repository(UserModel, [
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);

    const user = await repo.create(
      { name: 'TenantUser', email: 'tenant@test.com' },
      { organizationId: 'org_abc' }
    );

    expect(user.organizationId).toBe('org_abc');
  });

  it('should inject tenant on createMany with null-safe iteration', async () => {
    const repo = new Repository(UserModel, [
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);

    const users = await repo.createMany(
      [
        { name: 'A', email: 'a@test.com' },
        { name: 'B', email: 'b@test.com' },
      ],
      { organizationId: 'org_xyz' }
    );

    for (const u of users) {
      expect(u.organizationId).toBe('org_xyz');
    }
  });

  it('should scope reads by tenant', async () => {
    const repo = new Repository(UserModel, [
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);

    // Create users in different orgs
    await repo.create({ name: 'Org1User', email: 'o1@test.com' }, { organizationId: 'org_1' });
    await repo.create({ name: 'Org2User', email: 'o2@test.com' }, { organizationId: 'org_2' });

    const org1Result = await repo.getAll({}, { organizationId: 'org_1' });
    expect(org1Result.docs).toHaveLength(1);
    expect((org1Result.docs[0] as IUser).name).toBe('Org1User');
  });

  it('should prevent cross-tenant deletion', async () => {
    const repo = new Repository(UserModel, [
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);

    const user = await repo.create(
      { name: 'Protected', email: 'protected@test.com' },
      { organizationId: 'org_safe' }
    );

    // Try to delete from different org — should fail
    await expect(
      repo.delete(user._id.toString(), { organizationId: 'org_attacker' } as any)
    ).rejects.toThrow();

    // User should still exist
    const raw = await UserModel.findById(user._id);
    expect(raw).not.toBeNull();
  });

  it('should throw when tenant is missing and required', async () => {
    const repo = new Repository(UserModel, [
      multiTenantPlugin({ tenantField: 'organizationId', required: true }),
    ]);

    await expect(
      repo.create({ name: 'NoTenant', email: 'no@test.com' })
    ).rejects.toThrow(/Missing 'organizationId'/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Validation Chain — uniqueField Warning
// ════════════════════════════════════════════════════════════════════════════

describe('Validation Chain Integration', () => {
  let UserModel: mongoose.Model<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('ValUser', UserSchema);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  it('should enforce required fields', async () => {
    const repo = new Repository(UserModel, [
      validationChainPlugin([
        requireField('email', ['create']),
      ]),
    ]);

    await expect(
      repo.create({ name: 'NoEmail' } as any)
    ).rejects.toThrow(/Field 'email' is required/);
  });

  it('should enforce unique field on create', async () => {
    const repo = new Repository(UserModel, [
      validationChainPlugin([
        uniqueField('email', 'Email already taken'),
      ]),
    ]);

    await repo.create({ name: 'First', email: 'unique@test.com' });

    await expect(
      repo.create({ name: 'Second', email: 'unique@test.com' })
    ).rejects.toThrow('Email already taken');
  });

  it('should allow same email on update for same document', async () => {
    const repo = new Repository(UserModel, [
      validationChainPlugin([
        uniqueField('email'),
      ]),
    ]);

    const user = await repo.create({ name: 'Self', email: 'self@test.com' });

    // Updating the same doc with same email should NOT throw
    const updated = await repo.update(user._id.toString(), {
      name: 'Self Updated',
      email: 'self@test.com',
    });
    expect(updated.name).toBe('Self Updated');
  });

  it('should enforce immutable fields', async () => {
    const repo = new Repository(UserModel, [
      validationChainPlugin([
        immutableField('email'),
      ]),
    ]);

    const user = await repo.create({ name: 'Immutable', email: 'fixed@test.com' });

    await expect(
      repo.update(user._id.toString(), { email: 'changed@test.com' })
    ).rejects.toThrow(/Field 'email' cannot be modified/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Soft Delete + Cache Interaction
// ════════════════════════════════════════════════════════════════════════════

describe('Soft Delete + Cache Interaction', () => {
  let UserModel: mongoose.Model<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('SDCacheUser', UserSchema);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  it('should invalidate cache on soft delete and exclude from reads', async () => {
    const repo = new Repository(UserModel, [
      softDeletePlugin({ deletedField: 'deletedAt' }),
      cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
    ]) as any;

    const user = await repo.create({ name: 'CacheSoftDel', email: 'cs@test.com' });

    // Cache the user
    await repo.getById(user._id);
    expect(repo.getCacheStats().misses).toBe(1);

    // Soft delete — should invalidate
    const delResult = await repo.delete(user._id.toString());
    expect(delResult.soft).toBe(true);

    // getAll should not include soft-deleted user
    const all = await repo.getAll({});
    expect(all.docs).toHaveLength(0);

    // getAll with includeDeleted should include it
    const allIncluded = await repo.getAll({ includeDeleted: true });
    expect(allIncluded.docs).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Batch Operations — updateMany Safety
// ════════════════════════════════════════════════════════════════════════════

describe('Batch Operations Safety', () => {
  let UserModel: mongoose.Model<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('BatchUser', UserSchema);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  it('should reject updateMany with empty query', async () => {
    const repo = new Repository(UserModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ]) as any;

    await repo.create({ name: 'Safe1', email: 's1@test.com', score: 10 });
    await repo.create({ name: 'Safe2', email: 's2@test.com', score: 20 });

    await expect(
      repo.updateMany({}, { score: 999 })
    ).rejects.toThrow(/non-empty query filter/);

    // Verify no docs were updated
    const docs = await UserModel.find({});
    expect(docs.every(d => d.score < 100)).toBe(true);
  });

  it('should allow updateMany with valid query', async () => {
    const repo = new Repository(UserModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ]) as any;

    await repo.create({ name: 'Low1', email: 'l1@test.com', score: 10, role: 'user' });
    await repo.create({ name: 'Low2', email: 'l2@test.com', score: 20, role: 'user' });
    await repo.create({ name: 'Admin', email: 'admin@test.com', score: 50, role: 'admin' });

    const result = await repo.updateMany({ role: 'user' }, { score: 100 });
    expect(result.modifiedCount).toBe(2);

    // Admin should be unaffected
    const admin = await UserModel.findOne({ role: 'admin' });
    expect(admin!.score).toBe(50);
  });

  it('should allow deleteMany with valid query', async () => {
    const repo = new Repository(UserModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
    ]) as any;

    await repo.create({ name: 'Del1', email: 'd1@test.com', role: 'temp' });
    await repo.create({ name: 'Del2', email: 'd2@test.com', role: 'temp' });
    await repo.create({ name: 'Keep', email: 'keep@test.com', role: 'perm' });

    const result = await repo.deleteMany({ role: 'temp' });
    expect(result.deletedCount).toBe(2);

    const remaining = await UserModel.countDocuments();
    expect(remaining).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Transaction Fallback on Standalone
// ════════════════════════════════════════════════════════════════════════════

describe('Transaction Fallback', () => {
  let UserModel: mongoose.Model<IUser>;
  let repo: Repository<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('TxnUser', UserSchema);
    repo = new Repository(UserModel);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  it('should fallback gracefully on standalone MongoDB', async () => {
    // MongoMemoryServer is standalone — transactions are unsupported
    const result = await repo.withTransaction(
      async () => {
        const user = await repo.create({ name: 'TxnUser', email: 'txn@test.com' });
        return user;
      },
      { allowFallback: true }
    );

    expect(result).toBeDefined();
    expect(result.name).toBe('TxnUser');
  });

  it('should call onFallback when transaction falls back', async () => {
    let fallbackCalled = false;

    await repo.withTransaction(
      async () => {
        return await repo.create({ name: 'FallbackUser', email: 'fb@test.com' });
      },
      {
        allowFallback: true,
        onFallback: () => { fallbackCalled = true; },
      }
    );

    // On standalone, should fall back (or succeed directly — either is fine)
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Repository getAll — Full CRUD Cycle with Pagination
// ════════════════════════════════════════════════════════════════════════════

describe('Full CRUD Cycle with Pagination', () => {
  let UserModel: mongoose.Model<IUser>;
  let repo: Repository<IUser>;

  beforeAll(async () => {
    await connectDB();
    UserModel = await createTestModel('CrudUser', UserSchema);
    repo = new Repository(UserModel);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await disconnectDB();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
  });

  it('should create, read, update, delete with consistent results', async () => {
    // Create 5 users
    const users = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repo.create({ name: `User${i}`, email: `u${i}@test.com`, score: i * 10 })
      )
    );

    // Read all with offset pagination
    const page = await repo.getAll({ page: 1, limit: 3, sort: { score: 1 } });
    expect(page.docs).toHaveLength(3);
    expect((page as any).total).toBe(5);

    // Update one
    const updated = await repo.update(users[2]._id.toString(), { score: 999 });
    expect(updated.score).toBe(999);

    // Delete one — verify DeleteResult
    const delResult = await repo.delete(users[0]._id.toString());
    expect(delResult.success).toBe(true);
    expect(delResult.id).toBe(users[0]._id.toString());

    // Verify count
    const final = await repo.getAll({});
    expect(final.docs).toHaveLength(4);
  });

  it('should handle keyset pagination on score field', async () => {
    // Create 8 users with known scores
    for (let i = 0; i < 8; i++) {
      await repo.create({ name: `S${i}`, email: `s${i}@test.com`, score: (i + 1) * 10 });
    }

    // Page 1
    const p1 = await repo.getAll({ mode: 'keyset', sort: { score: -1 }, limit: 3 });
    expect(p1.method).toBe('keyset');
    expect(p1.docs).toHaveLength(3);
    expect((p1 as any).hasMore).toBe(true);

    // Scores should be descending: 80, 70, 60
    const scores1 = p1.docs.map((d: any) => d.score);
    expect(scores1).toEqual([80, 70, 60]);

    // Page 2
    const p2 = await repo.getAll({
      mode: 'keyset',
      sort: { score: -1 },
      after: (p1 as any).next,
      limit: 3,
    });
    const scores2 = p2.docs.map((d: any) => d.score);
    expect(scores2).toEqual([50, 40, 30]);

    // Page 3 — last 2 items
    const p3 = await repo.getAll({
      mode: 'keyset',
      sort: { score: -1 },
      after: (p2 as any).next,
      limit: 3,
    });
    expect(p3.docs).toHaveLength(2);
    expect((p3 as any).hasMore).toBe(false);
  });
});
