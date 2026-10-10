/**
 * `getByIds` chunking: n ids cost exactly ceil(n / chunkSize) `find` commands, at most
 * `concurrency` in flight outside a session, one at a time inside one; `preserveOrder` aligns
 * the result with the input (undefined for a miss, duplicates repeated).
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { recordCommands } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface IDoc {
  n: number;
}

const PRESENT = 12_500;
const TOTAL_IDS = 25_000;

describe('getByIds chunking', () => {
  let conn: Connection;
  let DocModel: Model<IDoc>;
  let repo: Repository<IDoc>;
  let ids: string[];

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
    DocModel = conn.model<IDoc>('GetByIdsChunkDoc', new Schema<IDoc>({ n: Number }));
    await DocModel.init();
    await DocModel.deleteMany({});
    const docs = await DocModel.insertMany(Array.from({ length: PRESENT }, (_, n) => ({ n })), { lean: true });
    const missing = Array.from({ length: TOTAL_IDS - PRESENT }, () => String(new mongoose.Types.ObjectId()));
    ids = [...docs.map((d) => String(d._id)), ...missing];
    repo = new Repository<IDoc>(DocModel);
  }, 120_000);
  afterAll(async () => {
    await DocModel.deleteMany({});
    await conn.close();
  });

  const finds = (cmds: { name: string; collection: string | undefined }[]) =>
    cmds.filter((c) => c.name === 'find' && c.collection === DocModel.collection.collectionName);

  it('25k ids at chunkSize 5000 cost exactly 5 find commands and return every present doc', async () => {
    const { result, commands } = await recordCommands(conn, () => repo.getByIds(ids, { chunkSize: 5000 }));
    expect(finds(commands)).toHaveLength(Math.ceil(TOTAL_IDS / 5000));
    expect(result.size).toBe(PRESENT);
  });

  it('the default chunk (10k) costs ceil(25k / 10k) = 3 commands', async () => {
    const { commands } = await recordCommands(conn, () => repo.getByIds(ids));
    expect(finds(commands)).toHaveLength(3);
  });

  /** Peak number of `find` commands in flight while `run` executes. */
  async function peakFinds(run: () => Promise<unknown>): Promise<number> {
    const client = conn.getClient();
    let inFlight = 0;
    let peak = 0;
    const started = new Set<number>();
    const onStart = (e: { commandName: string; requestId: number }) => {
      if (e.commandName !== 'find') return;
      started.add(e.requestId);
      inFlight++;
      peak = Math.max(peak, inFlight);
    };
    const onEnd = (e: { requestId: number }) => {
      if (started.delete(e.requestId)) inFlight--;
    };
    client.on('commandStarted', onStart);
    client.on('commandSucceeded', onEnd);
    client.on('commandFailed', onEnd);
    try {
      await run();
    } finally {
      client.off('commandStarted', onStart);
      client.off('commandSucceeded', onEnd);
      client.off('commandFailed', onEnd);
    }
    return peak;
  }

  it('outside a session at most `concurrency` chunks are in flight', async () => {
    const peak = await peakFinds(() => repo.getByIds(ids, { chunkSize: 1000, concurrency: 3 }));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('inside a transaction chunks run one at a time and all join the session', async () => {
    const session = await conn.startSession();
    try {
      await session.withTransaction(async () => {
        const { result, commands } = await recordCommands(conn, () =>
          repo.getByIds(ids.slice(0, 6000), { chunkSize: 2000, session }),
        );
        const f = finds(commands);
        expect(f).toHaveLength(3);
        for (const c of f) expect(c.command.lsid).toBeDefined();
        expect(result.size).toBe(6000);
        expect(await peakFinds(() => repo.getByIds(ids.slice(0, 6000), { chunkSize: 1000, session }))).toBe(1);
      });
    } finally {
      await session.endSession();
    }
  });

  it('preserveOrder returns an array aligned with the input, holes for misses and invalid ids', async () => {
    const present = ids[0] as string;
    const absent = ids[TOTAL_IDS - 1] as string;
    const out = await repo.getByIds([absent, present, 'not-an-id', present], { preserveOrder: true });
    expect(out).toHaveLength(4);
    expect(out[0]).toBeUndefined();
    expect(String((out[1] as { _id: unknown })._id)).toBe(present);
    expect(out[2]).toBeUndefined();
    expect(out[3]).toBe(out[1]);
  });

  it('a nonsense chunk size or concurrency is refused', async () => {
    await expect(repo.getByIds(ids, { chunkSize: 0 })).rejects.toThrow(/size must be a positive integer/);
    await expect(repo.getByIds(ids, { concurrency: 0 })).rejects.toThrow(/concurrency must be a positive integer/);
  });
});
