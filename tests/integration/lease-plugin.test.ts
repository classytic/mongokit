/**
 * `leasePlugin()` — distributed FIFO claim-lease primitive.
 *
 * Standardises the pattern five repos hand-rolled (outbox relays, flow
 * waves, promo pending-evaluation, fulfillment retry, cart idempotency):
 * atomic claim with dead-lease recovery, lease extension, and release.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { type LeaseMethods, leasePlugin, methodRegistryPlugin } from '../../src/plugins/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOutbox {
  _id?: mongoose.Types.ObjectId;
  status: string;
  payload: string;
  createdAt: Date;
  leasedBy?: string;
  leaseExpiresAt?: Date | null;
}

type OutboxRepo = Repository<IOutbox> & LeaseMethods<IOutbox>;

describe('leasePlugin — FIFO claim / extend / release', () => {
  let Model: mongoose.Model<IOutbox>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'LeaseOutbox',
      new Schema<IOutbox>({
        status: { type: String, required: true },
        payload: { type: String, required: true },
        createdAt: { type: Date, default: () => new Date() },
        leasedBy: String,
        leaseExpiresAt: Date,
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

  function makeRepo(): OutboxRepo {
    return new Repository<IOutbox>(Model, [methodRegistryPlugin(), leasePlugin()]) as OutboxRepo;
  }

  describe('lease()', () => {
    it('claims the oldest pending row (FIFO)', async () => {
      const repo = makeRepo();
      const oldest = await repo.create({
        status: 'pending',
        payload: 'a',
        createdAt: new Date('2026-01-01'),
      });
      await repo.create({ status: 'pending', payload: 'b', createdAt: new Date('2026-02-01') });
      await repo.create({ status: 'pending', payload: 'c', createdAt: new Date('2026-03-01') });

      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-1' });
      expect(claimed?._id?.toString()).toBe(oldest._id?.toString());
      expect(claimed?.status).toBe('processing');
      expect(claimed?.leasedBy).toBe('worker-1');
      expect(claimed?.leaseExpiresAt).toBeInstanceOf(Date);
    });

    it('returns null when nothing is leasable', async () => {
      const repo = makeRepo();
      // Only 'done' rows — none claimable.
      await repo.create({ status: 'done', payload: 'a' });

      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-1' });
      expect(claimed).toBeNull();
    });

    it('recovers a dead lease (leaseExpiresAt < now) via the same call', async () => {
      const repo = makeRepo();
      const stale = await repo.create({
        status: 'processing',
        payload: 'crashed',
        leasedBy: 'crashed-worker',
        leaseExpiresAt: new Date(Date.now() - 60_000), // expired 1m ago
      });

      const recovered = await repo.lease({ leaseFor: 30_000, leasedBy: 'worker-2' });
      expect(recovered?._id?.toString()).toBe(stale._id?.toString());
      expect(recovered?.leasedBy).toBe('worker-2');
      // Lease expiry is in the future now.
      expect((recovered?.leaseExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('honors a caller-supplied filter (e.g. payload-stream scoping)', async () => {
      const repo = makeRepo();
      // Two pending rows with different payloads. The filter narrows to one.
      await repo.create({ status: 'pending', payload: 'wrong-stream' });
      const right = await repo.create({ status: 'pending', payload: 'right-stream' });

      const claimed = await repo.lease({
        filter: { payload: 'right-stream' },
        leaseFor: 30_000,
        leasedBy: 'worker-1',
      });
      expect(claimed?._id?.toString()).toBe(right._id?.toString());
    });

    it('rejects invalid leaseFor / leasedBy', async () => {
      const repo = makeRepo();
      await expect(repo.lease({ leaseFor: 0, leasedBy: 'w' })).rejects.toThrow(/positive number/);
      await expect(repo.lease({ leaseFor: -5, leasedBy: 'w' })).rejects.toThrow(/positive number/);
      await expect(repo.lease({ leaseFor: 30_000, leasedBy: '' })).rejects.toThrow(
        /non-empty string/,
      );
    });

    it('is race-safe — exactly one of N concurrent leasers wins one row', async () => {
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'only-one' });

      const claimers = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.lease({ leaseFor: 30_000, leasedBy: `worker-${i}` }),
        ),
      );

      expect(claimers.filter((r) => r !== null)).toHaveLength(1);
    });
  });

  describe('extend()', () => {
    it('pushes leaseExpiresAt further when the lease is still ours', async () => {
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'p' });
      const claimed = await repo.lease({ leaseFor: 5_000, leasedBy: 'w-1' });
      const originalExpiry = (claimed?.leaseExpiresAt as Date).getTime();

      await new Promise((r) => setTimeout(r, 30));
      const extended = await repo.extend(String(claimed?._id), {
        leasedBy: 'w-1',
        leaseFor: 30_000,
      });
      expect(extended).not.toBeNull();
      expect((extended?.leaseExpiresAt as Date).getTime()).toBeGreaterThan(originalExpiry);
    });

    it('returns null when the lease is held by someone else', async () => {
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'p' });
      const claimed = await repo.lease({ leaseFor: 5_000, leasedBy: 'w-1' });

      // Someone else (w-2) tries to extend w-1's lease — must fail.
      const result = await repo.extend(String(claimed?._id), {
        leasedBy: 'w-2',
        leaseFor: 30_000,
      });
      expect(result).toBeNull();
    });

    it('returns null when the lease has already expired', async () => {
      const repo = makeRepo();
      // Manually create with expired lease.
      const created = await Model.create({
        status: 'processing',
        payload: 'p',
        leasedBy: 'w-1',
        leaseExpiresAt: new Date(Date.now() - 1000),
      });

      // Even the original holder can't extend after expiry — by design,
      // ensures dead-lease recovery semantics aren't bypassed.
      const result = await repo.extend(String(created._id), {
        leasedBy: 'w-1',
        leaseFor: 30_000,
      });
      expect(result).toBeNull();
    });

    it('rejects invalid leaseFor', async () => {
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'p' });
      const claimed = await repo.lease({ leaseFor: 5_000, leasedBy: 'w-1' });

      await expect(
        repo.extend(String(claimed?._id), { leasedBy: 'w-1', leaseFor: 0 }),
      ).rejects.toThrow(/positive number/);
    });
  });

  describe('release()', () => {
    it('marks the row as done and clears the lease fields', async () => {
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'p' });
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });

      const released = await repo.release(String(claimed?._id), { leasedBy: 'w-1' });
      expect(released?.status).toBe('done');
      expect(released?.leasedBy).toBeUndefined();
      expect(released?.leaseExpiresAt).toBeUndefined();
    });

    it('uses a custom finalStatus (e.g. failed) for error paths', async () => {
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'p' });
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });

      const failed = await repo.release(String(claimed?._id), {
        leasedBy: 'w-1',
        finalStatus: 'failed',
      });
      expect(failed?.status).toBe('failed');
      expect(failed?.leasedBy).toBeUndefined();
    });

    it('next lease() does NOT pick up a released row (final-status filter)', async () => {
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'p' });
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });
      await repo.release(String(claimed?._id), { leasedBy: 'w-1', finalStatus: 'done' });

      const next = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-2' });
      expect(next).toBeNull();
    });

    it('returns null when a different worker tries to release the lease', async () => {
      // Race scenario: w-1 holds the lease; w-2 tries to release it
      // (e.g. confused logic or a buggy retry). Without the CAS this
      // would silently mark w-1's in-progress work as done. With the
      // CAS, w-2 gets null and the row stays leased.
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'p' });
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });

      const result = await repo.release(String(claimed?._id), { leasedBy: 'w-2' });
      expect(result).toBeNull();

      // Row is still leased by w-1, status untouched.
      const row = await repo.getById(String(claimed?._id));
      expect(row?.status).toBe('processing');
      expect(row?.leasedBy).toBe('w-1');
    });

    it('returns null when the lease has expired (caller lost the race)', async () => {
      // Scenario: w-1 claimed but their work outlived the lease; the
      // dead-lease window opened so a recovery worker could grab it.
      // w-1 must NOT be allowed to finalise after expiry — it'd
      // overwrite whichever recovery worker now owns the row.
      const repo = makeRepo();
      const created = await Model.create({
        status: 'processing',
        payload: 'p',
        leasedBy: 'w-1',
        leaseExpiresAt: new Date(Date.now() - 1000),
      });

      const result = await repo.release(String(created._id), { leasedBy: 'w-1' });
      expect(result).toBeNull();
    });

    it('rejects release without a leasedBy', async () => {
      const repo = makeRepo();
      await repo.create({ status: 'pending', payload: 'p' });
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });

      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: probing runtime guard
        repo.release(String(claimed?._id), { leasedBy: '' as any }),
      ).rejects.toThrow(/non-empty string/);
    });
  });

  describe('configurable field names + statuses', () => {
    it('honors custom statusField / leasedByField / leaseExpiresAtField / pendingStatus', async () => {
      interface ICustomLease {
        _id?: mongoose.Types.ObjectId;
        state: string;
        lockedBy?: string;
        lockExpiresAt?: Date | null;
        createdAt: Date;
      }
      if (mongoose.models.LeaseCustom) delete mongoose.models.LeaseCustom;
      const Cust = mongoose.model<ICustomLease>(
        'LeaseCustom',
        new Schema<ICustomLease>({
          state: String,
          lockedBy: String,
          lockExpiresAt: Date,
          createdAt: { type: Date, default: () => new Date() },
        }),
      );
      await Cust.init();
      const repo = new Repository<ICustomLease>(Cust, [
        methodRegistryPlugin(),
        leasePlugin({
          statusField: 'state',
          leasedByField: 'lockedBy',
          leaseExpiresAtField: 'lockExpiresAt',
          pendingStatus: 'queued',
          processingStatus: 'running',
          doneStatus: 'finished',
        }),
      ]) as Repository<ICustomLease> & LeaseMethods<ICustomLease>;

      await repo.create({ state: 'queued', createdAt: new Date() });
      const claimed = await repo.lease({ leaseFor: 30_000, leasedBy: 'w-1' });
      expect(claimed?.state).toBe('running');
      expect(claimed?.lockedBy).toBe('w-1');

      const released = await repo.release(String(claimed?._id), { leasedBy: 'w-1' });
      expect(released?.state).toBe('finished');

      await Cust.deleteMany({});
    });
  });
});
