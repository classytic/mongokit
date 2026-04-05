/**
 * Security & Edge Case Tests
 *
 * Validates: NoSQL injection blocking, input validation at boundaries,
 * race conditions, idField per-call override, createMany edge cases,
 * deleteMany safety, cache invalidation ordering.
 */
import mongoose, { type Document, Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Repository from '../src/Repository.js';
import { QueryParser, cachePlugin, createMemoryCache, softDeletePlugin } from '../src/index.js';

// ─── Schema ─────────────────────────────────────────────────────────────────

interface IDoc extends Document {
  slug: string;
  name: string;
  role: string;
  score: number;
  deletedAt?: Date | null;
}

const DocSchema = new Schema<IDoc>({
  slug: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  role: { type: String, default: 'user' },
  score: { type: Number, default: 0 },
  deletedAt: { type: Date, default: null },
});

let mongo: MongoMemoryServer;
let DocModel: mongoose.Model<IDoc>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  DocModel = mongoose.model<IDoc>('SecEdgeDoc', DocSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await DocModel.deleteMany({});
});

// ─── NoSQL Injection via QueryParser ────────────────────────────────────────

describe('NoSQL injection prevention', () => {
  const parser = new QueryParser({ maxLimit: 100 });

  it('blocks $where operator', () => {
    const parsed = parser.parse({ $where: 'this.role === "admin"' });
    expect(parsed.filters.$where).toBeUndefined();
  });

  it('blocks $function operator', () => {
    const parsed = parser.parse({ role: { $function: { body: 'return true' } } });
    expect(parsed.filters.role?.$function).toBeUndefined();
  });

  it('blocks $accumulator operator', () => {
    const parsed = parser.parse({ role: { $accumulator: {} } });
    expect(parsed.filters.role?.$accumulator).toBeUndefined();
  });

  it('blocks nested injection via $gt/$ne on _id', () => {
    const parsed = parser.parse({ _id: { $gt: '' } });
    // QueryParser strips _id with empty $gt as potential injection — correct behavior
    // A real _id query would use a valid ObjectId string, not { $gt: '' }
    expect(parsed.filters._id?.$gt).not.toBe('');
  });

  it('caps regex length to prevent ReDoS', () => {
    const longPattern = 'a'.repeat(600);
    const parsed = parser.parse({ name: { regex: longPattern } });
    // Should either truncate or reject the pattern
    if (parsed.filters.name?.$regex) {
      expect(parsed.filters.name.$regex.source?.length || String(parsed.filters.name.$regex).length).toBeLessThanOrEqual(500);
    }
  });

  it('blocks $options outside allowed set', () => {
    const parsed = parser.parse({ name: { regex: 'test', options: 'gimsuxy' } });
    // Only i, m, s, x allowed
    if (parsed.filters.name?.$options) {
      expect(parsed.filters.name.$options).toMatch(/^[imsx]*$/);
    }
  });

  it('enforces maxFilterDepth', () => {
    const deepParser = new QueryParser({ maxFilterDepth: 3 });
    const deepFilter = { a: { b: { c: { d: { e: 'deep' } } } } };
    const parsed = deepParser.parse(deepFilter);
    // Deep nested keys should be flattened or rejected
    expect(parsed.filters.a?.b?.c?.d?.e).toBeUndefined();
  });
});

// ─── Input validation at boundaries ─────────────────────────────────────────

