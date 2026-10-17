/**
 * `searchMode: 'prefix'` end to end against a real mongod:
 *
 *   1. every write path keeps the keys field in step (create, createMany,
 *      update, findOneAndUpdate, upserts, getOrCreate, claim, claimVersion,
 *      updateMany, bulkWrite, bulkUpsert), drops forged keys, and refuses the
 *      writes it cannot follow;
 *   2. getAll({ search }) composes with filters, tenant scope, offset and keyset
 *      pagination and counts;
 *   3. the planner serves it from the multikey index (IXSCAN, never COLLSCAN),
 *      with tight bounds;
 *   4. rebuildSearchKeys backfills and is idempotent;
 *   5. the storage choice (tokens, not edge n-grams) holds on real index sizes.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  multiTenantPlugin,
  rebuildSearchKeys,
  SEARCH_KEYS_ERROR_CODES,
  searchKeysIndex,
  searchKeysPath,
} from '../../src/index.js';
import Repository from '../../src/Repository.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IPerson {
  _id: mongoose.Types.ObjectId;
  name: string;
  email?: string;
  status: string;
  version?: number;
  _searchKeys?: string[];
}

interface ITenantPerson {
  _id: mongoose.Types.ObjectId;
  name: string;
  status: string;
  organizationId: string;
  createdAt: Date;
  _searchKeys?: string[];
}

let Person: mongoose.Model<IPerson>;
let TenantPerson: mongoose.Model<ITenantPerson>;
let people: Repository<IPerson> & Record<string, any>;
let tenantPeople: Repository<ITenantPerson>;

/** The stored keys, read past `select: false`. */
const keysOf = async (id: unknown) =>
  (await Person.collection.findOne({ _id: id as mongoose.Types.ObjectId }))?._searchKeys;

beforeAll(async () => {
  await connectDB();
  const personSchema = new Schema<IPerson>({
    name: { type: String, required: true },
    email: { type: String },
    status: { type: String, default: 'active' },
    version: { type: Number },
    _searchKeys: searchKeysPath(),
  });
  // Serves bulkUpsert keyed by email.
  personSchema.index({ email: 1 }, { unique: true, sparse: true });
  // Serves getAll({ search }) prefix search on people (searchMode: 'prefix').
  const idx = searchKeysIndex();
  personSchema.index(idx.fields, idx.options);
  Person = await createTestModel<IPerson>('PrefixSearchPerson', personSchema);
  people = new Repository<IPerson>(
    Person,
    [methodRegistryPlugin(), batchOperationsPlugin()],
    {},
    {
      searchMode: 'prefix',
      searchFields: ['name', 'email'],
    },
  ) as typeof people;

  const tenantSchema = new Schema<ITenantPerson>({
    name: { type: String, required: true },
    status: { type: String, default: 'active' },
    organizationId: { type: String, required: true },
    createdAt: { type: Date, required: true },
    _searchKeys: searchKeysPath(),
  });
  // Serves tenant-scoped getAll({ search }): org equality + one key range per word.
  tenantSchema.index({ organizationId: 1, _searchKeys: 1 });
  TenantPerson = await createTestModel<ITenantPerson>('PrefixSearchTenantPerson', tenantSchema);
  tenantPeople = new Repository<ITenantPerson>(
    TenantPerson,
    [multiTenantPlugin({ tenantField: 'organizationId' })],
    {},
    { searchMode: 'prefix', searchFields: ['name'] },
  );
}, 60_000);

afterAll(async () => {
  await disconnectDB();
});

