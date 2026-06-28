/**
 * cascade-references.test.ts
 *
 * cascadePurgeReferences — imperative multi-relation purge-by-reference, plus
 * the idVariants id-match helper. Covers both routing paths (raw collection +
 * mongokit Repository via repo-core's runChunkedPurge), all three modes, mixed
 * string/ObjectId foreign keys, the per-relation report, and error isolation.
 */

import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cascadePurgeReferences, idVariants } from '../../src/index.js';
import { Repository } from '../../src/Repository.js';
import { connectDB, disconnectDB } from '../setup.js';

beforeAll(async () => {
  await connectDB();
});
afterAll(async () => {
  await disconnectDB();
});
afterEach(async () => {
  for (const name of Object.keys(mongoose.models)) mongoose.deleteModel(name);
  for (const key in mongoose.connection.collections) {
    await mongoose.connection.collections[key]!.deleteMany({});
  }
});

const oid = () => new mongoose.Types.ObjectId();

describe('idVariants', () => {
  it('returns [hex, ObjectId] for a valid hex id, [value] otherwise', () => {
    const id = oid();
    const hex = id.toHexString();
    const v = idVariants(hex);
    expect(v).toHaveLength(2);
    expect(v[0]).toBe(hex);
    expect(v[1]).toBeInstanceOf(mongoose.Types.ObjectId);
    expect((v[1] as mongoose.Types.ObjectId).toHexString()).toBe(hex);

    expect(idVariants('not-an-objectid')).toEqual(['not-an-objectid']);
    expect(idVariants(42)).toEqual([42]);
    const obj = oid();
    expect(idVariants(obj)).toEqual([obj]); // non-string passes through untouched
  });
});

describe('cascadePurgeReferences — collection-routed', () => {
  it('hard-purges across collections (string OR ObjectId FK), keeps others + unlisted', async () => {
    const db = mongoose.connection;
    const userId = oid();
    const hex = userId.toHexString();
    const other = oid();

    await db.collection('cpr_grants').insertMany([
      { customerId: userId }, // ObjectId form
      { customerId: hex }, // string form
      { customerId: other }, // different user
    ]);
    await db.collection('cpr_enroll').insertOne({ customerId: userId });
    await db.collection('cpr_keep').insertOne({ customerId: userId }); // NOT listed → retained

    const report = await cascadePurgeReferences({
      value: hex,
      relations: [
        { collection: db.collection('cpr_grants'), field: 'customerId' },
        { collection: db.collection('cpr_enroll'), field: 'customerId' },
      ],
    });

    expect(report.every((r) => r.ok)).toBe(true);
    expect(report.find((r) => r.target === 'cpr_grants')?.affected).toBe(2);
    expect(report.find((r) => r.target === 'cpr_enroll')?.affected).toBe(1);
    expect(await db.collection('cpr_grants').countDocuments({})).toBe(1); // `other` survives
    expect(await db.collection('cpr_enroll').countDocuments({})).toBe(0);
    expect(await db.collection('cpr_keep').countDocuments({})).toBe(1); // unlisted survives
  });

  it('soft mode sets deleted/deletedAt; anonymize mode $sets the declared fields', async () => {
    const db = mongoose.connection;
    const uid = oid();
    await db.collection('cpr_soft').insertOne({ customerId: uid });
    await db.collection('cpr_anon').insertOne({ customerId: uid, email: 'real@example.com' });

    const report = await cascadePurgeReferences({
      value: uid,
      relations: [
        { collection: db.collection('cpr_soft'), field: 'customerId', mode: 'soft' },
        {
          collection: db.collection('cpr_anon'),
          field: 'customerId',
          mode: 'anonymize',
          anonymizeFields: { email: 'deleted@user' },
        },
      ],
    });

    expect(report.every((r) => r.ok)).toBe(true);
    const soft = await db.collection('cpr_soft').findOne({ customerId: uid });
    expect(soft?.deleted).toBe(true);
    expect(soft?.deletedAt).toBeInstanceOf(Date);
    const anon = await db.collection('cpr_anon').findOne({ customerId: uid });
    expect(anon?.email).toBe('deleted@user');
  });

  it('reports ok:false for a failing relation without aborting siblings', async () => {
    const db = mongoose.connection;
    const uid = oid();
    await db.collection('cpr_ok').insertOne({ customerId: uid });
    const flaky = {
      collectionName: 'flaky',
      deleteMany: () => Promise.reject(new Error('boom')),
      updateMany: () => Promise.reject(new Error('boom')),
    };

    const report = await cascadePurgeReferences({
      value: uid,
      relations: [
        { collection: flaky, field: 'customerId' },
        { collection: db.collection('cpr_ok'), field: 'customerId' },
      ],
    });

    const bad = report.find((r) => r.target === 'flaky');
    const good = report.find((r) => r.target === 'cpr_ok');
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toContain('boom');
    expect(good?.ok).toBe(true);
    expect(good?.affected).toBe(1);
    expect(await db.collection('cpr_ok').countDocuments({})).toBe(0);
  });

  it('no-ops on empty relations or nullish value', async () => {
    expect(await cascadePurgeReferences({ value: oid(), relations: [] })).toEqual([]);
    expect(
      await cascadePurgeReferences({
        value: null,
        relations: [{ collection: mongoose.connection.collection('x'), field: 'y' }],
      }),
    ).toEqual([]);
  });
});