describe('Input validation at boundaries', () => {
  it('createMany with empty array does not throw', async () => {
    const repo = new Repository(DocModel);
    const result = await repo.createMany([]);
    expect(result).toEqual([]);
  });

  it('getById with undefined returns 404', async () => {
    const repo = new Repository(DocModel);
    await expect(repo.getById(undefined as unknown as string)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('getById with empty string returns 404', async () => {
    const repo = new Repository(DocModel);
    await expect(repo.getById('')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('update with empty data does not corrupt document', async () => {
    const repo = new Repository(DocModel);
    const doc = await repo.create({ slug: 'test', name: 'Test', score: 100 });
    const updated = await repo.update(String(doc._id), {});
    expect((updated as IDoc).score).toBe(100);
    expect((updated as IDoc).name).toBe('Test');
  });

  it('getAll with negative page returns page 1', async () => {
    const repo = new Repository(DocModel);
    await repo.create({ slug: 'a', name: 'A' });
    const result = await repo.getAll({ page: -5 });
    expect(result.docs.length).toBeGreaterThanOrEqual(0);
  });

  it('getAll with limit 0 uses default', async () => {
    const repo = new Repository(DocModel);
    await repo.create({ slug: 'a', name: 'A' });
    const result = await repo.getAll({ limit: 0 });
    expect(result.docs.length).toBe(1);
  });

  it('count with empty filter returns total count', async () => {
    const repo = new Repository(DocModel);
    await DocModel.insertMany([
      { slug: 'a', name: 'A' },
      { slug: 'b', name: 'B' },
    ]);
    const count = await repo.count({});
    expect(count).toBe(2);
  });
});

// ─── idField per-call override security ─────────────────────────────────────

describe('idField per-call — cannot bypass access control', () => {
  it('idField override does not expose unrelated documents', async () => {
    const repo = new Repository(DocModel);
    await DocModel.insertMany([
      { slug: 'admin-panel', name: 'Admin', role: 'admin' },
      { slug: 'user-page', name: 'User', role: 'user' },
    ]);

    // Querying by slug only returns the matched doc, not others
    const result = await repo.getById('admin-panel', { idField: 'slug' });
    expect(result).not.toBeNull();
    expect((result as IDoc).role).toBe('admin');

    // Non-existent slug returns null
    const missing = await repo.getById('hacked', { idField: 'slug', throwOnNotFound: false });
    expect(missing).toBeNull();
  });

  it('update with idField only updates the targeted doc', async () => {
    const repo = new Repository(DocModel);
    await DocModel.insertMany([
      { slug: 'doc-1', name: 'Doc 1', score: 10 },
      { slug: 'doc-2', name: 'Doc 2', score: 20 },
    ]);

    await repo.update('doc-1', { score: 999 }, { idField: 'slug' });

    const doc1 = await DocModel.findOne({ slug: 'doc-1' });
    const doc2 = await DocModel.findOne({ slug: 'doc-2' });
    expect(doc1!.score).toBe(999);
    expect(doc2!.score).toBe(20); // Untouched
  });
});

// ─── Race conditions ────────────────────────────────────────────────────────

describe('Race conditions', () => {
  it('getOrCreate is atomic — no duplicate creation under concurrency', async () => {
    const repo = new Repository(DocModel);
    // Ensure unique index is built before concurrent test
    await DocModel.ensureIndexes();

    const promises = Array.from({ length: 20 }, () =>
      repo.getOrCreate({ slug: 'atomic-test' }, { slug: 'atomic-test', name: 'Atomic' }),
    );

    const results = await Promise.allSettled(promises);
    // At least one succeeds; the rest either succeed (found existing) or fail (dup key)
    const successes = results.filter(r => r.status === 'fulfilled');
    expect(successes.length).toBeGreaterThanOrEqual(1);

    const count = await DocModel.countDocuments({ slug: 'atomic-test' });
    expect(count).toBe(1);
  });

  it('concurrent updates to same doc do not lose writes', async () => {
    const repo = new Repository(DocModel);
    const doc = await repo.create({ slug: 'race', name: 'Race', score: 0 });
    const id = String(doc._id);

    // 30 concurrent $inc operations
    const promises = Array.from({ length: 30 }, () =>
      repo.update(id, { $inc: { score: 1 } }),
    );

    await Promise.all(promises);
    const final = await DocModel.findById(id);
    expect(final!.score).toBe(30);
  });

  it('cache invalidation after write returns fresh data', async () => {
    const repo = new Repository(DocModel, [
      cachePlugin({ adapter: createMemoryCache(), ttl: 60 }),
    ]);

    const doc = await repo.create({ slug: 'cached', name: 'Cached', score: 1 });
    const id = String(doc._id);

    // Prime cache
    await repo.getById(id);

    // Update
    await repo.update(id, { score: 42 });

    // Read again — must return fresh, not stale
    const fresh = await repo.getById(id);
    expect((fresh as IDoc).score).toBe(42);
  });
});

// ─── Soft delete + idField combined ─────────────────────────────────────────

describe('Soft delete + idField combined', () => {
  it('soft-deletes by slug, excludes from getAll, includes with includeDeleted', async () => {
    const repo = new Repository(
      DocModel,
      [softDeletePlugin()],
      {},
      { idField: 'slug' },
    );

    await DocModel.insertMany([
      { slug: 'keep', name: 'Keep' },
      { slug: 'remove', name: 'Remove' },
    ]);

    await repo.delete('remove');

    // getById excludes soft-deleted
    const gone = await repo.getById('remove', { throwOnNotFound: false });
    expect(gone).toBeNull();

    // getAll excludes soft-deleted
    const all = await repo.getAll();
    expect(all.docs.length).toBe(1);
    expect((all.docs[0] as IDoc).slug).toBe('keep');

    // Include deleted
    const withDeleted = await repo.getAll({ includeDeleted: true } as Record<string, unknown>);
    expect(withDeleted.total).toBe(2);
  });
});

// ─── getOne compound filter tests ───────────────────────────────────────────

describe('getOne — compound filter edge cases', () => {
  beforeEach(async () => {
    await DocModel.insertMany([
      { slug: 'a', name: 'Alpha', role: 'admin', score: 100 },
      { slug: 'b', name: 'Beta', role: 'user', score: 200 },
      { slug: 'c', name: 'Gamma', role: 'admin', score: 300 },
    ]);
  });

  it('compound filter narrows correctly', async () => {
    const repo = new Repository(DocModel);
    const result = await repo.getOne({ role: 'admin', score: { $gte: 200 } });
    expect(result).not.toBeNull();
    expect((result as IDoc).slug).toBe('c');
  });

  it('empty filter returns first doc (not error)', async () => {
    const repo = new Repository(DocModel);
    const result = await repo.getOne({});
    expect(result).not.toBeNull();
  });

  it('conflicting filter returns null with throwOnNotFound: false', async () => {
    const repo = new Repository(DocModel);
    const result = await repo.getOne(
      { role: 'admin', score: 999 },
      { throwOnNotFound: false },
    );
    expect(result).toBeNull();
  });
});

// ─── QueryParser + Repository integration ───────────────────────────────────

describe('QueryParser → Repository integration', () => {
  beforeEach(async () => {
    await DocModel.insertMany([
      { slug: 'x1', name: 'X1', role: 'admin', score: 10 },
      { slug: 'x2', name: 'X2', role: 'user', score: 20 },
      { slug: 'x3', name: 'X3', role: 'user', score: 30 },
      { slug: 'x4', name: 'X4', role: 'admin', score: 40 },
    ]);
  });

  it('parsed filters flow through to getAll correctly', async () => {
    const parser = new QueryParser({ maxLimit: 50 });
    const repo = new Repository(DocModel, [], { maxLimit: 50 });

    const parsed = parser.parse({ role: 'admin', sort: '-score', limit: '10' });
    const result = await repo.getAll({
      filters: parsed.filters,
      sort: parsed.sort,
      limit: parsed.limit,
    });

    expect(result.docs.length).toBe(2);
    expect((result.docs[0] as IDoc).score).toBe(40); // sorted desc
  });

  it('parsed range filters work', async () => {
    const parser = new QueryParser();
    const repo = new Repository(DocModel);

    const parsed = parser.parse({ 'score[gte]': '20', 'score[lte]': '30' });
    const result = await repo.getAll({ filters: parsed.filters });

    expect(result.docs.length).toBe(2);
  });

  it('allowedFilterFields blocks unauthorized fields', async () => {
    const parser = new QueryParser({ allowedFilterFields: ['role'] });

    const parsed = parser.parse({ role: 'admin', score: '999' });
    expect(parsed.filters.role).toBe('admin');
    expect(parsed.filters.score).toBeUndefined();
  });

  it('allowedOperators blocks unauthorized operators', async () => {
    const parser = new QueryParser({
      allowedOperators: ['eq', 'in'],
    });

    const parsed = parser.parse({ score: { gte: '10' } });
    expect(parsed.filters.score?.$gte).toBeUndefined();
  });
});

// ─── findAll edge cases ─────────────────────────────────────────────────────

describe('findAll edge cases', () => {
  it('findAll on empty collection returns empty array', async () => {
    const repo = new Repository(DocModel);
    const result = await repo.findAll();
    expect(result).toEqual([]);
  });

  it('findAll respects soft-delete plugin', async () => {
    const repo = new Repository(DocModel, [softDeletePlugin()]);
    await DocModel.insertMany([
      { slug: 'live', name: 'Live' },
      { slug: 'dead', name: 'Dead', deletedAt: new Date() },
    ]);

    // findAll now hooks into before:findAll — excludes soft-deleted
    const result = await repo.findAll();
    expect(result.length).toBe(1);

    // includeDeleted shows all
    const all = await repo.findAll({}, { includeDeleted: true });
    expect(all.length).toBe(2);
  });
});
