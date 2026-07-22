/**
 * `immutableStatesPlugin()` — lifecycle immutability (frozen states).
 * Generalized from ledger's immutable-guard; these tests pin the exact
 * semantics ledger relies on PLUS the holes the hand-rolled version
 * had (findOneAndUpdate / updateMany / deleteMany / bulkWrite /
 * different-field claims).
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  batchOperationsPlugin,
  immutableStatesPlugin,
  methodRegistryPlugin,
  Repository,
} from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IEntry {
  _id?: mongoose.Types.ObjectId;
  organizationId: string;
  state: 'draft' | 'posted' | 'archived';
  phase?: string;
  amount: number;
  reversed?: boolean;
  version?: number;
}

class FrozenError extends Error {
  readonly code = 'ledger.immutable';
  constructor(readonly entryId: unknown) {
    super(`Entry ${String(entryId)} is posted and immutable`);
  }
}

describe('immutableStatesPlugin — frozen lifecycle states', () => {
  let EntryModel: mongoose.Model<IEntry>;
  let repo: Repository<IEntry>;

  beforeAll(async () => {
    await connectDB();
    EntryModel = await createTestModel(
      'ImmutableEntry',
      new Schema<IEntry>({
        organizationId: { type: String, required: true },
        state: { type: String, required: true },
        phase: String,
        amount: { type: Number, required: true },
        reversed: Boolean,
        version: Number,
      }),
    );
    repo = new Repository<IEntry>(EntryModel, [
      immutableStatesPlugin({
        states: ['posted'],
        field: 'state',
        internalFlag: '_ledgerInternal',
        tenantField: 'organizationId',
        allowClaim: ({ transition, data }) => {
          // Ledger's reverse-mark fingerprint: posted→posted stamp of
          // `reversed: true` guarded by `reversed: { $ne: true }`.
          if (transition.from !== 'posted' || transition.to !== 'posted') return false;
          const guard = (transition.where?.reversed ?? {}) as { $ne?: unknown };
          if (guard.$ne !== true) return false;
          const $set = (data?.$set ?? {}) as Record<string, unknown>;
          return $set.reversed === true;
        },
        errorFactory: ({ id }) => new FrozenError(id),
      }),
    ]);
  });
  afterAll(async () => {
    await disconnectDB();
  });
  beforeEach(async () => {
    await EntryModel.deleteMany({});
  });

  const mk = (state: IEntry['state'], amount = 100) =>
    repo.create({ organizationId: 'org1', state, amount, version: 0 });

  it('drafts stay fully editable; posted rows refuse update/delete/claimVersion', async () => {
    const draft = await mk('draft');
    const posted = await mk('posted');
    // Draft paths all work.
    await repo.update(String(draft._id), { amount: 150 });
    // Posted paths refuse with the DOMAIN error.
    await expect(repo.update(String(posted._id), { amount: 999 })).rejects.toBeInstanceOf(
      FrozenError,
    );
    await expect(repo.delete(String(posted._id))).rejects.toBeInstanceOf(FrozenError);
    await expect(
      repo.claimVersion(String(posted._id), { from: 0 }, { $set: { amount: 999 } }),
    ).rejects.toBeInstanceOf(FrozenError);
    const fresh = await repo.getById(String(posted._id));
    expect(fresh!.amount).toBe(100);
  });

  it('internal flag (engine verbs) passes the guard', async () => {
    const posted = await mk('posted');
    const updated = await repo.update(String(posted._id), { amount: 200 }, {
      _ledgerInternal: 'unpost',
    } as never);
    expect(updated!.amount).toBe(200);
  });

  it('CLOSED HOLE: findOneAndUpdate on a frozen row refuses', async () => {
    const posted = await mk('posted');
    await expect(
      repo.findOneAndUpdate({ _id: posted._id }, { $set: { amount: 999 } }),
    ).rejects.toBeInstanceOf(FrozenError);
  });

  it('CLOSED HOLE: updateMany/deleteMany refuse when ANY frozen row matches, work when none does', async () => {
    await mk('draft');
    await mk('posted');
    // Blast radius includes a posted row → refused wholesale (never a
    // silent partial application).
    await expect(
      repo.updateMany({ organizationId: 'org1' }, { $set: { amount: 1 } }),
    ).rejects.toBeInstanceOf(FrozenError);
    // Draft-only blast radius → allowed.
    const res = await repo.updateMany(
      { organizationId: 'org1', state: 'draft' },
      { $set: { amount: 1 } },
    );
    expect(res).toBeTruthy();
  });

  it('CLOSED HOLE: bulkWrite refused unless internal-flagged', async () => {
    const BulkModel = await createTestModel(
      'ImmutableBulk',
      new Schema<IEntry>({
        organizationId: String,
        state: { type: String, required: true },
        amount: Number,
      }),
    );
    const bulkRepo = new Repository<IEntry>(BulkModel, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      immutableStatesPlugin({
        states: ['posted'],
        errorFactory: ({ id }) => new FrozenError(id),
      }),
    ]) as Repository<IEntry> & {
      bulkWrite(ops: unknown[], opts?: unknown): Promise<unknown>;
    };
    await expect(
      bulkRepo.bulkWrite([
        { updateOne: { filter: { state: 'posted' }, update: { $set: { amount: 1 } } } },
      ]),
    ).rejects.toBeInstanceOf(FrozenError);
  });

  it('claim leaving a frozen state refuses; non-frozen claims pass zero-IO', async () => {
    const posted = await mk('posted');
    const draft = await mk('draft');
    // draft → posted (posting) is fine — from is not frozen.
    const postedNow = await repo.claim(String(draft._id), {
      field: 'state',
      from: 'draft',
      to: 'posted',
    });
    expect(postedNow!.state).toBe('posted');
    // posted → draft (unposting) via direct claim: refused.
    await expect(
      repo.claim(String(posted._id), { field: 'state', from: 'posted', to: 'draft' }),
    ).rejects.toBeInstanceOf(FrozenError);
    // Multi-source including a frozen state: refused.
    await expect(
      repo.claim(String(posted._id), {
        field: 'state',
        from: ['draft', 'posted'],
        to: 'archived',
      }),
    ).rejects.toBeInstanceOf(FrozenError);
  });

  it('allowClaim exempts the reverse-mark fingerprint ONLY', async () => {
    const posted = await mk('posted');
    // Exact fingerprint → allowed.
    const marked = await repo.claim(
      String(posted._id),
      {
        field: 'state',
        from: 'posted',
        to: 'posted',
        where: { reversed: { $ne: true } },
      },
      { $set: { reversed: true } },
    );
    expect(marked!.reversed).toBe(true);
    // Same shape but arbitrary stamp → refused.
    const posted2 = await mk('posted');
    await expect(
      repo.claim(
        String(posted2._id),
        { field: 'state', from: 'posted', to: 'posted', where: { reversed: { $ne: true } } },
        { $set: { amount: 999 } },
      ),
    ).rejects.toBeInstanceOf(FrozenError);
  });

  it('CLOSED HOLE: a claim on a DIFFERENT field cannot mutate a frozen row', async () => {
    const posted = await mk('posted');
    await EntryModel.updateOne({ _id: posted._id }, { $set: { phase: 'a' } });
    await expect(
      repo.claim(
        String(posted._id),
        { field: 'phase', from: 'a', to: 'b' },
        { $set: { amount: 999 } },
      ),
    ).rejects.toBeInstanceOf(FrozenError);
    // Same different-field claim on a DRAFT row works.
    const draft = await mk('draft');
    await EntryModel.updateOne({ _id: draft._id }, { $set: { phase: 'a' } });
    const moved = await repo.claim(String(draft._id), { field: 'phase', from: 'a', to: 'b' });
    expect(moved!.phase).toBe('b');
  });

  it('default error is 403 IMMUTABLE_STATE_VIOLATION when no errorFactory given', async () => {
    const PlainModel = await createTestModel(
      'ImmutablePlain',
      new Schema<IEntry>({
        organizationId: String,
        state: { type: String, required: true },
        amount: Number,
      }),
    );
    const plain = new Repository<IEntry>(PlainModel, [
      immutableStatesPlugin({ states: ['posted'] }),
    ]);
    const posted = await plain.create({ organizationId: 'o', state: 'posted', amount: 1 });
    const err = (await plain
      .update(String(posted._id), { amount: 2 })
      .catch((e: unknown) => e)) as Error & { status?: number; code?: string };
    expect(err.status).toBe(403);
    expect(err.code).toBe('IMMUTABLE_STATE_VIOLATION');
  });
});
