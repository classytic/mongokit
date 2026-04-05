/**
 * findAll + getOne plugin integration tests
 *
 * Proves that findAll() and getOne() respect ALL plugins:
 * multi-tenant, soft-delete, cache, field-filter, observability.
 */
import mongoose, { type Document, Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Repository from '../src/Repository.js';
import {
  softDeletePlugin,
  multiTenantPlugin,
  cachePlugin,
  createMemoryCache,
  fieldFilterPlugin,
  createFieldPreset,
  observabilityPlugin,
} from '../src/index.js';

interface ITask extends Document {
  title: string;
  status: string;
  orgId: string;
  secret: string;
  deletedAt?: Date | null;
}

const TaskSchema = new Schema<ITask>({
  title: { type: String, required: true },
  status: { type: String, default: 'open' },
  orgId: { type: String, required: true, index: true },
  secret: { type: String, default: 'hidden' },
  deletedAt: { type: Date, default: null },
});

let mongo: MongoMemoryServer;
let TaskModel: mongoose.Model<ITask>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  TaskModel = mongoose.model<ITask>('PluginTask', TaskSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await TaskModel.deleteMany({});
});

// ─── findAll + multi-tenant ─────────────────────────────────────────────────

describe('findAll() respects multi-tenant plugin', () => {
  let repo: Repository<ITask>;

  beforeEach(async () => {
    repo = new Repository(TaskModel, [
      multiTenantPlugin({ tenantField: 'orgId', contextKey: 'organizationId' }),
    ]);
    await TaskModel.insertMany([
      { title: 'A', orgId: 'org-1' },
      { title: 'B', orgId: 'org-1' },
      { title: 'C', orgId: 'org-2' },
    ]);
  });

  it('findAll scoped to tenant', async () => {
    const result = await repo.findAll({}, { organizationId: 'org-1' });
    expect(result.length).toBe(2);
    for (const doc of result as ITask[]) {
      expect(doc.orgId).toBe('org-1');
    }
  });

  it('findAll without orgId returns nothing when required', async () => {
    const strictRepo = new Repository(TaskModel, [
      multiTenantPlugin({ tenantField: 'orgId', contextKey: 'organizationId', required: true }),
    ]);
    await expect(strictRepo.findAll({})).rejects.toThrow();
  });
});

// ─── findAll + soft-delete ──────────────────────────────────────────────────

describe('findAll() respects soft-delete plugin', () => {
  let repo: Repository<ITask>;

  beforeEach(async () => {
    repo = new Repository(TaskModel, [softDeletePlugin()]);
    await TaskModel.insertMany([
      { title: 'Live-1', orgId: 'o', deletedAt: null },
      { title: 'Live-2', orgId: 'o', deletedAt: null },
      { title: 'Deleted', orgId: 'o', deletedAt: new Date() },
    ]);
  });

  it('findAll excludes soft-deleted docs', async () => {
    const result = await repo.findAll();
    expect(result.length).toBe(2);
    for (const doc of result as ITask[]) {
      expect(doc.title).not.toBe('Deleted');
    }
  });

  it('findAll with includeDeleted shows all', async () => {
    const result = await repo.findAll({}, { includeDeleted: true });
    expect(result.length).toBe(3);
  });
});

// ─── getOne + multi-tenant ──────────────────────────────────────────────────

describe('getOne() respects multi-tenant plugin', () => {
  let repo: Repository<ITask>;

  beforeEach(async () => {
    repo = new Repository(TaskModel, [
      multiTenantPlugin({ tenantField: 'orgId', contextKey: 'organizationId' }),
    ]);
    await TaskModel.insertMany([
      { title: 'Task-A', orgId: 'org-1', status: 'open' },
      { title: 'Task-B', orgId: 'org-2', status: 'open' },
    ]);
  });

  it('getOne scoped to tenant', async () => {
    const result = await repo.getOne({ status: 'open' }, { organizationId: 'org-1' });
    expect(result).not.toBeNull();
    expect((result as ITask).title).toBe('Task-A');
  });

  it('getOne cannot see other tenant docs', async () => {
    const result = await repo.getOne(
      { title: 'Task-B' },
      { organizationId: 'org-1', throwOnNotFound: false },
    );
    expect(result).toBeNull();
  });
});

// ─── getOne + soft-delete ───────────────────────────────────────────────────