describe('prefix search — keys on every write path', () => {
  beforeEach(async () => {
    await Person.deleteMany({});
  });

  it('create / createMany: keys of every search field; forged keys dropped; never selected', async () => {
    const a = await people.create({
      name: 'Mohammed Al-Harbi',
      email: 'mo.harbi@test.io',
      _searchKeys: ['forged'],
    });
    expect(await keysOf(a._id)).toEqual(['mohammed', 'al', 'harbi', 'mo', 'test', 'io']);
    expect((await people.getById(String(a._id)))?._searchKeys).toBeUndefined();

    const [b] = await people.createMany([{ name: 'أَحْمَد علي' }]);
    expect(await keysOf(b?._id)).toEqual(['احمد', 'علي']);
  });

  it('update: a partial patch reads the other search fields from the stored document', async () => {
    const p = await people.create({ name: 'Sara Zahrani', email: 'sara.z@test.io' });
    await people.update(String(p._id), { name: 'Sara Otaibi' });
    expect(await keysOf(p._id)).toEqual(['sara', 'otaibi', 'z', 'test', 'io']);
    await people.update(String(p._id), { $set: { email: 'so@x.io' } });
    expect(await keysOf(p._id)).toEqual(['sara', 'otaibi', 'so', 'x', 'io']);
    await people.update(String(p._id), { $unset: { email: '' } });
    expect(await keysOf(p._id)).toEqual(['sara', 'otaibi']);
    // A write that touches no search field leaves the keys alone.
    await people.update(String(p._id), { status: 'away' });
    expect(await keysOf(p._id)).toEqual(['sara', 'otaibi']);
  });

  it('findOneAndUpdate: filter equalities pin values; upserts derive from the insert', async () => {
    await people.create({ name: 'Lina Saleh', email: 'lina@test.io' });
    const r = await people.findOneAndUpdate(
      { email: 'lina@test.io' },
      { $set: { name: 'Lina K' } },
    );
    expect(await keysOf(r?._id)).toEqual(['lina', 'k', 'test', 'io']);

    // Upsert insert: $set name + filter email.
    const u = await people.findOneAndUpdate(
      { email: 'new@test.io' },
      { $set: { name: 'New Person' } },
      { upsert: true },
    );
    expect(await keysOf(u?._id)).toEqual(['new', 'person', 'test', 'io']);

    // Upsert with the name only on insert: keys ride $setOnInsert.
    const s = await people.findOneAndUpdate(
      { email: 'ins@test.io' },
      { $setOnInsert: { name: 'Only Insert' } },
      { upsert: true },
    );
    expect(await keysOf(s?._id)).toEqual(['only', 'insert', 'ins', 'test', 'io']);
  });

  it('getOrCreate, claim, claimVersion keep the keys', async () => {
    const { doc } = await people.getOrCreate({ email: 'g@test.io' }, { name: 'Gee Whiz' });
    expect(await keysOf(doc._id)).toEqual(['gee', 'whiz', 'g', 'test', 'io']);

    const claimed = await people.claim(
      String(doc._id),
      { field: 'status', from: 'active', to: 'held' },
      { name: 'Held Name' },
    );
    expect(claimed).not.toBeNull();
    expect(await keysOf(doc._id)).toEqual(['held', 'name', 'g', 'test', 'io']);

    await people.claimVersion(
      String(doc._id),
      { field: 'version', from: undefined },
      {
        $set: { name: 'Versioned' },
      },
    );
    expect(await keysOf(doc._id)).toEqual(['versioned', 'g', 'test', 'io']);
  });

  it('updateMany: complete updates derive; partial ones are refused (keys would differ per row)', async () => {
    await people.createMany([
      { name: 'A One', email: 'a1@x.io', status: 'x' },
      { name: 'A Two', email: 'a2@x.io', status: 'x' },
    ]);
    await expect(
      people.updateMany({ status: 'x' }, { $set: { name: 'Same' } }),
    ).rejects.toMatchObject({
      code: SEARCH_KEYS_ERROR_CODES.PARTIAL_MULTI_UPDATE,
    });
    await people.updateMany({ status: 'x' }, { $set: { name: 'Same' }, $unset: { email: '' } });
    const rows = await Person.collection.find({ status: 'x' }).toArray();
    expect(rows.map((r) => r._searchKeys)).toEqual([['same'], ['same']]);
    // No search field touched: allowed, keys untouched.
    await people.updateMany({ status: 'x' }, { $set: { status: 'y' } });
    expect(
      (await Person.collection.find({ status: 'y' }).toArray()).map((r) => r._searchKeys),
    ).toEqual([['same'], ['same']]);
  });

  it('bulkWrite and bulkUpsert derive per sub-operation', async () => {
    const base = await people.create({ name: 'Bulk Base', email: 'base@x.io' });
    await people.bulkWrite([
      { insertOne: { document: { name: 'Inserted One', email: 'ins1@x.io' } } },
      { updateOne: { filter: { _id: base._id }, update: { $set: { name: 'Bulk Renamed' } } } },
    ]);
    expect(await keysOf(base._id)).toEqual(['bulk', 'renamed', 'base', 'x', 'io']);
    const ins = await Person.collection.findOne({ email: 'ins1@x.io' });
    expect(ins?._searchKeys).toEqual(['inserted', 'one', 'ins1', 'x', 'io']);

    await people.bulkWrite([
      {
        replaceOne: {
          filter: { _id: base._id },
          replacement: { name: 'Replaced', status: 'active' },
        },
      },
    ]);
    expect(await keysOf(base._id)).toEqual(['replaced']);

    await expect(
      people.bulkWrite([{ updateMany: { filter: {}, update: { $set: { name: 'Nope' } } } }]),
    ).rejects.toMatchObject({ code: SEARCH_KEYS_ERROR_CODES.PARTIAL_MULTI_UPDATE });

    const res = await people.bulkUpsert(
      [
        { email: 'up1@x.io', name: 'Upsert One' },
        { email: 'ins1@x.io', name: 'Upserted Again' },
      ],
      { key: ['email'] },
    );
    expect(res.inserted + res.updated).toBe(2);
    expect((await Person.collection.findOne({ email: 'up1@x.io' }))?._searchKeys).toEqual([
      'upsert',
      'one',
      'up1',
      'x',
      'io',
    ]);
    expect((await Person.collection.findOne({ email: 'ins1@x.io' }))?._searchKeys).toEqual([
      'upserted',
      'again',
      'ins1',
      'x',
      'io',
    ]);
  });

  it('refuses operators the keys cannot follow, before writing', async () => {
    const p = await people.create({ name: 'Keep Me', email: 'k@x.io' });
    await expect(
      people.update(String(p._id), { $rename: { name: 'fullName' } }),
    ).rejects.toMatchObject({
      code: SEARCH_KEYS_ERROR_CODES.UNSUPPORTED_UPDATE,
    });
    expect((await Person.collection.findOne({ _id: p._id }))?.name).toBe('Keep Me');
  });
});

