/**
 * `Repository.claimVersion()` — optimistic-concurrency CAS via version
 * stamp. Sibling to `claim()` (status state-machine CAS); same null-on-
 * race semantics, different mental model.
 *
 * Filed-grade pattern: 10+ call sites across `@classytic/order`,
 * `@classytic/leave`, `@classytic/payrun` doing the same
 * `findOneAndUpdate({ _id, version: N }, { ..., $inc: { version: 1 } })`
 * dance. This primitive replaces them.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOrder {
  _id?: mongoose.Types.ObjectId;
  status: string;
  version: number;
  total?: number;
}

describe('Repository.claimVersion — optimistic-concurrency CAS', () => {
  let Model: mongoose.Model<IOrder>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'ClaimVersionOrder',
      new Schema<IOrder>({
        status: { type: String, required: true },
        version: { type: Number, required: true, default: 0 },
        total: Number,
      }),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  it('applies update + auto-bumps version on match', async () => {
    const repo = new Repository<IOrder>(Model);
    const created = await repo.create({ status: 'draft', version: 0 });

    const result = await repo.claimVersion(
      String(created._id),
      { from: 0 },
      { $set: { status: 'submitted' } },
    );
    expect(result?.status).toBe('submitted');
    expect(result?.version).toBe(1);
  });

  it('returns null when version does not match (race-loss signal)', async () => {
    const repo = new Repository<IOrder>(Model);
    const created = await repo.create({ status: 'draft', version: 5 });

    const result = await repo.claimVersion(
      String(created._id),
      { from: 4 },  // wrong version
      { $set: { status: 'submitted' } },
    );
    expect(result).toBeNull();

    // Doc unchanged.
    const reread = await repo.getById(String(created._id));
    expect(reread?.status).toBe('draft');
    expect(reread?.version).toBe(5);
  });

  it('returns null on missing id', async () => {
    const repo = new Repository<IOrder>(Model);
    const fakeId = new mongoose.Types.ObjectId();
    expect(
      await repo.claimVersion(String(fakeId), { from: 0 }, { $set: { status: 'x' } }),
    ).toBeNull();
  });

  it('accepts field-shape update (auto-wraps in $set)', async () => {
    const repo = new Repository<IOrder>(Model);
    const created = await repo.create({ status: 'draft', version: 0, total: 100 });

    const result = await repo.claimVersion(
      String(created._id),
      { from: 0 },
      { status: 'submitted', total: 150 },  // field-shape, no $set wrapper
    );
    expect(result?.status).toBe('submitted');
    expect(result?.total).toBe(150);
    expect(result?.version).toBe(1);
  });

  it('rejects mixed operator + field shapes loudly', async () => {
    const repo = new Repository<IOrder>(Model);
    const created = await repo.create({ status: 'draft', version: 0 });

    await expect(
      repo.claimVersion(
        String(created._id),
        { from: 0 },
        { $set: { total: 100 }, status: 'submitted' } as Record<string, unknown>,
      ),
    ).rejects.toThrow(/mixes Mongo operators.*with raw field keys/);
  });

  it('honors a custom `field` and `by` step', async () => {
    interface ICustom {
      _id?: mongoose.Types.ObjectId;
      name: string;
      rev: number;
    }
    if (mongoose.models.ClaimVersionCustom) delete mongoose.models.ClaimVersionCustom;
    const CustomModel = mongoose.model<ICustom>(
      'ClaimVersionCustom',
      new Schema<ICustom>({ name: String, rev: { type: Number, default: 0 } }),
    );
    await CustomModel.init();
    const customRepo = new Repository<ICustom>(CustomModel);
    const created = await customRepo.create({ name: 'A', rev: 12 });

    const result = await customRepo.claimVersion(
      String(created._id),
      { field: 'rev', from: 12, by: 5 },
      { $set: { name: 'B' } },
    );
    expect(result?.rev).toBe(17);  // 12 + 5
    expect(result?.name).toBe('B');

    await CustomModel.deleteMany({});
  });

  it('merges caller $inc with the version $inc instead of overwriting', async () => {
    interface IWithCounter {
      _id?: mongoose.Types.ObjectId;
      version: number;
      reads: number;
    }
    if (mongoose.models.ClaimVersionCounter) delete mongoose.models.ClaimVersionCounter;
    const CtrModel = mongoose.model<IWithCounter>(
      'ClaimVersionCounter',
      new Schema<IWithCounter>({
        version: { type: Number, default: 0 },
        reads: { type: Number, default: 0 },
      }),
    );
    await CtrModel.init();
    const ctrRepo = new Repository<IWithCounter>(CtrModel);
    const created = await ctrRepo.create({ version: 0, reads: 0 });

    const result = await ctrRepo.claimVersion(
      String(created._id),
      { from: 0 },
      { $inc: { reads: 1 } },  // caller $inc must coexist with version $inc
    );
    expect(result?.version).toBe(1);
    expect(result?.reads).toBe(1);

    await CtrModel.deleteMany({});
  });

  it('is race-safe — exactly one of N concurrent claimers wins', async () => {
    const repo = new Repository<IOrder>(Model);
    const created = await repo.create({ status: 'draft', version: 0 });
    const id = String(created._id);

    const claimers = await Promise.all(
      Array.from({ length: 10 }, () =>
        repo.claimVersion(id, { from: 0 }, { $set: { status: 'submitted' } }),
      ),
    );

    const winners = claimers.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.version).toBe(1);
  });

  describe('compound CAS via `transition.where`', () => {
    // Yard's transition() pattern: { _id, status, version } — state +
    // version both must match. Without `where`, callers were forced
    // back to raw findOneAndUpdate to keep the status guard.

    it('AND-merges status guard alongside version match', async () => {
      const repo = new Repository<IOrder>(Model);
      // Two docs both at version 0, different statuses.
      const queued = await repo.create({ status: 'queued', version: 0 });
      const inProgress = await repo.create({ status: 'in-progress', version: 0 });

      // Caller wants: bump version AND require status === 'queued'.
      // Doc that's already in-progress must NOT be claimed.
      const wrongStatus = await repo.claimVersion(
        String(inProgress._id),
        { from: 0, where: { status: 'queued' } },
        { $set: { status: 'in-progress', startedAt: new Date() } },
      );
      expect(wrongStatus).toBeNull();
      // Doc unchanged.
      const reread = await repo.getById(String(inProgress._id));
      expect(reread?.version).toBe(0);

      // Doc that IS queued — claim succeeds.
      const ok = await repo.claimVersion(
        String(queued._id),
        { from: 0, where: { status: 'queued' } },
        { $set: { status: 'in-progress' } },
      );
      expect(ok?.status).toBe('in-progress');
      expect(ok?.version).toBe(1);
    });

    it('canonical version key dominates duplicates in `where`', async () => {
      // Defensive: if a caller accidentally puts `version` in `where`
      // with a different value, the canonical `[versionField]: from`
      // spread last must win — same defensive contract as `claim`.
      const repo = new Repository<IOrder>(Model);
      const created = await repo.create({ status: 'draft', version: 7 });

      const result = await repo.claimVersion(
        String(created._id),
        {
          from: 7,
          where: { version: 999 }, // wiring bug — should be ignored
        },
        { $set: { status: 'submitted' } },
      );
      expect(result?.status).toBe('submitted');
      expect(result?.version).toBe(8);
    });
  });

  describe('`from: undefined` tolerance — first-write CAS on lean docs', () => {
    // Lean reads return version: number | undefined when the field is
    // missing on a fresh-from-mongo POJO. Forcing `?? 0` at every site
    // is the kind of friction that erodes adoption. Tolerating
    // undefined matches docs whose version field is null OR missing —
    // the safe first-write semantics callers actually want.

    it('matches docs whose version field is missing entirely', async () => {
      // Insert without setting version (bypass the model's default).
      const fresh = await Model.collection.insertOne({
        status: 'draft',
        createdAt: new Date(),
      });
      const id = String(fresh.insertedId);

      const repo = new Repository<IOrder>(Model);
      const result = await repo.claimVersion(
        id,
        { from: undefined },
        { $set: { status: 'submitted' } },
      );
      expect(result).not.toBeNull();
      expect(result?.status).toBe('submitted');
      expect(result?.version).toBe(1); // 0 + 1 (from undefined → first write)
    });

    it('matches docs whose version field is explicitly null', async () => {
      const inserted = await Model.collection.insertOne({
        status: 'draft',
        version: null,
      });
      const id = String(inserted.insertedId);

      const repo = new Repository<IOrder>(Model);
      const result = await repo.claimVersion(
        id,
        { from: undefined },
        { $set: { status: 'submitted' } },
      );
      expect(result?.status).toBe('submitted');
    });

    it('does NOT match docs with a numeric version (0, 1, ...)', async () => {
      // `from: undefined` is for first-write only. A doc that's already
      // versioned should NOT match — that would be a CAS escape hatch.
      const repo = new Repository<IOrder>(Model);
      const created = await repo.create({ status: 'draft', version: 0 });

      const result = await repo.claimVersion(
        String(created._id),
        { from: undefined },
        { $set: { status: 'submitted' } },
      );
      expect(result).toBeNull();
    });
  });

  describe('first-write CAS — version-field collision protection', () => {
    // When `from === undefined`, the version is initialized via $set
    // (since $inc can't apply to null). If the caller's update ALSO
    // writes the version field (in $set OR $inc), the implicit init
    // would silently fight the caller's value. Throw loudly.

    it('throws when caller $set includes the version field on first-write CAS', async () => {
      const repo = new Repository<IOrder>(Model);

      const inserted = await Model.collection.insertOne({
        status: 'draft',
      });
      const id = String(inserted.insertedId);

      let caught: Error | undefined;
      try {
        await repo.claimVersion(
          id,
          { from: undefined },
          { $set: { status: 'submitted', version: 99 } },
        );
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught?.message).toMatch(/first-write CAS/);
      expect(caught?.message).toMatch(/version/);
      // The message points at both fix paths (remove from $set, OR
      // pass numeric `from`) so the caller doesn't have to read the
      // source.
      expect(caught?.message).toMatch(/remove.*from your \$set|pass a numeric.*from/);
    });

    it('throws when caller $inc includes the version field on first-write CAS', async () => {
      const repo = new Repository<IOrder>(Model);

      const inserted = await Model.collection.insertOne({
        status: 'draft',
      });
      const id = String(inserted.insertedId);

      let caught: Error | undefined;
      try {
        await repo.claimVersion(
          id,
          { from: undefined },
          { $inc: { version: 1 } }, // would coexist-with-$set conflict
        );
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught?.message).toMatch(/first-write CAS/);
      expect(caught?.message).toMatch(/can't coexist with \$inc/);
    });

    it('first-write CAS still works when caller does NOT touch the version field', async () => {
      const repo = new Repository<IOrder>(Model);

      const inserted = await Model.collection.insertOne({
        status: 'draft',
      });
      const id = String(inserted.insertedId);

      const result = await repo.claimVersion(
        id,
        { from: undefined },
        { $set: { status: 'submitted' } }, // no version field — fine
      );

      expect(result?.status).toBe('submitted');
      expect(result?.version).toBe(1);
    });

    it('numeric `from` path is unaffected (caller can $inc the version freely)', async () => {
      const repo = new Repository<IOrder>(Model);
      const created = await repo.create({ status: 'draft', version: 5 });

      // With numeric `from`, the $inc path is canonical — caller can
      // pass additional $inc fields, version bump merges in.
      const result = await repo.claimVersion(
        String(created._id),
        { from: 5 },
        { $set: { status: 'submitted' } },
      );
      expect(result?.version).toBe(6);
    });
  });

  it('returns null on a structurally invalid id (parity with claim/getById)', async () => {
    const repo = new Repository<IOrder>(Model);
    const result = await repo.claimVersion(
      'bad-id-not-an-objectid',
      { from: 0 },
      { $set: { status: 'x' } },
    );
    expect(result).toBeNull();
  });
});