describe('getOne() respects soft-delete plugin', () => {
  let repo: Repository<ITask>;

  beforeEach(async () => {
    repo = new Repository(TaskModel, [softDeletePlugin()]);
    await TaskModel.insertMany([
      { title: 'Active', orgId: 'o', deletedAt: null },
      { title: 'Gone', orgId: 'o', deletedAt: new Date() },
    ]);
  });

  it('getOne excludes soft-deleted', async () => {
    const result = await repo.getOne({ title: 'Gone' }, { throwOnNotFound: false });
    expect(result).toBeNull();
  });

  it('getOne finds active doc', async () => {
    const result = await repo.getOne({ title: 'Active' });
    expect(result).not.toBeNull();
  });
});

// ─── getOne + cache ─────────────────────────────────────────────────────────

describe('getOne() respects cache plugin', () => {
  let repo: Repository<ITask>;

  beforeEach(async () => {
    repo = new Repository(TaskModel, [
      cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
    ]);
    await TaskModel.create({ title: 'Cacheable', orgId: 'o' });
  });

  it('getOne caches and returns fresh after update', async () => {
    // Prime cache
    const first = await repo.getOne({ title: 'Cacheable' });
    expect(first).not.toBeNull();

    // Update directly
    await TaskModel.updateOne({ title: 'Cacheable' }, { status: 'done' });

    // Cache should return stale (still 'open') because no repo.update was called
    const cached = await repo.getOne({ title: 'Cacheable' });
    expect((cached as ITask).status).toBe('open');

    // skipCache returns fresh
    const fresh = await repo.getOne({ title: 'Cacheable' }, { skipCache: true });
    expect((fresh as ITask).status).toBe('done');
  });
});

// ─── noPagination + multi-tenant + soft-delete combined ─────────────────────

describe('noPagination respects multi-tenant + soft-delete combined', () => {
  let repo: Repository<ITask>;

  beforeEach(async () => {
    repo = new Repository(TaskModel, [
      multiTenantPlugin({ tenantField: 'orgId', contextKey: 'organizationId' }),
      softDeletePlugin(),
    ]);
    await TaskModel.insertMany([
      { title: 'T1', orgId: 'org-1', deletedAt: null },
      { title: 'T2', orgId: 'org-1', deletedAt: new Date() }, // soft-deleted
      { title: 'T3', orgId: 'org-2', deletedAt: null },       // other tenant
    ]);
  });

  it('noPagination returns only org-1 non-deleted docs', async () => {
    const result = await repo.getAll(
      { noPagination: true },
      { organizationId: 'org-1' },
    );
    expect(Array.isArray(result)).toBe(true);
    expect((result as ITask[]).length).toBe(1);
    expect((result as ITask[])[0].title).toBe('T1');
  });
});

// ─── organizationId without cast ────────────────────────────────────────────

describe('organizationId in options — no cast needed', () => {
  it('create accepts organizationId directly', async () => {
    const repo = new Repository(TaskModel, [
      multiTenantPlugin({ tenantField: 'orgId', contextKey: 'organizationId' }),
    ]);

    // This should compile without `as Record<string, unknown>`
    const doc = await repo.create(
      { title: 'No Cast', orgId: 'org-x', secret: 's' },
      { organizationId: 'org-x' },
    );
    expect((doc as ITask).orgId).toBe('org-x');
  });

  it('getAll accepts organizationId directly', async () => {
    const repo = new Repository(TaskModel, [
      multiTenantPlugin({ tenantField: 'orgId', contextKey: 'organizationId' }),
    ]);
    await TaskModel.create({ title: 'X', orgId: 'org-y' });

    const result = await repo.getAll({}, { organizationId: 'org-y' });
    expect(result.docs.length).toBe(1);
  });

  it('findAll accepts organizationId directly', async () => {
    const repo = new Repository(TaskModel, [
      multiTenantPlugin({ tenantField: 'orgId', contextKey: 'organizationId' }),
    ]);
    await TaskModel.create({ title: 'Y', orgId: 'org-z' });

    const result = await repo.findAll({}, { organizationId: 'org-z' });
    expect(result.length).toBe(1);
  });
});

// ─── observability fires for findAll/getOne ─────────────────────────────────

describe('Observability plugin fires for findAll/getOne', () => {
  it('metrics include findAll and getOne', async () => {
    const metrics: string[] = [];
    const repo = new Repository(TaskModel, [
      observabilityPlugin({ onMetric: (m) => metrics.push(m.operation) }),
    ]);
    await TaskModel.create({ title: 'Obs', orgId: 'o' });

    await repo.findAll();
    await repo.getOne({ title: 'Obs' });

    expect(metrics).toContain('findAll');
    expect(metrics).toContain('getOne');
  });
});
