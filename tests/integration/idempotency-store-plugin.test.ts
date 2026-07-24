/**
 * `idempotencyStorePlugin()` — keyed exactly-once operation claims.
 *
 * Standardises the protocol four stores hand-rolled (flow's
 * MongoIdempotencyStore, cart's idempotency repository, order's
 * OrderIdempotencyRepository, be-prod's refund-operation store): atomic
 * claim-by-key with terminal-outcome replay, saga progress for crash
 * resume, bounded re-acquisition, and ambiguous-error lease lapse.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import {
  type IdempotencyStoreMethods,
  idempotencyStorePlugin,
  methodRegistryPlugin,
} from '../../src/plugins/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IOpClaim {
  _id?: mongoose.Types.ObjectId;
  key: string;
  status: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  attempts?: number;
  progress?: Record<string, unknown>;
  result?: unknown;
  failureCode?: string;
  lastError?: string;
  // Domain seed columns
  orderNumber?: string;
  amount?: number;
  createdAt?: Date;
}

type OpRepo = Repository<IOpClaim> & IdempotencyStoreMethods<Record<string, unknown>, { refundId: string }>;

describe('idempotencyStorePlugin — claim matrix / progress / terminal replay', () => {
  let Model: mongoose.Model<IOpClaim>;

  beforeAll(async () => {
    await connectDB();
    Model = await createTestModel(
      'IdemOpClaim',
      new Schema<IOpClaim>(
        {
          key: { type: String, required: true, unique: true },
          status: { type: String, required: true },
          leaseToken: String,
          leaseExpiresAt: Date,
          attempts: Number,
          progress: { type: Schema.Types.Mixed },
          result: { type: Schema.Types.Mixed },
          failureCode: String,
          lastError: String,
          orderNumber: String,
          amount: Number,
        },
        { timestamps: true },
      ),
    );
  });
  afterAll(async () => {
    await Model.deleteMany({});
    await disconnectDB();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
  });

  function makeRepo(opts?: Parameters<typeof idempotencyStorePlugin>[0]): OpRepo {
    return new Repository<IOpClaim>(Model, [
      methodRegistryPlugin(),
      idempotencyStorePlugin(opts),
    ]) as OpRepo;
  }

  it('first claim acquires; seed columns land on the row; re-claim while live is busy', async () => {
    const repo = makeRepo();
    const c1 = await repo.claimKey('op-1', { seed: { orderNumber: 'ORD-1', amount: 100 } });
    expect(c1.kind).toBe('acquired');
    if (c1.kind !== 'acquired') return;
    expect(c1.attempt).toBe(1);

    const row = await Model.findOne({ key: 'op-1' }).lean();
    expect(row?.orderNumber).toBe('ORD-1');
    expect(row?.amount).toBe(100);
    expect(row?.status).toBe('in_flight');

    const c2 = await repo.claimKey('op-1');
    expect(c2.kind).toBe('busy');
  });

  it('exactly ONE of N concurrent claimants acquires (atomic getOrCreate)', async () => {
    const repo = makeRepo();
    const claims = await Promise.all(Array.from({ length: 8 }, () => repo.claimKey('op-race')));
    const acquired = claims.filter((c) => c.kind === 'acquired');
    const busy = claims.filter((c) => c.kind === 'busy');
    expect(acquired).toHaveLength(1);
    expect(busy).toHaveLength(7);
  });

  it('completeClaim stores the result; later claims replay it without re-acquiring', async () => {
    const repo = makeRepo();
    const c1 = await repo.claimKey('op-2');
    if (c1.kind !== 'acquired') throw new Error('expected acquired');

    expect(await repo.completeClaim('op-2', c1.leaseToken, { refundId: 'ref_9' })).toBe(true);

    const replay = await repo.claimKey('op-2');
    expect(replay).toEqual({ kind: 'completed', result: { refundId: 'ref_9' } });
  });

  it('failClaim records a terminal failure; later claims replay the code', async () => {
    const repo = makeRepo();
    const c1 = await repo.claimKey('op-3');
    if (c1.kind !== 'acquired') throw new Error('expected acquired');

    expect(await repo.failClaim('op-3', c1.leaseToken, { code: 'AT_LIMIT', error: 'fully refunded' })).toBe(true);

    const replay = await repo.claimKey('op-3');
    expect(replay).toEqual({ kind: 'failed', failureCode: 'AT_LIMIT', error: 'fully refunded' });
  });

  it('expired lease re-acquires with the previous attempt`s progress (crash resume)', async () => {
    const repo = makeRepo({ defaultLeaseMs: 50 });
    const c1 = await repo.claimKey('op-4');
    if (c1.kind !== 'acquired') throw new Error('expected acquired');
    await repo.saveClaimProgress('op-4', c1.leaseToken, { externalId: 'ext_7' });

    // Lapse the lease immediately (ambiguous-error path) instead of sleeping.
    expect(await repo.expireClaim('op-4', c1.leaseToken, { error: 'ECONNRESET' })).toBe(true);

    const c2 = await repo.claimKey('op-4');
    expect(c2.kind).toBe('acquired');
    if (c2.kind !== 'acquired') return;
    expect(c2.attempt).toBe(2);
    expect(c2.progress).toEqual({ externalId: 'ext_7' });

    // The crashed holder's stale token can no longer finalise the record.
    expect(await repo.completeClaim('op-4', c1.leaseToken, { refundId: 'x' })).toBe(false);
    expect(await repo.completeClaim('op-4', c2.leaseToken, { refundId: 'ok' })).toBe(true);
  });

  it('maxAttempts bounds re-acquisition → exhausted (with progress surfaced)', async () => {
    const repo = makeRepo({ maxAttempts: 2 });
    const c1 = await repo.claimKey('op-5');
    if (c1.kind !== 'acquired') throw new Error('expected acquired');
    await repo.saveClaimProgress('op-5', c1.leaseToken, { step: 1 });
    await repo.expireClaim('op-5', c1.leaseToken);

    const c2 = await repo.claimKey('op-5'); // attempt 2 = ceiling
    expect(c2.kind).toBe('acquired');
    if (c2.kind !== 'acquired') return;
    await repo.expireClaim('op-5', c2.leaseToken);

    const c3 = await repo.claimKey('op-5');
    expect(c3).toEqual({ kind: 'exhausted', attempts: 2, progress: { step: 1 } });
  });

  it('releaseClaim deletes only the holder`s own in-flight row (retry re-executes)', async () => {
    const repo = makeRepo();
    const c1 = await repo.claimKey('op-6');
    if (c1.kind !== 'acquired') throw new Error('expected acquired');

    expect(await repo.releaseClaim('op-6', c1.leaseToken)).toBe(true);
    expect(await Model.countDocuments({ key: 'op-6' })).toBe(0);

    const c2 = await repo.claimKey('op-6');
    expect(c2.kind).toBe('acquired'); // fresh execution

    // A completed row is NEVER discarded by an error-path release.
    if (c2.kind !== 'acquired') return;
    await repo.completeClaim('op-6', c2.leaseToken, { refundId: 'r' });
    expect(await repo.releaseClaim('op-6', c2.leaseToken)).toBe(false);
    expect(await Model.countDocuments({ key: 'op-6' })).toBe(1);
  });

  it('busy surfaces persisted progress + holder token so domain layers can act on completed pivots', async () => {
    const repo = makeRepo();
    const c1 = await repo.claimKey('op-7');
    if (c1.kind !== 'acquired') throw new Error('expected acquired');
    await repo.saveClaimProgress('op-7', c1.leaseToken, { gatewayRefundId: 'g1' });

    const c2 = await repo.claimKey('op-7');
    expect(c2.kind).toBe('busy');
    if (c2.kind !== 'busy') return;
    expect(c2.progress).toEqual({ gatewayRefundId: 'g1' });
    expect(c2.leaseToken).toBe(c1.leaseToken);
  });

  it('pluggable field names — adopts an existing store`s columns without migration', async () => {
    const AltModel = await createTestModel(
      'IdemAltColumns',
      new Schema(
        {
          operationId: { type: String, required: true, unique: true },
          state: { type: String, required: true },
          holder: String,
          holderUntil: Date,
          tries: Number,
          pivot: { type: Schema.Types.Mixed },
        },
        { timestamps: true },
      ),
    );
    const repo = new Repository(AltModel, [
      methodRegistryPlugin(),
      idempotencyStorePlugin({
        keyField: 'operationId',
        statusField: 'state',
        leaseTokenField: 'holder',
        leaseExpiresAtField: 'holderUntil',
        attemptsField: 'tries',
        progressField: 'pivot',
        inFlightStatus: 'running',
        succeededStatus: 'done',
      }),
    ]) as Repository<Record<string, unknown>> & IdempotencyStoreMethods;

    const c1 = await repo.claimKey('alt-1');
    expect(c1.kind).toBe('acquired');
    if (c1.kind !== 'acquired') return;
    await repo.saveClaimProgress('alt-1', c1.leaseToken, { marker: true });
    await repo.completeClaim('alt-1', c1.leaseToken);

    const row = (await AltModel.findOne({ operationId: 'alt-1' }).lean()) as Record<string, unknown> | null;
    expect(row?.state).toBe('done');
    expect(row?.pivot).toEqual({ marker: true });
  });
});
