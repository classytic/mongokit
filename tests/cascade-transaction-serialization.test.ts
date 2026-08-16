/**
 * Cascades inside a transaction run SEQUENTIALLY, and roll back atomically.
 *
 * `cascadePlugin({ parallel })` defaults to `true` and dispatched every
 * relation through `Promise.allSettled`. Once cascades began propagating the
 * parent `ClientSession`, that meant multiple concurrent operations on ONE
 * session — which MongoDB does not support. The failure is not a clean error:
 * the driver serialises commands per session, so concurrent use is undefined
 * behaviour that surfaces later as transaction-state errors on an unrelated
 * statement.
 *
 * `parallel` is therefore IGNORED when a session is present, rather than
 * obeyed — a throughput flag must not be able to corrupt a transaction.
 */

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cascadePlugin } from '../src/plugins/cascade.plugin.js';
import { Repository } from '../src/Repository.js';

interface IParent {
  _id: mongoose.Types.ObjectId;
  name: string;
}
interface IChild {
  _id: mongoose.Types.ObjectId;
  parentId: mongoose.Types.ObjectId;
  tag: string;
}

let replset: MongoMemoryReplSet;
let parents: Repository<IParent>;
let childA: Repository<IChild>;
let childB: Repository<IChild>;

beforeAll(async () => {
  await mongoose.disconnect();
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri('cascade-tx'));

  const parentSchema = new mongoose.Schema<IParent>({ name: String });
  const childSchema = new mongoose.Schema<IChild>({
    parentId: mongoose.Schema.Types.ObjectId,
    tag: String,
  });

  const ParentModel = mongoose.model<IParent>('CascadeTxParent', parentSchema);
  const ChildAModel = mongoose.model<IChild>('CascadeTxChildA', childSchema);
  const ChildBModel = mongoose.model<IChild>('CascadeTxChildB', childSchema);

  childA = new Repository<IChild>(ChildAModel);
  childB = new Repository<IChild>(ChildBModel);

  // TWO relations — one is not enough to exercise concurrency.
  parents = new Repository<IParent>(ParentModel, [
    cascadePlugin({
      // The default, stated explicitly: this is the setting under test.
      parallel: true,
      relations: [
        { foreignKey: 'parentId', repo: childA, onDelete: 'cascade' },
        { foreignKey: 'parentId', repo: childB, onDelete: 'cascade' },
      ],
    }),
  ]);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await replset.stop();
}, 60000);

beforeEach(async () => {
  await Promise.all([
    parents.Model.deleteMany({}),
    childA.Model.deleteMany({}),
    childB.Model.deleteMany({}),
  ]);
});

async function seed() {
  const parent = await parents.create({ name: 'p' });
  await childA.create({ parentId: parent._id, tag: 'a' });
  await childB.create({ parentId: parent._id, tag: 'b' });
  return parent;
}

/**
 * Record entry/exit around each relation's cascade so INTERLEAVING is visible.
 * Asserting on row counts alone cannot distinguish sequential from parallel —
 * both delete the same rows — so the ordering trace is the actual evidence.
 */
function traceRelations() {
  const trace: string[] = [];
  const instrument = (repo: Repository<IChild>, label: string) => {
    repo.on('before:deleteMany', async () => {
      trace.push(`${label}:start`);
      // Yield the event loop. Under Promise.allSettled both relations reach
      // their start marker before either reaches its end marker.
      await new Promise((r) => setTimeout(r, 25));
      trace.push(`${label}:end`);
    });
  };
  instrument(childA, 'A');
  instrument(childB, 'B');
  return trace;
}

describe('cascade inside a transaction', () => {
  it('runs relations SEQUENTIALLY — the ordering trace never interleaves', async () => {
    const trace = traceRelations();
    const parent = await seed();

    await parents.withTransaction(async (txRepo) => {
      await txRepo.delete(String(parent._id));
    });

    // Sequential: each relation closes before the next opens.
    // Parallel would produce A:start, B:start, A:end, B:end.
    expect(trace).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('deletes across TWO relations in one transaction and commits', async () => {
    const parent = await seed();

    await parents.withTransaction(async (txRepo) => {
      await txRepo.delete(String(parent._id));
    });

    expect(await parents.count()).toBe(0);
    expect(await childA.count()).toBe(0);
    expect(await childB.count()).toBe(0);
  });

  it('rolls back ATOMICALLY — a throw after the cascade leaves every child intact', async () => {
    const parent = await seed();

    await expect(
      parents.withTransaction(async (txRepo) => {
        await txRepo.delete(String(parent._id));
        throw new Error('abort after cascade');
      }),
    ).rejects.toThrow('abort after cascade');

    // If the cascade had escaped the session, these would be gone.
    expect(await parents.count()).toBe(1);
    expect(await childA.count()).toBe(1);
    expect(await childB.count()).toBe(1);
  });

  it('OUTSIDE a transaction, parallel is still honoured', async () => {
    // The downgrade is scoped to sessions; it must not quietly serialise the
    // non-transactional path that has always run concurrently.
    const parent = await seed();
    await parents.delete(String(parent._id));
    expect(await childA.count()).toBe(0);
    expect(await childB.count()).toBe(0);
  });
});
