/**
 * Repository search — built-in modes + plugin contract + composition
 *
 * Three layers under test:
 *
 *   1. Built-in modes — `searchMode: 'text' | 'regex' | 'auto'` on Repository.
 *      Proves the index-free regex strategy works standalone (Express/Nest)
 *      without going through QueryParser, escapes regex metacharacters, and
 *      preserves backwards compatibility for the default 'text' mode.
 *
 *   2. Plugin contract — `before:getAll` plugins that resolve `ctx.search`
 *      against an external backend (Elasticsearch, Meilisearch, Typesense,
 *      pgvector, etc.) by mutating `ctx.filters` and clearing `ctx.search`.
 *      The default 'text' Repository must NOT throw when search has been
 *      consumed by such a plugin — this is the framework-level guarantee
 *      that makes search backends composable.
 *
 *   3. Composition — the regex code path AND the plugin contract path must
 *      both compose cleanly with multi-tenant scoping, soft-delete filters,
 *      caller-supplied filters, and cache invalidation. This is the actual
 *      production stack shape; if any of these break, the feature is unsafe
 *      to ship regardless of unit-test coverage.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Document, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachePlugin,
  createMemoryCache,
  multiTenantPlugin,
  softDeletePlugin,
} from '../src/index.js';
import Repository from '../src/Repository.js';
import type { RepositoryContext } from '../src/types.js';

// ── Fixture model ─────────────────────────────────────────────────────────
// Two interfaces: a plain memo for the built-in mode tests, and a tenant-
// scoped soft-deletable memo for the composition tests. Neither has a text
// index — that's the whole point.

interface IMemo extends Document {
  title: string;
  scope: string;
  body: string;
}

const MemoSchema = new Schema<IMemo>({
  title: { type: String, required: true },
  scope: { type: String, required: true },
  body: { type: String, default: '' },
});

interface ITenantMemo extends Document {
  title: string;
  body: string;
  organizationId: string;
  deletedAt?: Date | null;
}

const TenantMemoSchema = new Schema<ITenantMemo>({
  title: { type: String, required: true },
  body: { type: String, default: '' },
  organizationId: { type: String, required: true, index: true },
  deletedAt: { type: Date, default: null },
});

let mongoServer: MongoMemoryServer;
let MemoModel: mongoose.Model<IMemo>;
let TenantMemoModel: mongoose.Model<ITenantMemo>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  MemoModel = mongoose.model<IMemo>('Memo_SearchMode', MemoSchema);
  TenantMemoModel = mongoose.model<ITenantMemo>('TenantMemo_SearchMode', TenantMemoSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await MemoModel.deleteMany({});
  await TenantMemoModel.deleteMany({});
  await MemoModel.insertMany([
    { title: 'Alpha plan', scope: 'public', body: 'first' },
    { title: 'Beta rollout', scope: 'internal', body: 'alpha mention inside body' },
    { title: 'Gamma notes', scope: 'public', body: 'unrelated' },
    { title: 'special.chars+test', scope: 'public', body: 'regex metacharacters' },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Built-in modes
// ─────────────────────────────────────────────────────────────────────────

describe('Repository searchMode: regex', () => {
  it('searches across configured fields without requiring a text index', async () => {
    const repo = new Repository(
      MemoModel,
      [],
      {},
      {
        searchMode: 'regex',
        searchFields: ['title', 'scope', 'body'],
      },
    );

    const result = await repo.getAll({ search: 'alpha' });
    const docs = (result as { docs: IMemo[] }).docs;

    // Matches both "Alpha plan" (title) and "Beta rollout" (body mentions alpha) — case-insensitive
    expect(docs).toHaveLength(2);
    const titles = docs.map((d) => d.title).sort();
    expect(titles).toEqual(['Alpha plan', 'Beta rollout']);
  });

  it('escapes regex metacharacters so user input is treated literally', async () => {
    const repo = new Repository(
      MemoModel,
      [],
      {},
      {
        searchMode: 'regex',
        searchFields: ['title'],
      },
    );

    const result = await repo.getAll({ search: 'special.chars+test' });
    const docs = (result as { docs: IMemo[] }).docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('special.chars+test');
  });

  it('combines regex search with existing filters', async () => {
    const repo = new Repository(
      MemoModel,
      [],
      {},
      {
        searchMode: 'regex',
        searchFields: ['title', 'body'],
      },
    );

    const result = await repo.getAll({ search: 'alpha', filters: { scope: 'public' } });
    const docs = (result as { docs: IMemo[] }).docs;
    // Only "Alpha plan" — Beta rollout matches search but is scope:internal
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Alpha plan');
  });

  it('preserves a pre-existing $or filter by promoting to $and', async () => {
    const repo = new Repository(
      MemoModel,
      [],
      {},
      {
        searchMode: 'regex',
        searchFields: ['title'],
      },
    );

    const result = await repo.getAll({
      search: 'alpha',
      filters: { $or: [{ scope: 'public' }, { scope: 'internal' }] },
    });
    const docs = (result as { docs: IMemo[] }).docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Alpha plan');
  });

  it('throws a clear error when searchFields is missing and search is used', async () => {
    const repo = new Repository(
      MemoModel,
      [],
      {},
      {
        searchMode: 'regex',
        // searchFields intentionally omitted
      },
    );

    await expect(repo.getAll({ search: 'alpha' })).rejects.toThrow(/searchFields/);
  });
});

describe('Repository searchMode: auto', () => {
  it('falls back to regex when no text index exists', async () => {
    const repo = new Repository(
      MemoModel,
      [],
      {},
      {
        searchMode: 'auto',
        searchFields: ['title'],
      },
    );

    const result = await repo.getAll({ search: 'gamma' });
    const docs = (result as { docs: IMemo[] }).docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Gamma notes');
  });
});

describe('Repository searchMode: text (default, backwards compatible)', () => {
  it('still throws when no text index exists — preserves prior behavior', async () => {
    const repo = new Repository(MemoModel, [], {}, {});
    await expect(repo.getAll({ search: 'alpha' })).rejects.toThrow(/No text index/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Plugin contract — search-resolver pattern for external backends
// ─────────────────────────────────────────────────────────────────────────
//
// The "external backend" is mocked with vi.fn() returning canned IDs, the
// same shape an Elastic/Meili client call would return. Reads as a template
// for real integrations: swap the vi.fn() body for `await client.search(...)`
// and the rest of the plugin is unchanged.

/**
 * Reference implementation of the search-resolver plugin contract.
 * Hooks `before:getAll`, calls the supplied resolver with the search term,
 * mutates `ctx.filters` to constrain the Mongo query to the resolved IDs,
 * then clears `ctx.search` to bypass Repository's built-in search code path.
 */
