/**
 * CSOT transaction matrix: on a client with `timeoutMS` (as be-prod connects) and inside mongokit's
 * `withTransaction`, EVERY verb runs with deployment + repository query defaults set: none may send
 * a query-default bound: each is capped by what remains of the transaction's budget. Outside a
 * transaction the same verbs still carry the query-default bound.
 */

import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  batchOperationsPlugin,
  batchTransaction,
  configureAggregateDefaults,
  configureQueryDefaults,
  methodRegistryPlugin,
  multiTenantPlugin,
  Repository,
  resetQueryDefaults,
  withTransaction,
} from '../../src/index.js';
import { recordCommands } from '../../src/testkit/index.js';
import { connectDB, getMongoUri } from '../setup.js';

interface IRow {
  organizationId: string;
  sku: string;
  qty: number;
  tag?: string;
}

const ORG = 'org-csot';

describe('CSOT client + withTransaction: every verb', () => {
  let conn: Connection;
  let Row: Model<IRow>;
  let Tag: Model<{ organizationId: string; sku: string; label: string }>;
  let repo: Repository<IRow>;
  let batch: Repository<IRow> & {
    bulkWrite(ops: unknown[], o?: Record<string, unknown>): Promise<unknown>;
  };

  beforeAll(async () => {
    await connectDB();
    conn = await mongoose
      .createConnection(getMongoUri(), { timeoutMS: 120_000, monitorCommands: true })
      .asPromise();
    const schema = new Schema<IRow>({
      organizationId: String,
      sku: String,
      qty: Number,
      tag: String,
    });
    schema.index({ organizationId: 1, sku: 1 }, { unique: true });
    Row = conn.model<IRow>('CsotTxRow', schema);
    Tag = conn.model(
      'CsotTxTag',
      new Schema({ organizationId: String, sku: String, label: String }),
    );
    await Row.syncIndexes();
    await Tag.init();
    repo = new Repository<IRow>(
      Row,
      [multiTenantPlugin({ tenantField: 'organizationId' })],
      {},
      {
        queryDefaults: { maxTimeMS: 4321 },
        aggregateDefaults: { maxTimeMs: 6543 },
      },
    );
    new Repository(Tag, [multiTenantPlugin({ tenantField: 'organizationId' })]);
    batch = new Repository<IRow>(Row, [
      methodRegistryPlugin(),
      batchOperationsPlugin(),
      multiTenantPlugin({ tenantField: 'organizationId' }),
    ]) as typeof batch;
  });
  afterAll(async () => {
    resetQueryDefaults();
    await conn.close();
  });
  beforeEach(async () => {
    // be-prod sets the deployment defaults at boot.
    configureQueryDefaults({ maxTimeMS: 5000, writeConcern: { w: 'majority' } });
    configureAggregateDefaults({ maxTimeMs: 15000 });
    await Promise.all([Row.deleteMany({}), Tag.deleteMany({})]);
    await Row.insertMany([1, 2, 3].map((i) => ({ organizationId: ORG, sku: `S${i}`, qty: i })));
    await Tag.insertMany([{ organizationId: ORG, sku: 'S1', label: 'red' }]);
  });

  const scope = { organizationId: ORG };
  const id = async () => String((await Row.findOne({ sku: 'S1' }).lean())?._id);

  /** Every verb, given a session (or none). Each must succeed. */
  const verbs = (session?: mongoose.ClientSession): Array<[string, () => Promise<unknown>]> => {
    const s = session ? { session } : {};
    return [
      ['create', () => repo.create({ sku: 'N1', qty: 1 }, { ...scope, ...s })],
      [
        'createMany ordered',
        () =>
          repo.createMany(
            [
              { sku: 'N2', qty: 1 },
              { sku: 'N3', qty: 1 },
            ],
            { ...scope, ...s, ordered: true },
          ),
      ],
      [
        'createMany unordered',
        () =>
          repo.createMany(
            [
              { sku: 'N4', qty: 1 },
              { sku: 'N5', qty: 1 },
            ],
            { ...scope, ...s },
          ),
      ],
      [
        'bulkWrite (batch-operations plugin)',
        () =>
          batch.bulkWrite(
            [
              { insertOne: { document: { sku: 'B1', qty: 1 } } },
              { updateOne: { filter: { sku: 'S2' }, update: { $inc: { qty: 1 } } } },
              { deleteOne: { filter: { sku: 'B1' } } },
            ],
            { ...scope, ...s },
          ),
      ],
      ['getById', async () => repo.getById(await id(), { ...scope, ...s })],
      ['getByQuery', () => repo.getByQuery({ sku: 'S2' }, { ...scope, ...s })],
      ['getOne', () => repo.getOne({ sku: 'S2' }, { ...scope, ...s })],
      ['findAll', () => repo.findAll({}, { ...scope, ...s })],
      ['getByIds', async () => repo.getByIds([await id()], { ...scope, ...s, chunkSize: 1 })],
      ['count', () => repo.count({}, { ...scope, ...s })],
      ['exists', () => repo.exists({ sku: 'S1' }, { ...scope, ...s })],
      ['distinct', () => repo.distinct('sku', {}, { ...scope, ...s })],
      [
        'getAll offset',
        () => repo.getAll({ page: 1, limit: 2, countStrategy: 'exact' }, { ...scope, ...s }),
      ],
      [
        'getAll capped',
        () => repo.getAll({ page: 1, limit: 2, countStrategy: 'capped' }, { ...scope, ...s }),
      ],
      [
        'getAll keyset',
        () => repo.getAll({ sort: { _id: 1 }, limit: 2, mode: 'keyset' }, { ...scope, ...s }),
      ],
      ['aggregatePipeline', () => repo.aggregatePipeline([{ $match: {} }], { ...scope, ...s })],
      [
        'aggregatePipeline + lookup',
        () =>
          repo.aggregatePipeline(
            [
              {
                $lookup: {
                  from: Tag.collection.collectionName,
                  localField: 'sku',
                  foreignField: 'sku',
                  as: 'tags',
                },
              },
            ],
            { ...scope, ...s },
          ),
      ],
      [
        'aggregate IR',
        () => repo.aggregate({ measures: { q: { op: 'sum', field: 'qty' } } }, { ...scope, ...s }),
      ],
      [
        'aggregatePaginate',
        () =>
          repo.aggregatePaginate(
            { groupBy: 'sku', measures: { n: { op: 'count' } }, limit: 5 },
            { ...scope, ...s },
          ),
      ],
      [
        'aggregatePipelinePaginate',
        () =>
          repo.aggregatePipelinePaginate({
            pipeline: [{ $sort: { _id: 1 } }],
            limit: 2,
            ...scope,
            ...s,
          }),
      ],
      [
        'lookupPopulate',
        () => repo.lookupPopulate({ filters: {}, lookups: [], limit: 2, ...scope, ...s }),
      ],
      [
        'findOneAndUpdate',
        () => repo.findOneAndUpdate({ sku: 'S2' }, { $inc: { qty: 1 } }, { ...scope, ...s }),
      ],
      ['update', async () => repo.update(await id(), { qty: 9 }, { ...scope, ...s })],
      [
        'claim',
        async () =>
          repo.claim(
            await id(),
            { field: 'sku', from: 'S1', to: 'S1' },
            { $inc: { qty: 1 } },
            { ...scope, ...s },
          ),
      ],
      [
        'updateMany',
        () => repo.updateMany({ qty: { $gte: 0 } }, { $set: { tag: 't' } }, { ...scope, ...s }),
      ],
      [
        'bulkUpsert',
        () =>
          repo.bulkUpsert(
            [
              { sku: 'S3', qty: 1 },
              { sku: 'N9', qty: 1 },
            ],
            { key: ['sku'], inc: ['qty'], ...scope, ...s },
          ),
      ],
      [
        'iterate',
        async () => {
          for await (const _ of repo.iterate({}, { batchSize: 1, ...scope, ...s })) void _;
        },
      ],
      [
        'cursor',
        async () => {
          for await (const _ of repo.cursor({}, { ...scope, ...s })) void _;
        },
      ],
      ['deleteMany', () => repo.deleteMany({ sku: 'N2' }, { ...scope, ...s })],
      ['delete', async () => repo.delete(await id(), { ...scope, ...s })],
    ];
  };

  it('inside withTransaction every verb succeeds, bounded by the transaction budget, never by a query default', async () => {
    const failures: string[] = [];
    const { commands } = await recordCommands(conn, () =>
      withTransaction(conn, async (session) => {
        for (const [verb, run] of verbs(session)) {
          try {
            await run();
          } catch (err) {
            failures.push(`${verb}: ${(err as Error).message}`);
          }
        }
      }),
    );
    expect(failures).toEqual([]);
    // The transaction's own CSOT budget governs: a per-op bound would have been refused, and the
    // wire maxTimeMS (if any) comes only from the transaction context, never from 4321/6543/5000.
    const repoBounds = commands.filter((c) =>
      [4321, 6543, 5000, 15000].includes(Number(c.command.maxTimeMS)),
    );
    expect(repoBounds.map((c) => c.name)).toEqual([]);
  });

  it('raw Model.insertMany / Model.bulkWrite on the session also work inside withTransaction', async () => {
    await withTransaction(conn, async (session) => {
      await Row.insertMany([{ organizationId: ORG, sku: 'R1', qty: 1 }], { session });
      await Row.bulkWrite(
        [{ updateOne: { filter: { sku: 'R1' }, update: { $inc: { qty: 1 } } } }],
        { session },
      );
    });
    expect((await Row.findOne({ sku: 'R1' }).lean())?.qty).toBe(2);
  });

  it('a TransientTransactionError retries the whole attempt, and the retry commits once', async () => {
    let attempts = 0;
    await withTransaction(conn, async (session) => {
      attempts++;
      await Row.create([{ organizationId: ORG, sku: `T${attempts}`, qty: 1 }], { session });
      if (attempts === 1) {
        throw new mongoose.mongo.MongoServerError({
          message: 'simulated',
          errorLabels: ['TransientTransactionError'],
        });
      }
    });
    expect(attempts).toBe(2);
    expect(await Row.countDocuments({ sku: { $in: ['T1', 'T2'] } })).toBe(1);
    expect(await Row.countDocuments({ sku: 'T2' })).toBe(1);
  });

  it('retries stop at the deadline (transactionOptions.timeoutMS) with a timeout error wrapping the last one', async () => {
    let attempts = 0;
    const started = Date.now();
    await expect(
      withTransaction(
        conn,
        async () => {
          attempts++;
          await new Promise((r) => setTimeout(r, 50));
          throw new mongoose.mongo.MongoServerError({
            message: 'always transient',
            errorLabels: ['TransientTransactionError'],
          });
        },
        { transactionOptions: { timeoutMS: 400 } },
      ).catch((err: unknown) => err),
    ).resolves.toSatisfy((err: unknown) => {
      // As the driver: a timeout error wrapping the last error, its labels copied.
      const e = err as { name?: string; cause?: { message?: string }; errorLabels?: string[] };
      return (
        e.name === 'MongoOperationTimeoutError' &&
        e.cause?.message === 'always transient' &&
        (e.errorLabels ?? []).includes('TransientTransactionError')
      );
    });
    expect(attempts).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a non-transient error aborts once, with nothing committed', async () => {
    let attempts = 0;
    await expect(
      withTransaction(conn, async (session) => {
        attempts++;
        await Row.create([{ organizationId: ORG, sku: 'X1', qty: 1 }], { session });
        throw new Error('domain refusal');
      }),
    ).rejects.toThrow(/domain refusal/);
    expect(attempts).toBe(1);
    expect(await Row.countDocuments({ sku: 'X1' })).toBe(0);
  });

  it('transactionOptions.timeoutMS bounds the whole transaction: an op after the budget is refused, nothing commits', async () => {
    let lateError: unknown;
    const { result: err, commands } = await recordCommands(conn, () =>
      withTransaction(
        conn,
        async (session) => {
          await repo.create({ sku: 'D1', qty: 1 }, { ...scope, session });
          await new Promise((r) => setTimeout(r, 400));
          await repo.create({ sku: 'D2', qty: 1 }, { ...scope, session }).catch((e: unknown) => {
            lateError = e;
            throw e;
          });
        },
        { transactionOptions: { timeoutMS: 300 } },
      ).catch((e: unknown) => e),
    );
    expect((err as Error).name).toBe('MongoOperationTimeoutError');
    // The late op is refused by mongokit BEFORE sending: the server never sees the D2 insert.
    expect((lateError as Error).message).toMatch(/budget exhausted before this operation/);
    const inserts = commands.filter(
      (c) => c.name === 'insert' && c.collection === Row.collection.collectionName,
    );
    expect(inserts).toHaveLength(1);
    expect(await Row.countDocuments({ sku: { $in: ['D1', 'D2'] } })).toBe(0);
  });

  it('a callback that finishes after the budget is aborted, never committed', async () => {
    const err = await withTransaction(
      conn,
      async (session) => {
        await repo.create({ sku: 'E1', qty: 1 }, { ...scope, session });
        await new Promise((r) => setTimeout(r, 400));
      },
      { transactionOptions: { timeoutMS: 300 } },
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe('MongoOperationTimeoutError');
    expect(await Row.countDocuments({ sku: 'E1' })).toBe(0);
  });

  it('inside the budget each mongokit op is bounded by what remains of it, not by the client 120 s', async () => {
    const { commands } = await recordCommands(conn, () =>
      withTransaction(
        conn,
        async (session) => {
          await repo.findAll({}, { ...scope, session });
        },
        { transactionOptions: { timeoutMS: 2000 } },
      ),
    );
    const find = commands.find(
      (c) => c.name === 'find' && c.collection === Row.collection.collectionName,
    );
    expect(Number(find?.command.maxTimeMS)).toBeLessThanOrEqual(2000);
  });

  it('an abort that fails never masks the callback error (it rides along as abortError)', async () => {
    const err = await withTransaction(conn, async (session) => {
      await repo.create({ sku: 'F1', qty: 1 }, { ...scope, session });
      session.abortTransaction = async () => {
        throw new Error('abort boom');
      };
      throw new Error('the real failure');
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('the real failure');
    expect(((err as { abortError?: Error }).abortError as Error).message).toBe('abort boom');
  });

  it('bound repositories share one session; a nested bound withTransaction is refused', async () => {
    await batchTransaction(conn, { rows: repo }, async ({ rows }) => {
      await rows.createMany([{ sku: 'B9', qty: 1 }], scope);
      await rows.bulkUpsert([{ sku: 'B9', qty: 2 }], { key: ['sku'], inc: ['qty'], ...scope });
      expect(() => rows.withTransaction(async () => undefined)).toThrow(/Nested withTransaction/);
    });
    expect((await Row.findOne({ sku: 'B9' }).lean())?.qty).toBe(3);
  });

  it('Repository.withTransaction (a raw caller of the helper) runs insertMany on a CSOT client', async () => {
    await repo.withTransaction(async (tx) => {
      await tx.createMany(
        [
          { sku: 'W1', qty: 1 },
          { sku: 'W2', qty: 1 },
        ],
        scope,
      );
    });
    expect(await Row.countDocuments({ sku: { $in: ['W1', 'W2'] } })).toBe(2);
  });

  it('outside a transaction the same verbs still carry the bound', async () => {
    const { commands } = await recordCommands(conn, async () => {
      await repo.findAll({}, scope);
      await repo.aggregatePipeline([{ $match: {} }], scope);
      await repo.count({}, scope);
    });
    const coll = Row.collection.collectionName;
    const bound = (name: string) =>
      commands.find((c) => c.name === name && c.collection === coll)?.command.maxTimeMS;
    expect(Number(bound('find'))).toBeLessThanOrEqual(4321);
    expect(Number(bound('find'))).toBeGreaterThan(3321);
    expect(Number(bound('aggregate'))).toBeLessThanOrEqual(6543);
    expect(Number(bound('aggregate'))).toBeGreaterThan(5543);
  });
});

describe('commit retry on UnknownTransactionCommitResult (own replica set with test commands)', () => {
  let replset: import('mongodb-memory-server').MongoMemoryReplSet;
  let conn: Connection;

  beforeAll(async () => {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    replset = await MongoMemoryReplSet.create({
      replSet: { count: 1, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    conn = await mongoose
      .createConnection(replset.getUri('csot-commit'), {
        timeoutMS: 120_000,
        monitorCommands: true,
      })
      .asPromise();
  }, 120_000);
  afterAll(async () => {
    await conn.close();
    await replset.stop();
  });

  it('retries the COMMIT, not the attempt, and commits the insertMany once', async () => {
    const M = conn.model<IRow>(
      'CsotCommitRow',
      new Schema<IRow>({ organizationId: String, sku: String, qty: Number }),
    );
    await M.init();
    const repo = new Repository<IRow>(M);
    await conn.db?.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: {
        failCommands: ['commitTransaction'],
        errorCode: 91,
        errorLabels: ['UnknownTransactionCommitResult'],
      },
    });
    let attempts = 0;
    const { commands } = await recordCommands(conn, () =>
      withTransaction(conn, async (session) => {
        attempts++;
        await repo.createMany(
          [
            { sku: 'C1', qty: 1 },
            { sku: 'C2', qty: 1 },
          ],
          { session },
        );
      }),
    );
    expect(attempts).toBe(1);
    expect(commands.filter((c) => c.name === 'commitTransaction')).toHaveLength(2);
    expect(await M.countDocuments({ sku: { $in: ['C1', 'C2'] } })).toBe(2);
  });
});