describe('prefix search — reads', () => {
  const ORG = { organizationId: 'org-a' };
  const NAMES = [
    'Mohammed Ali',
    'Mohanad Saleh',
    'Ahmed Mohsen',
    'Ali Hassan',
    'أَحْمَد علي',
    'Sara Zahrani',
  ];
  let base: number;

  beforeAll(async () => {
    await TenantPerson.deleteMany({});
    base = Date.UTC(2026, 0, 1);
    // 6 named rows + 40 filler rows in org-a, and the same 6 names in org-b.
    const rows = [
      ...NAMES.map((name, i) => ({ name, organizationId: 'org-a', status: 'active', i })),
      ...Array.from({ length: 40 }, (_, i) => ({
        name: `Filler ${i}`,
        organizationId: 'org-a',
        status: i % 2 ? 'active' : 'away',
        i: 100 + i,
      })),
      ...NAMES.map((name, i) => ({ name, organizationId: 'org-b', status: 'active', i: 200 + i })),
    ];
    for (const r of rows) {
      await tenantPeople.create(
        { name: r.name, status: r.status, createdAt: new Date(base + r.i * 1000) },
        { organizationId: r.organizationId },
      );
    }
  }, 60_000);

  const names = (r: { data: Array<{ name: string }> }) => r.data.map((d) => d.name).sort();

  it('matches any word start, case/diacritic-insensitive, ANDs words, stays in the tenant', async () => {
    const moh = await tenantPeople.getAll({ search: 'MOH', page: 1, limit: 50 }, ORG);
    expect(names(moh)).toEqual(['Ahmed Mohsen', 'Mohammed Ali', 'Mohanad Saleh']);
    expect(moh.method === 'offset' && moh.total).toBe(3);

    const both = await tenantPeople.getAll({ search: 'ali moh', page: 1, limit: 50 }, ORG);
    expect(names(both)).toEqual(['Mohammed Ali']);

    // Arabic: any spelling of the query meets the stored normalisation.
    const ar = await tenantPeople.getAll({ search: 'احم', page: 1, limit: 50 }, ORG);
    expect(names(ar)).toEqual(['أَحْمَد علي']);
    const ar2 = await tenantPeople.getAll({ search: 'أحمد عل', page: 1, limit: 50 }, ORG);
    expect(names(ar2)).toEqual(['أَحْمَد علي']);

    // Not "contains": a mid-word fragment does not match.
    expect((await tenantPeople.getAll({ search: 'hammed', page: 1 }, ORG)).data).toEqual([]);
  });

  it('composes with caller filters (including $or / $and) and counts', async () => {
    const r = await tenantPeople.getAll(
      { search: 'filler', filters: { status: 'away' }, page: 1, limit: 50 },
      ORG,
    );
    expect(r.method === 'offset' && r.total).toBe(20);
    const withOr = await tenantPeople.getAll(
      {
        search: 'ali',
        filters: { $or: [{ status: 'active' }, { status: 'gone' }] },
        page: 1,
        limit: 50,
      },
      ORG,
    );
    // Latin "ali" is not the Arabic علي: scripts are never transliterated.
    expect(names(withOr)).toEqual(['Ali Hassan', 'Mohammed Ali']);
  });

  it('offset pagination: pages partition the matches and the total is the match count', async () => {
    const p1 = await tenantPeople.getAll(
      { search: 'fil', page: 1, limit: 15, sort: '-createdAt' },
      ORG,
    );
    const p3 = await tenantPeople.getAll(
      { search: 'fil', page: 3, limit: 15, sort: '-createdAt' },
      ORG,
    );
    if (p1.method !== 'offset' || p3.method !== 'offset') throw new Error('expected offset');
    expect(p1.total).toBe(40);
    expect(p1.pages).toBe(3);
    expect(p1.data).toHaveLength(15);
    expect(p3.data).toHaveLength(10);
    expect(p3.hasNext).toBe(false);
  });

  it('keyset pagination walks every match exactly once', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await tenantPeople.getAll(
        { search: 'filler', mode: 'keyset', sort: { createdAt: -1 }, limit: 12, after },
        ORG,
      );
      if (page.method !== 'keyset') throw new Error('expected keyset');
      seen.push(...page.data.map((d) => d.name));
      if (!page.hasMore) break;
      after = page.next ?? undefined;
    }
    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
  });

  it('a query with no letters or digits lists unfiltered', async () => {
    const r = await tenantPeople.getAll({ search: ' -- ', page: 1, limit: 1 }, ORG);
    expect(r.method === 'offset' && r.total).toBe(46);
  });

  it('explain: served by the keys index (IXSCAN, no COLLSCAN), with tight bounds', async () => {
    const build = (filters: Record<string, unknown>, search: string) =>
      (
        tenantPeople as unknown as {
          _buildSearchQuery(f: Record<string, unknown>, s: string): Record<string, unknown>;
        }
      )._buildSearchQuery(filters, search);
    const plan = async (q: Record<string, unknown>) => {
      const ex = (await TenantPerson.find(q).limit(20).explain('executionStats')) as unknown as {
        queryPlanner: { winningPlan: unknown };
        executionStats: { totalDocsExamined: number; totalKeysExamined: number; nReturned: number };
      };
      const winning = JSON.stringify(ex.queryPlanner.winningPlan);
      return { winning, stats: ex.executionStats };
    };

    const one = await plan(build({ organizationId: 'org-a' }, 'moh'));
    expect(one.winning).toContain('"stage":"IXSCAN"');
    expect(one.winning).toContain('organizationId_1__searchKeys_1');
    expect(one.winning).not.toContain('COLLSCAN');
    expect(one.stats.nReturned).toBe(3);
    // 46 rows in org-a, 52 overall: only the matching keys are walked.
    expect(one.stats.totalDocsExamined).toBe(3);
    // ~92 keys in org-a; the range walks the 3 matches plus its end bound.
    expect(one.stats.totalKeysExamined).toBeLessThanOrEqual(6);

    const multi = await plan(build({ organizationId: 'org-a', status: 'active' }, 'ali moh'));
    expect(multi.winning).toContain('"stage":"IXSCAN"');
    expect(multi.winning).not.toContain('COLLSCAN');
    expect(multi.stats.nReturned).toBe(1);
    expect(multi.stats.totalDocsExamined).toBeLessThanOrEqual(3);

    const ar = await plan(build({ organizationId: 'org-a' }, 'أحم'));
    expect(ar.winning).toContain('"stage":"IXSCAN"');
    expect(ar.stats.totalDocsExamined).toBe(1);

    // The count query of offset pagination runs on the same filter, so the same index.
    const counted = (await TenantPerson.collection
      .aggregate([
        { $match: build({ organizationId: 'org-a' }, 'fil') },
        { $group: { _id: 1, n: { $sum: 1 } } },
      ])
      .explain('executionStats')) as unknown;
    // The driver's countDocuments IS this pipeline ($match + $group); its explain nests the plan.
    expect(JSON.stringify(counted)).toContain('"stage":"IXSCAN"');
    expect(JSON.stringify(counted)).not.toContain('COLLSCAN');

    // Untenanted repo: the single-field multikey index.
    await Person.deleteMany({});
    await people.createMany(
      Array.from({ length: 30 }, (_, i) => ({ name: `Person ${i}`, email: `p${i}@x.io` })),
    );
    await people.create({ name: 'Zainab Q' });
    const q = (people as unknown as { _buildSearchQuery: typeof build })._buildSearchQuery(
      {},
      'zai',
    );
    const ex = (await Person.find(q).explain('executionStats')) as unknown as {
      queryPlanner: { winningPlan: unknown };
      executionStats: { totalDocsExamined: number };
    };
    const w = JSON.stringify(ex.queryPlanner.winningPlan);
    expect(w).toContain('"indexName":"_searchKeys_1"');
    expect(w).not.toContain('COLLSCAN');
    expect(ex.executionStats.totalDocsExamined).toBe(1);
  });
});

