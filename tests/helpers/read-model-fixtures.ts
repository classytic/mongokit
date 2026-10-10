/**
 * Shared Stage 2 fixtures: a tenant-scoped stock collection unique on (tenant, sku), source facts,
 * a totals read model unique on (tenant, period, rate) and a dedupe ledger. Used by the
 * data-access conformance harness and the read-model contract tests.
 */

import type { BulkUpsertFixture, ReadModelFixture } from '@classytic/repo-core/testing';
import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import { multiTenantPlugin, Repository } from '../../src/index.js';
import { applyIncrements, rebuildInto, reconcile } from '../../src/read-model/index.js';
import { getMongoUri } from '../setup.js';

interface IStock {
  organizationId: string;
  sku: string;
  qty: number;
  name?: string;
  firstSeen?: Date;
}
interface IFact {
  organizationId: string;
  period: string;
  rate: number;
  tax: number;
}
interface ITotal {
  organizationId: string;
  period: string;
  rate: number;
  tax: number;
}
interface ILedger {
  organizationId: string;
  dedupeKey: string;
}

export let conn: Connection;
export let Stock: Model<IStock>;
export let Fact: Model<IFact>;
export let Total: Model<ITotal>;
export let Ledger: Model<ILedger>;
export const tenant = () => [multiTenantPlugin({ tenantField: 'organizationId' })];

/** Open the monitored connection and register the models (call from beforeAll, after connectDB). */
export async function setupReadModelModels(): Promise<void> {
  if (conn) return;
  conn = await mongoose.createConnection(getMongoUri(), { monitorCommands: true }).asPromise();
  const stock = new Schema<IStock>({ organizationId: String, sku: String, qty: Number, name: String, firstSeen: Date });
  stock.index({ organizationId: 1, sku: 1 }, { unique: true });
  Stock = conn.model<IStock>('RmStock', stock);
  Fact = conn.model<IFact>('RmFact', new Schema<IFact>({ organizationId: String, period: String, rate: Number, tax: Number }));
  const total = new Schema<ITotal>({ organizationId: String, period: String, rate: Number, tax: Number });
  total.index({ organizationId: 1, period: 1, rate: 1 }, { unique: true });
  Total = conn.model<ITotal>('RmTotal', total);
  const ledger = new Schema<ILedger>({ organizationId: String, dedupeKey: String });
  ledger.index({ organizationId: 1, dedupeKey: 1 }, { unique: true });
  Ledger = conn.model<ILedger>('RmLedger', ledger);
  await Promise.all([Stock.syncIndexes(), Total.syncIndexes(), Ledger.syncIndexes(), Fact.init()]);
}

export const repos = () => ({
  stock: new Repository<IStock>(Stock, tenant()),
  fact: new Repository<IFact>(Fact, tenant()),
  total: new Repository<ITotal>(Total, tenant()),
  ledger: new Repository<ILedger>(Ledger, tenant()),
});
export const totalsPipeline = [
  { $group: { _id: { period: '$period', rate: '$rate' }, tax: { $sum: '$tax' } } },
  { $project: { _id: 0, period: '$_id.period', rate: '$_id.rate', tax: 1 } },
];
export const ON = ['organizationId', 'period', 'rate'] as const;


export const bulkUpsertFixture = async (): Promise<BulkUpsertFixture> => {
    const { stock } = repos();
    await Stock.deleteMany({});
    return {
      bulkUpsert: (rows, options, t) => stock.bulkUpsert(rows, { ...options, organizationId: t }),
      read: async (t) => Stock.find({ organizationId: t }).lean(),
      bulkUpsertByNonUniqueKey: (rows, t) => stock.bulkUpsert(rows, { key: ['name'], organizationId: t }),
      cleanup: async () => {
        await Stock.deleteMany({});
      },
    };
  };

export const readModelFixture = async (): Promise<ReadModelFixture> => {
    const { fact, total, ledger } = repos();
    await Promise.all([Fact.deleteMany({}), Total.deleteMany({}), Ledger.deleteMany({})]);
    const rebuild = (t: string, session?: mongoose.ClientSession) =>
      rebuildInto(fact, total, { pipeline: totalsPipeline, on: ON, scope: { organizationId: t }, session });
    return {
      seedSource: async (t, rows) => {
        await Fact.insertMany(rows.map((r) => ({ ...r, organizationId: t })));
      },
      rebuild: (t) => rebuild(t),
      rebuildInTransaction: async (t) => {
        const session = await conn.startSession();
        try {
          await session.withTransaction(() => rebuild(t, session));
        } finally {
          await session.endSession();
        }
      },
      reconcile: async (t) =>
        (await reconcile(fact, total, { pipeline: totalsPipeline, on: ON, measures: ['tax'], scope: { organizationId: t } }))
          .drift,
      tamper: async (t, period, rate) => {
        await Total.updateOne({ organizationId: t, period, rate }, { $inc: { tax: 1 } });
      },
      applyIncrements: async (t, grains) => {
        const session = await conn.startSession();
        try {
          await session.withTransaction(() =>
            applyIncrements(
              total,
              grains.map((g) => ({ key: { period: g.period, rate: g.rate }, inc: { tax: g.tax }, dedupeKey: g.dedupeKey })),
              { session, ledger, organizationId: t },
            ),
          );
        } finally {
          await session.endSession();
        }
      },
      readTotals: async (t) => Total.find({ organizationId: t }).lean(),
      cleanup: async () => {
        await Promise.all([Fact.deleteMany({}), Total.deleteMany({}), Ledger.deleteMany({})]);
      },
    };
  };
