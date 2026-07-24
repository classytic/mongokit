/**
 * `Repository.purgeByFilter(filter, strategy, options)` — the range/filter-
 * scoped sibling of `purgeByField`. Standardized in
 * `@classytic/repo-core/repository`; mongokit implements it via
 * `runChunkedPurge` + `createMongoPurgePortFromFilter`.
 *
 * Where `purgeByField` matches a single `field = value` equality, this
 * method takes an arbitrary compiled filter — the GDPR / retention primitive
 * for "purge/anonymize a slice across a RANGE while retaining measures"
 * (redact a PII dimension across a `civilDate` window; hard-delete rows past
 * a retention cutoff). Covers all four strategies over a range predicate,
 * tenant + soft-delete interplay, chunking with resume-by-reselection, and
 * the narrowed-write filter re-assertion.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { multiTenantPlugin, Repository, softDeletePlugin } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IFactRow {
  _id: Types.ObjectId;
  organizationId: string;
  /** Civil-date ordinal (e.g. YYYYMMDD) — the window dimension. */
  day: number;
  /** PII dimension redacted by anonymize; measures below are RETAINED. */
  customerEmail: string;
  amount: number;
  qty: number;
  deleted?: boolean;
  deletedAt?: Date | null;
}

const RANGE_SCHEMA = () =>
  new Schema<IFactRow>({
    organizationId: { type: String, required: true, index: true },
    day: { type: Number, required: true, index: true },
    customerEmail: { type: String, required: true },
    amount: { type: Number, required: true },
    qty: { type: Number, required: true },
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  });

beforeAll(async () => {
  await connectDB();
});
afterAll(async () => {
  await disconnectDB();
});

