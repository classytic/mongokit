/**
 * `createOutboxRepository` honours the claim window a relay asks for.
 *
 * A relay adapter reads its candidates with `getAll({ filters, sort, page: 1, limit: batchSize })`.
 * Built with the generic pagination default (`maxLimit: 100`) that read was silently clamped to
 * 100, so a relay configured for `batchSize: 500` claimed 100, saw "fewer than batchSize" and
 * never ran its next pass. The outbox repository now leaves the bound to the caller's `limit`,
 * and `pagination` still lets a host set a ceiling.
 */

import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOutboxModel, createOutboxRepository } from '../../src/outbox/index.js';
import { connectDB } from '../setup.js';

const ROWS = 1200;

/** The candidate read `repositoryAsOutboxStore.claimPending` sends. */
const claimWindow = (repo: ReturnType<typeof createOutboxRepository>, limit: number) =>
  repo.getAll({
    filters: { status: 'pending', visibleAt: { $lte: new Date() } },
    sort: { createdAt: 1 },
    page: 1,
    limit,
  }) as Promise<{ data: unknown[] }>;

describe('createOutboxRepository claim window', () => {
  const collection = 'outbox_claim_window';
  const options = { collection, modelName: 'OutboxClaimWindow' };

  beforeAll(async () => {
    await connectDB();
    await createOutboxModel(mongoose.connection, options).syncIndexes();
  });
  beforeEach(async () => {
    const model = createOutboxModel(mongoose.connection, options);
    await model.deleteMany({});
    const created = new Date(Date.now() - 60_000);
    await model.insertMany(
      Array.from({ length: ROWS }, (_, i) => ({
        _id: `evt-${String(i).padStart(5, '0')}`,
        event: { type: 'thing.happened', payload: { i }, meta: { id: `evt-${i}` } },
        type: 'thing.happened',
        status: 'pending',
        visibleAt: created,
        createdAt: new Date(created.getTime() + i),
      })),
    );
  });
  afterAll(async () => {
    await createOutboxModel(mongoose.connection, options).deleteMany({});
  });

  it('returns the full batch a relay asks for (500), not the generic 100 cap', async () => {
    const repo = createOutboxRepository(mongoose.connection, options);
    const page = await claimWindow(repo, 500);
    expect(page.data).toHaveLength(500);
  });

  it('drains 1,200 pending rows in three windows of 500, 500 and 200', async () => {
    const repo = createOutboxRepository(mongoose.connection, options);
    const model = createOutboxModel(mongoose.connection, options);
    const sizes: number[] = [];
    for (let pass = 0; pass < 5; pass++) {
      const { data: docs } = await claimWindow(repo, 500);
      sizes.push(docs.length);
      if (docs.length < 500) break;
      await model.updateMany(
        { _id: { $in: (docs as Array<{ _id: string }>).map((d) => d._id) } },
        { $set: { status: 'delivered', deliveredAt: new Date() } },
      );
    }
    expect(sizes).toEqual([500, 500, 200]);
  });

  it('a read with no limit still gets the default page size', async () => {
    const repo = createOutboxRepository(mongoose.connection, options);
    const page = (await repo.getAll({ filters: { status: 'pending' }, page: 1 })) as {
      data: unknown[];
    };
    expect(page.data).toHaveLength(10);
  });

  it('`pagination.maxLimit` sets a ceiling when a host wants one', async () => {
    const repo = createOutboxRepository(mongoose.connection, {
      ...options,
      pagination: { maxLimit: 250 },
    });
    expect((await claimWindow(repo, 500)).data).toHaveLength(250);
  });
});
