/**
 * `Repository.applyTransition(id, machine, args)` — state-machine-backed CAS
 * with status history and accurate race-loss diagnosis. The promoted
 * form of the `claimTransition` helper every engine package hand-rolled.
 *
 * The machine param is structural ({ name, assertTransition }) — these
 * tests use a hand-built machine, proving no primitives import is
 * needed.
 */

import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository, type TransitionMachine } from '../../src/index.js';
import { toPlain } from '../../src/utils/to-plain.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IWo {
  _id?: mongoose.Types.ObjectId;
  status: 'draft' | 'planned' | 'released' | 'completed' | 'cancelled';
  statusHistory: Array<{ status: string; occurredAt: Date; by?: string; note?: string }>;
  trail?: Array<{ status: string; occurredAt: Date }>;
  producedQuantity?: number;
  lines?: Array<{ sku: string; qty: number }>;
}

class IllegalMove extends Error {
  readonly code = 'wo.invalid_transition';
  constructor(
    readonly entityId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`wo ${entityId}: ${from} → ${to} illegal`);
  }
}

const TABLE: Record<string, readonly string[]> = {
  draft: ['planned', 'cancelled'],
  planned: ['released', 'cancelled'],
  released: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const MACHINE: TransitionMachine = {
  name: 'work_order',
  assertTransition(entityId, from, to) {
    if (!TABLE[from]?.includes(to)) throw new IllegalMove(entityId, from, to);
  },
};

describe('Repository.applyTransition — machine-backed CAS + history', () => {
  let WoModel: mongoose.Model<IWo>;
  let repo: Repository<IWo>;

  beforeAll(async () => {
    await connectDB();
    WoModel = await createTestModel(
      'TransitionWo',
      new Schema<IWo>({
        status: { type: String, required: true },
        statusHistory: {
          type: [
            new Schema(
              { status: String, occurredAt: Date, by: String, note: String },
              { _id: false },
            ),
          ],
          default: [],
        },
        trail: {
          type: [new Schema({ status: String, occurredAt: Date }, { _id: false })],
          default: undefined,
        },
        producedQuantity: Number,
        lines: {
          type: [new Schema({ sku: String, qty: Number }, { _id: false })],
          default: undefined,
        },
      }),
    );
    repo = new Repository<IWo>(WoModel);
  });
  afterAll(async () => {
    await disconnectDB();
  });

  const mk = (status: IWo['status'] = 'draft') =>
    repo.create({ status, statusHistory: [{ status, occurredAt: new Date() }] });

  it('happy path: CAS + $set + history append with by/note', async () => {
    const wo = await mk('draft');
    const updated = await repo.applyTransition(String(wo._id), MACHINE, {
      from: 'draft',
      to: 'planned',
      set: { producedQuantity: 0 },
      by: 'tester',
      note: 'plan it',
    });
    expect(updated.status).toBe('planned');
    expect(updated.producedQuantity).toBe(0);
    expect(updated.statusHistory).toHaveLength(2);
    const last = updated.statusHistory.at(-1)!;
    expect(last).toMatchObject({ status: 'planned', by: 'tester', note: 'plan it' });
    expect(last.occurredAt).toBeInstanceOf(Date);
  });

  it('illegal move throws the MACHINE error pre-flight (no write)', async () => {
    const wo = await mk('completed');
    await expect(
      repo.applyTransition(String(wo._id), MACHINE, { from: 'completed', to: 'released' }),
    ).rejects.toBeInstanceOf(IllegalMove);
    const fresh = await repo.getById(String(wo._id));
    expect(fresh!.statusHistory).toHaveLength(1); // untouched
  });

  it('race-loss where CURRENT state forbids the move → machine error with ACCURATE from', async () => {
    const wo = await mk('planned');
    // Simulate a racer: doc reaches terminal `cancelled` after our pre-read.
    await repo.claim(String(wo._id), { from: 'planned', to: 'cancelled' });
    // Caller still believes it's `planned` and asks planned → released
    // (legal per the table). CAS misses; diagnosis re-reads and throws
    // the machine's error with from='cancelled', not the stale 'planned'.
    const err = await repo
      .applyTransition(String(wo._id), MACHINE, { from: 'planned', to: 'released' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IllegalMove);
    expect((err as IllegalMove).from).toBe('cancelled');
  });

  it('race-loss where the move is STILL legal → 409 TRANSITION_RACE_LOST', async () => {
    const wo = await mk('draft');
    // Racer moves draft → planned; caller asks draft → cancelled.
    // cancelled is ALSO legal from planned, so this is a pure race.
    await repo.claim(String(wo._id), { from: 'draft', to: 'planned' });
    const err = (await repo
      .applyTransition(String(wo._id), MACHINE, { from: 'draft', to: 'cancelled' })
      .catch((e: unknown) => e)) as Error & { status?: number; code?: string };
    expect(err.status).toBe(409);
    expect(err.code).toBe('TRANSITION_RACE_LOST');
  });

  it('missing row → 404 TRANSITION_TARGET_MISSING', async () => {
    const ghost = new mongoose.Types.ObjectId();
    const err = (await repo
      .applyTransition(String(ghost), MACHINE, { from: 'draft', to: 'planned' })
      .catch((e: unknown) => e)) as Error & { status?: number; code?: string };
    expect(err.status).toBe(404);
    expect(err.code).toBe('TRANSITION_TARGET_MISSING');
  });

  it('multi-source from (array) + custom history field + extra push merge', async () => {
    const wo = await mk('released');
    const updated = await repo.applyTransition(String(wo._id), MACHINE, {
      from: ['draft', 'planned', 'released'],
      to: 'cancelled',
      history: 'trail',
      push: { statusHistory: { status: 'x-extra', occurredAt: new Date() } },
    });
    expect(updated.status).toBe('cancelled');
    expect(updated.trail).toHaveLength(1);
    expect(updated.trail![0]!.status).toBe('cancelled');
    // Caller's own $push entry merged alongside.
    expect(updated.statusHistory.at(-1)!.status).toBe('x-extra');
  });

  it('re-claim semantics: from-members equal to `to` skip table assertion (idempotent re-entry)', async () => {
    // The table has NO planned → planned edge, yet a multi-source CAS
    // including the target state is the documented re-claim idiom
    // (revenue's re-match, flow's reverse-mark): asserting it against
    // the transition table would be a category error.
    const wo = await mk('planned');
    const restamped = await repo.applyTransition(String(wo._id), MACHINE, {
      from: ['draft', 'planned'],
      to: 'planned',
      set: { producedQuantity: 7 },
      history: false,
    });
    expect(restamped.status).toBe('planned');
    expect(restamped.producedQuantity).toBe(7);
  });

  it('re-claim diagnosis: row already AT target + where-guard miss → 409, never a bogus to→to table error', async () => {
    const wo = await mk('planned');
    const err = (await repo
      .applyTransition(String(wo._id), MACHINE, {
        from: ['draft', 'planned'],
        to: 'planned',
        where: { producedQuantity: 999 }, // guard that cannot match
        set: { producedQuantity: 1 },
        history: false,
      })
      .catch((e: unknown) => e)) as Error & { status?: number; code?: string };
    expect(err.status).toBe(409);
    expect(err.code).toBe('TRANSITION_RACE_LOST');
  });

  it('history: false skips the append', async () => {
    const wo = await mk('draft');
    const updated = await repo.applyTransition(String(wo._id), MACHINE, {
      from: 'draft',
      to: 'planned',
      history: false,
    });
    expect(updated.status).toBe('planned');
    expect(updated.statusHistory).toHaveLength(1);
  });
});

describe('toPlain — spread-safety for hydrated subdocuments', () => {
  let WoModel: mongoose.Model<IWo>;
  let repo: Repository<IWo>;

  beforeAll(async () => {
    await connectDB();
    WoModel = await createTestModel(
      'ToPlainWo',
      new Schema<IWo>({
        status: { type: String, required: true },
        statusHistory: { type: [new Schema({ status: String, occurredAt: Date }, { _id: false })], default: [] },
        lines: {
          type: [new Schema({ sku: String, qty: Number }, { _id: false })],
          default: undefined,
        },
      }),
    );
    repo = new Repository<IWo>(WoModel);
  });

  it('spreading a hydrated subdoc loses schema fields; toPlain preserves them', async () => {
    const wo = await repo.create({
      status: 'draft',
      statusHistory: [],
      lines: [{ sku: 'LEG', qty: 4 }],
    });
    const line = wo.lines![0]!;
    const naive = { ...line, qty: 9 };
    const safe = { ...toPlain(line), qty: 9 };
    // The naive spread drops the schema field (Mongoose internals only).
    expect((naive as { sku?: string }).sku).toBeUndefined();
    expect(safe.sku).toBe('LEG');
    expect(safe.qty).toBe(9);
  });

  it('passes non-documents through unchanged', () => {
    expect(toPlain(null)).toBeNull();
    expect(toPlain(undefined)).toBeUndefined();
    expect(toPlain({ a: 1 })).toEqual({ a: 1 });
    expect(toPlain('x')).toBe('x');
  });
});
