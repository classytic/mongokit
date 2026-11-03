/**
 * `explainCommands` (testkit) and `assertQueryPlan({ commands })`: explain the command a
 * repository method or plugin actually sent, writes included. A `leasePlugin` claim is a
 * `findAndModify` whose filter the plugin builds (`$and` of the caller filter and the
 * pending / dead-lease `$or`); before this, a test could only explain a hand-copied filter.
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repository } from '../../src/index.js';
import { type LeaseMethods, leasePlugin, methodRegistryPlugin } from '../../src/plugins/index.js';
import { assertQueryPlan, explainCommands } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface IJob {
  state: string;
  createdAt: Date;
  leasedBy?: string;
  leaseExpiresAt?: Date;
}

const DOCS = 1500;
const COLLECTION = 'explain_commands_jobs';

describe('explainCommands', () => {
  let conn: Connection;
  let JobModel: Model<IJob>;
  let repo: Repository<IJob> & LeaseMethods<IJob>;

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
    const schema = new Schema<IJob>(
      { state: String, createdAt: Date, leasedBy: String, leaseExpiresAt: Date },
      { collection: COLLECTION },
    );
    schema.index({ state: 1, createdAt: 1 }, { name: 'state_created' });
    JobModel = conn.model<IJob>('ExplainCommandsJob', schema);
    await JobModel.deleteMany({});
    await JobModel.syncIndexes();
    await JobModel.insertMany(
      Array.from({ length: DOCS }, (_, i) => ({
        state: i % 10 === 0 ? 'pending' : 'done',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })),
    );
    repo = new Repository<IJob>(JobModel, [
      methodRegistryPlugin(),
      leasePlugin({ statusField: 'state' }),
    ]) as Repository<IJob> & LeaseMethods<IJob>;
  }, 60_000);
  afterAll(async () => {
    await JobModel.deleteMany({});
    await conn.close();
  });

  const claim = () => repo.lease({ leaseFor: 30_000, leasedBy: 'w:1' });

  it('explains the lease claim the plugin built (findAndModify), not a copy', async () => {
    const { result, explains } = await explainCommands(claim, {
      connection: conn,
      commands: ['findAndModify'],
      collections: [COLLECTION],
    });
    expect(result?.state).toBe('processing');
    expect(explains).toHaveLength(1);
    const [e] = explains;
    expect(e?.name).toBe('findAndModify');
    expect(e?.collection).toBe(COLLECTION);
    // The filter is the plugin's: the claim condition joined through `$and`.
    expect(JSON.stringify(e?.explained.query)).toContain('"$and"');
    expect(Object.fromEntries(e?.explained.sort as Map<string, number>)).toEqual({ createdAt: 1 });
    expect(e?.explained.lsid).toBeUndefined();
    expect(e?.explain.executionStats).toBeDefined();
    expect(e?.explain.queryPlanner).toBeDefined();
  });

  it('the explain never writes: one claim leases exactly one row', async () => {
    const before = await JobModel.countDocuments({ state: 'processing' });
    await explainCommands(claim, { connection: conn, commands: ['findAndModify'] });
    expect(await JobModel.countDocuments({ state: 'processing' })).toBe(before + 1);
  });

  it('splits a bulk update into one explain per statement', async () => {
    const { explains } = await explainCommands(
      () =>
        JobModel.bulkWrite(
          [
            { updateOne: { filter: { state: 'nope-1' }, update: { $set: { leasedBy: 'x' } } } },
            { updateMany: { filter: { state: 'nope-2' }, update: { $set: { leasedBy: 'y' } } } },
          ],
          { ordered: true },
        ),
      { connection: conn, commands: ['update'], verbosity: 'queryPlanner' },
    );
    expect(explains).toHaveLength(2);
    expect(explains.map((e) => (e.explained.updates as unknown[]).length)).toEqual([1, 1]);
  });

  it('throws on no matching command, and on a name that cannot be explained', async () => {
    await expect(
      explainCommands(() => JobModel.find({ state: 'pending' }).lean().exec(), {
        connection: conn,
        commands: ['findAndModify'],
      }),
    ).rejects.toThrow(/saw no matching command \(saw: find:/);
    await expect(
      explainCommands(claim, { connection: conn, commands: ['insert'] }),
    ).rejects.toThrow(/'insert' cannot be explained/);
  });

  it('assertQueryPlan gates a write with `commands`; reads only by default', async () => {
    // Default: the claim issues no read, so the gate refuses (unchanged behaviour).
    await expect(assertQueryPlan(claim, { connection: conn, minDocs: 1000 })).rejects.toThrow(
      /no plannable command \(saw: findAndModify\)/,
    );
    const { plans } = await assertQueryPlan(claim, {
      connection: conn,
      minDocs: 1000,
      commands: ['findAndModify'],
      forbid: ['COLLSCAN'],
    });
    expect(plans[0]?.name).toBe('findAndModify');
  });
});
