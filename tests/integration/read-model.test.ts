/**
 * Stage 2 mongokit contract for `bulkUpsert` and `@classytic/mongokit/read-model`: one command
 * per call, closed codes, scope rules. The portable groups run in data-access-conformance.test.ts.
 */

import { BULK_UPSERT_ERROR_CODES } from '@classytic/repo-core/repository';
import { Schema } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { applyIncrements, READ_MODEL_ERROR_CODES, rebuildInto, reconcile } from '../../src/read-model/index.js';
import { recordCommands } from '../../src/testkit/index.js';
import { conn, Fact, Ledger, ON, repos, setupReadModelModels, Stock, Total, tenant, totalsPipeline } from '../helpers/read-model-fixtures.js';
import { connectDB } from '../setup.js';

beforeAll(async () => {
  await connectDB();
  await setupReadModelModels();
});

describe('bulkUpsert — mongokit contract', () => {
  it('a batch of 500 rows is ONE command', async () => {
    const { stock } = repos();
    await Stock.deleteMany({});
    const rows = Array.from({ length: 500 }, (_, i) => ({ sku: `S${i}`, qty: i }));
    const { result, commands } = await recordCommands(conn, () => stock.bulkUpsert(rows, { key: ['sku'], organizationId: 'org-a' }));
    expect(commands.filter((c) => c.name === 'bulkWrite')).toHaveLength(1);
    expect(result.inserted).toBe(500);
  });

  it('refuses a non-unique key with the closed code, before any command', async () => {
    const { stock } = repos();
    const { commands, result } = await recordCommands(conn, () =>
      stock.bulkUpsert([{ sku: 'X', name: 'x' }], { key: ['name'], organizationId: 'org-a' }).catch((e: unknown) => e),
    );
    expect(result).toMatchObject({ code: BULK_UPSERT_ERROR_CODES.KEY_NOT_UNIQUE });
    expect(commands.filter((c) => c.name === 'bulkWrite')).toHaveLength(0);
  });

  it('a duplicate on ANOTHER unique index fails that row as duplicate; unordered, the rest land', async () => {
    const schema = new Schema({ organizationId: String, sku: String, code: String });
    schema.index({ organizationId: 1, sku: 1 }, { unique: true });
    schema.index({ organizationId: 1, code: 1 }, { unique: true });
    const Coded = conn.models.RmCoded ?? conn.model('RmCoded', schema);
    await Coded.syncIndexes();
    await Coded.deleteMany({});
    const coded = new Repository(Coded, tenant());
    const res = await coded.bulkUpsert(
      [
        { sku: 'A', code: 'same' },
        { sku: 'B', code: 'same' },
        { sku: 'C', code: 'other' },
      ],
      { key: ['sku'], organizationId: 'org-a' },
    );
    expect(res.results.map((r) => [r.outcome, r.code])).toEqual([
      ['inserted', undefined],
      ['failed', 'duplicate'],
      ['inserted', undefined],
    ]);
    const ordered = await coded.bulkUpsert(
      [
        { sku: 'D', code: 'same' },
        { sku: 'E', code: 'fresh' },
      ],
      { key: ['sku'], ordered: true, organizationId: 'org-a' },
    );
    expect(ordered.results.map((r) => [r.outcome, r.code])).toEqual([
      ['failed', 'duplicate'],
      ['failed', 'not_attempted'],
    ]);
  });

  it('the tenant key comes from the scope, never from a row', async () => {
    const { stock } = repos();
    await Stock.deleteMany({});
    await expect(
      stock.bulkUpsert([{ sku: 'A', qty: 1, organizationId: 'org-b' }], { key: ['sku'], organizationId: 'org-a' }),
    ).rejects.toThrow(/does not match the resolved tenant scope|organizationId/);
  });
});

describe('read-model — mongokit contract', () => {
  it('rebuildInto removes grains the source no longer produces, in the scope only', async () => {
    const { fact, total } = repos();
    await Promise.all([Fact.deleteMany({}), Total.deleteMany({})]);
    await Total.insertMany([
      { organizationId: 'org-a', period: '1999-01', rate: 1, tax: 9 },
      { organizationId: 'org-b', period: '1999-01', rate: 1, tax: 9 },
    ]);
    await Fact.insertMany([{ organizationId: 'org-a', period: '2026-01', rate: 15, tax: 5 }]);
    await rebuildInto(fact, total, { pipeline: totalsPipeline, on: ON, scope: { organizationId: 'org-a' } });
    expect((await Total.find({ organizationId: 'org-a' }).lean()).map((t) => t.period)).toEqual(['2026-01']);
    expect(await Total.countDocuments({ organizationId: 'org-b' })).toBe(1);
  });

  it('rebuildInto refuses `on` without a matching unique index, and `on` without the tenant field', async () => {
    const { fact, total } = repos();
    await expect(
      rebuildInto(fact, total, { pipeline: totalsPipeline, on: ['organizationId', 'period'], scope: { organizationId: 'org-a' } }),
    ).rejects.toMatchObject({ code: READ_MODEL_ERROR_CODES.ON_NOT_UNIQUE });
    await expect(
      rebuildInto(fact, total, { pipeline: totalsPipeline, on: ['period', 'rate'], scope: { organizationId: 'org-a' } }),
    ).rejects.toMatchObject({ code: READ_MODEL_ERROR_CODES.ON_MISSING_SCOPE });
  });

  it('rebuildInto inside a transaction is the closed code', async () => {
    const { fact, total } = repos();
    const session = await conn.startSession();
    try {
      session.startTransaction();
      await expect(
        rebuildInto(fact, total, { pipeline: totalsPipeline, on: ON, scope: { organizationId: 'org-a' }, session }),
      ).rejects.toMatchObject({ code: READ_MODEL_ERROR_CODES.MERGE_IN_TRANSACTION });
    } finally {
      await session.abortTransaction();
      await session.endSession();
    }
  });

  it('applyIncrements with a ledger refuses to run outside a transaction', async () => {
    const { total, ledger } = repos();
    await expect(
      applyIncrements(total, [{ key: { period: 'p', rate: 1 }, inc: { tax: 1 }, dedupeKey: 'k' }], { ledger, organizationId: 'org-a' }),
    ).rejects.toMatchObject({ code: READ_MODEL_ERROR_CODES.DEDUPE_NEEDS_TRANSACTION });
  });

  it('applyIncrements sums grains with the same key into ONE upsert', async () => {
    const { total } = repos();
    await Total.deleteMany({});
    const res = await applyIncrements(
      total,
      [
        { key: { period: 'p', rate: 1 }, inc: { tax: 2 } },
        { key: { period: 'p', rate: 1 }, inc: { tax: 3 } },
      ],
      { organizationId: 'org-a' },
    );
    expect(res.results).toHaveLength(1);
    expect((await Total.findOne({ organizationId: 'org-a', period: 'p' }).lean())?.tax).toBe(5);
  });
});
