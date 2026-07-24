/**
 * Cross-kit purge conformance — mongokit harness.
 *
 * Runs `runPurgeConformance` (from `@classytic/repo-core/testing`) against
 * BOTH port shapes: the equality-bound `purgeByField` and the filter-bound
 * `purgeByFilter`. Every scenario seeds more rows than one batch, proving
 * the keyset progression contract — soft/anonymize purges terminate WITHOUT
 * the caller hand-adding exclusion predicates (the historical hazard the old
 * resume-by-reselection port pushed onto callers).
 */

import type { TenantPurgeOptions, TenantPurgeStrategy } from '@classytic/repo-core/repository';
import type { PurgeConformanceContext } from '@classytic/repo-core/testing';
import { runPurgeConformance } from '@classytic/repo-core/testing';
import mongoose, { Schema, type Types } from 'mongoose';
import { afterAll, beforeAll, describe } from 'vitest';
import { Repository } from '../../src/index.js';
import { connectDB, createTestModel, disconnectDB } from '../setup.js';

interface IRow {
  _id: Types.ObjectId;
  organizationId: string;
  email: string;
  amount: number;
  deleted?: boolean;
  deletedAt?: Date | null;
}

const ROW_SCHEMA = () =>
  new Schema<IRow>({
    organizationId: { type: String, required: true, index: true },
    email: { type: String, required: true },
    amount: { type: Number, required: true },
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  });

const SCOPE = 'org-under-purge';
const OTHER = 'org-untouched';
const AMOUNT_EACH = 7;

beforeAll(async () => {
  await connectDB();
});
afterAll(async () => {
  await disconnectDB();
});

let seq = 0;

async function makeContext(
  purge: (
    repo: Repository<IRow>,
    strategy: TenantPurgeStrategy,
    options?: TenantPurgeOptions,
  ) => ReturnType<Repository<IRow>['purgeByField']>,
): Promise<PurgeConformanceContext> {
  const Model = await createTestModel<IRow>(`PurgeConf${seq++}`, ROW_SCHEMA());
  const repo = new Repository<IRow>(Model);

  return {
    async seed(inScope, outOfScope) {
      const rows: Partial<IRow>[] = [];
      for (let i = 0; i < inScope; i++) {
        rows.push({
          organizationId: SCOPE,
          email: `user-${i}@test.local`,
          amount: AMOUNT_EACH,
        });
      }
      for (let i = 0; i < outOfScope; i++) {
        rows.push({
          organizationId: OTHER,
          email: `other-${i}@test.local`,
          amount: AMOUNT_EACH,
        });
      }
      if (rows.length > 0) await Model.insertMany(rows);
    },
    purge: (strategy, options) => purge(repo, strategy, options),
    countRaw: () => Model.countDocuments({ organizationId: SCOPE }).exec(),
    countSoftFlagged: () =>
      Model.countDocuments({ organizationId: SCOPE, deleted: true }).exec(),
    countEmail: (value) =>
      Model.countDocuments({ organizationId: SCOPE, email: value }).exec(),
    async sumAmount() {
      const rows = await Model.aggregate([
        { $match: { organizationId: SCOPE } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      return rows[0]?.total ?? 0;
    },
    countOutOfScope: () => Model.countDocuments({ organizationId: OTHER }).exec(),
  };
}

describe('mongokit purge conformance', () => {
  runPurgeConformance({
    name: 'mongokit purgeByField',
    setup: () =>
      makeContext((repo, strategy, options) =>
        repo.purgeByField('organizationId', SCOPE, strategy, options),
      ),
  });

  runPurgeConformance({
    name: 'mongokit purgeByFilter',
    setup: () =>
      makeContext((repo, strategy, options) =>
        repo.purgeByFilter({ organizationId: SCOPE }, strategy, options),
      ),
  });
});
