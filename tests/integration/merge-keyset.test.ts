/**
 * `mergeKeysetPages` over two real collections through `keysetSource`: the merged walk equals the
 * sorted union (ties across collections in source order), every row once, under concurrent
 * inserts; tenant-scoped sources refuse a cursor minted for another tenant. Runs repo-core's
 * capability-gated merge conformance too.
 */

import { mergeKeysetPages, CURSOR_ERROR_CODES } from '@classytic/repo-core/pagination';
import { runMergeKeysetConformance } from '@classytic/repo-core/testing';
import mongoose, { type Model, Schema } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { keysetSource, MONGOKIT_CAPABILITIES, multiTenantPlugin, Repository } from '../../src/index.js';
import { connectDB, createTestModel } from '../setup.js';

interface IDoc {
  organizationId: string;
  at: Date;
  label: string;
}

let Inbound: Model<IDoc>;
let Purchase: Model<IDoc>;
const tenant = () => [multiTenantPlugin({ tenantField: 'organizationId' })];
const sort = { at: -1 as const, _id: -1 as const };

beforeAll(async () => {
  await connectDB();
  const schema = () => {
    const s = new Schema<IDoc>({ organizationId: String, at: Date, label: String });
    s.index({ organizationId: 1, at: -1, _id: -1 });
    return s;
  };
  Inbound = await createTestModel('MergeInbound', schema());
  Purchase = await createTestModel('MergePurchase', schema());
});

const sources = (org: string) => [
  keysetSource(new Repository<IDoc>(Inbound, tenant()), { name: 'inbound', sort, organizationId: org }),
  keysetSource(new Repository<IDoc>(Purchase, tenant()), { name: 'purchase', sort, organizationId: org }),
];

describe('mergeKeysetPages over two collections', () => {
  it('walks the union in the shared total order (ties across collections by _id), under concurrent inserts', async () => {
    await Promise.all([Inbound.deleteMany({}), Purchase.deleteMany({})]);
    const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
    await Inbound.insertMany([0, 2, 4, 4, 6].map((m, i) => ({ organizationId: 'org-a', at: t(m), label: `i${i}` })));
    await Purchase.insertMany([1, 2, 3, 4, 5].map((m, i) => ({ organizationId: 'org-a', at: t(m), label: `p${i}` })));
    await Inbound.insertMany([{ organizationId: 'org-b', at: t(9), label: 'other-tenant' }]);
    const before = [...(await Inbound.find({ organizationId: 'org-a' }).lean()), ...(await Purchase.find({ organizationId: 'org-a' }).lean())];

    const seen: { source: string; label: string; at: number; id: string }[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await mergeKeysetPages(sources('org-a'), { sort, limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(
        ...page.docs.map((d) => ({
          source: d.source,
          label: d.row.label,
          at: d.row.at.getTime(),
          id: String((d.row as IDoc & { _id: unknown })._id),
        })),
      );
      if (i === 0) await Purchase.insertMany([{ organizationId: 'org-a', at: t(0), label: 'late' }]);
      if (!page.hasNext) break;
      cursor = page.next ?? undefined;
    }
    const labels = seen.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const d of before) expect(labels).toContain(d.label);
    expect(labels).not.toContain('other-tenant');
    const ats = seen.map((s) => s.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    // Equal `at` across collections follows the shared total order's tiebreaker: _id descending.
    const at4 = seen.filter((s) => s.at === t(4).getTime()).map((s) => s.id);
    expect(at4).toHaveLength(3);
    expect(at4).toEqual([...at4].sort().reverse());
  });

  it('a cursor minted for one tenant is refused for another', async () => {
    const page = await mergeKeysetPages(sources('org-a'), { sort, limit: 2 });
    await expect(mergeKeysetPages(sources('org-b'), { sort, limit: 2, cursor: page.next as string })).rejects.toMatchObject({
      code: CURSOR_ERROR_CODES.SCOPE_MISMATCH,
    });
  });

  it('keysetCursor mints the same cursor getAll would for its last row', async () => {
    const repo = new Repository<IDoc>(Inbound, tenant());
    const page = await repo.getAll({ sort, limit: 2, mode: 'keyset', organizationId: 'org-a' });
    if (page.method !== 'keyset') throw new Error('expected keyset');
    const minted = await repo.keysetCursor(page.data[1] as IDoc & { _id: mongoose.Types.ObjectId }, { sort, organizationId: 'org-a' });
    const viaMinted = await repo.getAll({ sort, limit: 2, after: minted, organizationId: 'org-a' });
    const viaNext = await repo.getAll({ sort, limit: 2, after: page.next as string, organizationId: 'org-a' });
    expect(viaMinted.data).toEqual(viaNext.data);
  });
});

runMergeKeysetConformance({
  name: 'mongokit',
  features: MONGOKIT_CAPABILITIES,
  fixture: async () => {
    await Promise.all([Inbound.deleteMany({}), Purchase.deleteMany({})]);
    return {
      insert: async (source, rows) => {
        await (source === 0 ? Inbound : Purchase).insertMany(
          rows.map((r) => ({ organizationId: 'org-c', at: new Date(Date.UTC(2026, 0, 1) + r.k * 60_000), label: r.label })),
        );
      },
      sources: () => sources('org-c'),
      sort,
      labelOf: (row) => (row as IDoc).label,
      keyOf: (row) => (row as IDoc).at.getTime(),
      cleanup: async () => {
        await Promise.all([Inbound.deleteMany({}), Purchase.deleteMany({})]);
      },
    };
  },
});
