/**
 * `context.loadTarget()` / `context.memo()` — N hooks of one operation that need the same
 * read pay for ONE. Before these, every plugin guarding a claim did its own
 * `Model.findById(context.id)`: five plugins, five identical reads of one document.
 */
import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { methodRegistryPlugin, multiTenantPlugin, Repository } from '../../src/index.js';
import type { RepositoryContext } from '../../src/types/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IEntry {
  _id?: mongoose.Types.ObjectId;
  status: 'draft' | 'posted';
  amount: number;
}

describe('shared-read seams on the hook context', () => {
  let Model: mongoose.Model<IEntry>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'SharedReadEntry',
      new Schema<IEntry>({ status: { type: String, required: true }, amount: Number }),
    );
  });

  afterAll(async () => {
    await disconnectDB();
  });

  /** Counts reads of the entry collection issued while `fn` runs. */
  async function countReads(fn: () => Promise<unknown>): Promise<number> {
    let reads = 0;
    mongoose.set('debug', (coll: string, method: string) => {
      if (coll === Model.collection.name && (method === 'findOne' || method === 'find')) reads += 1;
    });
    try {
      await fn();
    } finally {
      mongoose.set('debug', false);
    }
    return reads;
  }

  it('three hooks reading the target share ONE read, and see the pre-write document', async () => {
    const repo = new Repository(Model);
    const seen: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      repo.on('before:claim', async (ctx: RepositoryContext) => {
        const doc = await ctx.loadTarget?.();
        seen.push(doc?.status);
      });
    }
    const created = await repo.create({ status: 'draft', amount: 5 });

    const reads = await countReads(() => repo.claim(String(created._id), { from: 'draft', to: 'posted' }));

    expect(seen).toEqual(['draft', 'draft', 'draft']);
    expect(reads).toBe(1);
  });

  it('a caller-seeded target is used as-is — zero reads', async () => {
    const repo = new Repository(Model);
    repo.on('before:claim', async (ctx: RepositoryContext) => {
      expect((await ctx.loadTarget?.())?.amount).toBe(7);
    });
    const created = await repo.create({ status: 'draft', amount: 7 });
    const target = (await Model.findById(created._id).lean()) as Record<string, unknown>;

    const reads = await countReads(() =>
      repo.claim(String(created._id), { from: 'draft', to: 'posted' }, {}, { target }),
    );
    expect(reads).toBe(0);
  });

  it('a seeded target for a DIFFERENT document is refused', async () => {
    const repo = new Repository(Model);
    const a = await repo.create({ status: 'draft', amount: 1 });
    const b = await repo.create({ status: 'draft', amount: 2 });
    const targetOfB = (await Model.findById(b._id).lean()) as Record<string, unknown>;
    await expect(
      repo.claim(String(a._id), { from: 'draft', to: 'posted' }, {}, { target: targetOfB }),
    ).rejects.toThrow(/not the claimed/);
    expect((await Model.findById(a._id).lean())?.status).toBe('draft');
  });

  it('a STALE seeded target misses the claim — hooks never act on an out-of-date copy', async () => {
    const repo = new Repository(Model);
    const created = await repo.create({ status: 'draft', amount: 3 });
    const stale = (await Model.findById(created._id).lean()) as Record<string, unknown>;
    // A write lands between the read and the claim.
    await Model.updateOne({ _id: created._id }, { $inc: { __v: 1 }, $set: { amount: 99 } });

    const claimed = await repo.claim(String(created._id), { from: 'draft', to: 'posted' }, {}, { target: stale });
    expect(claimed).toBeNull();
    expect((await Model.findById(created._id).lean())?.status).toBe('draft');

    // A fresh read claims normally.
    const fresh = (await Model.findById(created._id).lean()) as Record<string, unknown>;
    expect(await repo.claim(String(created._id), { from: 'draft', to: 'posted' }, {}, { target: fresh })).not.toBeNull();
  });

  it('loadTarget stays in the tenant — a custom id shared across tenants loads THIS tenant\'s doc', async () => {
    const Tenanted = await createTestModel(
      'SharedReadTenanted',
      new Schema({ code: String, organizationId: String, status: String, amount: Number }),
    );
    const repo = new Repository(Tenanted, [methodRegistryPlugin(), multiTenantPlugin({ tenantField: 'organizationId' })]);
    (repo as { idField: string }).idField = 'code';
    await Tenanted.create({ code: 'INV-1', organizationId: 'org_a', status: 'draft', amount: 1 });
    await Tenanted.create({ code: 'INV-1', organizationId: 'org_b', status: 'draft', amount: 2 });

    let seen: unknown;
    repo.on('before:claim', async (ctx: RepositoryContext) => {
      seen = (await ctx.loadTarget?.())?.organizationId;
    });
    await repo.claim('INV-1', { from: 'draft', to: 'posted' }, {}, { organizationId: 'org_b' } as never);
    expect(seen).toBe('org_b');
  });

  it('memo shares any keyed read across hooks, and forgets a failed one', async () => {
    const repo = new Repository(Model);
    let loads = 0;
    let fail = true;
    const load = async () => {
      loads += 1;
      if (fail) throw new Error('transient');
      return 'value';
    };
    repo.on('before:claim', async (ctx: RepositoryContext) => {
      await expect(ctx.memo!('k', load)).rejects.toThrow('transient');
      fail = false;
      expect(await ctx.memo!('k', load)).toBe('value');
    });
    repo.on('before:claim', async (ctx: RepositoryContext) => {
      expect(await ctx.memo!('k', load)).toBe('value');
    });
    const created = await repo.create({ status: 'draft', amount: 1 });
    await repo.claim(String(created._id), { from: 'draft', to: 'posted' });
    expect(loads).toBe(2); // the failure, then ONE successful load shared by both hooks
  });

  it('an operation with no id gets memo but no loadTarget', async () => {
    const repo = new Repository(Model);
    let ctxSeen: RepositoryContext | undefined;
    repo.on('before:create', async (ctx: RepositoryContext) => {
      ctxSeen = ctx;
    });
    await repo.create({ status: 'draft', amount: 2 });
    expect(typeof ctxSeen?.memo).toBe('function');
    expect(ctxSeen?.loadTarget).toBeUndefined();
  });
});