describe('cascadePurgeReferences — repo-routed (reuses repo-core runChunkedPurge)', () => {
  it('hard-deletes through a mongokit Repository', async () => {
    const schema = new mongoose.Schema(
      { customerId: mongoose.Schema.Types.ObjectId },
      { collection: 'cpr_repo' },
    );
    const Model = mongoose.model('CprRepo', schema);
    const repo = new Repository(Model as never);
    const uid = oid();
    await Model.create([{ customerId: uid }, { customerId: uid }, { customerId: oid() }]);

    const report = await cascadePurgeReferences({
      value: uid.toHexString(),
      relations: [{ repo: repo as never, field: 'customerId' }],
    });

    expect(report[0].ok).toBe(true);
    expect(report[0].target).toBe('CprRepo');
    expect(report[0].affected).toBe(2);
    expect(await Model.countDocuments({})).toBe(1);
  });

  it('soft mode through a Repository sets the soft-delete flag (not a hard delete)', async () => {
    const schema = new mongoose.Schema(
      { customerId: mongoose.Schema.Types.ObjectId, deleted: Boolean, deletedAt: Date },
      { collection: 'cpr_repo_soft' },
    );
    const Model = mongoose.model('CprRepoSoft', schema);
    const repo = new Repository(Model as never);
    const uid = oid();
    await Model.create([{ customerId: uid }, { customerId: uid }]);

    const report = await cascadePurgeReferences({
      value: uid,
      mode: 'soft',
      relations: [{ repo: repo as never, field: 'customerId' }],
    });

    expect(report[0].ok).toBe(true);
    expect(report[0].mode).toBe('soft');
    expect(await Model.countDocuments({})).toBe(2); // rows retained
    expect(await Model.countDocuments({ deleted: true })).toBe(2); // flagged
  });
});

describe('cascadePurgeReferences — option branches', () => {
  it('matchIdVariants:false matches only the exact value (no ObjectId variant)', async () => {
    const db = mongoose.connection;
    const userId = oid();
    const hex = userId.toHexString();
    await db.collection('cpr_exact').insertMany([{ customerId: userId }, { customerId: hex }]);

    const report = await cascadePurgeReferences({
      value: hex, // a string; with variants off, the ObjectId row must survive
      matchIdVariants: false,
      relations: [{ collection: db.collection('cpr_exact'), field: 'customerId' }],
    });

    expect(report[0].affected).toBe(1); // only the string-form row
    expect(await db.collection('cpr_exact').countDocuments({ customerId: userId })).toBe(1);
  });

  it('parallel:false runs relations sequentially and returns them in order', async () => {
    const db = mongoose.connection;
    const uid = oid();
    await db.collection('cpr_seq_a').insertOne({ customerId: uid });
    await db.collection('cpr_seq_b').insertOne({ customerId: uid });

    const report = await cascadePurgeReferences({
      value: uid,
      parallel: false,
      relations: [
        { collection: db.collection('cpr_seq_a'), field: 'customerId' },
        { collection: db.collection('cpr_seq_b'), field: 'customerId' },
      ],
    });

    expect(report.map((r) => r.target)).toEqual(['cpr_seq_a', 'cpr_seq_b']);
    expect(report.every((r) => r.ok && r.affected === 1)).toBe(true);
  });
});