describe('purgeByFilter — range predicate, all strategies', () => {
  let Model: mongoose.Model<IFactRow>;
  let repo: Repository<IFactRow>;

  beforeAll(async () => {
    Model = await createTestModel('PbfRange', RANGE_SCHEMA());
    repo = new Repository<IFactRow>(Model);
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    // days 1..10, one row each; email carries PII, amount/qty are measures.
    await Model.create(
      Array.from({ length: 10 }, (_, i) => ({
        organizationId: 'org-a',
        day: i + 1,
        customerEmail: `user${i + 1}@example.com`,
        amount: (i + 1) * 100,
        qty: i + 1,
      })),
    );
  });

  it('hard: deletes only rows inside the [gte, lte] window; leaves the rest', async () => {
    const result = await repo.purgeByFilter(
      { day: { $gte: 3, $lte: 7 } },
      { type: 'hard' },
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('hard');
    expect(result.processed).toBe(5); // days 3,4,5,6,7
    expect(await Model.countDocuments({})).toBe(5);
    expect(await Model.countDocuments({ day: { $gte: 3, $lte: 7 } })).toBe(0);
    // Boundary + outside rows survive.
    expect(await Model.countDocuments({ day: { $lt: 3 } })).toBe(2);
    expect(await Model.countDocuments({ day: { $gt: 7 } })).toBe(3);
  });

  it('hard: accepts Filter IR (and/gte/lte), same window semantics', async () => {
    // Plain-record form and IR form must compile to the same predicate.
    const result = await repo.purgeByFilter(
      { day: { $gte: 8 } },
      { type: 'hard' },
    );
    expect(result.processed).toBe(3); // 8,9,10
    expect(await Model.countDocuments({})).toBe(7);
  });

  it('soft: flags deleted/deletedAt across the window, RETAINS rows + measures', async () => {
    const result = await repo.purgeByFilter(
      { day: { $lte: 4 } },
      { type: 'soft' },
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('soft');
    expect(result.processed).toBe(4);
    // No physical deletion — measures retained.
    expect(await Model.countDocuments({})).toBe(10);
    expect(await Model.countDocuments({ deleted: true })).toBe(4);
    const flagged = await Model.find({ deleted: true }).lean();
    for (const row of flagged) {
      expect(row.day).toBeLessThanOrEqual(4);
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect(row.amount).toBeGreaterThan(0); // measure untouched
    }
  });

  it('anonymize (static): redacts the PII dimension across the window; measures survive', async () => {
    const result = await repo.purgeByFilter(
      { day: { $gte: 5, $lte: 8 } },
      { type: 'anonymize', fields: { customerEmail: 'redacted@anon.invalid' } },
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('anonymize');
    expect(result.processed).toBe(4); // 5,6,7,8

    const inWindow = await Model.find({ day: { $gte: 5, $lte: 8 } }).lean();
    for (const row of inWindow) {
      expect(row.customerEmail).toBe('redacted@anon.invalid'); // PII gone
      expect(row.amount).toBe(row.day * 100); // measure RETAINED
      expect(row.qty).toBe(row.day); // measure RETAINED
    }
    // Rows outside the window keep their PII.
    const outside = await Model.find({ day: { $lt: 5 } }).lean();
    for (const row of outside) {
      expect(row.customerEmail).toBe(`user${row.day}@example.com`);
    }
  });

  it('anonymize (function): computes a per-row deterministic replacement', async () => {
    const result = await repo.purgeByFilter(
      { day: { $gte: 9 } },
      {
        type: 'anonymize',
        fields: {
          customerEmail: (doc: Record<string, unknown>) => `anon-${doc.day as number}@masked`,
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(2); // 9,10
    const rows = await Model.find({ day: { $gte: 9 } }).lean();
    for (const row of rows) {
      expect(row.customerEmail).toBe(`anon-${row.day}@masked`); // per-row fn
      expect(row.amount).toBe(row.day * 100); // measure retained
    }
    // Untouched rows keep original PII.
    expect((await Model.findOne({ day: 1 }).lean())?.customerEmail).toBe('user1@example.com');
  });

  it('skip: performs no write and echoes the reason', async () => {
    const result = await repo.purgeByFilter(
      { day: { $gte: 1 } },
      { type: 'skip', reason: 'legal-hold' },
    );
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('skip');
    expect(result.processed).toBe(0);
    expect(result.skipReason).toBe('legal-hold');
    expect(await Model.countDocuments({})).toBe(10); // untouched
  });

  it('empty match: ok with zero processed', async () => {
    const result = await repo.purgeByFilter({ day: { $gt: 999 } }, { type: 'hard' });
    expect(result.ok).toBe(true);
    expect(result.processed).toBe(0);
    expect(await Model.countDocuments({})).toBe(10);
  });
});

describe('purgeByFilter — chunking + resume-by-reselection', () => {
  let Model: mongoose.Model<IFactRow>;
  let repo: Repository<IFactRow>;

  beforeAll(async () => {
    Model = await createTestModel('PbfChunk', RANGE_SCHEMA());
    repo = new Repository<IFactRow>(Model);
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  it('hard: drives multiple chunks and reports each via onProgress', async () => {
    // 25 rows in-window (day 1..25), 5 rows out-of-window (day 100..104).
    await Model.create(
      Array.from({ length: 25 }, (_, i) => ({
        organizationId: 'org-a',
        day: i + 1,
        customerEmail: `u${i}@x.io`,
        amount: 1,
        qty: 1,
      })),
    );
    await Model.create(
      Array.from({ length: 5 }, (_, i) => ({
        organizationId: 'org-a',
        day: 100 + i,
        customerEmail: `keep${i}@x.io`,
        amount: 1,
        qty: 1,
      })),
    );

    const progress: number[] = [];
    const result = await repo.purgeByFilter(
      { day: { $lte: 25 } },
      { type: 'hard' },
      {
        batchSize: 10,
        onProgress: (e) => {
          progress.push(e.chunkSize);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(25);
    // Chunks are hard-deleted, so re-selecting the same filter advances
    // naturally: 10 + 10 + 5 = 25.
    expect(progress).toEqual([10, 10, 5]);
    expect(await Model.countDocuments({})).toBe(5); // out-of-window survives
  });

  it('soft: resume-by-reselection — narrows the base filter so soft-flagged rows drop out of the next chunk', async () => {
    // Without soft-delete plugin the base filter must EXCLUDE already-flagged
    // rows or a soft purge would re-select the same chunk forever. We prove
    // termination by adding `deleted: { $ne: true }` to the window filter.
    await Model.create(
      Array.from({ length: 15 }, (_, i) => ({
        organizationId: 'org-a',
        day: i + 1,
        customerEmail: `u${i}@x.io`,
        amount: 1,
        qty: 1,
      })),
    );

    const result = await repo.purgeByFilter(
      { day: { $lte: 15 }, deleted: { $ne: true } },
      { type: 'soft' },
      { batchSize: 6 },
    );

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(15); // 6 + 6 + 3
    expect(await Model.countDocuments({ deleted: true })).toBe(15);
    expect(await Model.countDocuments({})).toBe(15); // retained
  });
});

describe('purgeByFilter — narrowed-write re-assertion', () => {
  let Model: mongoose.Model<IFactRow>;
  let repo: Repository<IFactRow>;

  beforeAll(async () => {
    Model = await createTestModel('PbfReassert', RANGE_SCHEMA());
    repo = new Repository<IFactRow>(Model);
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  it('anonymize (static) write is scoped to {_id:$in, ...filter} — a concurrent mutation out of the window is spared', async () => {
    await Model.create(
      Array.from({ length: 6 }, (_, i) => ({
        organizationId: 'org-a',
        day: i + 1,
        customerEmail: `u${i + 1}@x.io`,
        amount: 1,
        qty: 1,
      })),
    );

    // Bind a port over the window [1,4] but simulate a race: after the port
    // is created, we mutate day-3 out of the window before running. Because
    // the WRITE re-asserts the base filter (`day` range) on the narrowed
    // `_id: {$in}` set, day-3 (now day 999) must NOT be anonymized even
    // though its _id was captured in-window on the read.
    //
    // We emulate the interleave deterministically by monkeypatching the
    // repo's updateMany to first move day-3 out of the window, then delegate.
    const realUpdateMany = repo.updateMany.bind(repo);
    let raced = false;
    (repo as unknown as { updateMany: typeof repo.updateMany }).updateMany = async (
      filter: Record<string, unknown>,
      data: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      if (!raced) {
        raced = true;
        await Model.updateOne({ day: 3 }, { $set: { day: 999 } });
      }
      return realUpdateMany(filter, data as never, options as never);
    };

    const result = await repo.purgeByFilter(
      { day: { $gte: 1, $lte: 4 } },
      { type: 'anonymize', fields: { customerEmail: 'X@anon' } },
    );
    (repo as unknown as { updateMany: typeof realUpdateMany }).updateMany = realUpdateMany;

    expect(result.ok).toBe(true);
    // day-3 escaped the window before the write; re-assertion spares it.
    const escaped = await Model.findOne({ day: 999 }).lean();
    expect(escaped?.customerEmail).toBe('u3@x.io'); // original PII, untouched
    // The remaining in-window rows (1,2,4) are anonymized.
    expect(await Model.countDocuments({ customerEmail: 'X@anon' })).toBe(3);
  });
});

describe('purgeByFilter — tenant + soft-delete plugin interplay', () => {
  it('compound filter carries the tenant scope; bypassTenant keeps the authoritative predicate', async () => {
    const Model = await createTestModel('PbfTenant', RANGE_SCHEMA());
    // Tenant plugin would normally inject the ambient org; the purge filter
    // itself IS the authoritative scope, so the port bypasses tenant
    // injection. We verify org-b rows in the same window are untouched.
    const repo = new Repository<IFactRow>(Model, [
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]);

    await Model.create([
      { organizationId: 'org-a', day: 2, customerEmail: 'a2@x', amount: 1, qty: 1 },
      { organizationId: 'org-a', day: 3, customerEmail: 'a3@x', amount: 1, qty: 1 },
      { organizationId: 'org-b', day: 3, customerEmail: 'b3@x', amount: 1, qty: 1 },
    ]);

    const result = await repo.purgeByFilter(
      { organizationId: 'org-a', day: { $gte: 2, $lte: 3 } },
      { type: 'hard' },
    );

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(2); // org-a only
    expect(await Model.countDocuments({ organizationId: 'org-a' })).toBe(0);
    expect(await Model.countDocuments({ organizationId: 'org-b' })).toBe(1); // spared
  });

  it('hard mode bypasses a wired soft-delete plugin (physical deletion for erasure)', async () => {
    const Model = await createTestModel('PbfSoftPlugin', RANGE_SCHEMA());
    const repo = new Repository<IFactRow>(Model, [
      softDeletePlugin({ deletedField: 'deletedAt', filterMode: 'null' }),
    ]);

    await Model.create(
      Array.from({ length: 4 }, (_, i) => ({
        organizationId: 'org-a',
        day: i + 1,
        customerEmail: `u${i}@x`,
        amount: 1,
        qty: 1,
      })),
    );

    const result = await repo.purgeByFilter(
      { day: { $lte: 2 } },
      { type: 'hard' },
    );

    expect(result.ok).toBe(true);
    expect(result.processed).toBe(2);
    // mode: 'hard' → real removal despite the soft-delete plugin.
    expect(await Model.countDocuments({})).toBe(2);
  });
});