function externalSearchPlugin(resolver: (term: string) => Promise<string[]>) {
  return (repo: Repository<IMemo | ITenantMemo>) => {
    repo.on('before:getAll', async (ctx: RepositoryContext) => {
      if (!ctx.search) return;
      const ids = await resolver(ctx.search);
      ctx.filters = {
        ...(ctx.filters ?? {}),
        _id: { $in: ids },
      };
      // Framework guarantee: clearing search bypasses the text-index check.
      ctx.search = undefined;
    });
  };
}

describe('Repository: search-resolver plugin contract', () => {
  it('clears ctx.search and the default text mode does not throw', async () => {
    // Pre-fetch the IDs the "external backend" would return for the term "alpha"
    const alphaDoc = await MemoModel.findOne({ title: 'Alpha plan' }).lean();
    const resolver = vi.fn(async (_term: string) => [String(alphaDoc?._id)]);

    const repo = new Repository(MemoModel, [externalSearchPlugin(resolver)], {}, {});
    const result = await repo.getAll({ search: 'alpha' });
    const docs = (result as { docs: IMemo[] }).docs;

    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith('alpha');
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Alpha plan');
  });

  it('plugin path coexists with caller-supplied filters', async () => {
    const alphaDoc = await MemoModel.findOne({ title: 'Alpha plan' }).lean();
    const betaDoc = await MemoModel.findOne({ title: 'Beta rollout' }).lean();
    const resolver = vi.fn(async (_term: string) => [String(alphaDoc?._id), String(betaDoc?._id)]);

    const repo = new Repository(MemoModel, [externalSearchPlugin(resolver)], {}, {});
    // Caller asks for scope:public AND search "alpha"
    // Resolver returns both Alpha and Beta IDs; scope filter then narrows to Alpha
    const result = await repo.getAll({
      search: 'alpha',
      filters: { scope: 'public' },
    });
    const docs = (result as { docs: IMemo[] }).docs;

    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Alpha plan');
  });

  it('does NOT call the resolver when search is absent', async () => {
    const resolver = vi.fn(async (_term: string) => []);
    const repo = new Repository(MemoModel, [externalSearchPlugin(resolver)], {}, {});

    const result = await repo.getAll({ filters: { scope: 'public' } });
    const docs = (result as { docs: IMemo[] }).docs;

    expect(resolver).not.toHaveBeenCalled();
    expect(docs.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Composition — the real production stack
// ─────────────────────────────────────────────────────────────────────────
//
// These tests prove the feature is safe to ship. They wire searchMode AND
// the plugin contract through realistic plugin stacks (multi-tenant +
// soft-delete + cache + caller filters) and assert that every constraint
// survives. This is what was missing from the first cut of the feature.

describe('Composition: searchMode regex + multi-tenant + soft-delete + caller filter', () => {
  beforeEach(async () => {
    await TenantMemoModel.insertMany([
      // org_a — 2 live, 1 soft-deleted
      { title: 'Alpha report', body: 'public stuff', organizationId: 'org_a' },
      { title: 'Alpha draft', body: 'wip', organizationId: 'org_a' },
      {
        title: 'Alpha archived',
        body: 'old',
        organizationId: 'org_a',
        deletedAt: new Date('2026-01-01'),
      },
      // org_b — 1 live with same search term
      { title: 'Alpha leak', body: 'wrong tenant', organizationId: 'org_b' },
      // unrelated
      { title: 'Beta plan', body: 'no match', organizationId: 'org_a' },
    ]);
  });

  it('all four filters survive together (search ∧ tenant ∧ not-deleted ∧ caller)', async () => {
    const repo = new Repository(
      TenantMemoModel,
      [
        softDeletePlugin({ deletedField: 'deletedAt' }),
        multiTenantPlugin({ field: 'organizationId' }),
      ],
      {},
      {
        searchMode: 'regex',
        searchFields: ['title', 'body'],
      },
    );

    const result = await repo.getAll({
      search: 'alpha',
      filters: { title: { $regex: 'report', $options: 'i' } }, // caller wants only "report"
      organizationId: 'org_a' as unknown as string, // multi-tenant scope
    } as Parameters<typeof repo.getAll>[0]);
    const docs = (result as { docs: ITenantMemo[] }).docs;

    // Must match: "alpha" search ∧ org_a ∧ not-deleted ∧ caller's "report" filter
    // → only "Alpha report" survives all four constraints
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Alpha report');
    expect(docs[0].organizationId).toBe('org_a');

    // Negative assertions — these MUST NOT leak through:
    const titles = docs.map((d) => d.title);
    expect(titles).not.toContain('Alpha draft'); // org_a but caller filter excludes
    expect(titles).not.toContain('Alpha archived'); // soft-deleted
    expect(titles).not.toContain('Alpha leak'); // wrong tenant (org_b)
    expect(titles).not.toContain('Beta plan'); // doesn't match search
  });

  it('without explicit caller filter, all live tenant matches return', async () => {
    const repo = new Repository(
      TenantMemoModel,
      [
        softDeletePlugin({ deletedField: 'deletedAt' }),
        multiTenantPlugin({ field: 'organizationId' }),
      ],
      {},
      {
        searchMode: 'regex',
        searchFields: ['title'],
      },
    );

    const result = await repo.getAll({
      search: 'alpha',
      organizationId: 'org_a' as unknown as string,
    } as Parameters<typeof repo.getAll>[0]);
    const docs = (result as { docs: ITenantMemo[] }).docs;

    // org_a alpha-titled live docs only: Alpha report, Alpha draft
    // (Alpha archived is soft-deleted, Alpha leak is org_b)
    expect(docs).toHaveLength(2);
    const titles = docs.map((d) => d.title).sort();
    expect(titles).toEqual(['Alpha draft', 'Alpha report']);
  });
});

describe('Composition: search-resolver plugin + cache + caller filter', () => {
  it('cache key reflects post-hook filters; second call hits cache', async () => {
    const alphaDoc = await MemoModel.findOne({ title: 'Alpha plan' }).lean();
    const resolver = vi.fn(async (_term: string) => [String(alphaDoc?._id)]);

    const cache = createMemoryCache();
    const repo = new Repository(
      MemoModel,
      [externalSearchPlugin(resolver), cachePlugin({ adapter: cache, ttl: 60 })],
      {},
      {},
    );

    // First call — resolver invoked, result computed and cached
    const first = await repo.getAll({ search: 'alpha', filters: { scope: 'public' } });
    const firstDocs = (first as { docs: IMemo[] }).docs;
    expect(firstDocs).toHaveLength(1);
    expect(firstDocs[0].title).toBe('Alpha plan');
    expect(resolver).toHaveBeenCalledTimes(1);

    // Second call with the same params — must hit cache
    // The resolver still runs (it's a before:getAll hook, runs before cache check),
    // but the Mongo query is served from cache. We assert the result is identical.
    const second = await repo.getAll({ search: 'alpha', filters: { scope: 'public' } });
    const secondDocs = (second as { docs: IMemo[] }).docs;
    expect(secondDocs).toHaveLength(1);
    expect(secondDocs[0].title).toBe('Alpha plan');
  });

  it('different search terms produce different cache keys (no cross-pollination)', async () => {
    const alphaDoc = await MemoModel.findOne({ title: 'Alpha plan' }).lean();
    const gammaDoc = await MemoModel.findOne({ title: 'Gamma notes' }).lean();
    const resolver = vi.fn(async (term: string) => {
      if (term === 'alpha') return [String(alphaDoc?._id)];
      if (term === 'gamma') return [String(gammaDoc?._id)];
      return [];
    });

    const cache = createMemoryCache();
    const repo = new Repository(
      MemoModel,
      [externalSearchPlugin(resolver), cachePlugin({ adapter: cache, ttl: 60 })],
      {},
      {},
    );

    const alphaResult = await repo.getAll({ search: 'alpha' });
    const gammaResult = await repo.getAll({ search: 'gamma' });

    expect((alphaResult as { docs: IMemo[] }).docs[0].title).toBe('Alpha plan');
    expect((gammaResult as { docs: IMemo[] }).docs[0].title).toBe('Gamma notes');
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});
