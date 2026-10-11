/**
 * Nothing called on a tx-bound repository runs OUTSIDE the transaction silently: every method is
 * threaded the session, passed through for a stated reason, or refused. Real replica set.
 */

import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { methodRegistryPlugin, Repository } from '../src/index.js';
import { Repository as RepositoryClass } from '../src/Repository.js';
import { isTxClassified } from '../src/tx-bound.js';
import { connectDB, createTestModel, disconnectDB } from './setup.js';

interface ITicket {
  _id: Types.ObjectId;
  code: string;
  status: string;
}

const TicketSchema = new Schema<ITicket>({
  code: { type: String, required: true },
  status: { type: String, required: true },
});

describe('tx-bound repository — every method is classified', () => {
  let TicketModel: mongoose.Model<ITicket>;
  let repo: Repository<ITicket> & {
    registerMethod(name: string, fn: (...a: unknown[]) => unknown): void;
  };

  beforeAll(async () => {
    await connectDB();
    TicketModel = await createTestModel('TxBoundTicket', TicketSchema);
    repo = new Repository(TicketModel, [methodRegistryPlugin()]) as typeof repo;
    repo.registerMethod('reopenAll', async function (this: Repository<ITicket>) {
      return this.updateMany({ status: 'closed' }, { status: 'open' });
    });
  });

  afterAll(async () => {
    await disconnectDB();
  });

  beforeEach(async () => {
    await TicketModel.deleteMany({});
  });

  it('claim() joins the transaction — a rollback undoes the state transition', async () => {
    const t = await repo.create({ code: 'T-1', status: 'open' });
    await expect(
      repo.withTransaction(async (tx) => {
        const claimed = await tx.claim(String(t._id), { from: 'open', to: 'closed' });
        expect(claimed?.status).toBe('closed');
        throw new Error('abort the unit of work');
      }),
    ).rejects.toThrow('abort the unit of work');

    expect((await TicketModel.findById(t._id).lean())?.status).toBe('open');
  });

  it('an unclassified method throws on call instead of running outside the transaction', async () => {
    await repo.create({ code: 'T-2', status: 'closed' });
    await expect(
      repo.withTransaction(async (tx) => {
        await (tx as unknown as { reopenAll(): Promise<unknown> }).reopenAll();
      }),
    ).rejects.toThrow(
      /reopenAll\(\) is not classified for transactions.*repo\.reopenAll\(\.\.\., \{ session: uow\.session \}\)/s,
    );

    expect((await TicketModel.findOne({ code: 'T-2' }).lean())?.status).toBe('closed');
  });

  it('watch() is refused — a change stream cannot open inside a transaction', async () => {
    await expect(
      repo.withTransaction(async (tx) => {
        tx.watch();
      }),
    ).rejects.toThrow(/watch\(\) cannot run on a tx-bound repository/);
  });

  it('a non-object in the options slot is a TypeError, not a call without the session', async () => {
    const t = await repo.create({ code: 'T-3', status: 'open' });
    await expect(
      repo.withTransaction(async (tx) => {
        await (tx.update as (...a: unknown[]) => Promise<unknown>)(
          String(t._id),
          { status: 'x' },
          'oops',
        );
      }),
    ).rejects.toThrow(/argument 2 must be an options object/);

    expect((await TicketModel.findById(t._id).lean())?.status).toBe('open');
  });

  it('non-IO methods still work on the tx-bound repository', async () => {
    await repo.withTransaction(async (tx) => {
      expect(tx.isDuplicateKeyError(new Error('x'))).toBe(false);
      expect(typeof (tx as unknown as { reopenAll: unknown }).reopenAll).toBe('function');
    });
  });
  it('every public Repository method is classified for transactions (a new verb cannot slip past)', () => {
    const methods = Object.getOwnPropertyNames(RepositoryClass.prototype).filter((name) => {
      if (name === 'constructor' || name.startsWith('_')) return false;
      const d = Object.getOwnPropertyDescriptor(RepositoryClass.prototype, name);
      return typeof d?.value === 'function';
    });
    expect(methods.length).toBeGreaterThan(30);
    expect(methods.filter((m) => !isTxClassified(m))).toEqual([]);
  });
});