describe('prefix search — backfill and construction', () => {
  it('rebuildSearchKeys fills missing and stale keys, then is a no-op', async () => {
    await Person.deleteMany({});
    await Person.collection.insertMany([
      { name: 'Raw One', email: 'r1@x.io', status: 'active' },
      { name: 'Raw Two', status: 'active', _searchKeys: ['stale'] },
      { name: 'Raw Three', status: 'active' },
    ]);
    expect(await rebuildSearchKeys(people, { onlyMissing: true, batchSize: 1 })).toEqual({
      scanned: 2,
      updated: 2,
    });
    expect(await rebuildSearchKeys(people, { batchSize: 2 })).toEqual({ scanned: 3, updated: 1 });
    expect(await rebuildSearchKeys(people)).toEqual({ scanned: 3, updated: 0 });
    const rows = await Person.collection.find({}, { sort: { _id: 1 } }).toArray();
    expect(rows.map((r) => r._searchKeys)).toEqual([
      ['raw', 'one', 'r1', 'x', 'io'],
      ['raw', 'two'],
      ['raw', 'three'],
    ]);
    // `updated` is what the server modified: a model whose `_id` cast misses the rows reports 0.
    await Person.collection.updateMany({}, { $set: { _searchKeys: ['stale'] } });
    const StringIds = await createTestModel(
      'PrefixSearchStringIdView',
      new Schema({ _id: String }, { strict: false, collection: Person.collection.collectionName }),
    );
    expect((await rebuildSearchKeys(StringIds, { fields: ['name', 'email'] })).updated).toBe(0);
    expect((await rebuildSearchKeys(people)).updated).toBe(3);
    // A bare model works too, with explicit fields.
    expect(await rebuildSearchKeys(Person, { fields: ['name', 'email'] })).toEqual({
      scanned: 3,
      updated: 0,
    });
  });

  it('fails boot when the keys could never be written', async () => {
    expect(() => new Repository(Person, [], {}, { searchMode: 'prefix' })).toThrow(/searchFields/);
    const Strict = await createTestModel('PrefixSearchStrictNoPath', new Schema({ name: String }));
    expect(
      () => new Repository(Strict, [], {}, { searchMode: 'prefix', searchFields: ['name'] }),
    ).toThrow(/searchKeysPath/);
  });
});

