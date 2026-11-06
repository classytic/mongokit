/**
 * `applyTransition` — `priorAt` (durationInPriorMs without a pre-read) and
 * `historyExtra` (extra fields on the history entry).
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type TransitionMachine } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IAlert {
  _id?: mongoose.Types.ObjectId;
  status: string;
  statusHistory: Array<Record<string, unknown>>;
  updatedAt?: Date;
}

const TABLE: Record<string, readonly string[]> = {
  NEW: ['DISPATCHED'],
  DISPATCHED: ['DELIVERED'],
  DELIVERED: [],
};
const MACHINE: TransitionMachine = {
  name: 'alert',
  assertTransition(id, from, to) {
    if (!TABLE[from]?.includes(to)) throw new Error(`${id}: ${from} -> ${to} illegal`);
  },
};

describe('applyTransition — priorAt / historyExtra', () => {
  let repo: Repository<IAlert>;
  const T0 = new Date('2026-10-30T08:00:00.000Z');

  beforeAll(async () => {
    await connectDB();
    const Model = await createTestModel(
      'TransitionHistoryExtras',
      new Schema<IAlert>(
        {
          status: { type: String, required: true },
          statusHistory: {
            type: [
              new Schema(
                {
                  status: String,
                  occurredAt: Date,
                  by: String,
                  note: String,
                  durationInPriorMs: Number,
                  device: String,
                },
                { _id: false },
              ),
            ],
            default: [],
          },
        },
        { timestamps: true },
      ),
    );
    repo = new Repository<IAlert>(Model);
  });
  afterAll(async () => {
    await disconnectDB();
  });

  const mk = () =>
    repo.create({ status: 'NEW', statusHistory: [{ status: 'NEW', occurredAt: T0 }] });

  it('writes durationInPriorMs = at - priorAt, and stores historyExtra', async () => {
    const a = await mk();
    const out = await repo.applyTransition(String(a._id), MACHINE, {
      from: 'NEW',
      to: 'DISPATCHED',
      at: new Date(T0.getTime() + 4_500),
      priorAt: T0,
      historyExtra: { device: 'cab-7' },
      by: 'u1',
    });
    const last = out.statusHistory.at(-1)!;
    expect(last).toMatchObject({
      status: 'DISPATCHED',
      by: 'u1',
      durationInPriorMs: 4_500,
      device: 'cab-7',
    });
  });

  it('clamps a negative duration to 0', async () => {
    const a = await mk();
    const out = await repo.applyTransition(String(a._id), MACHINE, {
      from: 'NEW',
      to: 'DISPATCHED',
      at: T0,
      priorAt: new Date(T0.getTime() + 10_000),
    });
    expect(out.statusHistory.at(-1)?.durationInPriorMs).toBe(0);
  });

  it('pairs with a where guard on updatedAt (stale read misses with 409)', async () => {
    const a = await mk();
    const staleUpdatedAt = new Date(0);
    await expect(
      repo.applyTransition(String(a._id), MACHINE, {
        from: 'NEW',
        to: 'DISPATCHED',
        priorAt: T0,
        where: { updatedAt: staleUpdatedAt },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('400 on reserved historyExtra keys, on history: false, and on an invalid priorAt', async () => {
    const a = await mk();
    const id = String(a._id);
    await expect(
      repo.applyTransition(id, MACHINE, {
        from: 'NEW',
        to: 'DISPATCHED',
        historyExtra: { status: 'X' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repo.applyTransition(id, MACHINE, {
        from: 'NEW',
        to: 'DISPATCHED',
        history: false,
        priorAt: T0,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repo.applyTransition(id, MACHINE, {
        from: 'NEW',
        to: 'DISPATCHED',
        priorAt: new Date('bad'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    // An invalid `at` with priorAt would store NaN as the duration.
    await expect(
      repo.applyTransition(id, MACHINE, {
        from: 'NEW',
        to: 'DISPATCHED',
        priorAt: T0,
        at: new Date('bad'),
      }),
    ).rejects.toMatchObject({ status: 400 });
    // null / array historyExtra is a 400, not a TypeError.
    for (const bad of [null, ['x']]) {
      await expect(
        repo.applyTransition(id, MACHINE, {
          from: 'NEW',
          to: 'DISPATCHED',
          historyExtra: bad as unknown as Record<string, unknown>,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    // Nothing was written by the refused calls.
    expect((await repo.getById(id))?.status).toBe('NEW');
  });

  it('omitting both leaves the entry exactly { status, occurredAt, by?, note? }', async () => {
    const a = await mk();
    const out = await repo.applyTransition(String(a._id), MACHINE, {
      from: 'NEW',
      to: 'DISPATCHED',
      at: T0,
      by: 'u1',
    });
    const raw = await repo.Model.collection.findOne({ _id: out._id });
    const entry = (raw?.statusHistory as Record<string, unknown>[]).at(-1);
    expect(Object.keys(entry ?? {})).toEqual(['status', 'occurredAt', 'by']);
  });
});
