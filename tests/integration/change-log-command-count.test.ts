/**
 * changeLogPlugin adds no driver round trip beyond the change row itself: with an in-memory feed
 * (zero driver commands of its own) every verb must issue exactly the commands it issues WITHOUT
 * the plugin. A re-read of the written document is the regression this file pins.
 */
import { MemoryChangeLogStore } from '@classytic/repo-core/sync';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchOperationsPlugin } from '../../src/plugins/batch-operations.plugin.js';
import { changeLogPlugin } from '../../src/plugins/change-log.plugin.js';
import { methodRegistryPlugin } from '../../src/plugins/method-registry.plugin.js';
import { Repository } from '../../src/repository.js';
import { recordCommands } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface Doc {
  name: string;
  total: number;
  version?: number;
  organizationId?: string;
}

describe('changeLogPlugin command budget', () => {
  let conn: mongoose.Connection;
  let Model: mongoose.Model<Doc>;
  let bare: Repository<Doc>;
  let captured: Repository<Doc>;
  let store: MemoryChangeLogStore;
  let seq = 0;

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
    Model = conn.model<Doc>(
      'ClCmdCount',
      new mongoose.Schema<Doc>(
        { name: String, total: Number, version: Number, organizationId: String },
        { timestamps: true },
      ),
    );
    await Model.init();
    store = new MemoryChangeLogStore();
    bare = new Repository<Doc>(Model, [methodRegistryPlugin(), batchOperationsPlugin()]);
    captured = new Repository<Doc>(Model, [methodRegistryPlugin(), batchOperationsPlugin(), changeLogPlugin({ store, scope: 'cmd' })]);
  });

  afterAll(async () => {
    await conn.close();
  });

  /** Commands the callback sends to the test collection, in order (`find`, `findAndModify`, ...). */
  async function commands(run: () => Promise<unknown>): Promise<string[]> {
    const { commands: sent } = await recordCommands(conn, run);
    return sent.filter((c) => c.collection === Model.collection.collectionName).map((c) => c.name);
  }

  /** Same scenario on both repositories; fresh fixture rows each time so the runs are comparable. */
  async function budget(
    scenario: (repo: Repository<Doc>, ids: string[]) => Promise<unknown>,
    rows = 2,
  ): Promise<{ without: string[]; withLog: string[] }> {
    const run = async (repo: Repository<Doc>) => {
      seq += 1;
      const created = await Model.create(
        Array.from({ length: rows }, (_, i) => ({ name: `open`, total: 1, organizationId: `b${seq}`, version: i })),
      );
      const ids = created.map((d) => String(d._id));
      return commands(() => scenario(repo, ids));
    };
    return { without: await run(bare), withLog: await run(captured) };
  }

  /** `extra`: commands the capture may add (a many-document verb reads its targets: ids before, one batched read after). */
  const cases: [string, (r: Repository<Doc>, ids: string[]) => Promise<unknown>, number?][] = [
    ['update by id', (r, [id]) => r.update(id!, { total: 9 })],
    ['update ifVersion', (r, [id]) => r.update(id!, { total: 9 }, { ifVersion: 0 })],
    ['findOneAndUpdate', (r, [id]) => r.findOneAndUpdate({ _id: id }, { $set: { total: 9 } })],
    [
      'findOneAndUpdate with select (row must stay whole: one re-read)',
      (r, [id]) => r.findOneAndUpdate({ _id: id }, { $set: { total: 9 } }, { select: 'total' } as never),
      1,
    ],
    ['claim', (r, [id]) => r.claim(id!, { field: 'name', from: 'open', to: 'paid' }, { total: 9 })],
    [
      'applyTransition',
      (r, [id]) =>
        r.applyTransition(id!, { name: 'm', assertTransition: () => {} }, { field: 'name', from: 'open', to: 'paid', history: false }),
    ],
    ['getOrCreate', (r, [id]) => r.getOrCreate({ _id: id }, { name: 'x' })],
    ['create', (r) => r.create({ name: 'n', total: 1 })],
    ['delete', (r, [id]) => r.delete(id!)],
    ['updateMany (3 rows)', (r, ids) => r.updateMany({ _id: { $in: ids } }, { $set: { total: 3 } }), 2],
    ['deleteMany (3 rows)', (r, ids) => r.deleteMany({ _id: { $in: ids } }), 2],
    [
      'bulkWrite (update + delete)',
      (r, [a, b]) =>
        (r as unknown as { bulkWrite: (ops: unknown[]) => Promise<unknown> }).bulkWrite([
          { updateOne: { filter: { _id: a }, update: { $set: { total: 5 } } } },
          { deleteOne: { filter: { _id: b } } },
        ]),
      3,
    ],
  ];

  for (const [label, scenario, extra = 0] of cases) {
    it(`${label}: the verb's own commands plus at most ${extra}`, async () => {
      const { without, withLog } = await budget(scenario, 3);
      if (process.env.CL_DUMP) console.log(`CMDS ${label}: without=${without.join(',')} with=${withLog.join(',')}`);
      expect(withLog.length).toBeLessThanOrEqual(without.length + extra);
    });
  }
});