describe('prefix search — storage choice (tokens vs edge n-grams)', () => {
  it('token keys stay a fraction of the n-gram keys and index size', async () => {
    const first = [
      'Mohammed',
      'Abdullah',
      'Fatimah',
      'Khalid',
      'Noura',
      'Abdulrahman',
      'Sara',
      'Faisal',
    ];
    const last = [
      'Al-Harbi',
      'Al-Otaibi',
      'Zahrani',
      'Al-Qahtani',
      'Al-Ghamdi',
      'Shehri',
      'Dosari',
    ];
    const names = Array.from(
      { length: 2000 },
      (_, i) => `${first[i % first.length]}${i} ${last[(i * 7) % last.length]}`,
    );
    const { buildSearchKeys } = await import('../../src/search/index.js');
    const tokens = names.map((n) => buildSearchKeys({ n }, ['n']));
    const N = 20;
    const grams = tokens.map((ts) => [
      ...new Set(
        ts.flatMap((t) =>
          Array.from({ length: Math.min(N, t.length) }, (_, i) => t.slice(0, i + 1)),
        ),
      ),
    ]);
    const db = mongoose.connection.db as mongoose.mongo.Db;
    const tok = db.collection('prefix_search_bench_tokens');
    const ngr = db.collection('prefix_search_bench_ngrams');
    await Promise.all([tok.drop().catch(() => {}), ngr.drop().catch(() => {})]);
    await tok.insertMany(tokens.map((k) => ({ k })));
    await ngr.insertMany(grams.map((k) => ({ k })));
    await tok.createIndex({ k: 1 }, { name: 'k_1' });
    await ngr.createIndex({ k: 1 }, { name: 'k_1' });
    const size = async (c: mongoose.mongo.Collection) =>
      (
        (await c.aggregate([{ $collStats: { storageStats: {} } }]).toArray())[0] as {
          storageStats: { indexSizes: Record<string, number> };
        }
      ).storageStats.indexSizes.k_1 as number;
    const tokenKeys = tokens.reduce((n, t) => n + t.length, 0);
    const gramKeys = grams.reduce((n, g) => n + g.length, 0);
    const [tokenBytes, gramBytes] = [await size(tok), await size(ngr)];
    // Measured 2026-10-17 (mongod 8, WiredTiger): tokens 6,000 keys / 60 KiB index,
    // edge n-grams (N=20) 34,140 keys / 256 KiB index. Documented in src/search/prefix.ts.
    expect(gramKeys).toBeGreaterThan(tokenKeys * 4);
    expect(gramBytes).toBeGreaterThan(tokenBytes);
    // Same query plan class either way: the anchored regex is an index range.
    const ex = (await tok.find({ k: { $regex: '^moh' } }).explain('executionStats')) as {
      queryPlanner: { winningPlan: unknown };
    };
    expect(JSON.stringify(ex.queryPlanner.winningPlan)).toContain('IXSCAN');
    await Promise.all([tok.drop(), ngr.drop()]);
  });
});
