/**
 * `queryDefaults` / `aggregateDefaults`: every bounded command carries the time bound and tag,
 * every write the write concern; per call beats repository beats deployment (FL1).
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertQueryDefaultsConfigured,
  configureAggregateDefaults,
  configureQueryDefaults,
  QUERY_DEFAULTS_ERROR_CODES,
  Repository,
  resetQueryDefaults,
} from '../../src/index.js';
import { type RecordedCommand, recordCommands } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface IDoc {
  name: string;
  n: number;
}

const BOUNDED = new Set(['find', 'aggregate', 'count', 'distinct', 'findAndModify']);
const WRITES = new Set(['insert', 'update', 'delete']);

describe('queryDefaults', () => {
  let conn: Connection;
  let DocModel: Model<IDoc>;

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
    DocModel = conn.model<IDoc>('QueryDefaultsDoc', new Schema<IDoc>({ name: String, n: Number }));
    await DocModel.init();
  });
  afterAll(async () => {
    await DocModel.deleteMany({});
    await conn.close();
  });
  afterEach(() => resetQueryDefaults());

  const coll = () => DocModel.collection.collectionName;
  const on = (cmds: RecordedCommand[], names: Set<string>) =>
    cmds.filter((c) => names.has(c.name) && c.collection === coll());

  async function seed(): Promise<string> {
    await DocModel.deleteMany({});
    const docs = await DocModel.insertMany([
      { name: 'a', n: 1 },
      { name: 'b', n: 2 },
      { name: 'c', n: 3 },
    ]);
    return String(docs[0]?._id);
  }

  it('every read, aggregate and findAndModify verb carries the repository maxTimeMS and comment', async () => {
    const repo = new Repository<IDoc>(DocModel, [], {}, {
      queryDefaults: { maxTimeMS: 4321, comment: 'qd-repo' },
    });
    const id = await seed();
    const verbs: Array<[string, () => Promise<unknown>]> = [
      ['getById', () => repo.getById(id)],
      ['getByQuery', () => repo.getByQuery({ name: 'a' })],
      ['getOne', () => repo.getOne({ name: 'b' })],
      ['findAll', () => repo.findAll({})],
      [
        'cursor',
        async () => {
          for await (const _ of repo.cursor({})) void _;
        },
      ],
      ['getAll offset', () => repo.getAll({ page: 1, limit: 2 })],
      ['getAll keyset', () => repo.getAll({ sort: { _id: 1 }, limit: 2, mode: 'keyset' })],
      ['count', () => repo.count({})],
      ['exists', () => repo.exists({ name: 'a' })],
      ['distinct', () => repo.distinct('name')],
      ['aggregatePipeline', () => repo.aggregatePipeline([{ $match: {} }])],
      ['aggregate', () => repo.aggregate({ measures: { total: { op: 'sum', field: 'n' } } })],
      ['aggregatePaginate', () => repo.aggregatePaginate({ groupBy: 'name', measures: { c: { op: 'count' } }, limit: 5 })],
      ['aggregatePipelinePaginate', () => repo.aggregatePipelinePaginate({ pipeline: [{ $match: {} }], limit: 2 })],
      ['lookupPopulate', () => repo.lookupPopulate({ filters: {}, lookups: [], limit: 2 })],
      ['findOneAndUpdate', () => repo.findOneAndUpdate({ name: 'c' }, { $set: { n: 30 } })],
      ['update', () => repo.update(id, { n: 10 })],
    ];
    for (const [verb, run] of verbs) {
      const { commands } = await recordCommands(conn, run);
      const bounded = on(commands, BOUNDED);
      expect(bounded.length, `${verb} issued no bounded command`).toBeGreaterThan(0);
      for (const c of bounded) {
        expect(c.command.maxTimeMS, `${verb} ${c.name} maxTimeMS`).toBe(4321);
        expect(c.command.comment, `${verb} ${c.name} comment`).toBe('qd-repo');
      }
    }
  });

  it('every write verb carries the repository write concern', async () => {
    const repo = new Repository<IDoc>(DocModel, [], {}, {
      queryDefaults: { writeConcern: { w: 'majority', wtimeoutMS: 5000 } },
    });
    const id = await seed();
    const verbs: Array<[string, () => Promise<unknown>]> = [
      ['create', () => repo.create({ name: 'd', n: 4 })],
      ['createMany', () => repo.createMany([{ name: 'e', n: 5 }])],
      ['update', () => repo.update(id, { n: 11 })],
      ['findOneAndUpdate', () => repo.findOneAndUpdate({ name: 'b' }, { $set: { n: 20 } })],
      ['updateMany', () => repo.updateMany({ n: { $gte: 0 } }, { $set: { n: 0 } })],
      ['delete', () => repo.delete(id)],
      ['deleteMany', () => repo.deleteMany({ name: 'e' })],
    ];
    for (const [verb, run] of verbs) {
      const { commands } = await recordCommands(conn, run);
      const writes = commands.filter(
        (c) => (WRITES.has(c.name) || c.name === 'findAndModify') && c.collection === coll(),
      );
      expect(writes.length, `${verb} issued no write`).toBeGreaterThan(0);
      for (const c of writes) {
        expect(c.command.writeConcern, `${verb} ${c.name}`).toMatchObject({ w: 'majority' });
      }
    }
  });

  it('a per-call value beats the repository default, which beats the deployment default', async () => {
    configureQueryDefaults({ maxTimeMS: 777, comment: 'qd-deploy' });
    const repoDefault = new Repository<IDoc>(DocModel, [], {}, { queryDefaults: { maxTimeMS: 4321 } });
    const plain = new Repository<IDoc>(DocModel);
    const id = await seed();

    const perCall = await recordCommands(conn, () => repoDefault.getById(id, { maxTimeMS: 99 }));
    expect(on(perCall.commands, BOUNDED)[0]?.command.maxTimeMS).toBe(99);
    const fromRepo = await recordCommands(conn, () => repoDefault.getById(id));
    expect(on(fromRepo.commands, BOUNDED)[0]?.command.maxTimeMS).toBe(4321);
    // The repository did not set a comment, so the deployment's fills that one field in.
    expect(on(fromRepo.commands, BOUNDED)[0]?.command.comment).toBe('qd-deploy');
    const fromDeploy = await recordCommands(conn, () => plain.getById(id));
    expect(on(fromDeploy.commands, BOUNDED)[0]?.command.maxTimeMS).toBe(777);
  });

  it('aggregations consult aggregateDefaults before the generic query bound', async () => {
    configureQueryDefaults({ maxTimeMS: 777 });
    configureAggregateDefaults({ maxTimeMs: 5555, allowDiskUse: true });
    const repo = new Repository<IDoc>(DocModel);
    await seed();
    const agg = await recordCommands(conn, () => repo.aggregatePipeline([{ $match: {} }]));
    const [cmd] = on(agg.commands, BOUNDED);
    expect(cmd?.command.maxTimeMS).toBe(5555);
    expect(cmd?.command.allowDiskUse).toBe(true);
    const ir = await recordCommands(conn, () =>
      repo.aggregate({ measures: { c: { op: 'count' } }, executionHints: { maxTimeMs: 42 } }),
    );
    expect(on(ir.commands, BOUNDED)[0]?.command.maxTimeMS).toBe(42);
    const find = await recordCommands(conn, () => repo.findAll({}));
    expect(on(find.commands, BOUNDED)[0]?.command.maxTimeMS).toBe(777);
  });

  it('inside a transaction a DEFAULT read/write concern is dropped, so the transaction still runs', async () => {
    configureQueryDefaults({ readConcern: 'majority', writeConcern: { w: 'majority' } });
    const repo = new Repository<IDoc>(DocModel);
    await seed();
    const session = await conn.startSession();
    try {
      await session.withTransaction(async () => {
        await repo.findAll({}, { session });
        await repo.create({ name: 'tx', n: 9 }, { session });
      });
    } finally {
      await session.endSession();
    }
    expect(await DocModel.countDocuments({ name: 'tx' })).toBe(1);
  });

  it('an unknown read preference is refused, never passed through', async () => {
    const repo = new Repository<IDoc>(DocModel);
    await expect(repo.findAll({}, { readPreference: 'nearest-ish' })).rejects.toThrow(/unknown readPreference/);
  });

  describe('assertQueryDefaultsConfigured (boot check M7)', () => {
    it('throws a closed code when no deployment maxTimeMS is set', () => {
      expect.assertions(2);
      try {
        assertQueryDefaultsConfigured();
      } catch (err) {
        expect((err as { code?: string }).code).toBe(QUERY_DEFAULTS_ERROR_CODES.NOT_CONFIGURED);
        expect((err as { meta?: { missing?: string } }).meta?.missing).toBe('maxTimeMS');
      }
    });

    it('throws when the connection has no CSOT timeoutMS, passes when it has one', async () => {
      configureQueryDefaults({ maxTimeMS: 1000 });
      expect(() => assertQueryDefaultsConfigured(conn)).toThrow(/timeoutMS/);
      const bounded = await mongoose
        .createConnection(getMongoUri(), { timeoutMS: 20_000 })
        .asPromise();
      try {
        expect(assertQueryDefaultsConfigured(bounded)).toEqual({ maxTimeMS: 1000, timeoutMS: 20_000 });
      } finally {
        await bounded.close();
      }
    });
  });
});
